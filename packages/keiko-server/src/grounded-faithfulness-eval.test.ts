import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GROUNDED_FAITHFULNESS_BUDGET,
  evaluateGroundedFaithfulnessBudget,
  isGroundedEmptyEvidenceAbstention,
  runGroundedFaithfulnessEval,
} from "./grounded-faithfulness-eval.js";
import { LEGACY_CONNECTED_SEARCH_ABSTENTION } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
import { buildEvalContextPack, evalUncertainty } from "./grounded-eval-support.js";

describe("grounded faithfulness eval (RB-4, GEN-AI-EVAL-003)", () => {
  it("scores real answer-kind and citation-warning production rules", () => {
    const scorecard = runGroundedFaithfulnessEval();
    expect(scorecard.answerKindAccuracy).toBe(1);
    expect(scorecard.missingCitationAccuracy).toBe(1);
  });

  it("fails the real floor for the treat-clarification-as-answer negative control", () => {
    const scorecard = runGroundedFaithfulnessEval("treat-clarification-as-answer");
    expect(scorecard.answerKindAccuracy).toBeLessThan(1);
    expect(scorecard.missingCitationAccuracy).toBeLessThan(1);
    expect(evaluateGroundedFaithfulnessBudget(scorecard)).toMatchObject({ ok: false });
  });
  it("detects every fabricated citation, abstains on every empty-evidence answer, no false positives", () => {
    const scorecard = runGroundedFaithfulnessEval();
    const result = evaluateGroundedFaithfulnessBudget(scorecard);
    expect(result.ok, `failures: ${result.failures.join(", ")}`).toBe(true);
    expect(scorecard.unsupportedDetectionRate).toBe(1);
    expect(scorecard.citationPrecision).toBe(1);
    expect(scorecard.abstentionOnEmptyRate).toBe(1);
  });

  it("scores current English and German abstentions produced by the shared builder", async () => {
    vi.resetModules();
    const owner = await import("@oscharko-dev/keiko-contracts/runtime/no-evidence-answer");
    const builder = vi.spyOn(owner, "connectedSearchNoEvidenceAnswer");
    try {
      const { runGroundedFaithfulnessEval: run } = await import("./grounded-faithfulness-eval.js");
      expect(run().abstentionOnEmptyRate).toBe(1);
      expect(builder).toHaveBeenCalledWith("What evidence exists?");
      expect(builder).toHaveBeenCalledWith("Welche Belege gibt es?");
    } finally {
      builder.mockRestore();
    }
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
    expect(
      isGroundedEmptyEvidenceAbstention(
        emptyPack,
        "No matching evidence was found for this search.",
      ),
    ).toBe(true);
    expect(
      isGroundedEmptyEvidenceAbstention(
        emptyPack,
        "Keine passenden Belege für diese Suche gefunden.",
      ),
    ).toBe(true);
    expect(runGroundedFaithfulnessEval().failures).toEqual([]);
  });

  it("recognizes legacy stored abstentions separately from current eval producers", () => {
    const emptyPack = buildEvalContextPack([], [evalUncertainty("no-evidence")]);
    expect(isGroundedEmptyEvidenceAbstention(emptyPack, LEGACY_CONNECTED_SEARCH_ABSTENTION)).toBe(
      true,
    );
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
