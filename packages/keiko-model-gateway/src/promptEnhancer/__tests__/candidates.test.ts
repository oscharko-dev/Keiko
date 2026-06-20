import { describe, expect, it } from "vitest";
import { validateEnhancedPrompt, type RawPromptInput } from "@oscharko-dev/keiko-contracts";
import { generatePromptCandidates } from "../candidates.js";
import { makeAnalysis, type AnalysisOverrides } from "./_support.js";

const INPUT: RawPromptInput = { text: "Generate a small utility module with tests." };

function candidatesFor(
  overrides: AnalysisOverrides,
  candidateCount: number,
): ReturnType<typeof generatePromptCandidates> {
  return generatePromptCandidates({
    analysis: makeAnalysis(overrides),
    input: INPUT,
    candidateCount,
  });
}

describe("generatePromptCandidates", () => {
  it("generates at least three distinct, valid candidates for a variation-admitting task", () => {
    const { candidates } = candidatesFor({ recommendedProfile: "technical" }, 3);
    expect(candidates).toHaveLength(3);
    const profiles = candidates.map((candidate) => candidate.profile);
    expect(new Set(profiles).size).toBe(3);
    for (const candidate of candidates) {
      expect(validateEnhancedPrompt(candidate.prompt).ok).toBe(true);
      expect(candidate.candidateId).toBe(candidate.prompt.promptId);
    }
  });

  it("places the baseline (recommended) profile first", () => {
    const { candidates } = candidatesFor({ recommendedProfile: "research" }, 3);
    expect(candidates[0]?.profile).toBe("research");
  });

  it("respects the candidateCount upper bound", () => {
    const { candidates } = candidatesFor({ recommendedProfile: "technical" }, 2);
    expect(candidates).toHaveLength(2);
  });

  it("is deterministic for identical inputs", () => {
    const a = candidatesFor({ recommendedProfile: "precise" }, 4);
    const b = candidatesFor({ recommendedProfile: "precise" }, 4);
    expect(a).toEqual(b);
  });

  it("rejects candidates that would drop the human-approval gate of an agentic baseline (AC5)", () => {
    const { candidates, rejected } = candidatesFor({ recommendedProfile: "agentic" }, 7);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.profile).toBe("agentic");
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((entry) => entry.reason === "safety-floor-not-preserved")).toBe(true);
  });

  it("keeps every variant when a risk flag pins the human-approval gate across all profiles", () => {
    const { candidates } = candidatesFor(
      { recommendedProfile: "technical", riskFlags: ["tool-authority-requested"] },
      3,
    );
    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      expect(candidate.plan.safetyPosture.requiresHumanApproval).toBe(true);
    }
  });

  it("collapses a critical-criticality task to the single safety-critical candidate without duplicates", () => {
    const { candidates, rejected } = candidatesFor({ criticality: "critical" }, 7);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.profile).toBe("safety-critical");
    expect(rejected).toHaveLength(0);
  });

  it("preserves the grounding plan and output schema across every candidate (AC5)", () => {
    const { candidates } = generatePromptCandidates({
      analysis: makeAnalysis({
        recommendedProfile: "research",
        groundingNeed: { kind: "supplied-context", volatile: false, signals: [] },
        outputSchema: { format: "json", structured: true, hints: ["explicit-json"] },
      }),
      input: INPUT,
      candidateCount: 4,
    });
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    for (const candidate of candidates) {
      expect(candidate.prompt.outputSchema).toEqual({
        format: "json",
        structured: true,
        hints: ["explicit-json"],
      });
      expect(candidate.prompt.groundingPlan.required).toBe(true);
      expect(candidate.prompt.groundingPlan).toEqual(candidates[0]?.prompt.groundingPlan);
    }
  });

  it("produces structurally distinct prompts across candidates", () => {
    const { candidates } = candidatesFor({ recommendedProfile: "technical" }, 3);
    const signatures = candidates.map((candidate) =>
      JSON.stringify([
        candidate.prompt.taskDecomposition,
        candidate.prompt.constraints,
        candidate.prompt.qualityCriteria,
      ]),
    );
    expect(new Set(signatures).size).toBe(candidates.length);
  });
});
