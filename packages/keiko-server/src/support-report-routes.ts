import {
  isClientReportFailure,
  MAX_DESKTOP_SUPPORT_REPORT_REQUEST_BYTES,
  type DesktopSupportReportRequest,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createClientOnlySupportReport } from "@oscharko-dev/keiko-activity-log/reader";
import {
  completePreparedSupportIncident,
  resolveRuntimeStateDir,
} from "@oscharko-dev/keiko-activity-log";
import {
  cacheSupportReportDownload,
  SupportReportDeliveryCapacityError,
} from "./support-report-download.js";
import { readJsonRequestBodyOutcome } from "./bounded-request-body.js";
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

const REPORT_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "correlationId",
  "evidenceScope",
  "failure",
]);

function reportRequest(value: unknown): DesktopSupportReportRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !REPORT_REQUEST_KEYS.has(key))) return undefined;
  if ("evidenceScope" in value && value.evidenceScope !== "client-only") return undefined;
  if (!validReportCorrelation(value)) return undefined;
  const failure = "failure" in value ? value.failure : undefined;
  if (!isClientReportFailure(failure)) return undefined;
  return reportRequestFields(value, failure);
}

function reportRequestFields(
  value: object,
  failure: DesktopSupportReportRequest["failure"],
): DesktopSupportReportRequest {
  return {
    ...(failure === undefined ? {} : { failure }),
    ...("correlationId" in value && typeof value.correlationId === "string"
      ? { correlationId: value.correlationId }
      : {}),
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
  const outcome = await readJsonRequestBodyOutcome(
    ctx.req,
    MAX_DESKTOP_SUPPORT_REPORT_REQUEST_BYTES,
    ctx.correlationId,
  );
  if (outcome.kind === "rejected") return invalidReportRequest(ctx, outcome.response.status);
  const request = reportRequest(outcome.value);
  if (request !== undefined) return request;
  return invalidReportRequest(ctx, 400);
}

function invalidReportRequest(ctx: RouteContext, status: 400 | 413): RouteResult {
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
  let abandon: (() => void) | undefined;
  const cancel = (): void => {
    controller.abort();
  };
  ctx.res.once("close", cancel);
  if (ctx.res.destroyed) cancel();
  emitSupportReportStarted(
    ctx.correlationId,
    request.correlationId !== undefined,
    request.correlationId,
  );
  try {
    const report = await runSupportReportJob(
      resolveRuntimeStateDir(deps.env),
      request.correlationId,
      controller.signal,
      ctx.correlationId,
      (cleanup): void => {
        abandon = cleanup;
      },
    );
    if (controller.signal.aborted || ctx.res.destroyed)
      throw new SupportReportJobError("cancelled");
    const delivery = cacheSupportReportDownload(deps, sessionId, report, ctx.correlationId);
    if (report.summary !== undefined) {
      completePreparedSupportIncident(resolveRuntimeStateDir(deps.env), report.summary.incidentId, {
        correlationId: ctx.correlationId,
        env: deps.env,
      });
    }
    emitSupportReportCompleted(ctx.correlationId, report, request.correlationId);
    return {
      status: 200,
      body: { ...report, ...delivery },
      headers: { "Cache-Control": "no-store" },
    };
  } catch (error) {
    abandon?.();
    return reportPreparationFailure(ctx, error);
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
  emitSupportReportStarted(
    ctx.correlationId,
    request.correlationId !== undefined,
    request.correlationId,
  );
  try {
    const report = createClientOnlySupportReport(
      request.correlationId ?? ctx.correlationId,
      hasSession ? "diagnostic-delivery-unavailable" : "session-unavailable",
      request.failure,
    );
    const delivery = cacheSupportReportDownload(deps, undefined, report, ctx.correlationId);
    emitSupportReportCompleted(ctx.correlationId, report, request.correlationId);
    return {
      status: 200,
      body: { ...report, ...delivery },
      headers: { "Cache-Control": "no-store" },
    };
  } catch (error) {
    return reportPreparationFailure(ctx, error);
  }
}

function reportPreparationFailure(ctx: RouteContext, error: unknown): RouteResult {
  const capacity = error instanceof SupportReportDeliveryCapacityError;
  const reason = capacity ? "busy" : "unavailable";
  const failure =
    error instanceof SupportReportJobError ? error : new SupportReportJobError(reason, error);
  emitSupportReportFailed(
    ctx.correlationId,
    failure,
    undefined,
    capacity ? "delivery-capacity" : undefined,
  );
  return {
    status: failure.reason === "busy" ? 429 : 503,
    body: errorBody(
      failure.reason === "selection-unavailable"
        ? "SUPPORT_REPORT_SELECTION_UNAVAILABLE"
        : "SUPPORT_REPORT_UNAVAILABLE",
      "Report unavailable.",
      ctx.correlationId,
    ),
  };
}
