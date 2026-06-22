import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  assertProfileCompatibleWithModel,
  buildSelectionQueryForCapabilities,
} from "../capabilityGate.js";
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

// No live profile requires `vision` or `function-calling` today, but the gate's capability map and
// the QualityIntelligenceCapability type admit both. A synthetic profile exercises those branches in
// the gate (and, below, the matching selection-query builder) so a mapping regression is caught.
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

// buildSelectionQueryForCapabilities is the WRITE side of the SAME capability mapping that
// modelSupports/assertProfileCompatibleWithModel reads (Issue #762: one shared mapping, no per-stage
// duplicate). These pins lock all four arms so the auto-selection query can never silently drop a
// capability the gate still enforces — the latent vision/function-calling drop is the specific mutant
// they kill (no current profile requires those, so only a direct unit test can catch a regression).
describe("buildSelectionQueryForCapabilities", () => {
  it("maps a text-only profile to a bare chat query (no capability flags)", () => {
    expect(buildSelectionQueryForCapabilities(["text"])).toEqual({ kind: "chat" });
  });

  it("maps structured-output to the structuredOutput query flag", () => {
    expect(buildSelectionQueryForCapabilities(["text", "structured-output"])).toEqual({
      kind: "chat",
      structuredOutput: true,
    });
  });

  it("maps vision to the supportsImageInput query flag", () => {
    expect(buildSelectionQueryForCapabilities(["text", "vision"])).toEqual({
      kind: "chat",
      supportsImageInput: true,
    });
  });

  it("maps function-calling to the toolCalling query flag", () => {
    expect(buildSelectionQueryForCapabilities(["text", "function-calling"])).toEqual({
      kind: "chat",
      toolCalling: true,
    });
  });

  it("maps every capability of a full profile into the query simultaneously", () => {
    expect(
      buildSelectionQueryForCapabilities([
        "text",
        "structured-output",
        "function-calling",
        "vision",
      ]),
    ).toEqual({
      kind: "chat",
      structuredOutput: true,
      toolCalling: true,
      supportsImageInput: true,
    });
  });

  it("stays consistent with the gate: the query a profile builds is satisfied only by a model the gate accepts", () => {
    // A model that advertises exactly the queried flags must pass the gate for the same capabilities,
    // proving the write side (query) and read side (gate) agree for vision + function-calling.
    const required: QualityIntelligenceCapability[] = ["text", "vision", "function-calling"];
    const query = buildSelectionQueryForCapabilities(required);
    expect(query.supportsImageInput).toBe(true);
    expect(query.toolCalling).toBe(true);
    expect(() => {
      assertProfileCompatibleWithModel(
        syntheticProfile(required),
        chatCapability({ supportsImageInput: true, toolCalling: true }),
      );
    }).not.toThrow();
  });
});
