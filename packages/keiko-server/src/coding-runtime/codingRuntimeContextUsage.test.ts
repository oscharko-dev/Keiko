import { describe, expect, it } from "vitest";

import { createCodingRuntimeContextUsageRegistry } from "./codingRuntimeContextUsage.js";

const AT = "2026-09-15T06:30:00.000Z";

describe("coding runtime context usage", () => {
  // #4359: a prompt size the model gateway reports reads against the geometry the run was admitted
  // with; a run without one has nothing to read it against and records nothing.
  it("records a gateway-reported prompt size only for a run with a bound geometry", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    expect(registry.recordGatewayPrompt("run-1", "head", "call-1", 7_303, AT)).toBeUndefined();
    expect(registry.read("run-1")).toBeUndefined();
    registry.bindGeometry("run-1", { capacityTokens: 272_000, reservedOutputTokens: 32_768 });
    expect(registry.recordGatewayPrompt("run-1", "head", "call-1", 7_303, AT)).toEqual({
      accepted: true,
      capacityTokens: 272_000,
      reservedOutputTokens: 32_768,
    });
    expect(registry.recordGatewayPrompt("run-1", "head", "call-1", 7_303, AT)?.accepted).toBe(
      false,
    );
    expect(registry.read("run-1")).toMatchObject({
      state: "available",
      source: "provider-reported",
      capacityTokens: 272_000,
      reservedOutputTokens: 32_768,
      usedInputTokens: 7_303,
    });
    expect(registry.read("run-2")).toBeUndefined();
  });

  // #4359: a run holds several conversations (subagents); a small subagent prompt is never read as
  // the primary conversation's context, and a caller that cannot say who asks sizes against the
  // fullest conversation.
  it("attributes a gateway sample to its conversation, and sizes an unattributed asker on the fullest", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    registry.bindGeometry("run-1", { capacityTokens: 272_000, reservedOutputTokens: 32_768 });
    registry.recordGatewayPrompt("run-1", "primary", "call-1", 90_000, AT);
    registry.recordGatewayPrompt("run-1", "subagent", "call-2", 3_000, AT);
    expect(registry.read("run-1")?.usedInputTokens).toBe(90_000);
    expect(registry.readLargest("run-1")?.usedInputTokens).toBe(90_000);
    registry.recordGatewayPrompt("run-1", "primary", "call-3", 91_000, AT);
    registry.recordGatewayPrompt("run-1", "subagent", "call-4", 120_000, AT);
    expect(registry.read("run-1")?.usedInputTokens).toBe(91_000);
    expect(registry.readLargest("run-1")?.usedInputTokens).toBe(120_000);
    expect(registry.readLargest("run-2")).toBeUndefined();
  });

  it("separates current provider context from cumulative prompt usage", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    const first = {
      sampleId: "sample-1",
      capacityTokens: 128_000,
      reservedOutputTokens: 8_000,
      inputTokens: 40_000,
      updatedAt: AT,
    };
    expect(registry.recordProviderSample("run-1", first)).toBe(true);
    expect(registry.recordProviderSample("run-1", first)).toBe(false);
    expect(
      registry.recordProviderSample("run-1", {
        ...first,
        sampleId: "sample-2",
        inputTokens: 70_000,
      }),
    ).toBe(true);
    expect(registry.read("run-1")).toMatchObject({
      state: "available",
      usedInputTokens: 70_000,
      freeTokens: 50_000,
      cumulativePromptTokens: 110_000,
    });
  });

  it("rejects impossible geometry instead of clamping or guessing", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    expect(
      registry.recordProviderSample("run-1", {
        sampleId: "sample-1",
        capacityTokens: 10_000,
        reservedOutputTokens: 2_000,
        inputTokens: 8_001,
        updatedAt: AT,
      }),
    ).toBe(false);
    expect(registry.read("run-1")).toBeUndefined();
  });

  it("reports compaction only after the runtime actually emits it", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    registry.recordProviderSample("run-1", {
      sampleId: "sample-1",
      capacityTokens: 128_000,
      reservedOutputTokens: 8_000,
      inputTokens: 40_000,
      updatedAt: AT,
    });
    expect(registry.read("run-1")).not.toHaveProperty("compaction");
    expect(registry.recordCompaction("run-1", "compaction-1", AT)).toBe(true);
    expect(registry.recordCompaction("run-1", "compaction-1", AT)).toBe(false);
    expect(registry.read("run-1")).toMatchObject({
      compaction: { count: 1, lastCompactedAt: AT },
    });
  });

  it("rejects malformed and oversized opaque telemetry identities", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    expect(registry.recordCompaction("run-1", "", AT)).toBe(false);
    expect(registry.recordCompaction("run-1", "compaction-1", "not-an-instant")).toBe(false);
    expect(
      registry.recordProviderSample("run-1", {
        sampleId: "x".repeat(513),
        capacityTokens: 128_000,
        reservedOutputTokens: 8_000,
        inputTokens: 40_000,
        updatedAt: AT,
      }),
    ).toBe(false);
    expect(registry.read("run-1")).toBeUndefined();
  });
});
