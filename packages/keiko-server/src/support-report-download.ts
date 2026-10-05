// Delivery retains the canonical worker output only; it never rebuilds or persists a report.
import { parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import {
  MAX_SUPPORT_REPORT_BYTES,
  SUPPORT_REPORT_DELIVERY_TTL_MS,
  isSupportReportFileName,
  supportReportDownloadPath,
  type DesktopSupportReportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import {
  emitSupportReportDelivered,
  emitSupportReportDeliveryReleased,
  emitSupportReportDownloadRefused,
  emitSupportReportFailed,
} from "./support-report-evidence.js";
import { SupportReportJobError } from "./support-report-job.js";
import type { UiHandlerDeps } from "./deps.js";
import type { HandlerOutcome, RouteContext } from "./routes.js";
import { STREAMING } from "./route-outcome.js";
import { errorBody } from "./route-error.js";

const MAX_DELIVERY_ENTRIES = 128;
// Retain the ready artifact while a replacement is prepared, each within the canonical byte cap.
export const MAX_SUPPORT_REPORT_DELIVERY_BYTES = 2 * MAX_SUPPORT_REPORT_BYTES;
interface Delivery {
  readonly authority:
    | { readonly kind: "session-bound"; readonly sessionId: string }
    | { readonly kind: "client-only" };
  readonly report: Pick<DesktopSupportReportResponse, "fileName" | "summary" | "evidenceScope">;
  readonly canonicalBytes: number;
  reportJson?: string;
  bytes: number;
  compressed?: Promise<Buffer>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  readonly creationCorrelationId?: string | undefined;
  readonly expiresAtMs: number;
}
const caches = new WeakMap<UiHandlerDeps, Map<string, Delivery>>();

function prune(cache: Map<string, Delivery>, now: number): void {
  for (const [key, entry] of cache)
    if (entry.expiresAtMs <= now) disposeDelivery(cache, key, entry, "expired");
  let bytes = [...cache.values()].reduce((total, entry) => total + entry.bytes, 0);
  const ordered = [...cache].sort(
    ([, left], [, right]) =>
      Number(left.authority.kind === "session-bound") -
      Number(right.authority.kind === "session-bound"),
  );
  for (const [key, entry] of ordered) {
    if (bytes <= MAX_SUPPORT_REPORT_DELIVERY_BYTES && cache.size <= MAX_DELIVERY_ENTRIES) break;
    const reason = bytes > MAX_SUPPORT_REPORT_DELIVERY_BYTES ? "byte-pressure" : "entry-pressure";
    bytes -= entry.bytes;
    disposeDelivery(cache, key, entry, reason);
  }
}

function disposeDelivery(
  cache: Map<string, Delivery>,
  key: string,
  entry: Delivery,
  reason: "expired" | "byte-pressure" | "entry-pressure",
): void {
  if (cache.get(key) !== entry) return;
  clearTimeout(entry.expiryTimer);
  cache.delete(key);
  emitSupportReportDeliveryReleased(
    entry.creationCorrelationId,
    reason,
    entry.canonicalBytes,
    entry.bytes,
    entry.authority.kind,
    entry.report.evidenceScope ?? "server",
  );
}

function assertLimitedDeliveryCapacity(cache: Map<string, Delivery>, incomingBytes: number): void {
  let protectedBytes = 0;
  let protectedCount = 0;
  for (const entry of cache.values()) {
    if (entry.authority.kind !== "session-bound") continue;
    protectedBytes += entry.bytes;
    protectedCount += 1;
  }
  if (
    protectedBytes + incomingBytes > MAX_SUPPORT_REPORT_DELIVERY_BYTES ||
    protectedCount >= MAX_DELIVERY_ENTRIES
  )
    throw new SupportReportDeliveryCapacityError();
}

export function cacheSupportReportDownload(
  deps: UiHandlerDeps,
  sessionId: string | undefined,
  report: DesktopSupportReportResponse,
  creationCorrelationId?: string,
): { readonly downloadPath: string; readonly downloadExpiresAtMs: number } {
  const bytes = Buffer.byteLength(report.reportJson);
  if (bytes > MAX_SUPPORT_REPORT_BYTES || !isSupportReportFileName(report.fileName))
    throw new TypeError("Invalid support report delivery artifact");
  const cache = caches.get(deps) ?? new Map<string, Delivery>();
  caches.set(deps, cache);
  prune(cache, Date.now());
  if (sessionId === undefined) {
    validateLimitedDelivery(report);
    assertLimitedDeliveryCapacity(cache, bytes);
  }
  const id = randomUUID();
  const expiresAtMs = Date.now() + SUPPORT_REPORT_DELIVERY_TTL_MS;
  const authority =
    sessionId === undefined
      ? { kind: "client-only" as const }
      : { kind: "session-bound" as const, sessionId };
  const entry: Delivery = {
    authority,
    report: {
      fileName: report.fileName,
      ...(report.summary === undefined ? {} : { summary: report.summary }),
      ...(report.evidenceScope === undefined ? {} : { evidenceScope: report.evidenceScope }),
    },
    reportJson: report.reportJson,
    canonicalBytes: bytes,
    bytes,
    expiresAtMs,
    creationCorrelationId,
  };
  cache.set(id, entry);
  entry.expiryTimer = setTimeout(() => {
    disposeDelivery(cache, id, entry, "expired");
  }, SUPPORT_REPORT_DELIVERY_TTL_MS);
  entry.expiryTimer.unref();
  prune(cache, Date.now());
  if (!cache.has(id)) throw new SupportReportDeliveryCapacityError();
  return {
    downloadPath: supportReportDownloadPath(id),
    downloadExpiresAtMs: expiresAtMs,
  };
}

export async function handleDownloadSupportReport(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const cache = caches.get(deps);
  if (cache !== undefined) prune(cache, Date.now());
  const entry = cache?.get(ctx.params.downloadId ?? "");
  const denied = authorizeDelivery(ctx, deps, entry);
  if (denied !== undefined) return denied;
  if (entry === undefined) throw new TypeError("Missing authorized report delivery");
  try {
    const bytes = await compressedReport(entry, cache);
    const currentDenied = authorizeDelivery(ctx, deps, entry);
    if (currentDenied !== undefined) return currentDenied;
    if (Date.now() >= entry.expiresAtMs) return refusedDelivery(ctx, 404, "expired-or-unknown");
    if (ctx.res.destroyed) {
      reportFailedDelivery(ctx, entry, "cancelled");
      return STREAMING;
    }
    return deliverReport(ctx, entry, bytes);
  } catch (error) {
    reportFailedDelivery(ctx, entry, "unavailable", error);
    return {
      status: 500,
      body: errorBody("INTERNAL", "Report delivery unavailable.", ctx.correlationId),
    };
  }
}

function authorizeDelivery(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  entry: Delivery | undefined,
): HandlerOutcome | undefined {
  if (entry?.authority.kind === "client-only") return undefined;
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined) return refusedDelivery(ctx, 403, "no-session");
  if (entry === undefined) return refusedDelivery(ctx, 404, "expired-or-unknown");
  if (entry.authority.sessionId !== session.sessionId)
    return refusedDelivery(ctx, 404, "other-session");
  return undefined;
}

function refusedDelivery(
  ctx: RouteContext,
  status: 403 | 404,
  reason: "no-session" | "other-session" | "expired-or-unknown",
): HandlerOutcome {
  emitSupportReportDownloadRefused(ctx.correlationId, reason, status);
  return {
    status,
    body: errorBody(
      status === 403 ? "DENIED" : "NOT_FOUND",
      status === 403 ? "Local session unavailable." : "Report unavailable.",
      ctx.correlationId,
    ),
  };
}

function compressedReport(
  entry: Delivery,
  cache: Map<string, Delivery> | undefined,
): Promise<Buffer> {
  entry.compressed ??= new Promise<Buffer>((resolve, reject) => {
    if (entry.reportJson === undefined) {
      reject(new TypeError("Missing prepared report bytes"));
      return;
    }
    gzip(
      Buffer.from(entry.reportJson, "utf8"),
      { maxOutputLength: MAX_SUPPORT_REPORT_BYTES },
      (error, bytes) => {
        if (error !== null) {
          reject(error);
          return;
        }
        delete entry.reportJson;
        entry.bytes = bytes.length;
        if (cache !== undefined) prune(cache, Date.now());
        resolve(bytes);
      },
    );
  });
  return entry.compressed;
}

function reportFailedDelivery(
  ctx: RouteContext,
  entry: Delivery,
  reason: "cancelled" | "unavailable",
  error?: unknown,
): void {
  emitSupportReportFailed(
    ctx.correlationId,
    new SupportReportJobError(reason, error),
    entry.creationCorrelationId,
  );
}

function observeDelivery(ctx: RouteContext, entry: Delivery, reportBytes: number): () => void {
  const cleanup = (): void => {
    ctx.res.off("finish", finished);
    ctx.res.off("close", closed);
    ctx.res.off("error", failed);
  };
  const finished = (): void => {
    cleanup();
    emitSupportReportDelivered(
      ctx.correlationId,
      entry.canonicalBytes,
      entry.authority.kind,
      entry.creationCorrelationId,
      entry.report.summary?.reportDigest,
      entry.report.evidenceScope ?? "server",
      reportBytes,
    );
  };
  const closed = (): void => {
    cleanup();
    reportFailedDelivery(ctx, entry, "cancelled");
  };
  const failed = (error: Error): void => {
    cleanup();
    reportFailedDelivery(ctx, entry, "unavailable", error);
  };
  ctx.res.once("finish", finished);
  ctx.res.once("close", closed);
  ctx.res.once("error", failed);
  return cleanup;
}

function deliverReport(ctx: RouteContext, entry: Delivery, bytes: Buffer): HandlerOutcome {
  const cleanup = observeDelivery(ctx, entry, bytes.length);
  try {
    ctx.res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${entry.report.fileName}.gz"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    ctx.res.end(bytes);
  } catch (error) {
    cleanup();
    reportFailedDelivery(ctx, entry, "unavailable", error);
    ctx.res.destroy();
  }
  return STREAMING;
}

function validateLimitedDelivery(report: DesktopSupportReportResponse): void {
  if (report.evidenceScope !== "client-only")
    throw new TypeError("Full support report requires session-bound delivery");
  const parsed = parseSupportReport(report.reportJson);
  if (parsed.incident.clientReport === undefined || parsed.evidence.recordCount !== 0)
    throw new TypeError("Limited delivery cannot contain server evidence");
}

export class SupportReportDeliveryCapacityError extends Error {
  public constructor() {
    super("Support report delivery capacity unavailable");
    this.name = "SupportReportDeliveryCapacityError";
  }
}
