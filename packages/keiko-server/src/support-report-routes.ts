import type { DesktopSupportReportRequest } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createClientOnlySupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import { resolveRuntimeStateDir } from "@oscharko-dev/keiko-activity-log";
import {
  cacheSupportReportDownload,
  SupportReportDeliveryCapacityError,
} from "./support-report-download.js";
import { readJsonRequestBody } from "./bounded-request-body.js";
import { isValidCorrelationId } from "./correlation.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { createInlineCompletionRateLimiter } from "./editor/inlineCompletionRateLimiter.js";
import { runSupportReportJob, SupportReportJobError } from "./support-report-job.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  emitSupportReportStarted,
  emitSupportReportCompleted,
  emitSupportReportFailed,
} from "./support-report-evidence.js";

const limiter = createInlineCompletionRateLimiter({
  maxPerWindow: 6,
  windowMs: 60_000,
  minIntervalMs: 0,
});

function reportRequest(value: unknown): DesktopSupportReportRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "correlationId" && key !== "evidenceScope"))
    return undefined;
  if ("evidenceScope" in value && value.evidenceScope !== "client-only") return undefined;
  if (!validReportCorrelation(value)) return undefined;
  return {
    ...("correlationId" in value ? { correlationId: value.correlationId as string } : {}),
    ...("evidenceScope" in value ? { evidenceScope: "client-only" as const } : {}),
  };
}

function validReportCorrelation(value: object): boolean {
  return (
    !("correlationId" in value) ||
    (typeof value.correlationId === "string" && isValidCorrelationId(value.correlationId))
  );
}

export async function handleCreateSupportReport(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  const request = await readReportRequest(ctx);
  if ("status" in request) return request;
  const limited = session === undefined || request.evidenceScope === "client-only";
  if (!limiter.tryAcquire(limited ? "support-report-client-only" : "support-report", Date.now()))
    return { status: 429, body: errorBody("RATE_LIMITED", "Try again later.", ctx.correlationId) };
  if (limited) return clientOnlyReportResponse(ctx, deps, request, session !== undefined);
  return createReportResponse(ctx, deps, request, session.sessionId);
}

async function readReportRequest(
  ctx: RouteContext,
): Promise<DesktopSupportReportRequest | RouteResult> {
  const parsed = await readJsonRequestBody(ctx.req, 1024, ctx.correlationId);
  const request = reportRequest(parsed);
  if (request !== undefined) return request;
  const status = "status" in parsed && parsed.status === 413 ? 413 : 400;
  return {
    status,
    body: errorBody(
      status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
      "Invalid report request.",
      ctx.correlationId,
    ),
  };
}

async function createReportResponse(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: DesktopSupportReportRequest,
  sessionId: string,
): Promise<RouteResult> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  ctx.res.once("close", cancel);
  if (ctx.res.destroyed) cancel();
  emitSupportReportStarted(ctx.correlationId, request.correlationId !== undefined);
  try {
    const report = await runSupportReportJob(
      resolveRuntimeStateDir(deps.env),
      request.correlationId,
      controller.signal,
      ctx.correlationId,
    );
    emitSupportReportCompleted(ctx.correlationId, report);
    return {
      status: 200,
      body: { ...report, ...cacheSupportReportDownload(deps, sessionId, report) },
      headers: { "Cache-Control": "no-store" },
    };
  } catch (error) {
    if (!(error instanceof SupportReportJobError)) throw error;
    emitSupportReportFailed(ctx.correlationId, error);
    const status = error.reason === "busy" ? 429 : 503;
    return {
      status,
      body: errorBody("SUPPORT_REPORT_UNAVAILABLE", "Report unavailable.", ctx.correlationId),
    };
  } finally {
    ctx.res.off("close", cancel);
  }
}

function clientOnlyReportResponse(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: DesktopSupportReportRequest,
  hasSession: boolean,
): RouteResult {
  emitSupportReportStarted(ctx.correlationId, request.correlationId !== undefined);
  try {
    const report = createClientOnlySupportReport(
      request.correlationId ?? ctx.correlationId,
      hasSession ? "diagnostic-delivery-unavailable" : "session-unavailable",
    );
    const delivery = cacheSupportReportDownload(deps, undefined, report);
    emitSupportReportCompleted(ctx.correlationId, report);
    return {
      status: 200,
      body: { ...report, ...delivery },
      headers: { "Cache-Control": "no-store" },
    };
  } catch (error) {
    if (!(error instanceof SupportReportDeliveryCapacityError)) throw error;
    emitSupportReportFailed(ctx.correlationId, new SupportReportJobError("busy", error));
    return { status: 429, body: errorBody("RATE_LIMITED", "Try again later.", ctx.correlationId) };
  }
}
