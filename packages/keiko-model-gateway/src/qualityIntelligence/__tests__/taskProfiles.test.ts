import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_TASK_PROFILES,
  getQualityIntelligenceTaskProfile,
  listQualityIntelligenceTaskProfiles,
} from "../taskProfiles.js";
import type {
  QualityIntelligenceCapability,
  QualityIntelligenceTaskProfileId,
} from "../taskProfiles.js";

const EXPECTED_IDS: readonly QualityIntelligenceTaskProfileId[] = [
  "qi:test-design",
  "qi:judge-logic",
  "qi:judge-faithfulness",
  "qi:judge-semantic",
  "qi:judge-mutation",
  "qi:coverage-relevance",
  "qi:self-check",
  "qi:summarize",
];

const VALID_CAPABILITIES: readonly QualityIntelligenceCapability[] = [
  "text",
  "vision",
  "structured-output",
  "function-calling",
];

describe("QualityIntelligence task profiles", () => {
  it("registers exactly the expected profile ids in declared order", () => {
    expect(QUALITY_INTELLIGENCE_TASK_PROFILES.map((p) => p.id)).toEqual(EXPECTED_IDS);
    expect(listQualityIntelligenceTaskProfiles().map((p) => p.id)).toEqual(EXPECTED_IDS);
  });

  it("freezes every profile and its requiredCapabilities array", () => {
    for (const profile of QUALITY_INTELLIGENCE_TASK_PROFILES) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.requiredCapabilities)).toBe(true);
    }
  });

  it("has unique profile ids", () => {
    const ids = QUALITY_INTELLIGENCE_TASK_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares only valid required-capability values", () => {
    const valid = new Set<string>(VALID_CAPABILITIES);
    for (const profile of QUALITY_INTELLIGENCE_TASK_PROFILES) {
      for (const cap of profile.requiredCapabilities) {
        expect(valid.has(cap)).toBe(true);
      }
    }
  });

  it("constrains temperatureHint to [0, 1] and yields positive token/timeout hints", () => {
    for (const profile of QUALITY_INTELLIGENCE_TASK_PROFILES) {
      expect(profile.temperatureHint).toBeGreaterThanOrEqual(0);
      expect(profile.temperatureHint).toBeLessThanOrEqual(1);
      expect(profile.tokenBudgetHint).toBeGreaterThan(0);
      expect(profile.timeoutMsHint).toBeGreaterThan(0);
      expect(profile.retriesMax).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns the same instance via getQualityIntelligenceTaskProfile", () => {
    const a = getQualityIntelligenceTaskProfile("qi:test-design");
    const b = getQualityIntelligenceTaskProfile("qi:test-design");
    expect(a).toBe(b);
  });

  it("requires only text for qi:test-design so chat-only models can degrade gracefully", () => {
    expect(getQualityIntelligenceTaskProfile("qi:test-design").requiredCapabilities).toEqual([
      "text",
    ]);
  });
});
