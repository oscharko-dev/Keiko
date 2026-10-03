// Field report 1.1.13: the meter showed one number, so a grounded chat could not tell that the
// retrieved sources filled most of the window. These pin the breakdown contract: shares in stacking
// order that sum to the window, sources shown beside a capped conversation lane, and a request
// never drawn larger than its input budget.
import { describe, expect, it } from "vitest";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { GroundedPromptContextWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { contextBreakdown, type ConversationShare } from "./chat-context-breakdown.js";

const PROFILE = deriveContextProfile({
  maxInputTokens: 16_384,
  reservedOutputTokens: 4_096,
  safetyMarginTokens: 512,
});

const CONVERSATION: ConversationShare = {
  systemTokens: 180,
  summaryTokens: 0,
  summaryCount: 0,
  messageTokens: 1_200,
  messageCount: 4,
};

const LAST_PROMPT: GroundedPromptContextWire = {
  promptTokens: 5_901,
  promptTokensMeasured: true,
  instructionTokens: 310,
  sourceTokens: 4_100,
  sentReferenceCount: 16,
  availableReferenceCount: 16,
};

function total(breakdown: ReturnType<typeof contextBreakdown>): number {
  return breakdown.segments.reduce((sum, segment) => sum + segment.tokens, 0);
}

describe("contextBreakdown", () => {
  it("breaks a plain chat's window into shares that sum to the window", () => {
    const breakdown = contextBreakdown({ profile: PROFILE, conversation: CONVERSATION });
    expect(breakdown.segments.map((segment) => segment.id)).toEqual([
      "system",
      "summary",
      "messages",
      "free",
      "compaction-buffer",
      "output-reserve",
      "safety-margin",
    ]);
    expect(total(breakdown)).toBe(16_384);
    expect(breakdown.usedTokens).toBe(1_380);
    expect(breakdown.autoCompactionAtTokens).toBe(Math.floor(PROFILE.effectiveInputBudget * 0.9));
    const free = breakdown.segments.find((segment) => segment.id === "free");
    expect(free?.tokens).toBe(breakdown.autoCompactionAtTokens - 1_380);
  });

  it("shows the retrieved sources of a grounded chat beside its capped conversation lane", () => {
    const breakdown = contextBreakdown({
      profile: PROFILE,
      conversation: { ...CONVERSATION, messageTokens: 9_000 },
      grounded: { historyLaneTokens: 3_925, lastPrompt: LAST_PROMPT },
    });
    const byId = new Map(breakdown.segments.map((segment) => [segment.id, segment]));
    expect(byId.get("system")?.tokens).toBe(310);
    expect(byId.get("messages")?.tokens).toBe(3_925);
    expect(byId.get("knowledge")).toEqual({ id: "knowledge", tokens: 4_100, count: 16 });
    expect(breakdown.usedTokens).toBe(310 + 3_925 + 4_100);
    expect(total(breakdown)).toBe(16_384);
  });

  it("separates a large model's unused source capacity from its conversation buffer", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 128_000,
      reservedOutputTokens: 8_000,
      safetyMarginTokens: 4_000,
    });
    const breakdown = contextBreakdown({
      profile,
      conversation: { ...CONVERSATION, messageTokens: 3_871 },
      grounded: { historyLaneTokens: 8_000, lastPrompt: { ...LAST_PROMPT, sourceTokens: 542 } },
    });
    const byId = new Map(breakdown.segments.map((segment) => [segment.id, segment.tokens]));
    expect(byId.get("free")).toBe(3_329);
    expect(byId.get("compaction-buffer")).toBe(800);
    expect(byId.get("source-capacity")).toBe(107_148);
    expect(total(breakdown)).toBe(profile.maxInputTokens);
  });

  it("draws a grounded chat without an answer yet with an empty source share", () => {
    const breakdown = contextBreakdown({
      profile: PROFILE,
      conversation: CONVERSATION,
      grounded: { historyLaneTokens: 3_925, lastPrompt: undefined },
    });
    expect(breakdown.segments.find((segment) => segment.id === "knowledge")).toEqual({
      id: "knowledge",
      tokens: 0,
      count: 0,
    });
  });

  it("never draws the used shares beyond the usable input", () => {
    const breakdown = contextBreakdown({
      profile: PROFILE,
      conversation: { ...CONVERSATION, summaryTokens: 6_000, messageTokens: 30_000 },
    });
    expect(breakdown.usedTokens).toBe(PROFILE.effectiveInputBudget);
    expect(breakdown.segments.find((segment) => segment.id === "free")?.tokens).toBe(0);
    expect(breakdown.segments.find((segment) => segment.id === "compaction-buffer")?.tokens).toBe(
      0,
    );
    expect(total(breakdown)).toBe(16_384);
    expect(breakdown.segments.every((segment) => segment.tokens >= 0)).toBe(true);
  });

  // PR #3678 review: in a grounded question only the conversation lane is compacted. The trigger is
  // 90 % of that lane beside the system and source shares, not 90 % of the whole budget.
  it("places a grounded chat's compaction trigger at the conversation lane", () => {
    const breakdown = contextBreakdown({
      profile: PROFILE,
      conversation: CONVERSATION,
      grounded: { historyLaneTokens: 3_925, lastPrompt: LAST_PROMPT },
    });
    const lane = Math.floor(3_925 * 0.9);
    expect(breakdown.autoCompactionAtTokens).toBe(310 + 4_100 + lane);
    const free = breakdown.segments.find((segment) => segment.id === "free");
    // Tokens until compaction are the conversation's room left in its lane.
    expect(free?.tokens).toBe(lane - 1_200);
    expect(total(breakdown)).toBe(16_384);
  });

  // PR #3678 review: a source share recorded under a larger window gives way alone; the exactly
  // known system and conversation shares are never squeezed.
  it("fits an oversized source share by trimming only the sources", () => {
    const breakdown = contextBreakdown({
      profile: PROFILE,
      conversation: CONVERSATION,
      grounded: {
        historyLaneTokens: 3_925,
        lastPrompt: { ...LAST_PROMPT, sourceTokens: 80_000 },
      },
    });
    const byId = new Map(breakdown.segments.map((segment) => [segment.id, segment.tokens]));
    expect(byId.get("system")).toBe(310);
    expect(byId.get("messages")).toBe(1_200);
    expect(byId.get("knowledge")).toBe(PROFILE.effectiveInputBudget - 310 - 1_200);
    expect(breakdown.usedTokens).toBe(PROFILE.effectiveInputBudget);
    expect(total(breakdown)).toBe(16_384);
  });
});
