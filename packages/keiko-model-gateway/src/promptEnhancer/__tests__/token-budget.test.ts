import { describe, expect, it } from "vitest";
import {
  analyzePrompt,
  asEnhancedPromptId,
  asPromptEnhancementRequestId,
  PROMPT_ENHANCER_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import type {
  PromptEnhancementProfileId,
  PromptEnhancementRequest,
} from "@oscharko-dev/keiko-contracts";
import { PROMPT_ENHANCER_EXECUTION_PROFILES } from "../profiles.js";
import { planPromptEnhancement } from "../planner.js";
import { generateEnhancedPrompt } from "../generator.js";
import { renderEnhancedPromptText } from "../rendering.js";

// A neutral, non-critical request so an explicit profile preference is honored (not escalated). The
// same input is rendered under each profile so size differences come only from profile shaping.
const NEUTRAL_REQUEST: PromptEnhancementRequest = {
  schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
  requestId: asPromptEnhancementRequestId("token-budget"),
  input: { text: "Explain the rules of chess for a beginner." },
  missingInformationStrategy: "clarify",
};

function renderedFor(profile: PromptEnhancementProfileId): string {
  const analysis = analyzePrompt(NEUTRAL_REQUEST);
  const plan = planPromptEnhancement(analysis, { profilePreference: profile });
  expect(plan.selectedProfile).toBe(profile);
  const prompt = generateEnhancedPrompt({
    promptId: asEnhancedPromptId("token-budget-prompt"),
    analysis,
    plan,
    input: NEUTRAL_REQUEST.input,
  });
  return renderEnhancedPromptText(prompt);
}

describe("token budget (Issue #1310 Expected Verification)", () => {
  it("declares the fast profile a materially smaller token budget than precise and research", () => {
    const fast = PROMPT_ENHANCER_EXECUTION_PROFILES.fast.tokenBudget;
    const precise = PROMPT_ENHANCER_EXECUTION_PROFILES.precise.tokenBudget;
    const research = PROMPT_ENHANCER_EXECUTION_PROFILES.research.tokenBudget;
    expect(fast).toBeLessThan(precise);
    expect(fast).toBeLessThan(research);
    // "Materially" smaller: at least half the precise budget and a quarter of the research budget.
    expect(fast * 2).toBeLessThanOrEqual(precise);
    expect(fast * 4).toBeLessThanOrEqual(research);
  });

  it("produces a materially smaller rendered prompt for fast than for precise and research", () => {
    const fast = renderedFor("fast").length;
    const precise = renderedFor("precise").length;
    const research = renderedFor("research").length;
    expect(fast).toBeLessThan(precise);
    expect(fast).toBeLessThan(research);
    // Research carries a deeper decomposition, extra grounding discipline, and richer criteria, so it
    // is comfortably larger than fast.
    expect(fast * 1.2).toBeLessThan(research);
  });
});
