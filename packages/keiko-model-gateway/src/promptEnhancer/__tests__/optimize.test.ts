import { describe, expect, it } from "vitest";
import {
  validatePromptCandidateSelection,
  type PromptOptimizationBounds,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOKEN_BUDGET,
  optimizePromptCandidates,
} from "../optimize.js";
import { makeAnalysis, type AnalysisOverrides } from "./_support.js";

const INPUT: RawPromptInput = { text: "Draft a concise migration plan for the billing service." };

function optimizeFor(
  overrides: AnalysisOverrides,
  bounds?: Partial<PromptOptimizationBounds>,
): ReturnType<typeof optimizePromptCandidates> {
  return optimizePromptCandidates({
    analysis: makeAnalysis(overrides),
    input: INPUT,
    bounds,
  });
}

function isSortedDescending(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? 0) >= value);
}

describe("optimizePromptCandidates", () => {
  it("generates, scores, and ranks at least three candidates and selects a stable winner (AC1)", () => {
    const selection = optimizeFor({ recommendedProfile: "technical" }, { candidateCount: 3 });
    expect(selection.ranked.length).toBe(3);
    expect(selection.candidatesConsidered).toBe(3);
    expect(selection.winner).toEqual(selection.ranked[0]);
    const aggregates = selection.ranked.map((card) => card.aggregateScore);
    expect(isSortedDescending(aggregates)).toBe(true);
    expect(selection.winner.aggregateScore).toBe(Math.max(...aggregates));
  });

  it("is deterministic for identical inputs", () => {
    const a = optimizeFor({ recommendedProfile: "precise" }, { candidateCount: 4 });
    const b = optimizeFor({ recommendedProfile: "precise" }, { candidateCount: 4 });
    expect(a).toEqual(b);
  });

  it("produces a contract-valid selection result", () => {
    const selection = optimizeFor({ recommendedProfile: "research" }, { candidateCount: 5 });
    expect(validatePromptCandidateSelection(selection).ok).toBe(true);
  });

  it("makes every rejected alternative auditable with a reason and score (AC3)", () => {
    const selection = optimizeFor({ recommendedProfile: "technical" }, { candidateCount: 3 });
    const losers = selection.rejected.filter((entry) => entry.reason === "lower-aggregate-score");
    expect(losers.length).toBe(2);
    for (const loser of losers) {
      expect(typeof loser.aggregateScore).toBe("number");
      expect(loser.aggregateScore ?? -1).toBeLessThanOrEqual(selection.winner.aggregateScore);
    }
  });

  it("echoes the resolved bounds and defaults when none are supplied (AC4)", () => {
    const selection = optimizeFor({ recommendedProfile: "precise" });
    expect(selection.bounds).toEqual({
      candidateCount: DEFAULT_CANDIDATE_COUNT,
      maxIterations: DEFAULT_MAX_ITERATIONS,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
    });
  });

  it("bounds exploration by maxIterations (AC4)", () => {
    const selection = optimizeFor(
      { recommendedProfile: "technical" },
      {
        candidateCount: 5,
        maxIterations: 1,
      },
    );
    expect(selection.iterations).toBe(1);
    expect(selection.candidatesConsidered).toBe(1);
    expect(selection.ranked.length).toBe(1);
  });

  it("bounds scoring by the token budget while always evaluating the baseline (AC4)", () => {
    const selection = optimizeFor(
      { recommendedProfile: "technical" },
      {
        candidateCount: 3,
        maxIterations: 3,
        tokenBudget: 1,
      },
    );
    expect(selection.candidatesConsidered).toBe(1);
    expect(selection.tokensConsumed).toBeLessThanOrEqual(1);
    const skipped = selection.rejected.filter((entry) => entry.reason === "exceeded-token-budget");
    expect(skipped.length).toBe(2);
    for (const entry of skipped) {
      expect(entry.aggregateScore).toBeNull();
    }
  });

  it("clamps candidateCount to the slate size and out-of-range bounds to safe values", () => {
    const selection = optimizeFor(
      { recommendedProfile: "technical" },
      {
        candidateCount: 999,
        maxIterations: 0,
        tokenBudget: -5,
      },
    );
    expect(selection.bounds.candidateCount).toBe(7);
    expect(selection.bounds.maxIterations).toBe(1);
    expect(selection.bounds.tokenBudget).toBe(1);
  });

  it("surfaces safety-floor rejections from candidate generation as auditable alternatives (AC3/AC5)", () => {
    const selection = optimizeFor({ recommendedProfile: "agentic" }, { candidateCount: 7 });
    expect(selection.winner.profile).toBe("agentic");
    expect(selection.candidatesConsidered).toBe(1);
    const safetyFloor = selection.rejected.filter(
      (entry) => entry.reason === "safety-floor-not-preserved",
    );
    expect(safetyFloor.length).toBeGreaterThan(0);
    for (const entry of safetyFloor) {
      expect(entry.aggregateScore).toBeNull();
    }
  });

  it("never exceeds the configured token budget in tokensConsumed", () => {
    const selection = optimizeFor(
      { recommendedProfile: "research" },
      {
        candidateCount: 6,
        tokenBudget: 1_200,
      },
    );
    expect(selection.tokensConsumed).toBeLessThanOrEqual(1_200);
  });
});
