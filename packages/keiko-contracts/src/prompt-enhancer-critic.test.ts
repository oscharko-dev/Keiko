import { describe, expect, it } from "vitest";
import {
  isPromptCandidateRejectionReason,
  isPromptCriticDimension,
  PROMPT_CANDIDATE_REJECTION_REASONS,
  PROMPT_CRITIC_DIMENSIONS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  validatePromptCandidateScorecard,
  validatePromptCandidateSelection,
  type PromptCandidateScorecard,
  type PromptCandidateSelection,
} from "./index.js";

function validScorecard(candidateId = "req-1-technical"): PromptCandidateScorecard {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    candidateId,
    profile: "technical",
    dimensionScores: PROMPT_CRITIC_DIMENSIONS.map((dimension) => ({
      dimension,
      score: 0.8,
      rationale: `score for ${dimension}`,
    })),
    aggregateScore: 0.8,
    estimatedTokens: 120,
  };
}

function validSelection(): PromptCandidateSelection {
  const winner = validScorecard();
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    winner,
    ranked: [winner],
    rejected: [
      {
        candidateId: "req-1-fast",
        profile: "fast",
        aggregateScore: 0.5,
        reason: "lower-aggregate-score",
      },
      {
        candidateId: "req-1-research",
        profile: "research",
        aggregateScore: null,
        reason: "exceeded-token-budget",
      },
    ],
    bounds: { candidateCount: 3, tokenBudget: 8_000, maxIterations: 3 },
    iterations: 1,
    candidatesConsidered: 1,
    tokensConsumed: 120,
  };
}

describe("prompt-enhancer-critic constants and guards", () => {
  it("exposes the six critic dimensions in canonical order", () => {
    expect(PROMPT_CRITIC_DIMENSIONS).toEqual([
      "clarity",
      "completeness",
      "grounding-readiness",
      "safety",
      "output-controllability",
      "token-efficiency",
    ]);
  });

  it("recognises only valid dimension and rejection-reason members", () => {
    expect(isPromptCriticDimension("clarity")).toBe(true);
    expect(isPromptCriticDimension("nope")).toBe(false);
    for (const reason of PROMPT_CANDIDATE_REJECTION_REASONS) {
      expect(isPromptCandidateRejectionReason(reason)).toBe(true);
    }
    expect(isPromptCandidateRejectionReason("unknown")).toBe(false);
  });
});

describe("validatePromptCandidateScorecard", () => {
  it("accepts a well-formed scorecard", () => {
    expect(validatePromptCandidateScorecard(validScorecard()).ok).toBe(true);
  });

  it("rejects non-objects and unknown fields", () => {
    expect(validatePromptCandidateScorecard(null).ok).toBe(false);
    expect(validatePromptCandidateScorecard({ ...validScorecard(), extra: 1 }).ok).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    expect(validatePromptCandidateScorecard({ ...validScorecard(), schemaVersion: "9" }).ok).toBe(
      false,
    );
  });

  it("rejects an out-of-range score", () => {
    const card = validScorecard();
    const broken = {
      ...card,
      dimensionScores: card.dimensionScores.map((entry, index) =>
        index === 0 ? { ...entry, score: 1.5 } : entry,
      ),
    };
    expect(validatePromptCandidateScorecard(broken).ok).toBe(false);
  });

  it("rejects a missing or reordered dimension", () => {
    const card = validScorecard();
    expect(
      validatePromptCandidateScorecard({ ...card, dimensionScores: card.dimensionScores.slice(1) })
        .ok,
    ).toBe(false);
    const reordered = [...card.dimensionScores].reverse();
    expect(validatePromptCandidateScorecard({ ...card, dimensionScores: reordered }).ok).toBe(
      false,
    );
  });

  it("rejects an unknown profile and a non-integer token estimate", () => {
    expect(validatePromptCandidateScorecard({ ...validScorecard(), profile: "nope" }).ok).toBe(
      false,
    );
    expect(validatePromptCandidateScorecard({ ...validScorecard(), estimatedTokens: 1.5 }).ok).toBe(
      false,
    );
  });
});

describe("validatePromptCandidateSelection", () => {
  it("accepts a well-formed selection", () => {
    expect(validatePromptCandidateSelection(validSelection()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validatePromptCandidateSelection(42).ok).toBe(false);
  });

  it("rejects when the winner is not the first ranked candidate", () => {
    const selection = validSelection();
    const other = validScorecard("req-1-precise");
    expect(validatePromptCandidateSelection({ ...selection, ranked: [other] }).ok).toBe(false);
  });

  it("rejects an empty ranked list", () => {
    expect(validatePromptCandidateSelection({ ...validSelection(), ranked: [] }).ok).toBe(false);
  });

  it("rejects malformed bounds and negative totals", () => {
    const selection = validSelection();
    expect(
      validatePromptCandidateSelection({
        ...selection,
        bounds: { candidateCount: 3, tokenBudget: 8_000 },
      }).ok,
    ).toBe(false);
    expect(validatePromptCandidateSelection({ ...selection, iterations: -1 }).ok).toBe(false);
  });

  it("rejects a rejection entry with an unknown reason", () => {
    const selection = validSelection();
    const badRejected = [
      { candidateId: "x", profile: "fast", aggregateScore: null, reason: "bogus" },
    ];
    expect(validatePromptCandidateSelection({ ...selection, rejected: badRejected }).ok).toBe(
      false,
    );
  });
});
