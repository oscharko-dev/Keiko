// Review model-policy resolution (ADR-0182 D8, Issue #4137). Strictest wins:
//   1. the operator's configuration: an invalid explicit value refuses every role
//      (`invalid-operator-value`) and never yields to another model; an allowlist bounds every
//      choice; a lock makes the operator defaults (or the recommendation) the only admissible pair;
//   2. the user's per-repository selection, inside the allowlist;
//   3. the recommendation: the eligible model with the largest verified window for the Reviewer,
//      then a DIFFERENT eligible model for the Counter-checker when one exists (the shared
//      role-policy helper), else the same model with a visible single-model state.
// Eligibility is exactly child 1's `evaluateReviewRoleEligibility` with the run's role budgets.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { isToolCallingVerificationFresh } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type {
  ReviewModelOption,
  ReviewModelPolicyRefusalReason,
  ReviewModelRole,
  ReviewOperatorConfig,
  ReviewOperatorConfigKey,
  ReviewResolvedRole,
  ReviewResolvedRoleState,
  ReviewRoleEligibility,
  ReviewSettingsDocument,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { evaluateReviewRoleEligibility } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";

import {
  compareContextWindowDesc,
  indexedChatCapabilities,
  pickRoleModel,
  type IndexedCapability,
} from "../../modelRolePolicy/recommendation.js";
import { REVIEW_ROLE_BUDGETS } from "../service/models.js";

/** What resolution reads: the operator configuration and the gateway's current capability data. */
export interface ReviewPolicyContext {
  readonly operator: ReviewOperatorConfig;
  /** Every configured model in configuration order. */
  readonly capabilities: readonly ModelCapability[];
  readonly capability: (modelId: string) => ModelCapability | undefined;
  readonly nowMs: number;
}

export interface ReviewRoleModels {
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
}

export interface ResolvedReviewPolicy {
  readonly reviewer: ReviewResolvedRole;
  readonly counterChecker: ReviewResolvedRole;
  readonly singleModel: boolean;
  readonly locked: boolean;
  readonly allowlistActive: boolean;
  readonly invalidOperatorKeys: readonly ReviewOperatorConfigKey[];
}

export type ReviewPolicyCheck =
  | { readonly ok: true; readonly temporarilyUnavailable: boolean }
  | {
      readonly ok: false;
      readonly reason: ReviewModelPolicyRefusalReason;
      readonly role: ReviewModelRole | "none";
    };

const ROLE_FIELD = {
  reviewer: "reviewerModelId",
  "counter-checker": "counterCheckerModelId",
} as const satisfies Record<ReviewModelRole, keyof ReviewRoleModels>;

function verifiedWindow(capability: ModelCapability): number | undefined {
  return capability.maxInputTokens ?? capability.contextWindow;
}

function byVerifiedWindow(a: IndexedCapability, b: IndexedCapability): number {
  return (
    compareContextWindowDesc(verifiedWindow(a.capability), verifiedWindow(b.capability)) ||
    a.index - b.index
  );
}

export function isAllowedReviewModel(operator: ReviewOperatorConfig, modelId: string): boolean {
  return operator.allowedReviewModelIds?.includes(modelId) ?? true;
}

export function reviewRoleEligibility(
  ctx: ReviewPolicyContext,
  role: ReviewModelRole,
  modelId: string,
): ReviewRoleEligibility {
  return evaluateReviewRoleEligibility(ctx.capability(modelId), REVIEW_ROLE_BUDGETS[role], {
    nowMs: ctx.nowMs,
  });
}

function recommendRole(
  ctx: ReviewPolicyContext,
  role: ReviewModelRole,
  avoidModelId: string | undefined,
): string | undefined {
  const candidates = indexedChatCapabilities(ctx.capabilities).filter((entry) =>
    isAllowedReviewModel(ctx.operator, entry.capability.id),
  );
  const eligible = (capability: ModelCapability): boolean =>
    reviewRoleEligibility(ctx, role, capability.id).status === "eligible";
  return pickRoleModel(candidates, eligible, byVerifiedWindow, avoidModelId)?.id;
}

function stateOf(eligibility: ReviewRoleEligibility): ReviewResolvedRoleState {
  if (eligibility.status === "ineligible") return { status: "refused", reason: eligibility.reason };
  return eligibility;
}

function refused(
  modelId: string | null,
  source: ReviewResolvedRole["source"],
  reason: ReviewModelPolicyRefusalReason,
): ReviewResolvedRole {
  return { modelId, source, state: { status: "refused", reason } };
}

function chosenValue(
  ctx: ReviewPolicyContext,
  role: ReviewModelRole,
  settings: ReviewSettingsDocument | undefined,
  avoidModelId: string | undefined,
): { readonly modelId: string; readonly source: ReviewResolvedRole["source"] } | undefined {
  const field = ROLE_FIELD[role];
  const user = ctx.operator.lockModelPolicy ? undefined : settings?.[field];
  if (user !== undefined) return { modelId: user, source: "user" };
  const operator = ctx.operator[field];
  if (operator !== undefined) return { modelId: operator, source: "operator" };
  const recommended = recommendRole(ctx, role, avoidModelId);
  return recommended === undefined ? undefined : { modelId: recommended, source: "recommendation" };
}

