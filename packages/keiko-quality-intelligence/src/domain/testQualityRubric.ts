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
