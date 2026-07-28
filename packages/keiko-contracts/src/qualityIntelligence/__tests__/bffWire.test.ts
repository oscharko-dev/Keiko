import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_RUN_STATUSES,
  type QualityIntelligenceRunStatus,
} from "../bffWire.js";
import { isQualityIntelligenceJudgeEligible } from "../../index.js";
import type { ModelCapability } from "../../gateway.js";

function chatCapability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "judge-candidate",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Quality Intelligence"],
    knownLimitations: [],
    ...overrides,
  };
}

describe("Quality Intelligence run-status union (GEN-DUP-SEMANTIC-010)", () => {
  it("pins the canonical run-status set", () => {
    expect(QUALITY_INTELLIGENCE_RUN_STATUSES).toEqual<readonly QualityIntelligenceRunStatus[]>([
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });
});

describe("Quality Intelligence judge eligibility (#2804)", (): void => {
  it("requires a chat model with structured output enforced by response_format", (): void => {
    expect(
      isQualityIntelligenceJudgeEligible(chatCapability({ supportsResponseFormat: true })),
    ).toBe(true);
    expect(
      isQualityIntelligenceJudgeEligible(chatCapability({ supportsResponseFormat: false })),
    ).toBe(false);
    expect(isQualityIntelligenceJudgeEligible(chatCapability())).toBe(false);
    expect(
      isQualityIntelligenceJudgeEligible(
        chatCapability({ structuredOutput: false, supportsResponseFormat: true }),
      ),
    ).toBe(false);
    expect(
      isQualityIntelligenceJudgeEligible(
        chatCapability({ kind: "embedding", supportsResponseFormat: true }),
      ),
    ).toBe(false);
  });
});
