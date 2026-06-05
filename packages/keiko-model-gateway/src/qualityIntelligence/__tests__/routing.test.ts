import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { selectModelForProfile } from "../routing.js";
import { QualityIntelligenceSafeErrorException } from "../safeError.js";
import { getQualityIntelligenceTaskProfile } from "../taskProfiles.js";

function cap(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...overrides,
  };
}

describe("selectModelForProfile", () => {
  it("returns the first registry capability that satisfies the profile", () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const registry = {
      capabilities: [
        cap("first-no-structured", { structuredOutput: false }),
        cap("second-good"),
        cap("third-also-good"),
      ],
    };
    const selected = selectModelForProfile(profile, registry);
    expect(selected.modelId).toBe("second-good");
    expect(selected.capability.id).toBe("second-good");
  });

  it("throws qi/capability-mismatch when no candidate satisfies the profile", () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const registry = {
      capabilities: [cap("a", { structuredOutput: false }), cap("b", { kind: "embedding" })],
    };
    let caught: unknown;
    try {
      selectModelForProfile(profile, registry);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/capability-mismatch");
    }
  });

  it("returns the first match when multiple candidates satisfy the profile", () => {
    const profile = getQualityIntelligenceTaskProfile("qi:summarize");
    const registry = {
      capabilities: [cap("alpha"), cap("beta"), cap("gamma")],
    };
    expect(selectModelForProfile(profile, registry).modelId).toBe("alpha");
  });
});
