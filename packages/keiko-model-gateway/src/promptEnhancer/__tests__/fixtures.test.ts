import { describe, expect, it } from "vitest";
import {
  analyzePrompt,
  asEnhancedPromptId,
  validateEnhancedPrompt,
} from "@oscharko-dev/keiko-contracts";
import { planPromptEnhancement } from "../planner.js";
import { generateEnhancedPrompt } from "../generator.js";
import { getPromptEnhancerExecutionProfile } from "../profiles.js";
import { PROFILE_FIXTURES } from "./fixtures.js";

// The stable EnhancedPrompt key set. A structural snapshot: the output schema must not drift, and it
// must be identical across every profile (output-schema stability without brittle prose assertions).
const EXPECTED_PROMPT_KEYS = [
  "constraints",
  "context",
  "goal",
  "groundingPlan",
  "groundingRules",
  "input",
  "outputSchema",
  "promptId",
  "qualityCriteria",
  "role",
  "safetyRules",
  "schemaVersion",
  "taskDecomposition",
  "uncertaintyHandling",
].sort();

describe("profile fixtures (Issue #1310 deliverable 3)", () => {
  for (const fixture of PROFILE_FIXTURES) {
    describe(fixture.name, () => {
      const analysis = analyzePrompt(fixture.request);
      const plan = planPromptEnhancement(analysis, {
        profilePreference: fixture.request.profilePreference,
        missingInformationStrategy: fixture.request.missingInformationStrategy,
      });
      const prompt = generateEnhancedPrompt({
        promptId: asEnhancedPromptId(`${fixture.request.requestId}-prompt`),
        analysis,
        plan,
        input: fixture.request.input,
      });

      it("selects the expected generation profile", () => {
        expect(plan.selectedProfile).toBe(fixture.expectedProfile);
      });

      it("generates a valid Enhanced Prompt", () => {
        const result = validateEnhancedPrompt(prompt);
        expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
      });

      it("keeps the structural output-schema stable", () => {
        expect(Object.keys(prompt).sort()).toEqual(EXPECTED_PROMPT_KEYS);
      });

      it("respects the profile's structural caps", () => {
        const profile = getPromptEnhancerExecutionProfile(fixture.expectedProfile);
        expect(prompt.taskDecomposition.length).toBeLessThanOrEqual(
          profile.maxTaskDecompositionSteps,
        );
        expect(prompt.qualityCriteria.length).toBeLessThanOrEqual(profile.maxQualityCriteria);
      });
    });
  }

  it("covers all seven generation profiles exactly once", () => {
    const covered = PROFILE_FIXTURES.map((f) => f.expectedProfile).sort();
    expect(covered).toEqual(
      ["agentic", "creative", "fast", "precise", "research", "safety-critical", "technical"].sort(),
    );
  });
});
