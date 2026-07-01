// PR4-W2 hard gates (ADR-0055 D3 / D6). These pin the budget-aware semantics:
//  - profile-backed many short turns above the legacy 24-turn threshold stay verbatim when they
//    fit the effective budget and do NOT equal the sliced legacy projection.
//  - undefined-profile many short turns use the DEFAULT_CONTEXT_PROFILE fallback and stay verbatim
//    when they fit the effective budget.
//  - oversized histories compact deterministically, keep the newest filtered turn verbatim, and
//    preserve the retained tail.
//  - determinism: same input -> same output (no clock / no random).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfile,
  estimateTokensForSegments,
  type ContextProfile,
  validateContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import { conversationForGatewayWithCompaction } from "./conversation-compaction.js";
import {
  conversationForGateway,
  MAX_CONTEXT_MESSAGES,
  usableGatewayMessages,
} from "./chat-handlers.js";
import type { ChatMessage } from "./store/index.js";

const NON_PATTERN_SECRET = "customer-secret-ABC-1234567890";
const CURRENT_INSTRUCTION = "latest question";

function msg(role: ChatMessage["role"], content: string, index: number): ChatMessage {
  return {
    id: `m${String(index)}`,
    chatId: "chat-1",
    role,
    content,
    timestamp: 1000 + index,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

// Alternating user/assistant turns; user turns carry the index so the latest user turn is unique.
function history(count: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push(msg(role, `${role} turn ${String(i)}`, i));
  }
  return out;
}

function budgetPressureHistory(): ChatMessage[] {
  const huge = "x".repeat(300_000);
  return [
    msg("user", `here is my key ${NON_PATTERN_SECRET} keep it ${huge}`, 0),
    msg("assistant", `assistant reply ${huge}`, 1),
    msg("user", CURRENT_INSTRUCTION, 2),
  ];
}

function singleDropHistory(): ChatMessage[] {
  const huge = "x".repeat(420_000);
  return [
    msg("user", `here is my key ${NON_PATTERN_SECRET} keep it ${huge}`, 0),
    msg("assistant", "assistant reply", 1),
    msg("user", CURRENT_INSTRUCTION, 2),
  ];
}

function latestTurnOverflowHistory(): ChatMessage[] {
  const huge = "x".repeat(80_000);
  return [
    msg("user", `earlier note ${NON_PATTERN_SECRET} ${huge}`, 0),
    msg("user", `latest instruction ${huge}`, 1),
  ];
}

function fullConversation(
  messages: readonly ChatMessage[],
): ReturnType<typeof conversationForGateway> {
  const systemMessage = conversationForGateway(messages)[0];
  const filtered = usableGatewayMessages(messages).map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
  return systemMessage === undefined ? filtered : [systemMessage, ...filtered];
}

function zeroBudgetProfile(): ContextProfile {
  return deriveContextProfile({
    maxInputTokens: 1,
    reservedOutputTokens: 1,
    safetyMarginTokens: 0,
  });
}

describe("conversationForGatewayWithCompaction — fast path (unchanged guarantee)", () => {
  it("profile-backed many short turns stay verbatim above the legacy 24-turn threshold", () => {
    const messages = history(40);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(fullConversation(messages));
    expect(outcome.messages).not.toEqual(conversationForGateway(messages));
  });

  it("undefined-profile many short turns use the fallback budget path and stay verbatim", () => {
    const messages = history(40);
    const outcome = conversationForGatewayWithCompaction(messages, { contextProfile: undefined });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(fullConversation(messages));
    expect(outcome.messages).not.toEqual(conversationForGateway(messages));
  });

  it("shortSessionByteIdentical: exactly MAX_CONTEXT_MESSAGES with profile is the fast path", () => {
    const messages = history(MAX_CONTEXT_MESSAGES);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(conversationForGateway(messages));
  });

  it("shortSessionByteIdentical: below the boundary with profile is the fast path", () => {
    const messages = history(10);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(conversationForGateway(messages));
  });

  it("empty history with profile stays byte-identical and never emits a compaction record", () => {
    const messages: ChatMessage[] = [];
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(fullConversation(messages));
  });

  it("zero-budget history fails closed without a zero-item summary record", () => {
    const messages = history(1);
    expect(() =>
      conversationForGatewayWithCompaction(messages, {
        contextProfile: zeroBudgetProfile(),
      }),
    ).toThrow(ContextOverflowError);
  });

  it("fails closed when only dropping the newest turn would make the prompt fit", () => {
    const messages = latestTurnOverflowHistory();
    const tightProfile = deriveContextProfile({
      maxInputTokens: 1_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    expect(() =>
      conversationForGatewayWithCompaction(messages, {
        contextProfile: tightProfile,
        redactionSecrets: [NON_PATTERN_SECRET],
      }),
    ).toThrow(ContextOverflowError);
  });

  it("manyShortTurnsStayVerbatim: count above MAX_CONTEXT_MESSAGES still stays byte-identical when under budget", () => {
    const messages = history(30);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(fullConversation(messages));
    expect(outcome.messages).not.toEqual(conversationForGateway(messages));
  });
});

describe("conversationForGatewayWithCompaction — slow path (compaction)", () => {
  const messages = singleDropHistory();
  const multiDropMessages = budgetPressureHistory();
  function longTailMessages(): ChatMessage[] {
    const huge = "x".repeat(250_000);
    const turns = history(30);
    turns[0] = msg("user", `opening pressure ${NON_PATTERN_SECRET} ${huge}`, 0);
    turns[1] = msg("assistant", `assistant pressure ${huge}`, 1);
    return turns;
  }

  it("undefined-profile oversized history compacts instead of raw slicing and keeps the latest user turn exact", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: undefined,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const plain = fullConversation(messages);
    const first = outcome.messages[0];
    const second = outcome.messages[1];
    expect(outcome.compaction).toBeDefined();
    expect(first?.role).toBe("system");
    expect(second?.role).toBe("user");
    expect(second?.content).toContain("Automated structured summary");
    expect(outcome.messages[0]).toEqual(plain[0]);
    expect(outcome.messages.slice(2)).toEqual(plain.slice(2));
    expect(
      estimateTokensForSegments(outcome.messages.map((message) => message.content)),
    ).toBeLessThanOrEqual(DEFAULT_CONTEXT_PROFILE.effectiveInputBudget);
    expect(
      outcome.messages.some(
        (message) => message.role === "user" && message.content === CURRENT_INSTRUCTION,
      ),
    ).toBe(true);
  });

  it("fewOversizedTurnsCompact: the retained recent window after the summary is preserved verbatim", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const plain = fullConversation(messages);
    expect(outcome.messages[0]).toEqual(plain[0]);
    expect(outcome.compaction?.itemsBefore).toBe(1);
    expect(outcome.messages.slice(2)).toEqual(plain.slice(2));
  });

  it("fewOversizedTurnsCompact: a smaller profile drops multiple turns and preserves the retained tail", () => {
    const smallProfile = deriveContextProfile({
      maxInputTokens: 40_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const outcome = conversationForGatewayWithCompaction(multiDropMessages, {
      contextProfile: smallProfile,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const plain = fullConversation(multiDropMessages);
    expect(outcome.compaction).toBeDefined();
    expect(outcome.compaction?.itemsBefore).toBe(2);
    expect(outcome.compaction?.sourceSpans?.length).toBe(2);
    expect(outcome.messages.slice(2)).toEqual(plain.slice(3));
    expect(
      estimateTokensForSegments(outcome.messages.map((message) => message.content)),
    ).toBeLessThanOrEqual(smallProfile.effectiveInputBudget);
  });

  it("fewOversizedTurnsCompact: the current (latest) user turn is preserved exactly", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const latestUser = [...outcome.messages].reverse().find((m) => m.role === "user");
    expect(latestUser?.content).toBe(CURRENT_INSTRUCTION);
  });

  it("fewOversizedTurnsCompact: dropped content is NOT present verbatim", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const summary = outcome.messages[1]?.content ?? "";
    // The full dropped turn-0 text never appears verbatim.
    expect(summary).not.toContain(`here is my key ${NON_PATTERN_SECRET} keep it`);
  });

  it("fewOversizedTurnsCompact: a secret in a dropped message is redacted in the summary", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const summary = outcome.messages[1]?.content ?? "";
    expect(summary).not.toContain(NON_PATTERN_SECRET);
  });

  it("fewOversizedTurnsCompact: the compaction record validates", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    expect(outcome.compaction).toBeDefined();
    expect(validateContextCompactionRecord(outcome.compaction).ok).toBe(true);
    expect(outcome.compaction?.sourceSpans?.length).toBe(outcome.compaction?.itemsBefore);
    expect(outcome.compaction?.reason).toContain("budget");
  });

  it("fewOversizedTurnsCompact: record itemsBefore equals the dropped count and itemsAfter is 1", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    expect(outcome.compaction?.itemsBefore).toBe(1);
    expect(outcome.compaction?.itemsAfter).toBe(1);
    expect(outcome.compaction?.sourceSpans?.length).toBe(1);
  });

  it("fewOversizedTurnsCompact: every source span is a message ref with a deterministic stableId", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    for (const span of outcome.compaction?.sourceSpans ?? []) {
      expect(span.kind).toBe("message");
      expect(span.stableId.length).toBeGreaterThan(0);
    }
    expect(outcome.compaction?.sourceSpans?.[0]?.stableId).toBe("history-msg-0");
  });

  it("fewOversizedTurnsCompact: the final assembled token count stays within the effective budget", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    expect(
      estimateTokensForSegments(outcome.messages.map((message) => message.content)),
    ).toBeLessThanOrEqual(DEFAULT_CONTEXT_PROFILE.effectiveInputBudget);
  });

  it("tight budget also respects the final assembled token count after the minimal safe drop", () => {
    const tightProfile = deriveContextProfile({
      maxInputTokens: 1_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: tightProfile,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    expect(outcome.compaction).toBeDefined();
    expect(outcome.compaction?.itemsBefore).toBe(1);
    expect(
      estimateTokensForSegments(outcome.messages.map((message) => message.content)),
    ).toBeLessThanOrEqual(tightProfile.effectiveInputBudget);
  });

  it("explicit history budget override matches the same real profile under the tighter limit", () => {
    const tightProfile = deriveContextProfile({
      maxInputTokens: 1_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const overridden = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      effectiveInputBudget: tightProfile.effectiveInputBudget,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const direct = conversationForGatewayWithCompaction(messages, {
      contextProfile: tightProfile,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    expect(overridden).toEqual(direct);
  });

  it("drops only the minimum oldest prefix needed when more than 24 recent turns still fit", () => {
    const outcome = conversationForGatewayWithCompaction(longTailMessages(), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const plain = fullConversation(longTailMessages());
    expect(outcome.compaction).toBeDefined();
    expect(outcome.compaction?.itemsBefore).toBe(1);
    expect(outcome.compaction?.sourceSpans?.length).toBe(1);
    expect(outcome.messages.slice(2)).toEqual(plain.slice(2));
    expect(outcome.messages.slice(2)).toHaveLength(29);
    expect(outcome.messages.slice(2).length).toBeGreaterThan(MAX_CONTEXT_MESSAGES);
  });

  it("determinism: identical input yields identical output (no clock, no random)", () => {
    const a = conversationForGatewayWithCompaction(singleDropHistory(), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    const b = conversationForGatewayWithCompaction(singleDropHistory(), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
      redactionSecrets: [NON_PATTERN_SECRET],
    });
    expect(a).toEqual(b);
  });
});
