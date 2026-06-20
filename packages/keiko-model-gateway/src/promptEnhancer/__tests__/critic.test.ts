import { describe, expect, it } from "vitest";
import {
  asEnhancedPromptId,
  PROMPT_CRITIC_DIMENSIONS,
  validatePromptCandidateScorecard,
  type PromptCriticDimension,
  type PromptEnhancementProfileId,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import { planPromptEnhancement } from "../planner.js";
import { generateEnhancedPrompt } from "../generator.js";
import {
  estimatePromptTokens,
  PROMPT_CRITIC_DIMENSION_WEIGHTS,
  scorePromptCandidate,
  type PromptCandidateScoringContext,
} from "../critic.js";
import { makeAnalysis, type AnalysisOverrides } from "./_support.js";

const INPUT: RawPromptInput = { text: "Summarize the quarterly results for the leadership team." };

function contextFor(
  overrides: AnalysisOverrides,
  profilePreference?: PromptEnhancementProfileId,
  input: RawPromptInput = INPUT,
): PromptCandidateScoringContext {
  const analysis = makeAnalysis(overrides);
  const plan = planPromptEnhancement(
    analysis,
    profilePreference === undefined ? {} : { profilePreference },
  );
  const id = `cand-${plan.selectedProfile}`;
  const prompt = generateEnhancedPrompt({
    promptId: asEnhancedPromptId(id),
    analysis,
    plan,
    input,
  });
  return { candidateId: id, profile: plan.selectedProfile, prompt, plan, analysis };
}

function scoreOf(context: PromptCandidateScoringContext, dimension: PromptCriticDimension): number {
  const card = scorePromptCandidate(context);
  return card.dimensionScores.find((d) => d.dimension === dimension)?.score ?? -1;
}

describe("scorePromptCandidate", () => {
  it("emits exactly one score per dimension in canonical order, each in [0, 1] with a rationale", () => {
    const card = scorePromptCandidate(contextFor({ recommendedProfile: "technical" }));
    expect(card.dimensionScores.map((d) => d.dimension)).toEqual([...PROMPT_CRITIC_DIMENSIONS]);
    for (const entry of card.dimensionScores) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
      expect(entry.rationale.length).toBeGreaterThan(0);
    }
  });

  it("aggregate equals the weighted sum of the dimension scores (rounded to 4 dp)", () => {
    const card = scorePromptCandidate(contextFor({ recommendedProfile: "research" }));
    const expected = card.dimensionScores.reduce(
      (sum, entry) => sum + PROMPT_CRITIC_DIMENSION_WEIGHTS[entry.dimension] * entry.score,
      0,
    );
    expect(card.aggregateScore).toBeCloseTo(expected, 4);
    expect(card.aggregateScore).toBeGreaterThanOrEqual(0);
    expect(card.aggregateScore).toBeLessThanOrEqual(1);
  });

  it("is deterministic for identical inputs", () => {
    const context = contextFor({ recommendedProfile: "precise" });
    expect(scorePromptCandidate(context)).toEqual(scorePromptCandidate(context));
  });

  it("produces a contract-valid scorecard", () => {
    const card = scorePromptCandidate(contextFor({ recommendedProfile: "creative" }));
    const result = validatePromptCandidateScorecard(card);
    expect(result.ok).toBe(true);
  });

  it("reports a positive token estimate matching estimatePromptTokens", () => {
    const context = contextFor({ recommendedProfile: "technical" });
    const card = scorePromptCandidate(context);
    expect(card.estimatedTokens).toBe(estimatePromptTokens(context.prompt));
    expect(card.estimatedTokens).toBeGreaterThan(0);
  });

  it("rewards a thorough profile on completeness over a lean profile", () => {
    const thorough = scoreOf(contextFor({ recommendedProfile: "research" }), "completeness");
    const lean = scoreOf(contextFor({ recommendedProfile: "technical" }, "fast"), "completeness");
    expect(thorough).toBeGreaterThan(lean);
  });

  it("rewards a lean profile on token efficiency over a thorough profile", () => {
    const lean = scoreOf(
      contextFor({ recommendedProfile: "technical" }, "fast"),
      "token-efficiency",
    );
    const thorough = scoreOf(contextFor({ recommendedProfile: "research" }), "token-efficiency");
    expect(lean).toBeGreaterThan(thorough);
  });

  it("scores safety at the maximum for a safety-critical prompt", () => {
    expect(scoreOf(contextFor({ criticality: "critical" }), "safety")).toBe(1);
  });

  it("scores grounding readiness at the maximum when no grounding is required", () => {
    const context = contextFor({
      recommendedProfile: "fast",
      groundingNeed: { kind: "none", volatile: false, signals: [] },
    });
    expect(scoreOf(context, "grounding-readiness")).toBe(1);
  });

  it("scores grounding readiness on the grounding apparatus when grounding is required", () => {
    const context = contextFor({
      recommendedProfile: "research",
      groundingNeed: { kind: "supplied-context", volatile: false, signals: [] },
    });
    const card = scorePromptCandidate(context);
    const grounding = card.dimensionScores.find((d) => d.dimension === "grounding-readiness");
    expect(grounding?.score).toBeGreaterThanOrEqual(0.8);
    expect(grounding?.rationale).toContain("grounded task");
  });

  it("never echoes the raw user input in any rationale", () => {
    const sentinel = "SENTINELZZZ confidential salary 999999";
    const card = scorePromptCandidate(
      contextFor({ recommendedProfile: "precise" }, undefined, { text: sentinel }),
    );
    for (const entry of card.dimensionScores) {
      expect(entry.rationale).not.toContain("SENTINELZZZ");
    }
  });
});
