// Direct pins for the single shared READ-side capability predicate (Epic #761 consolidation).
//
// modelSupportsCapability is now consumed by BOTH the capability gate (assertProfileCompatibleWithModel)
// and the profile router (selectModelForProfile). Each branch is exercised with the OTHER capability
// fields inverted, so a mutant that returns the wrong ModelCapability field for any capability is caught.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { TOOL_CALLING_VERIFICATION_MAX_AGE_MS } from "../../config.js";
import { modelSupportsCapability } from "../capabilityMapping.js";

function verifiedToolCallingProof(): NonNullable<ModelCapability["toolCallingVerification"]> {
  return {
    status: "verified",
    checkedAt: new Date().toISOString(),
    probe: "gateway-tool-calling-v1",
    configurationFingerprint: "test-fingerprint",
  };
}

function cap(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "fake-model",
    kind: "chat",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    toolCallingVerification: verifiedToolCallingProof(),
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

afterEach(() => {
  vi.useRealTimers();
});

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
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

  it("function-calling rejects missing, invalid, unverified, future, and expired proofs", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    vi.setSystemTime(new Date(now));
    const { toolCallingVerification: removedProof, ...withoutProof } = cap();
    expect(removedProof).toBeDefined();

    expect(modelSupportsCapability("function-calling", withoutProof)).toBe(false);
    expect(
      modelSupportsCapability(
        "function-calling",
        cap({
          toolCallingVerification: { ...verifiedToolCallingProof(), status: "unverified" },
        }),
      ),
    ).toBe(false);
    expect(
      modelSupportsCapability(
        "function-calling",
        cap({
          toolCallingVerification: { ...verifiedToolCallingProof(), checkedAt: "invalid" },
        }),
      ),
    ).toBe(false);
    expect(
      modelSupportsCapability(
        "function-calling",
        cap({
          toolCallingVerification: {
            ...verifiedToolCallingProof(),
            checkedAt: new Date(now + 1).toISOString(),
          },
        }),
      ),
    ).toBe(false);
    expect(
      modelSupportsCapability(
        "function-calling",
        cap({
          toolCallingVerification: {
            ...verifiedToolCallingProof(),
            checkedAt: new Date(now - TOOL_CALLING_VERIFICATION_MAX_AGE_MS - 1).toISOString(),
          },
        }),
      ),
    ).toBe(false);
  });

  it("function-calling accepts a proof exactly at the freshness boundary", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    vi.setSystemTime(new Date(now));

    expect(
      modelSupportsCapability(
        "function-calling",
        cap({
          toolCallingVerification: {
            ...verifiedToolCallingProof(),
            checkedAt: new Date(now - TOOL_CALLING_VERIFICATION_MAX_AGE_MS).toISOString(),
          },
        }),
      ),
    ).toBe(true);
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
