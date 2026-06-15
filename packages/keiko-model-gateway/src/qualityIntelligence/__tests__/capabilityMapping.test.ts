// Direct pins for the single shared READ-side capability predicate (Epic #761 consolidation).
//
// modelSupportsCapability is now consumed by BOTH the capability gate (assertProfileCompatibleWithModel)
// and the profile router (selectModelForProfile). Each branch is exercised with the OTHER capability
// fields inverted, so a mutant that returns the wrong ModelCapability field for any capability is caught.

import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { modelSupportsCapability } from "../capabilityMapping.js";

function cap(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "fake-model",
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

describe("modelSupportsCapability", () => {
  it("text → satisfied only by a chat-kind model", () => {
    expect(modelSupportsCapability("text", cap({ kind: "chat" }))).toBe(true);
    expect(modelSupportsCapability("text", cap({ kind: "embedding" }))).toBe(false);
  });

  it("structured-output → keyed to structuredOutput, not another flag", () => {
    expect(
      modelSupportsCapability(
        "structured-output",
        cap({ structuredOutput: true, supportsImageInput: false, toolCalling: false }),
      ),
    ).toBe(true);
    expect(
      modelSupportsCapability(
        "structured-output",
        cap({ structuredOutput: false, supportsImageInput: true, toolCalling: true }),
      ),
    ).toBe(false);
  });

  it("function-calling → keyed to toolCalling, not another flag", () => {
    expect(
      modelSupportsCapability(
        "function-calling",
        cap({ toolCalling: true, supportsImageInput: false, structuredOutput: false }),
      ),
    ).toBe(true);
    expect(
      modelSupportsCapability(
        "function-calling",
        cap({ toolCalling: false, supportsImageInput: true, structuredOutput: true }),
      ),
    ).toBe(false);
  });

  it("vision → keyed to supportsImageInput, not another flag", () => {
    expect(
      modelSupportsCapability(
        "vision",
        cap({ supportsImageInput: true, structuredOutput: false, toolCalling: false }),
      ),
    ).toBe(true);
    expect(
      modelSupportsCapability(
        "vision",
        cap({ supportsImageInput: false, structuredOutput: true, toolCalling: true }),
      ),
    ).toBe(false);
  });
});
