// The review model-policy and settings routes (ADR-0182 D8, Issue #4137).
//
//   GET /api/git-review/model-policy?repositoryId=…  the resolved roles with their sources, the lock
//       and allowlist state, every configured chat model as an option with its capability summary,
//       and the pair status. A read view: it never writes. It answers while the area is switched
//       off (`enabled: false`), so the UI knows not to mount the area.
//   GET /api/git-review/settings?repositoryId=…      the stored settings document and its revision.
//   PUT /api/git-review/settings?repositoryId=…      validates and preflights before saving.
//
// Checking a pair without saving is the `dryRun` of the run start route (Issue #4136). Both write
// routes carry the server's JSON and CSRF guard like every other state-changing `/api/` route.

import {
  REVIEW_CONTRACT_VERSION,
  type ReviewModelPolicyRefusalReason,
  type ReviewModelPolicyResponse,
  type ReviewPairStatusView,
  type ReviewSettingsDocument,
  type ReviewSettingsResponse,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { readJsonRequestBodyOutcome } from "../../bounded-request-body.js";
import { correlationIdOrUnknown } from "../../correlation.js";
import type { UiHandlerDeps } from "../../deps.js";
import { errorBody } from "../../route-error.js";
import type { RouteContext, RouteResult } from "../../routes.js";
import { reportReviewFailure } from "../diagnostics.js";
import { logReviewModelPolicyResolved, logReviewModelPolicyUpdated } from "./activity-log.js";
import {
  effectiveRulesFilePath,
  recordReviewPolicyRefusal,
  reviewPolicyContext,
} from "./policy.js";
import {
  resolveReviewPolicy,
  reviewModelOptions,
  type ResolvedReviewPolicy,
  type ReviewPolicyContext,
} from "./resolution.js";
import {
  emptyReviewSettings,
  isReviewSettingsRepositoryId,
  ReviewSettingsStorageError,
  type ReviewSettingsStore,
} from "./settingsStore.js";
import { updateReviewSettings } from "./settingsUpdate.js";
import type { ServerLogSink } from "../../observability/index.js";
import { processServerLogSink } from "../../process-log-sink.js";

const SETTINGS_BODY_MAX_BYTES = 16 * 1024;

const REFUSAL_STATUS: Readonly<
  Record<ReviewModelPolicyRefusalReason, { readonly status: number; readonly code: string }>
> = {
  "not-configured": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "not-tool-capable": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "tool-verification-stale": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "window-unknown": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "window-too-small": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "not-coding-safe": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "invalid-operator-value": { status: 422, code: "REVIEW_POLICY_INVALID" },
  "outside-allowlist": { status: 403, code: "REVIEW_MODEL_NOT_ALLOWED" },
  "policy-locked": { status: 403, code: "REVIEW_POLICY_LOCKED" },
  "rules-path-invalid": { status: 400, code: "REVIEW_SETTINGS_INVALID" },
  "request-invalid": { status: 400, code: "BAD_REQUEST" },
  "revision-conflict": { status: 409, code: "REVIEW_SETTINGS_CONFLICT" },
};

function failure(ctx: RouteContext, status: number, code: string, message: string): RouteResult {
  return { status, body: errorBody(code, message, ctx.correlationId) };
}

/** A refused policy decision: the closed reason and role travel with the error. */
export function reviewPolicyRefusalResult(
  ctx: RouteContext,
  refusal: { readonly reason: ReviewModelPolicyRefusalReason; readonly role: string },
  message: string,
): RouteResult {
  const mapped = REFUSAL_STATUS[refusal.reason];
  const body = errorBody(mapped.code, message, ctx.correlationId);
  return { status: mapped.status, body: { ...body, reason: refusal.reason, role: refusal.role } };
}

function activityLog(deps: UiHandlerDeps): ServerLogSink {
  return deps.activityLog ?? processServerLogSink();
}

/** `undefined` for no repository, `false` for an invalid one. */
function repositoryIdQuery(ctx: RouteContext): string | undefined | false {
  const raw = ctx.url.searchParams.get("repositoryId");
  if (raw === null) return undefined;
  return isReviewSettingsRepositoryId(raw) ? raw : false;
}

function readSettings(
  store: ReviewSettingsStore,
  repositoryId: string,
  correlationId: string,
): ReviewSettingsDocument {
  const stored = store.read(repositoryId);
  if (stored.kind === "stored") return stored.document;
  if (stored.kind === "invalid") {
    reportReviewFailure("review.settings.read", correlationId, new TypeError("invalid settings"));
  }
  return emptyReviewSettings(repositoryId);
}

function pairStatus(deps: UiHandlerDeps, policy: ResolvedReviewPolicy): ReviewPairStatusView {
  const reviewerModelId = policy.reviewer.modelId;
  const counterCheckerModelId = policy.counterChecker.modelId;
  if (reviewerModelId === null || counterCheckerModelId === null) return { status: "unmeasured" };
  return (
    deps.reviewPolicy?.pairStatus.status({
      reviewerModelId,
      counterCheckerModelId,
      generation: deps.gatewayConfig?.generation(),
    }) ?? { status: "unmeasured" }
  );
}

function policyResponse(
  deps: UiHandlerDeps,
  policyCtx: ReviewPolicyContext,
  repositoryId: string | null,
  settings: ReviewSettingsDocument | undefined,
): Extract<ReviewModelPolicyResponse, { readonly enabled: true }> {
  const policy = resolveReviewPolicy(policyCtx, settings);
  return {
    schemaVersion: REVIEW_CONTRACT_VERSION,
    enabled: true,
    repositoryId,
    locked: policy.locked,
    allowlistActive: policy.allowlistActive,
    invalidOperatorKeys: policy.invalidOperatorKeys,
    reviewer: policy.reviewer,
    counterChecker: policy.counterChecker,
    singleModel: policy.singleModel,
    options: reviewModelOptions(policyCtx),
    pair: pairStatus(deps, policy),
    configurationGeneration: deps.gatewayConfig?.generation() ?? null,
  };
}

function logResolved(
  deps: UiHandlerDeps,
  correlationId: string,
  response: Extract<ReviewModelPolicyResponse, { readonly enabled: true }>,
): void {
  const eligible = (role: "reviewer" | "counterChecker"): number =>
    response.options.filter((option) => option.allowed && option[role].status === "eligible")
      .length;
  logReviewModelPolicyResolved(activityLog(deps), correlationId, {
    reviewer: response.reviewer,
    counterChecker: response.counterChecker,
    locked: response.locked,
    allowlistActive: response.allowlistActive,
    singleModel: response.singleModel,
    pairStatus: response.pair.status,
    optionCount: response.options.length,
    eligibleReviewerCount: eligible("reviewer"),
    eligibleCounterCheckerCount: eligible("counterChecker"),
    invalidOperatorKeyCount: response.invalidOperatorKeys.length,
  });
}

/** A failed settings read or write: the cause goes to the diagnostic sink, the UI gets a code. */
function reportSettingsStorageFailure(
  ctx: RouteContext,
  operation: "review.settings.read" | "review.settings.write",
  error: unknown,
): RouteResult {
  reportReviewFailure(operation, ctx.correlationId, error);
  return error instanceof ReviewSettingsStorageError
    ? failure(ctx, 500, "REVIEW_SETTINGS_UNSAFE", "The review settings store is not safe.")
    : failure(ctx, 500, "REVIEW_SETTINGS_STORAGE_FAILED", "The review settings are unavailable.");
}

/** `GET /api/git-review/model-policy?repositoryId=…`. */
export function handleReviewModelPolicy(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  const repositoryId = repositoryIdQuery(ctx);
  if (repositoryId === false) {
    return failure(ctx, 400, "BAD_REQUEST", "The repository id is invalid.");
  }
  const policyCtx = reviewPolicyContext(deps);
  if (!policyCtx.operator.enabled) {
    logReviewModelPolicyResolved(activityLog(deps), correlationId, undefined);
    return { status: 200, body: { schemaVersion: REVIEW_CONTRACT_VERSION, enabled: false } };
  }
  try {
    const store = deps.reviewPolicy?.settings;
    const settings =
      repositoryId === undefined || store === undefined
        ? undefined
        : readSettings(store, repositoryId, correlationId);
    const response = policyResponse(deps, policyCtx, repositoryId ?? null, settings);
    logResolved(deps, correlationId, response);
    return { status: 200, body: deps.redactor(response) };
  } catch (error) {
    return reportSettingsStorageFailure(ctx, "review.settings.read", error);
  }
}

function settingsResponse(
  policyCtx: ReviewPolicyContext,
  settings: ReviewSettingsDocument,
): ReviewSettingsResponse {
  const rules = effectiveRulesFilePath(policyCtx.operator, settings, settings.repositoryId);
  return {
    schemaVersion: REVIEW_CONTRACT_VERSION,
    settings,
    effectiveRulesFilePath: rules.path,
    rulesFilePathSource: rules.source,
    locked: policyCtx.operator.lockModelPolicy,
  };
}

function settingsTarget(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): { readonly store: ReviewSettingsStore; readonly repositoryId: string } | RouteResult {
  const repositoryId = repositoryIdQuery(ctx);
  if (repositoryId === undefined || repositoryId === false) {
    return failure(ctx, 400, "BAD_REQUEST", "The repository id is invalid.");
  }
  const store = deps.reviewPolicy?.settings;
  if (store === undefined) {
    return failure(ctx, 503, "REVIEW_UNAVAILABLE", "Review settings are not available.");
  }
  return { store, repositoryId };
}

/** `GET /api/git-review/settings?repositoryId=…`. */
export function handleReviewSettingsGet(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const target = settingsTarget(ctx, deps);
  if ("status" in target) return target;
  try {
    const settings = readSettings(
      target.store,
      target.repositoryId,
      correlationIdOrUnknown(ctx.correlationId),
    );
    return { status: 200, body: settingsResponse(reviewPolicyContext(deps), settings) };
  } catch (error) {
    return reportSettingsStorageFailure(ctx, "review.settings.read", error);
  }
}

/** `PUT /api/git-review/settings?repositoryId=…`. */
export async function handleReviewSettingsPut(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const target = settingsTarget(ctx, deps);
  if ("status" in target) return target;
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  const body = await readJsonRequestBodyOutcome(ctx.req, SETTINGS_BODY_MAX_BYTES, correlationId);
  if (body.kind === "rejected") return { status: body.response.status, body: body.response.body };
  const policyCtx = reviewPolicyContext(deps);
  try {
    const outcome = await updateReviewSettings({
      ctx: policyCtx,
      current: readSettings(target.store, target.repositoryId, correlationId),
      body: body.value,
      nowIso: new Date(policyCtx.nowMs).toISOString(),
      save: (document) => {
        target.store.write(document);
      },
    });
    if (outcome.kind === "refused") {
      const refusal = { ok: false as const, reason: outcome.reason, role: outcome.role };
      recordReviewPolicyRefusal(
        activityLog(deps),
        correlationId,
        policyCtx.operator,
        refusal,
        "settings-update",
      );
      return reviewPolicyRefusalResult(ctx, outcome, "The review settings were not saved.");
    }
    logReviewModelPolicyUpdated(activityLog(deps), correlationId, {
      reviewer: outcome.policy.reviewer,
      counterChecker: outcome.policy.counterChecker,
      revision: outcome.document.revision,
      modelsChanged: outcome.modelsChanged,
      rulesPathChanged: outcome.rulesPathChanged,
      rulesPathSet: outcome.document.rulesFilePath !== undefined,
    });
    return { status: 200, body: settingsResponse(policyCtx, outcome.document) };
  } catch (error) {
    return reportSettingsStorageFailure(ctx, "review.settings.write", error);
  }
}
