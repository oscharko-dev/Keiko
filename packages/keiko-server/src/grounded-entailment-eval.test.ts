import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUNDED_ENTAILMENT_BUDGET,
  evaluateGroundedEntailmentBudget,
  runGroundedEntailmentEval,
} from "./grounded-entailment-eval.js";

describe("runGroundedEntailmentEval", () => {
  it("scores the real reconciliation at the floor and proves non-tautology", async () => {
    const scorecard = await runGroundedEntailmentEval();
    expect(scorecard.fixtures).toBeGreaterThan(0);
    expect(scorecard.unsupportedClaimDetectionRate).toBe(1);
    expect(scorecard.claimPrecision).toBe(1);
    expect(scorecard.degradationCorrectnessRate).toBe(1);
    expect(scorecard.nonTautologyProven).toBe(true);
    expect(scorecard.failures).toEqual([]);
  });

  it("keeps both path and numeric citation branch fixtures in the deterministic gate", async () => {
    // The outer gate already asserts 1.0 across variants; the exact count prevents a future
    // refactor from silently dropping numeric membership, duplicate, malformed, or judge cases.
    const scorecard = await runGroundedEntailmentEval();
    // 9 existing path fixtures + 6 numeric connector fixtures = 15.
    expect(scorecard.fixtures).toBe(15);
    expect(scorecard.unsupportedClaimDetectionRate).toBe(1);
    expect(scorecard.degradationCorrectnessRate).toBe(1);
    expect(scorecard.failures).toEqual([]);
  });

  it("passes the default budget on the real scorecard", async () => {
    const scorecard = await runGroundedEntailmentEval();
    expect(evaluateGroundedEntailmentBudget(scorecard).ok).toBe(true);
  });
});

describe("DEFAULT_GROUNDED_ENTAILMENT_BUDGET", () => {
  it("floors every rate at 1.0 and requires the non-tautology proof", () => {
    expect(DEFAULT_GROUNDED_ENTAILMENT_BUDGET.minUnsupportedClaimDetectionRate).toBe(1);
    expect(DEFAULT_GROUNDED_ENTAILMENT_BUDGET.minClaimPrecision).toBe(1);
    expect(DEFAULT_GROUNDED_ENTAILMENT_BUDGET.minDegradationCorrectnessRate).toBe(1);
    expect(DEFAULT_GROUNDED_ENTAILMENT_BUDGET.requireNonTautology).toBe(true);
  });
});

describe("evaluateGroundedEntailmentBudget (non-tautology / regression)", () => {
  it("fails when the entailment checker is disabled (detection drops below the floor)", async () => {
    // Simulate a checker-disabled regression: a pass-through checker would miss unsupported claims,
    // so the detection rate falls below 1. The gate MUST fail with the named floor.
    const scorecard = await runGroundedEntailmentEval();
    const regressed = { ...scorecard, unsupportedClaimDetectionRate: 0 };
    const result = evaluateGroundedEntailmentBudget(regressed);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("unsupportedClaimDetectionRate");
  });

  it("fails when a supported claim is falsely flagged (precision regression)", async () => {
    const scorecard = await runGroundedEntailmentEval();
    const regressed = { ...scorecard, claimPrecision: 0.5 };
    expect(evaluateGroundedEntailmentBudget(regressed).ok).toBe(false);
  });

  it("fails when the non-tautology proof is lost", async () => {
    const scorecard = await runGroundedEntailmentEval();
    const regressed = { ...scorecard, nonTautologyProven: false };
    const result = evaluateGroundedEntailmentBudget(regressed);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("nonTautologyProven");
  });

  it("fails closed when the degradation path silently reports supported", async () => {
    const scorecard = await runGroundedEntailmentEval();
    const regressed = { ...scorecard, degradationCorrectnessRate: 0 };
    expect(evaluateGroundedEntailmentBudget(regressed).ok).toBe(false);
  });
});
