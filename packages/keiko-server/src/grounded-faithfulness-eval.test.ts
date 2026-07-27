import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUNDED_FAITHFULNESS_BUDGET,
  evaluateGroundedFaithfulnessBudget,
  isGroundedEmptyEvidenceAbstention,
  runGroundedFaithfulnessEval,
} from "./grounded-faithfulness-eval.js";
import { GROUNDED_NO_EVIDENCE_ANSWER } from "./grounded-faithfulness.js";
import { buildEvalContextPack, evalUncertainty } from "./grounded-eval-support.js";

describe("grounded faithfulness eval (RB-4, GEN-AI-EVAL-003)", () => {
  it("detects every fabricated citation, abstains on every empty-evidence answer, no false positives", () => {
    const scorecard = runGroundedFaithfulnessEval();
    const result = evaluateGroundedFaithfulnessBudget(scorecard);
    expect(result.ok, `failures: ${result.failures.join(", ")}`).toBe(true);
    expect(scorecard.unsupportedDetectionRate).toBe(1);
    expect(scorecard.citationPrecision).toBe(1);
    expect(scorecard.abstentionOnEmptyRate).toBe(1);
  });

  it("floors are the faithfulness correctness invariants (all = 1)", () => {
    expect(DEFAULT_GROUNDED_FAITHFULNESS_BUDGET.minUnsupportedDetectionRate).toBe(1);
    expect(DEFAULT_GROUNDED_FAITHFULNESS_BUDGET.minAbstentionOnEmptyRate).toBe(1);
  });

  it("the gate FAILS if reconciliation regresses to not flag an out-of-pack citation", () => {
    // Simulate a regression: a scorecard where a fabricated citation slipped through.
    const regressed = { ...runGroundedFaithfulnessEval(), unsupportedDetectionRate: 0.5 };
    expect(evaluateGroundedFaithfulnessBudget(regressed).ok).toBe(false);
  });

  it("the gate FAILS if abstention regresses on empty evidence", () => {
    const regressed = { ...runGroundedFaithfulnessEval(), abstentionOnEmptyRate: 0 };
    expect(evaluateGroundedFaithfulnessBudget(regressed).ok).toBe(false);
  });

  it("detects a confident answer over empty evidence instead of scoring the empty pack alone", () => {
    const emptyPack = buildEvalContextPack([], [evalUncertainty("no-evidence")]);
    expect(
      isGroundedEmptyEvidenceAbstention(
        emptyPack,
        "The system definitely rotates credentials every 24 hours.",
      ),
    ).toBe(false);
    expect(isGroundedEmptyEvidenceAbstention(emptyPack, GROUNDED_NO_EVIDENCE_ANSWER)).toBe(true);
    expect(runGroundedFaithfulnessEval().failures).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails the owning budget evaluator closed for a non-finite score (%s)",
    (value) => {
      const scorecard = {
        ...runGroundedFaithfulnessEval(),
        abstentionOnEmptyRate: value,
      };
      expect(evaluateGroundedFaithfulnessBudget(scorecard)).toMatchObject({
        ok: false,
        failures: ["abstentionOnEmptyRate"],
      });
    },
  );
});
