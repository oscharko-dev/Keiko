// Delivery retains the canonical worker output only; it never rebuilds or persists a report.
import { parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import {
  MAX_SUPPORT_REPORT_BYTES,
  isSupportReportFileName,
  type DesktopSupportReportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { emitSupportReportDelivered, emitSupportReportFailed } from "./support-report-evidence.js";
import { SupportReportJobError } from "./support-report-job.js";
import type { UiHandlerDeps } from "./deps.js";
import type { HandlerOutcome, RouteContext } from "./routes.js";
import { STREAMING } from "./route-outcome.js";
import { errorBody } from "./route-error.js";

const DELIVERY_TTL_MS = 15 * 60_000;
const MAX_DELIVERY_ENTRIES = 128;
interface Delivery {
  readonly authority:
    | { readonly kind: "session-bound"; readonly sessionId: string }
    | { readonly kind: "client-only" };
  readonly report: DesktopSupportReportResponse;
  bytes: number;
  compressed?: Promise<Buffer>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  readonly creationCorrelationId?: string | undefined;
  readonly expiresAtMs: number;
}
const caches = new WeakMap<UiHandlerDeps, Map<string, Delivery>>();

function prune(cache: Map<string, Delivery>, now: number): void {
  for (const [key, entry] of cache)
    if (entry.expiresAtMs <= now) disposeDelivery(cache, key, entry);
  let bytes = [...cache.values()].reduce((total, entry) => total + entry.bytes, 0);
  const ordered = [...cache].sort(
    ([, left], [, right]) =>
      Number(left.authority.kind === "session-bound") -
      Number(right.authority.kind === "session-bound"),
  );
  for (const [key, entry] of ordered) {
    if (bytes <= MAX_SUPPORT_REPORT_BYTES && cache.size <= MAX_DELIVERY_ENTRIES) break;
    bytes -= entry.bytes;
    disposeDelivery(cache, key, entry);
  }
}

function disposeDelivery(cache: Map<string, Delivery>, key: string, entry: Delivery): void {
  clearTimeout(entry.expiryTimer);
  if (cache.get(key) === entry) cache.delete(key);
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
  const id = randomUUID();
  const expiresAtMs = Date.now() + DELIVERY_TTL_MS;
  if (sessionId === undefined) validateLimitedDelivery(report);
  const authority =
    sessionId === undefined
      ? { kind: "client-only" as const }
      : { kind: "session-bound" as const, sessionId };
  const entry: Delivery = { authority, report, bytes, expiresAtMs, creationCorrelationId };
  cache.set(id, entry);
  entry.expiryTimer = setTimeout(() => {
    disposeDelivery(cache, id, entry);
  }, DELIVERY_TTL_MS);
  entry.expiryTimer.unref();
  prune(cache, Date.now());
  if (!cache.has(id)) throw new SupportReportDeliveryCapacityError();
  return {
    downloadPath: `/api/diagnostics/report/download/${id}`,
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
    if (Date.now() >= entry.expiresAtMs)
      return {
        status: 404,
        body: errorBody("NOT_FOUND", "Report unavailable.", ctx.correlationId),
      };
    if (ctx.res.destroyed) {
      failedDelivery(ctx, entry, "cancelled");
      return STREAMING;
    }
    return deliverReport(ctx, entry, bytes);
  } catch (error) {
    failedDelivery(ctx, entry, "unavailable", error);
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
  if (session === undefined)
    return {
      status: 403,
      body: errorBody("DENIED", "Local session unavailable.", ctx.correlationId),
    };
  if (entry?.authority.sessionId !== session.sessionId)
    return { status: 404, body: errorBody("NOT_FOUND", "Report unavailable.", ctx.correlationId) };
  return undefined;
}

function compressedReport(
  entry: Delivery,
  cache: Map<string, Delivery> | undefined,
): Promise<Buffer> {
  entry.compressed ??= new Promise<Buffer>((resolve, reject) => {
    gzip(
      Buffer.from(entry.report.reportJson, "utf8"),
      { maxOutputLength: MAX_SUPPORT_REPORT_BYTES },
      (error, bytes) => {
        if (error !== null) {
          reject(error);
          return;
        }
        entry.bytes += bytes.length;
        if (cache !== undefined) prune(cache, Date.now());
        resolve(bytes);
      },
    );
  });
  return entry.compressed;
}

function failedDelivery(
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
      reportBytes,
      entry.authority.kind,
      entry.creationCorrelationId,
      entry.report.summary?.reportDigest,
    );
  };
  const closed = (): void => {
    cleanup();
    failedDelivery(ctx, entry, "cancelled");
  };
  const failed = (error: Error): void => {
    cleanup();
    failedDelivery(ctx, entry, "unavailable", error);
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
    failedDelivery(ctx, entry, "unavailable", error);
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
