// The Keiko for Quality review run routes (ADR-0182, Issue #4136). Every route is authenticated
// like every other `/api/` route; the two POST routes carry the server's JSON and CSRF guard. The
// start route addresses the repository by the Git window's selected `root`, resolved through the
// same registered-project authority as every Git read; reads address records by the content-free
// repository id. The events route is an SSE stream under the shared flow control: frames are never
// size-limited and only a stalled reader is torn down. No candidate content is streamed.

import {
  REVIEW_CONTRACT_VERSION,
  REVIEW_PULL_REQUEST_NUMBER_MAX,
  REVIEW_REPOSITORY_ID_MAX_CHARS,
  REVIEW_RUN_ID_MAX_CHARS,
  type ReviewRunEvent,
  type ReviewRunRefusalReason,
  type ReviewRunStartResponse,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateReviewRunStartRequest } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";

import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import { correlationIdOrUnknown } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import { optionsWithDefaults, resolveRepository } from "../gitRoutes.js";
import { errorBody } from "../route-error.js";
import type { HandlerOutcome, RouteContext, RouteResult } from "../routes.js";
import { reviewCancelResult, serveReviewEventStream } from "./eventStream.js";
import type { ReviewRunService } from "./service/service.js";

const START_BODY_MAX_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const PULL_REQUEST_NUMBER = /^[1-9]\d{0,9}$/u;
const CONTEXT_LINES = /^\d{1,3}$/u;
const DEFAULT_DIFF_CONTEXT_LINES = 3;

const REFUSAL_STATUS: Readonly<Record<ReviewRunRefusalReason, { status: number; code: string }>> = {
  "active-review-exists": { status: 409, code: "REVIEW_ACTIVE" },
  "policy-invalid": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "model-unavailable": { status: 503, code: "REVIEW_MODEL_UNAVAILABLE" },
  "request-invalid": { status: 400, code: "BAD_REQUEST" },
};

function failure(ctx: RouteContext, status: number, code: string, message: string): RouteResult {
  return { status, body: errorBody(code, message, ctx.correlationId) };
}

function unavailable(ctx: RouteContext): RouteResult {
  return failure(ctx, 503, "REVIEW_UNAVAILABLE", "Pull request reviews are not available.");
}

function safeId(value: string | null | undefined, maxChars: number): string | undefined {
  return value !== null && value !== undefined && value.length <= maxChars && SAFE_ID.test(value)
    ? value
    : undefined;
}

function runIdParam(ctx: RouteContext): string | undefined {
  return safeId(ctx.params.runId, REVIEW_RUN_ID_MAX_CHARS);
}

function refused(
  ctx: RouteContext,
  reason: ReviewRunRefusalReason,
  activeRunId?: string,
): RouteResult {
  const mapped = REFUSAL_STATUS[reason];
  const body = errorBody(mapped.code, "The review could not be started.", ctx.correlationId);
  return {
    status: mapped.status,
    body: activeRunId === undefined ? body : { ...body, activeRunId },
  };
}

function refuseInvalid(ctx: RouteContext, service: ReviewRunService, dryRun: boolean): RouteResult {
  service.refuseInvalidRequest(correlationIdOrUnknown(ctx.correlationId), dryRun);
  return refused(ctx, "request-invalid");
}

async function startedResponse(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  service: ReviewRunService,
  body: Record<string, unknown>,
): Promise<RouteResult> {
  const dryRun = body.dryRun === true;
  const validated = validateReviewRunStartRequest(body);
  if (!validated.ok) return refuseInvalid(ctx, service, dryRun);
  const options = optionsWithDefaults(deps.gitRouteOptions, ctx.correlationId);
  const repository = await resolveRepository(ctx, deps, options);
  if ("available" in repository) return refuseInvalid(ctx, service, dryRun);
  const outcome = await service.start({
    repositoryRoot: repository.repositoryRoot,
    request: validated.value,
    correlationId: correlationIdOrUnknown(ctx.correlationId),
  });
  if (outcome.kind === "refused") return refused(ctx, outcome.reason, outcome.activeRunId);
  const response: ReviewRunStartResponse =
    outcome.kind === "dry-run"
      ? { kind: "dry-run", estimate: outcome.estimate }
      : { kind: "started", run: outcome.run };
  const status = outcome.kind === "started" && !outcome.replayed ? 202 : 200;
  return { status, body: deps.redactor(response) };
}

/** `POST /api/git-review/runs`: start a review, or validate and estimate one with `dryRun`. */
export async function handleReviewRunStart(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const body = await readJsonRequestBodyOutcome(ctx.req, START_BODY_MAX_BYTES, ctx.correlationId);
  if (body.kind === "rejected") return { status: body.response.status, body: body.response.body };
  return startedResponse(ctx, deps, service, body.value);
}

