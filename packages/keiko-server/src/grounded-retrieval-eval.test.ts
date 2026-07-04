import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUNDED_RETRIEVAL_BUDGET,
  GROUNDED_RETRIEVAL_REGRESSION_MODES,
  evaluateGroundedRetrievalBudget,
  runGroundedRetrievalQualityEval,
} from "./grounded-retrieval-eval.js";

describe("grounded retrieval eval (RB-5, GEN-AI-RELEASE-GATE-001)", () => {
  it("the production semantic + RRF + model-reranker path clears the non-tautological floors", async () => {
    const scorecard = await runGroundedRetrievalQualityEval("baseline");
    const result = evaluateGroundedRetrievalBudget(scorecard);
    expect(result.ok, `failures: ${result.failures.join(", ")}`).toBe(true);
    // Floors are strictly below a perfect score, so a real ranking regression can drop under them.
    expect(DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minTop1Rate).toBeLessThan(1);
    expect(scorecard.top1Rate).toBeGreaterThanOrEqual(
      DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minTop1Rate,
    );
    expect(scorecard.recallAtK).toBeGreaterThanOrEqual(
      DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minRecallAtK,
    );
  });

  it("proves the semantic path is exercised: a paraphrased query with no lexical overlap still ranks the right file", async () => {
    // If retrieval were lexical-only, queries whose words differ from the target file would fail.
    // The baseline clears an 0.8 top-1 floor over exactly such paraphrased queries.
    const scorecard = await runGroundedRetrievalQualityEval("baseline");
    expect(scorecard.top1Rate).toBeGreaterThanOrEqual(0.8);
  });

  it("with the model reranker unavailable, the semantic + RRF fallback still ranks correctly (positive control)", async () => {
    // Contrast with `embedding-flat` below: same no-reranker condition, but a WORKING embedding.
    // This isolates the semantic retrieval ranking as the thing carrying the result.
    const scorecard = await runGroundedRetrievalQualityEval("reranker-off");
    expect(evaluateGroundedRetrievalBudget(scorecard).ok).toBe(true);
  });

  it("FAILS closed when the model reranker regresses (reversed order)", async () => {
    const scorecard = await runGroundedRetrievalQualityEval("reranker-reversed");
    const result = evaluateGroundedRetrievalBudget(scorecard);
    expect(result.ok).toBe(false);
    expect(scorecard.top1Rate).toBeLessThan(DEFAULT_GROUNDED_RETRIEVAL_BUDGET.minTop1Rate);
  });

  it("FAILS closed when the embedding ranking regresses (flat vectors)", async () => {
    const scorecard = await runGroundedRetrievalQualityEval("embedding-flat");
    const result = evaluateGroundedRetrievalBudget(scorecard);
    expect(result.ok).toBe(false);
  });

  it("every injected regression mode drops the gate below its floors", async () => {
    for (const mode of GROUNDED_RETRIEVAL_REGRESSION_MODES) {
      const scorecard = await runGroundedRetrievalQualityEval(mode);
      expect(evaluateGroundedRetrievalBudget(scorecard).ok, `mode ${mode} should fail`).toBe(false);
    }
  });
});
