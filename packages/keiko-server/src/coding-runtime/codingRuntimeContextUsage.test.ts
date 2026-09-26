import { describe, expect, it } from "vitest";

import { createCodingRuntimeContextUsageRegistry } from "./codingRuntimeContextUsage.js";

const AT = "2026-09-15T06:30:00.000Z";

describe("coding runtime context usage", () => {
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
