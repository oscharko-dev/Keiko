import { describe, expect, it } from "vitest";

import {
  createCodingRuntimeContextUsageRegistry,
  type CodingRuntimeConversation,
} from "./codingRuntimeContextUsage.js";

const BUILD: CodingRuntimeConversation = {
  agentKey: "agent-build",
  headKey: "head-build",
  toolBearing: true,
};
const EXPLORE: CodingRuntimeConversation = {
  agentKey: "agent-explore",
  headKey: "head-explore",
  toolBearing: true,
};
const TITLE: CodingRuntimeConversation = {
  agentKey: "agent-title",
  headKey: "head-title",
  toolBearing: false,
};

const AT = "2026-09-15T06:30:00.000Z";

describe("coding runtime context usage", () => {
  // #4359: a prompt size the model gateway reports reads against the geometry the run was admitted
  // with; a run without one has nothing to read it against and records nothing.
  it("records a gateway-reported prompt size only for a run with a bound geometry", () => {
    const registry = createCodingRuntimeContextUsageRegistry();
    expect(registry.recordGatewayPrompt("run-1", BUILD, "call-1", 7_303, AT)).toBeUndefined();
    expect(registry.read("run-1")).toBeUndefined();
    registry.bindGeometry("run-1", { capacityTokens: 272_000, reservedOutputTokens: 32_768 });
    expect(registry.recordGatewayPrompt("run-1", BUILD, "call-1", 7_303, AT)).toEqual({
      accepted: true,
      capacityTokens: 272_000,
      reservedOutputTokens: 32_768,
    });
    expect(registry.recordGatewayPrompt("run-1", BUILD, "call-1", 7_303, AT)?.accepted).toBe(false);
    expect(registry.read("run-1")).toMatchObject({
      state: "available",
      source: "provider-reported",
      capacityTokens: 272_000,
      reservedOutputTokens: 32_768,
      usedInputTokens: 7_303,
    });
    expect(registry.read("run-2")).toBeUndefined();
  });

  // The rule, in one sentence: only requests that offer tools count, a conversation is its agent
  // plus its head, a new head of the same agent supersedes the old one, the primary is the first
  // agent that offered tools, and a conversation unheard of for 16 further requests has ended.
  describe("which conversation a sample belongs to", () => {
    function bound(): ReturnType<typeof createCodingRuntimeContextUsageRegistry> {
      const registry = createCodingRuntimeContextUsageRegistry();
      registry.bindGeometry("run-1", { capacityTokens: 272_000, reservedOutputTokens: 32_768 });
      return registry;
    }
    let sample = 0;
    const record = (
      registry: ReturnType<typeof createCodingRuntimeContextUsageRegistry>,
      conversation: CodingRuntimeConversation,
      tokens: number,
    ): void => {
      sample += 1;
      registry.recordGatewayPrompt("run-1", conversation, `call-${String(sample)}`, tokens, AT);
    };

    it("never makes a title or summary request the primary, or the fullest", () => {
      const registry = bound();
      record(registry, TITLE, 120_000);
      expect(registry.read("run-1")).toBeUndefined();
      expect(registry.readLargest("run-1")).toBeUndefined();
      record(registry, BUILD, 9_000);
      record(registry, TITLE, 150_000);
      expect(registry.read("run-1")?.usedInputTokens).toBe(9_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(9_000);
      expect(registry.read("run-1")?.cumulativePromptTokens).toBe(120_000 + 9_000 + 150_000);
    });

    it("keeps a subagent apart from the primary", () => {
      const registry = bound();
      record(registry, BUILD, 90_000);
      record(registry, EXPLORE, 3_000);
      expect(registry.read("run-1")?.usedInputTokens).toBe(90_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(90_000);
      record(registry, EXPLORE, 120_000);
      expect(registry.read("run-1")?.usedInputTokens).toBe(90_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(120_000);
    });

    it("lets a new head of the same agent supersede the old one, so a compaction frees a describe", () => {
      const registry = bound();
      record(registry, BUILD, 180_000);
      record(registry, { ...BUILD, headKey: "build-after-compaction" }, 12_000);
      expect(registry.read("run-1")?.usedInputTokens).toBe(12_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(12_000);
    });

    it("ends a conversation that has seen no request while the run served 16 others", () => {
      const registry = bound();
      record(registry, BUILD, 180_000);
      for (let round = 0; round < 15; round += 1) record(registry, EXPLORE, 2_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(180_000);
      record(registry, EXPLORE, 2_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(2_000);
      expect(registry.read("run-1")?.usedInputTokens).toBe(180_000);
      record(registry, BUILD, 40_000);
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(40_000);
    });

    it("never evicts the fullest conversation, or the primary, past the retention bound", () => {
      const registry = bound();
      record(registry, BUILD, 5_000);
      record(registry, { agentKey: "agent-big", headKey: "head-big", toolBearing: true }, 200_000);
      for (let agent = 0; agent < 12; agent += 1)
        record(
          registry,
          {
            agentKey: `agent-${String(agent)}`,
            headKey: `head-${String(agent)}`,
            toolBearing: true,
          },
          1_000 + agent,
        );
      expect(registry.readLargest("run-1")?.usedInputTokens).toBe(200_000);
      expect(registry.read("run-1")?.usedInputTokens).toBe(5_000);
    });
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
