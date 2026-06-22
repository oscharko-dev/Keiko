import { describe, expect, it } from "vitest";
import { PROMPT_ENHANCEMENT_PROFILE_IDS } from "@oscharko-dev/keiko-contracts";
import {
  PROMPT_ENHANCER_EXECUTION_PROFILES,
  REASONING_DEPTHS,
  REASONING_STRATEGIES,
  getPromptEnhancerExecutionProfile,
  listPromptEnhancerExecutionProfiles,
  reasoningDepthRank,
} from "../profiles.js";

describe("prompt enhancer execution profiles", () => {
  it("defines exactly one execution profile per contract profile id", () => {
    const catalogIds = Object.keys(PROMPT_ENHANCER_EXECUTION_PROFILES).sort();
    expect(catalogIds).toEqual([...PROMPT_ENHANCEMENT_PROFILE_IDS].sort());
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      expect(PROMPT_ENHANCER_EXECUTION_PROFILES[id].id).toBe(id);
    }
  });

  it("freezes the catalog and each profile against mutation", () => {
    expect(Object.isFrozen(PROMPT_ENHANCER_EXECUTION_PROFILES)).toBe(true);
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      expect(Object.isFrozen(PROMPT_ENHANCER_EXECUTION_PROFILES[id])).toBe(true);
    }
  });

  it("getPromptEnhancerExecutionProfile returns the matching profile", () => {
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      expect(getPromptEnhancerExecutionProfile(id).id).toBe(id);
    }
  });

  it("getPromptEnhancerExecutionProfile throws on an unknown id", () => {
    expect(() =>
      // Deliberate bad cast to exercise the runtime totality guard.
      getPromptEnhancerExecutionProfile("not-a-profile" as never),
    ).toThrow(/Unknown Prompt Enhancer execution profile/);
  });

  it("listPromptEnhancerExecutionProfiles returns every profile in contract id order", () => {
    const listed = listPromptEnhancerExecutionProfiles().map((p) => p.id);
    expect(listed).toEqual([...PROMPT_ENHANCEMENT_PROFILE_IDS]);
  });

  it("ranks reasoning depths in ascending order", () => {
    expect(REASONING_DEPTHS).toEqual(["minimal", "standard", "extended", "exhaustive"]);
    expect(reasoningDepthRank("minimal")).toBeLessThan(reasoningDepthRank("standard"));
    expect(reasoningDepthRank("standard")).toBeLessThan(reasoningDepthRank("extended"));
    expect(reasoningDepthRank("extended")).toBeLessThan(reasoningDepthRank("exhaustive"));
  });

  it("maps each profile to a known reasoning strategy", () => {
    for (const id of PROMPT_ENHANCEMENT_PROFILE_IDS) {
      expect(REASONING_STRATEGIES).toContain(
        PROMPT_ENHANCER_EXECUTION_PROFILES[id].reasoningStrategy,
      );
    }
  });

  it("keeps the fast profile the smallest token budget and research the largest (AC2)", () => {
    const fast = PROMPT_ENHANCER_EXECUTION_PROFILES.fast.tokenBudget;
    const precise = PROMPT_ENHANCER_EXECUTION_PROFILES.precise.tokenBudget;
    const research = PROMPT_ENHANCER_EXECUTION_PROFILES.research.tokenBudget;
    expect(fast).toBeLessThan(precise);
    expect(fast).toBeLessThan(research);
    const budgets = listPromptEnhancerExecutionProfiles().map((p) => p.tokenBudget);
    expect(Math.min(...budgets)).toBe(fast);
    expect(Math.max(...budgets)).toBe(research);
  });

  it("keeps fast's reasoning depth shallower than precise and research (AC2)", () => {
    const fast = reasoningDepthRank(PROMPT_ENHANCER_EXECUTION_PROFILES.fast.reasoningDepth);
    const precise = reasoningDepthRank(PROMPT_ENHANCER_EXECUTION_PROFILES.precise.reasoningDepth);
    const research = reasoningDepthRank(PROMPT_ENHANCER_EXECUTION_PROFILES.research.reasoningDepth);
    expect(fast).toBeLessThan(precise);
    expect(fast).toBeLessThan(research);
  });

  it("bounds every structural cap to a positive integer", () => {
    for (const profile of listPromptEnhancerExecutionProfiles()) {
      for (const cap of [
        profile.maxTaskDecompositionSteps,
        profile.maxQualityCriteria,
        profile.maxConstraints,
      ]) {
        expect(Number.isInteger(cap)).toBe(true);
        expect(cap).toBeGreaterThan(0);
      }
    }
  });
});
