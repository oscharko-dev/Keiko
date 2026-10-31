// The Reviewer's diff budget fits the 64 KiB first-prompt bound (Issue #4136): a package within the
// budget, as the gateway estimator counts it, can never push the task past the bound.

import { describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { REVIEW_RULES_FILE_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { REVIEW_TASK_MAX_BYTES, renderReviewTask } from "../runtime/reviewPrompt.js";
import {
  estimateReviewRun,
  REVIEW_ESTIMATOR_MAX_BYTES_PER_TOKEN,
  reviewDiffBudgetTokens,
} from "./budget.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

/** The longest repetition of `unit` the estimator still counts within `tokens` (binary search). */
function fillTo(tokens: number, unit: string): string {
  let low = 0;
  let high = tokens * 8;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countContextTokens(unit.repeat(middle)) <= tokens) low = middle;
    else high = middle - 1;
  }
  return unit.repeat(low);
}

describe("reviewDiffBudgetTokens", () => {
  it("states the estimator's byte ceiling the budget relies on", () => {
    for (const sample of ["x".repeat(7000), "const a = 1;\n".repeat(400), "ä€😀".repeat(300)]) {
      const tokens = countContextTokens(sample);
      expect(Buffer.byteLength(sample, "utf8")).toBeLessThanOrEqual(
        REVIEW_ESTIMATOR_MAX_BYTES_PER_TOKEN * (tokens - 2),
      );
    }
  });

  it("fits the largest package of the budget beside the largest rules file", () => {
    const budget = reviewDiffBudgetTokens(BASE, HEAD);
    expect(budget).toBeGreaterThan(10_000);
    for (const unit of ["+ plain ascii code line\n", "x", "ü"]) {
      const diff = fillTo(budget, unit);
      const task = renderReviewTask({
        baseSha: BASE,
        headSha: HEAD,
        rules: { outcome: "loaded", text: "r".repeat(REVIEW_RULES_FILE_MAX_BYTES) },
        diffPackageText: diff,
      });
      expect(task.ok).toBe(true);
      if (task.ok) expect(task.byteCount).toBeLessThanOrEqual(REVIEW_TASK_MAX_BYTES);
    }
  });

  it("estimates from changed lines, bounded by the package budget", () => {
    const small = estimateReviewRun(10, 15_000, null);
    const huge = estimateReviewRun(1_000_000, 15_000, 90_000);
    expect(small.estimatedInputTokens.reviewer).toBeLessThan(huge.estimatedInputTokens.reviewer);
    expect(huge.estimatedInputTokens.reviewer).toBeLessThan(15_000 + 5_000);
    expect(small.estimatedDurationMs).toBeNull();
    expect(huge.estimatedDurationMs).toBe(90_000);
    expect(small.estimatedInputTokens.counterChecker).toBeGreaterThan(0);
  });
});
