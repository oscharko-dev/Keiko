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
});
