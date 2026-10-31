// Role model validation of one review run (ADR-0182 D8, Issue #4136). Each role's model is checked
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
const REVIEW_ROLE_BUDGETS: Readonly<Record<ReviewModelRole, ReviewRoleBudget>> = {
  reviewer: { minContextWindowTokens: 32_768 },
  "counter-checker": { minContextWindowTokens: 16_384 },
};

/** What the service reads about a gateway model; production reads the live gateway catalog. */
export interface ReviewModelPort {
  capability(modelId: string): ModelCapability | undefined;
  /** The gateway configuration generation the run is admitted under, when known. */
  generation?(): number | undefined;
}

export interface ReviewRoleModels {
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
}

export type ReviewModelValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "policy-invalid" | "model-unavailable" };

/** Validates both role models; an ineligible model wins over a temporarily unavailable one. */
export function validateReviewRoleModels(
  port: ReviewModelPort,
  models: ReviewRoleModels,
  nowMs: number,
): ReviewModelValidation {
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
