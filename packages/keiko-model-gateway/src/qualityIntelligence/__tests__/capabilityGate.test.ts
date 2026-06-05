import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { assertProfileCompatibleWithModel } from "../capabilityGate.js";
import { QualityIntelligenceSafeErrorException } from "../safeError.js";
import { getQualityIntelligenceTaskProfile } from "../taskProfiles.js";

function chatCapability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "fake-chat",
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

describe("assertProfileCompatibleWithModel", () => {
  it("does not throw when the model supports every required capability", () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    expect(() => {
      assertProfileCompatibleWithModel(profile, chatCapability());
    }).not.toThrow();
  });

  it("throws qi/capability-mismatch when structured-output is required but absent", () => {
    const profile = getQualityIntelligenceTaskProfile("qi:judge-logic");
    const model = chatCapability({ structuredOutput: false });
    let caught: unknown;
    try {
      assertProfileCompatibleWithModel(profile, model);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/capability-mismatch");
      if (caught.safe.code === "qi/capability-mismatch") {
        expect(caught.safe.missingCapabilities).toEqual(["structured-output"]);
        expect(caught.safe.profileId).toBe("qi:judge-logic");
      }
    }
  });

  it("throws when the model is not chat-kind (text capability unsatisfied)", () => {
    const profile = getQualityIntelligenceTaskProfile("qi:summarize");
    const embedding = chatCapability({ kind: "embedding" });
    expect(() => {
      assertProfileCompatibleWithModel(profile, embedding);
    }).toThrow(QualityIntelligenceSafeErrorException);
  });
});