/** `GET /api/git-review/runs/{runId}`. */
export async function handleReviewRunGet(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const runId = runIdParam(ctx);
  const view = runId === undefined ? undefined : await service.get(runId, ctx.correlationId);
  if (view === undefined) return failure(ctx, 404, "NOT_FOUND", "No such review run.");
  return { status: 200, body: deps.redactor(view) };
}

function pullRequestNumberQuery(ctx: RouteContext): number | undefined | false {
  const raw = ctx.url.searchParams.get("pullRequestNumber");
  if (raw === null) return undefined;
  const value = PULL_REQUEST_NUMBER.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) && value <= REVIEW_PULL_REQUEST_NUMBER_MAX ? value : false;
}

/** `GET /api/git-review/runs?repositoryId=…&pullRequestNumber=…`: history, newest first. */
export async function handleReviewRunHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const repositoryId = safeId(
    ctx.url.searchParams.get("repositoryId"),
    REVIEW_REPOSITORY_ID_MAX_CHARS,
  );
  const number = pullRequestNumberQuery(ctx);
  if (repositoryId === undefined || number === false) {
    return failure(ctx, 400, "BAD_REQUEST", "The review history query is invalid.");
  }
  const runs = await service.history(repositoryId, number);
  return { status: 200, body: deps.redactor({ schemaVersion: REVIEW_CONTRACT_VERSION, runs }) };
}

/** `GET /api/git-review/review-states?repositoryId=…`: the latest run state per pull request. */
export async function handleReviewStates(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const repositoryId = safeId(
    ctx.url.searchParams.get("repositoryId"),
    REVIEW_REPOSITORY_ID_MAX_CHARS,
  );
  if (repositoryId === undefined) {
    return failure(ctx, 400, "BAD_REQUEST", "The repository id is invalid.");
  }
  const states = await service.reviewStates(repositoryId);
  return { status: 200, body: { schemaVersion: REVIEW_CONTRACT_VERSION, states } };
}

/** `GET /api/git-review/runs/{runId}/diff?path=…&context=…`: the reviewed diff of one file. */
export async function handleReviewRunDiff(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const runId = runIdParam(ctx);
  const path = ctx.url.searchParams.get("path");
  const context = ctx.url.searchParams.get("context");
  if (runId === undefined || path === null || path.length === 0) {
    return failure(ctx, 400, "BAD_REQUEST", "The diff request is invalid.");
  }
  if (context !== null && !CONTEXT_LINES.test(context)) {
    return failure(ctx, 400, "BAD_REQUEST", "The context line count is invalid.");
  }
  const lines = context === null ? DEFAULT_DIFF_CONTEXT_LINES : Number(context);
  const result = await service.diff(runId, path, lines);
  if (result.kind === "not-found") return failure(ctx, 404, "NOT_FOUND", "No such review run.");
  return { status: 200, body: deps.redactor(result.body) };
}

/** `POST /api/git-review/runs/{runId}/cancel`. */
export function handleReviewRunCancel(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const runId = runIdParam(ctx);
  return reviewCancelResult(ctx, runId === undefined ? "not-found" : service.cancel(runId), {
    notFoundMessage: "No such review run.",
    settledCode: "REVIEW_SETTLED",
    settledMessage: "The review run has already settled.",
  });
}

/** A run that is not in flight is settled (or settles right now): one `settled` frame. */
async function settledEvent(
  service: ReviewRunService,
  runId: string,
  correlationId: string | undefined,
): Promise<ReviewRunEvent | undefined> {
  const settled = await service.get(runId, correlationId);
  const settlement = settled?.settlement ?? null;
  if (settlement === null) return undefined;
  return {
    kind: "settled",
    runId,
    settlement,
    presentedCount: settled?.presentedFindings.length ?? 0,
    elapsedMs: 0,
    counts: { filesPackaged: 0, candidates: settled?.candidateCount ?? 0, counterChecked: 0 },
  };
}

/** `GET /api/git-review/runs/{runId}/events`: progress until the one `settled` event. */
export async function handleReviewRunEvents(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const service = deps.reviewRunService;
  if (service === undefined) return unavailable(ctx);
  const runId = runIdParam(ctx);
  const view = runId === undefined ? undefined : await service.get(runId, ctx.correlationId);
  if (runId === undefined || view === undefined) {
    return failure(ctx, 404, "NOT_FOUND", "No such review run.");
  }
  return serveReviewEventStream<ReviewRunEvent>(ctx, deps, {
    stream: "review.run.events",
    eventName: "review",
    subscribe: (listener) => service.subscribe(runId, listener),
    settled: () => settledEvent(service, runId, ctx.correlationId),
  });
}
