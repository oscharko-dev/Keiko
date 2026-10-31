// The local pair qualification routes (ADR-0182 D8, Issue #4137).
//
//   POST /api/git-review/pair-qualifications            start one for a Reviewer/Counter-checker
//        pair, after the same operator and user policy and eligibility check a run start applies;
//   GET  /api/git-review/pair-qualifications/{id}       its state, per-case results and score;
//   GET  /api/git-review/pair-qualifications/{id}/events  body-free progress over the shared SSE
//        flow control until the one settled frame;
//   POST /api/git-review/pair-qualifications/{id}/cancel  cancel it; its seed repositories go.
// One qualification runs at a time. Both POST routes carry the server's JSON and CSRF guard.

import type { ReviewPairQualificationEvent } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateReviewPairQualificationStartRequest } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";

import { readJsonRequestBodyOutcome } from "../../bounded-request-body.js";
import { correlationIdOrUnknown } from "../../correlation.js";
import type { UiHandlerDeps } from "../../deps.js";
import { processServerLogSink } from "../../process-log-sink.js";
import { errorBody } from "../../route-error.js";
import type { HandlerOutcome, RouteContext, RouteResult } from "../../routes.js";
import { reviewCancelResult, serveReviewEventStream } from "../eventStream.js";
import { recordReviewPolicyRefusal, reviewPolicyContext } from "../policy/policy.js";
import { checkReviewRoleModels } from "../policy/resolution.js";
import { reviewPolicyRefusalResult } from "../policy/routes.js";
import { logPairQualificationFailed } from "./activity-log.js";
import type { PairQualificationService } from "./service.js";

const START_BODY_MAX_BYTES = 4 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function failure(ctx: RouteContext, status: number, code: string, message: string): RouteResult {
  return { status, body: errorBody(code, message, ctx.correlationId) };
}

function unavailable(ctx: RouteContext): RouteResult {
  return failure(ctx, 503, "REVIEW_UNAVAILABLE", "Pair qualification is not available.");
}

function qualificationIdParam(ctx: RouteContext): string | undefined {
  const value = ctx.params.qualificationId;
  return value !== undefined && SAFE_ID.test(value) ? value : undefined;
}

function startRefusal(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  service: PairQualificationService,
  body: unknown,
): RouteResult {
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  const log = deps.activityLog ?? processServerLogSink();
  const validated = validateReviewPairQualificationStartRequest(body);
  const policyCtx = reviewPolicyContext(deps);
  if (!validated.ok) {
    const refusal = {
      ok: false as const,
      reason: "request-invalid" as const,
      role: "none" as const,
    };
    recordReviewPolicyRefusal(log, correlationId, policyCtx.operator, refusal, "qualification");
    return reviewPolicyRefusalResult(ctx, refusal, "The pair qualification could not be started.");
  }
  const check = checkReviewRoleModels(policyCtx, validated.value);
  if (!check.ok) {
    recordReviewPolicyRefusal(log, correlationId, policyCtx.operator, check, "qualification");
    return reviewPolicyRefusalResult(ctx, check, "The pair qualification could not be started.");
  }
  if (check.temporarilyUnavailable) {
    logPairQualificationFailed(log, correlationId, { reason: "unavailable" });
    return failure(ctx, 503, "REVIEW_MODEL_UNAVAILABLE", "A model of the pair is not ready.");
  }
  const outcome = service.start({
    models: validated.value,
    generation: deps.gatewayConfig?.generation(),
    correlationId,
  });
  if (outcome.kind === "refused") {
    return outcome.reason === "active-qualification"
      ? failure(ctx, 409, "REVIEW_QUALIFICATION_ACTIVE", "A pair qualification is running.")
      : unavailable(ctx);
  }
  return {
    status: 202,
    body: deps.redactor({ kind: "started", qualification: outcome.qualification }),
  };
}

/** `POST /api/git-review/pair-qualifications`. */
export async function handlePairQualificationStart(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = deps.reviewPolicy?.qualifications;
  if (service === undefined) return unavailable(ctx);
  const body = await readJsonRequestBodyOutcome(ctx.req, START_BODY_MAX_BYTES, ctx.correlationId);
  if (body.kind === "rejected") return { status: body.response.status, body: body.response.body };
  return startRefusal(ctx, deps, service, body.value);
}

/** `GET /api/git-review/pair-qualifications/{id}`. */
export function handlePairQualificationGet(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const service = deps.reviewPolicy?.qualifications;
  if (service === undefined) return unavailable(ctx);
  const id = qualificationIdParam(ctx);
  const view = id === undefined ? undefined : service.get(id);
  if (view === undefined) return failure(ctx, 404, "NOT_FOUND", "No such pair qualification.");
  return { status: 200, body: deps.redactor(view) };
}

/** `POST /api/git-review/pair-qualifications/{id}/cancel`. */
export function handlePairQualificationCancel(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const service = deps.reviewPolicy?.qualifications;
  if (service === undefined) return unavailable(ctx);
  const id = qualificationIdParam(ctx);
  return reviewCancelResult(ctx, id === undefined ? "not-found" : service.cancel(id), {
    notFoundMessage: "No such pair qualification.",
    settledCode: "REVIEW_QUALIFICATION_SETTLED",
    settledMessage: "The qualification has settled.",
  });
}

/** `GET /api/git-review/pair-qualifications/{id}/events`. */
export async function handlePairQualificationEvents(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const service = deps.reviewPolicy?.qualifications;
  if (service === undefined) return unavailable(ctx);
  const id = qualificationIdParam(ctx);
  const view = id === undefined ? undefined : service.get(id);
  if (id === undefined || view === undefined) {
    return failure(ctx, 404, "NOT_FOUND", "No such pair qualification.");
  }
  return serveReviewEventStream<ReviewPairQualificationEvent>(ctx, deps, {
    stream: "review.pair-qualification.events",
    eventName: "pair-qualification",
    subscribe: (listener) => service.subscribe(id, listener),
    settled: () => {
      const settled = service.get(id);
      const outcome = settled?.outcome ?? null;
      return Promise.resolve(
        settled === undefined || outcome === null
          ? undefined
          : {
              kind: "settled",
              qualificationId: id,
              outcome,
              score: settled.score,
              elapsedMs: settled.durationMs,
            },
      );
    },
  });
}
