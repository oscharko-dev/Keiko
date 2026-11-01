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
}

/** Re-verifies each distinct role model before the run is admitted (#4138). */
export async function ensureReviewRoleModelsReady(
  port: ReviewModelPort,
  models: ReviewRoleModels,
  correlationId: string | undefined,
): Promise<void> {
  if (port.ensureReady === undefined) return;
  for (const modelId of new Set([models.reviewerModelId, models.counterCheckerModelId])) {
    await port.ensureReady(modelId, correlationId);
  }
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
  correlationId?: string,
): ReviewModelValidation {
  if (port.admit?.(models, correlationId) === false) return { ok: false, reason: "policy-invalid" };
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
