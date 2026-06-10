// Tests for weighted scoring composition (Issue #182). Verifies defaults, clamping at the
// [0,1] boundary, and override semantics. No randomness, no clock.

import { describe, expect, it } from "vitest";

import type { CandidateSignal } from "@oscharko-dev/keiko-contracts/connected-context";

import { DEFAULT_SCORING_WEIGHTS, computeScore, type ScoringWeights } from "./scoring.js";
import type { ExtractedSignals } from "./signals.js";

function build(values: Partial<Record<string, number>>): ExtractedSignals {
  const signals: CandidateSignal[] = [
    { name: "provenance-best-score", value: values["provenance-best-score"] ?? 0 },
    { name: "provenance-count", value: values["provenance-count"] ?? 0 },
    { name: "anchor-overlap", value: values["anchor-overlap"] ?? 0 },
    { name: "path-depth-affinity", value: values["path-depth-affinity"] ?? 0 },
    { name: "test-pair-bonus", value: values["test-pair-bonus"] ?? 0 },
    {
      name: "stacktrace-position-bonus",
      value: values["stacktrace-position-bonus"] ?? 0,
    },
    { name: "generated-penalty", value: values["generated-penalty"] ?? 0 },
  ];
  return { scopePath: "src/foo.ts", signals, baseScore: 0, generatedHint: false };
}

describe("DEFAULT_SCORING_WEIGHTS", () => {
  it("sums to 1.25 (positives + penalty weight)", () => {
    const sum =
      DEFAULT_SCORING_WEIGHTS.provenanceBestScore +
      DEFAULT_SCORING_WEIGHTS.provenanceCount +
      DEFAULT_SCORING_WEIGHTS.anchorOverlap +
      DEFAULT_SCORING_WEIGHTS.pathDepthAffinity +
      DEFAULT_SCORING_WEIGHTS.testPairBonus +
      DEFAULT_SCORING_WEIGHTS.stacktracePositionBonus +
      DEFAULT_SCORING_WEIGHTS.generatedPenalty;
    expect(Math.abs(sum - 1.25) < 1e-9).toBe(true);
  });
});

describe("computeScore", () => {
  it("returns 0 when every signal is zero", () => {
    expect(computeScore(build({}))).toBe(0);
  });

  it("returns the positive-weight sum when every positive signal is one with no penalty", () => {
    const signals = build({
      "provenance-best-score": 1,
      "provenance-count": 1,
      "anchor-overlap": 1,
      "path-depth-affinity": 1,
      "test-pair-bonus": 1,
      "stacktrace-position-bonus": 1,
    });
    const score = computeScore(signals);
    expect(score > 0.9).toBe(true);
    expect(score <= 1).toBe(true);
  });

  it("clamps the raw score into [0, 1] when custom weights overshoot", () => {
    const overweight: ScoringWeights = {
      provenanceBestScore: 2,
      provenanceCount: 0,
      anchorOverlap: 0,
      pathDepthAffinity: 0,
      testPairBonus: 0,
      stacktracePositionBonus: 0,
      generatedPenalty: 0,
    };
    expect(computeScore(build({ "provenance-best-score": 1 }), overweight)).toBe(1);
  });

  it("returns 0 (clamped) when only the penalty fires", () => {
    expect(computeScore(build({ "generated-penalty": -1 }))).toBe(0);
  });

  it("custom weights override defaults", () => {
    const custom: ScoringWeights = {
      provenanceBestScore: 1,
      provenanceCount: 0,
      anchorOverlap: 0,
      pathDepthAffinity: 0,
      testPairBonus: 0,
      stacktracePositionBonus: 0,
      generatedPenalty: 0,
    };
    expect(computeScore(build({ "provenance-best-score": 0.5 }), custom)).toBe(0.5);
  });

  it("is deterministic across repeat calls", () => {
    const signals = build({
      "provenance-best-score": 0.7,
      "anchor-overlap": 0.4,
    });
    expect(computeScore(signals)).toBe(computeScore(signals));
  });

  it("penalty subtracts when generated-penalty is -1 with positives present", () => {
    const noPenalty = build({ "provenance-best-score": 1 });
    const withPenalty = build({
      "provenance-best-score": 1,
      "generated-penalty": -1,
    });
    expect(computeScore(noPenalty)).toBeGreaterThan(computeScore(withPenalty));
  });
});