function resolveRole(
  ctx: ReviewPolicyContext,
  role: ReviewModelRole,
  settings: ReviewSettingsDocument | undefined,
  avoidModelId: string | undefined,
): ReviewResolvedRole {
  if (ctx.operator.issues.length > 0) {
    const operator = ctx.operator[ROLE_FIELD[role]];
    return refused(
      operator ?? null,
      operator === undefined ? "none" : "operator",
      "invalid-operator-value",
    );
  }
  const chosen = chosenValue(ctx, role, settings, avoidModelId);
  if (chosen === undefined) return refused(null, "none", "not-configured");
  if (!isAllowedReviewModel(ctx.operator, chosen.modelId)) {
    return refused(chosen.modelId, chosen.source, "outside-allowlist");
  }
  const state = stateOf(reviewRoleEligibility(ctx, role, chosen.modelId));
  return { modelId: chosen.modelId, source: chosen.source, state };
}

/** Resolves both roles for one repository's stored settings (absent: none saved). */
export function resolveReviewPolicy(
  ctx: ReviewPolicyContext,
  settings: ReviewSettingsDocument | undefined,
): ResolvedReviewPolicy {
  const reviewer = resolveRole(ctx, "reviewer", settings, undefined);
  const counterChecker = resolveRole(
    ctx,
    "counter-checker",
    settings,
    reviewer.modelId ?? undefined,
  );
  return {
    reviewer,
    counterChecker,
    singleModel: reviewer.modelId !== null && reviewer.modelId === counterChecker.modelId,
    locked: ctx.operator.lockModelPolicy,
    allowlistActive: ctx.operator.allowedReviewModelIds !== undefined,
    invalidOperatorKeys: [...new Set(ctx.operator.issues.map((issue) => issue.key))],
  };
}

function admissionRefusal(
  ctx: ReviewPolicyContext,
  models: ReviewRoleModels,
): ReviewPolicyCheck | undefined {
  if (ctx.operator.issues.length > 0) {
    return { ok: false, reason: "invalid-operator-value", role: "none" };
  }
  const locked = ctx.operator.lockModelPolicy ? resolveReviewPolicy(ctx, undefined) : undefined;
  for (const role of ["reviewer", "counter-checker"] as const) {
    const modelId = models[ROLE_FIELD[role]];
    if (!isAllowedReviewModel(ctx.operator, modelId)) {
      return { ok: false, reason: "outside-allowlist", role };
    }
    const lockedModel = role === "reviewer" ? locked?.reviewer : locked?.counterChecker;
    if (lockedModel !== undefined && lockedModel.modelId !== modelId) {
      return { ok: false, reason: "policy-locked", role };
    }
  }
  return undefined;
}

/**
 * The operator and user policy in front of every use of a pair: a run start (child 6's model port),
 * a dry run, a pair qualification and a settings write. An admitted pair is then checked with the
 * eligibility rule; a temporarily unavailable model is admitted and reported as such.
 */
export function checkReviewRoleModels(
  ctx: ReviewPolicyContext,
  models: ReviewRoleModels,
): ReviewPolicyCheck {
  const refusal = admissionRefusal(ctx, models);
  if (refusal !== undefined) return refusal;
  let temporarilyUnavailable = false;
  for (const role of ["reviewer", "counter-checker"] as const) {
    const eligibility = reviewRoleEligibility(ctx, role, models[ROLE_FIELD[role]]);
    if (eligibility.status === "ineligible") return { ok: false, reason: eligibility.reason, role };
    if (eligibility.status === "temporarily-unavailable") temporarilyUnavailable = true;
  }
  return { ok: true, temporarilyUnavailable };
}

/** Only the operator and user policy, without eligibility (child 6 checks eligibility itself). */
export function admitReviewRoleModels(
  ctx: ReviewPolicyContext,
  models: ReviewRoleModels,
): ReviewPolicyCheck {
  return admissionRefusal(ctx, models) ?? { ok: true, temporarilyUnavailable: false };
}

function toolCallingState(
  capability: ModelCapability,
  nowMs: number,
): ReviewModelOption["toolCalling"] {
  if (!capability.toolCalling) return "unsupported";
  const verification = capability.toolCallingVerification;
  if (isToolCallingVerificationFresh(verification, { nowMs })) return "verified";
  return verification?.status === "verified" ? "stale" : "unverified";
}

/** Every configured chat model as a role option with its capability summary. */
export function reviewModelOptions(ctx: ReviewPolicyContext): readonly ReviewModelOption[] {
  return indexedChatCapabilities(ctx.capabilities).map(({ capability }) => {
    const window = verifiedWindow(capability);
    return {
      modelId: capability.id,
      contextWindowTokens:
        capability.contextWindowAssumed === true || window === undefined || window <= 0
          ? null
          : window,
      contextWindowAssumed: capability.contextWindowAssumed === true,
      toolCalling: toolCallingState(capability, ctx.nowMs),
      conversationReady: capability.conversationReady ?? null,
      costClass: capability.costClass,
      latencyClass: capability.latencyClass,
      allowed: isAllowedReviewModel(ctx.operator, capability.id),
      reviewer: reviewRoleEligibility(ctx, "reviewer", capability.id),
      counterChecker: reviewRoleEligibility(ctx, "counter-checker", capability.id),
    };
  });
}
