// Quality Intelligence test-quality rubric domain helpers (Epic #736, Issue #746).
//
// Pure functions — no IO, no model calls. Compute aggregate scores and verdict
// classifications from per-dimension rubric scores.

import type { TestQualityRubricDimension } from "@oscharko-dev/keiko-contracts";

/** Threshold below which an overall score is classified as "weak". */
export const TEST_QUALITY_WEAK_THRESHOLD = 60;

/**
 * Compute the mean score across all dimensions. Returns 0 when `dimensions` is empty.
 * Deterministic: iteration order of `dimensions` does not affect the result.
 */
export function scoreFromDimensions(dimensions: readonly TestQualityRubricDimension[]): number {
  if (dimensions.length === 0) return 0;
  let total = 0;
  for (const d of dimensions) {
    total += d.score;
  }
  return total / dimensions.length;
}

/**
 * Classify an overall score as "weak" or "strong".
 * Scores strictly below `TEST_QUALITY_WEAK_THRESHOLD` (60) are "weak"; 60 and above are "strong".
 */
export function verdictFromScore(score: number): "weak" | "strong" {
  return score < TEST_QUALITY_WEAK_THRESHOLD ? "weak" : "strong";
}

/**
 * Classify a full rubric verdict. A candidate is only strong when the aggregate score and every
 * mandatory rubric dimension meet the threshold; one weak dimension is enough to keep the finding
 * visible instead of hiding it behind a passing average.
 */
export function verdictFromDimensions(
  dimensions: readonly TestQualityRubricDimension[],
): "weak" | "strong" {
  if (verdictFromScore(scoreFromDimensions(dimensions)) === "weak") return "weak";
  return dimensions.every((dimension) => dimension.score >= TEST_QUALITY_WEAK_THRESHOLD)
    ? "strong"
    : "weak";
}
