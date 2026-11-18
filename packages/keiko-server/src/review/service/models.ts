// Role model validation of one review run (ADR-0184 D8, Issue #4136). Each role's model is checked
// with the one eligibility rule of child 1 (`evaluateReviewRoleEligibility`) against the gateway's
// current capability data. An ineligible model refuses the run as `policy-invalid`, a temporarily
// unavailable one as `model-unavailable`. Operator defaults, allowlist and lock (Issue #4137) sit
// in front of this check through the same port without changing it.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import type {
  ReviewModelRole,
  ReviewRoleBudget,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { evaluateReviewRoleEligibility } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";

/** The context each role needs: the Reviewer's 64 KiB task and tools, a counter-check session. */
export const REVIEW_ROLE_BUDGETS: Readonly<Record<ReviewModelRole, ReviewRoleBudget>> = {
  reviewer: { minContextWindowTokens: 32_768 },
  "counter-checker": { minContextWindowTokens: 16_384 },
};

/** What the service reads about a gateway model; production reads the live gateway catalog. */
export interface ReviewModelPort {
  capability(modelId: string): ModelCapability | undefined;
  /** The gateway configuration generation the run is admitted under, when known. */
  generation?(): number | undefined;
  /**
   * The operator and user policy in front of eligibility (Issue #4137): `false` refuses the pair
   * as `policy-invalid`; the policy records its own closed reason under `correlationId`.
   */
  admit?(models: ReviewRoleModels, correlationId: string | undefined): boolean;
  /**
   * Verifies a model again whose conversation readiness lapsed, as a conversation request does
   * (#4138): a review started more than the readiness lifetime after the model last answered must
   * not be refused for a stale observation. Resolves when the check settled, whatever its result.
   */
  ensureReady?(modelId: string, correlationId: string | undefined): Promise<void>;
  /**
   * Whether a person activated the model in Settings > Models in this server process (ADR-0171 D2,
   * amended 2026-11-16; R4130-079). Keiko sends a chat model no request until then, so a review
   * refuses a role model that is not activated before it reads, probes or calls anything.
   */
  activated?(modelId: string): boolean;
}

/** The role models a person has not activated, in role order (R4130-079). */
export function inactiveReviewRoleModels(
  port: ReviewModelPort,
  models: ReviewRoleModels,
): readonly ReviewModelRole[] {
  if (port.activated === undefined) return [];
  const roles: ReviewModelRole[] = [];
  if (!port.activated(models.reviewerModelId)) roles.push("reviewer");
  if (!port.activated(models.counterCheckerModelId)) roles.push("counter-checker");
  return roles;
}

/** Re-verifies each distinct role model before the run is admitted (#4138). */
export async function ensureReviewRoleModelsReady(
  port: ReviewModelPort,
  models: ReviewRoleModels,
  correlationId: string | undefined,
): Promise<void> {
  if (port.ensureReady === undefined) return;
  for (const modelId of new Set([models.reviewerModelId, models.counterCheckerModelId])) {
    await port.ensureReady(modelId, correlationId); // NOSONAR typescript:S9382 -- a readiness check can be a model call: the two role models are verified one after the other, never at once on a single-slot provider
  }
}

export interface ReviewRoleModels {
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
}

/** Eligibility of both role models against the gateway's capability data. */
export type ReviewModelEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "policy-invalid" | "model-unavailable" };

/** A dry run's validation: eligibility, or a role model nobody activated (R4130-079). */
export type ReviewModelValidation =
  ReviewModelEligibility | { readonly ok: false; readonly reason: "model-not-activated" };

/**
 * The operator and user policy alone (R4130-003): a run checks it before anything reads, probes or
 * calls a role model, so a model the policy refuses never receives traffic for that run.
 */
export function admitReviewRoleModels(
  port: ReviewModelPort,
  models: ReviewRoleModels,
  correlationId?: string,
): boolean {
  return port.admit?.(models, correlationId) !== false;
}

/** Eligibility of both admitted role models; an ineligible model wins over an unavailable one. */
export function evaluateReviewRoleModels(
  port: ReviewModelPort,
  models: ReviewRoleModels,
  nowMs: number,
): ReviewModelEligibility {
  const verdicts = [
    evaluateReviewRoleEligibility(
      port.capability(models.reviewerModelId),
      REVIEW_ROLE_BUDGETS.reviewer,
      { nowMs },
    ),
    evaluateReviewRoleEligibility(
      port.capability(models.counterCheckerModelId),
      REVIEW_ROLE_BUDGETS["counter-checker"],
      { nowMs },
    ),
  ];
  if (verdicts.some((verdict) => verdict.status === "ineligible")) {
    return { ok: false, reason: "policy-invalid" };
  }
  if (verdicts.some((verdict) => verdict.status === "temporarily-unavailable")) {
    return { ok: false, reason: "model-unavailable" };
  }
  return { ok: true };
}

/**
 * Admission, then readiness, then eligibility of both role models: the dry run's check, in the
 * order a run start uses (`checkRoleModels`). The readiness check renews what has lapsed, so a dry
 * run and the start it stands for judge the same proof (R4130-058). A pair the policy refuses is
 * never checked for readiness, so its models receive no traffic (R4130-003).
 */
export async function validateReviewRoleModels(
  port: ReviewModelPort,
  models: ReviewRoleModels,
  now: () => number,
  correlationId?: string,
): Promise<ReviewModelValidation> {
  if (!admitReviewRoleModels(port, models, correlationId)) {
    return { ok: false, reason: "policy-invalid" };
  }
  if (inactiveReviewRoleModels(port, models).length > 0) {
    return { ok: false, reason: "model-not-activated" };
  }
  await ensureReviewRoleModelsReady(port, models, correlationId);
  return evaluateReviewRoleModels(port, models, now());
}
