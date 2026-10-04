// Delivery retains the canonical worker output only; it never rebuilds or persists a report.
import { parseSupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  MAX_SUPPORT_REPORT_BYTES,
  isSupportReportFileName,
  type DesktopSupportReportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { emitSupportReportDelivered } from "./support-report-evidence.js";
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
  readonly bytes: number;
  readonly expiresAtMs: number;
}
const caches = new WeakMap<UiHandlerDeps, Map<string, Delivery>>();

function prune(cache: Map<string, Delivery>, now: number): void {
  for (const [key, entry] of cache) if (entry.expiresAtMs <= now) cache.delete(key);
  let bytes = [...cache.values()].reduce((total, entry) => total + entry.bytes, 0);
  const ordered = [...cache].sort(
    ([, left], [, right]) =>
      Number(left.authority.kind === "session-bound") -
      Number(right.authority.kind === "session-bound"),
  );
  for (const [key, entry] of ordered) {
    if (bytes <= MAX_SUPPORT_REPORT_BYTES && cache.size <= MAX_DELIVERY_ENTRIES) break;
    bytes -= entry.bytes;
    cache.delete(key);
  }
}

export function cacheSupportReportDownload(
  deps: UiHandlerDeps,
  sessionId: string | undefined,
  report: DesktopSupportReportResponse,
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
  cache.set(id, { authority, report, bytes, expiresAtMs });
  prune(cache, Date.now());
  if (!cache.has(id)) throw new SupportReportDeliveryCapacityError();
  return {
    downloadPath: `/api/diagnostics/report/download/${id}`,
    downloadExpiresAtMs: expiresAtMs,
  };
}

export function handleDownloadSupportReport(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): HandlerOutcome {
  const cache = caches.get(deps);
  if (cache !== undefined) prune(cache, Date.now());
  const entry = cache?.get(ctx.params.downloadId ?? "");
  const denied = authorizeDelivery(ctx, deps, entry);
  if (denied !== undefined) return denied;
  if (entry === undefined) throw new TypeError("Missing authorized report delivery");
  return deliverReport(ctx, entry);
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

function deliverReport(ctx: RouteContext, entry: Delivery): HandlerOutcome {
  const bytes = gzipSync(Buffer.from(entry.report.reportJson, "utf8"), {
    maxOutputLength: MAX_SUPPORT_REPORT_BYTES,
  });
  ctx.res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": String(bytes.length),
    "Content-Disposition": `attachment; filename="${entry.report.fileName}.gz"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  ctx.res.end(bytes);
  emitSupportReportDelivered(ctx.correlationId, bytes.length);
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
