import type { DesktopSupportReportRequest } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { resolveRuntimeStateDir } from "@oscharko-dev/keiko-activity-log";
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
  if (Object.keys(value).some((key) => key !== "correlationId")) return undefined;
  if (!("correlationId" in value)) return {};
  return typeof value.correlationId === "string" && isValidCorrelationId(value.correlationId)
    ? { correlationId: value.correlationId }
    : undefined;
}

export async function handleCreateSupportReport(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return {
      status: 403,
      body: errorBody("DENIED", "Local session unavailable.", ctx.correlationId),
    };
  }
  const parsed = await readJsonRequestBody(ctx.req, 1024, ctx.correlationId);
  if ("status" in parsed && (parsed.status === 400 || parsed.status === 413) && "body" in parsed) {
    return {
      status: parsed.status,
      body: errorBody(
        parsed.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
        "Invalid report request.",
        ctx.correlationId,
      ),
    };
  }
  const request = reportRequest(parsed);
  if (request === undefined)
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "Invalid report request.", ctx.correlationId),
    };
  if (!limiter.tryAcquire("support-report", Date.now()))
    return { status: 429, body: errorBody("RATE_LIMITED", "Try again later.", ctx.correlationId) };
  return createReportResponse(ctx, deps, request);
}

async function createReportResponse(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: DesktopSupportReportRequest,
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
    return { status: 200, body: report, headers: { "Cache-Control": "no-store" } };
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
