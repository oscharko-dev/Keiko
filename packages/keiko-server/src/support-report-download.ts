// Delivery retains the canonical worker output only; it never rebuilds or persists a report.
import { randomUUID } from "node:crypto";
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
  readonly sessionId: string;
  readonly report: DesktopSupportReportResponse;
  readonly bytes: number;
  readonly expiresAtMs: number;
}
const caches = new WeakMap<UiHandlerDeps, Map<string, Delivery>>();

function prune(cache: Map<string, Delivery>, now: number): void {
  for (const [key, entry] of cache) if (entry.expiresAtMs <= now) cache.delete(key);
  let bytes = [...cache.values()].reduce((total, entry) => total + entry.bytes, 0);
  for (const [key, entry] of cache) {
    if (bytes <= MAX_SUPPORT_REPORT_BYTES && cache.size <= MAX_DELIVERY_ENTRIES) break;
    bytes -= entry.bytes;
    cache.delete(key);
  }
}

export function cacheSupportReportDownload(
  deps: UiHandlerDeps,
  sessionId: string,
  report: DesktopSupportReportResponse,
): { readonly downloadPath: string; readonly downloadExpiresAtMs: number } {
  const bytes = Buffer.byteLength(report.reportJson);
  if (bytes > MAX_SUPPORT_REPORT_BYTES || !isSupportReportFileName(report.fileName))
    throw new TypeError("Invalid support report delivery artifact");
  const cache = caches.get(deps) ?? new Map<string, Delivery>();
  caches.set(deps, cache);
  const id = randomUUID();
  const expiresAtMs = Date.now() + DELIVERY_TTL_MS;
  cache.set(id, { sessionId, report, bytes, expiresAtMs });
  prune(cache, Date.now());
  return {
    downloadPath: `/api/diagnostics/report/download/${id}`,
    downloadExpiresAtMs: expiresAtMs,
  };
}

export function handleDownloadSupportReport(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): HandlerOutcome {
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined)
    return {
      status: 403,
      body: errorBody("DENIED", "Local session unavailable.", ctx.correlationId),
    };
  const cache = caches.get(deps);
  if (cache !== undefined) prune(cache, Date.now());
  const entry = cache?.get(ctx.params.downloadId ?? "");
  if (entry === undefined || entry.sessionId !== session.sessionId)
    return { status: 404, body: errorBody("NOT_FOUND", "Report unavailable.", ctx.correlationId) };
  ctx.res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(entry.bytes),
    "Content-Disposition": `attachment; filename="${entry.report.fileName}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  ctx.res.end(entry.report.reportJson);
  emitSupportReportDelivered(ctx.correlationId, entry.bytes);
  return STREAMING;
}
