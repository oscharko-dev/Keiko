import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { assertProfileCompatibleWithModel } from "../capabilityGate.js";
import { QualityIntelligenceSafeErrorException } from "../safeError.js";
import {
  getQualityIntelligenceTaskProfile,
  type QualityIntelligenceCapability,
  type QualityIntelligenceTaskProfile,
} from "../taskProfiles.js";

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

  // No live profile requires `vision` or `function-calling` today, but the gate's capability map
  // declares branches for both (capabilityGate.ts) and the QualityIntelligenceCapability type admits
  // them. A synthetic profile exercises those branches so a regression in the vision→supportsImageInput
  // or function-calling→toolCalling mapping is caught (#279 AC1: capability-gated before request).
  function syntheticProfile(
    requiredCapabilities: QualityIntelligenceCapability[],
  ): QualityIntelligenceTaskProfile {
    return {
      id: "qi:test-design",
      requiredCapabilities,
      tokenBudgetHint: 1024,
      timeoutMsHint: 10_000,
      retriesMax: 0,
      cacheable: false,
      temperatureHint: 0,
    };
  }

  it("throws qi/capability-mismatch listing 'function-calling' when toolCalling is absent", () => {
    const model = chatCapability({ toolCalling: false });
    let caught: unknown;
    try {
      assertProfileCompatibleWithModel(syntheticProfile(["text", "function-calling"]), model);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/capability-mismatch");
      if (caught.safe.code === "qi/capability-mismatch") {
        expect(caught.safe.missingCapabilities).toEqual(["function-calling"]);
      }
    }
  });

  it("throws qi/capability-mismatch listing 'vision' when supportsImageInput is absent", () => {
    const model = chatCapability({ supportsImageInput: false });
    let caught: unknown;
    try {
      assertProfileCompatibleWithModel(syntheticProfile(["text", "vision"]), model);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QualityIntelligenceSafeErrorException);
    if (caught instanceof QualityIntelligenceSafeErrorException) {
      expect(caught.safe.code).toBe("qi/capability-mismatch");
      if (caught.safe.code === "qi/capability-mismatch") {
        expect(caught.safe.missingCapabilities).toEqual(["vision"]);
      }
    }
  });

  it("does not throw when a vision profile is paired with an image-capable model", () => {
    const model = chatCapability({ supportsImageInput: true, toolCalling: true });
    expect(() => {
      assertProfileCompatibleWithModel(syntheticProfile(["text", "vision"]), model);
    }).not.toThrow();
  });
});
