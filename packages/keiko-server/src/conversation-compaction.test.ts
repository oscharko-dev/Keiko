// PR4-W2 hard gates (ADR-0055 D3 / D6). These pin the unchanged-guarantee:
//  - noProfileUnchanged: > MAX_CONTEXT_MESSAGES history with NO profile -> shim returns exactly
//    conversationForGateway(messages) (deep-equal), and buildGatewayMessages output is unchanged.
//  - shortSessionByteIdentical: EXACTLY MAX_CONTEXT_MESSAGES messages WITH profile -> fast path.
//  - longSessionCompaction: 30-message history WITH profile -> the system message remains first,
//    a redacted user-role summary segment follows it, and the verbatim recent window follows that;
//    dropped content is not present verbatim; a dropped secret is redacted; the compaction record
//    validates; the latest user turn is preserved exactly.
//  - determinism: same input -> same output (no clock / no random).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PROFILE,
  validateContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import { conversationForGatewayWithCompaction } from "./conversation-compaction.js";
import { conversationForGateway, MAX_CONTEXT_MESSAGES } from "./chat-handlers.js";
import type { ChatMessage } from "./store/index.js";

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

describe("conversationForGatewayWithCompaction — fast path (unchanged guarantee)", () => {
  it("noProfileUnchanged: >24 messages with no profile returns conversationForGateway verbatim", () => {
    const messages = history(40);
    const outcome = conversationForGatewayWithCompaction(messages, { contextProfile: undefined });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(conversationForGateway(messages));
  });

  it("noProfileUnchanged: omitting opts entirely is also the verbatim fast path", () => {
    const messages = history(40);
    const outcome = conversationForGatewayWithCompaction(messages);
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(conversationForGateway(messages));
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
});

describe("conversationForGatewayWithCompaction — slow path (compaction)", () => {
  const SECRET = "sk-test-ABCDEF0123456789ABCDEF0123456789";

  function longHistoryWithSecret(): ChatMessage[] {
    const messages = history(30);
    // Plant a secret in an OLD turn (index 0) that will be dropped.
    messages[0] = msg("user", `here is my key ${SECRET} keep it`, 0);
    return messages;
  }

  it("longSessionCompaction: keeps the system message first and inserts a user-role summary second", () => {
    const messages = longHistoryWithSecret();
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const first = outcome.messages[0];
    const second = outcome.messages[1];
    expect(first?.role).toBe("system");
    expect(second?.role).toBe("user");
    expect(second?.content).toContain("Automated summary");
  });

  it("longSessionCompaction: the recent user/assistant window after the system message is preserved verbatim", () => {
    const messages = longHistoryWithSecret();
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.messages[0]).toEqual(conversationForGateway(messages)[0]);
    expect(outcome.messages.slice(2)).toEqual(conversationForGateway(messages).slice(1));
  });

  it("longSessionCompaction: the current (latest) user turn is preserved exactly", () => {
    const messages = longHistoryWithSecret();
    const latestUser = [...messages].reverse().find((m) => m.role === "user");
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const present = outcome.messages.some(
      (m) => m.role === "user" && m.content === latestUser?.content,
    );
    expect(present).toBe(true);
  });

  it("longSessionCompaction: dropped content is NOT present verbatim", () => {
    const messages = longHistoryWithSecret();
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const summary = outcome.messages[1]?.content ?? "";
    // The full dropped turn-1 text ("here is my key <secret> keep it") never appears verbatim.
    expect(summary).not.toContain(`here is my key ${SECRET} keep it`);
  });

  it("longSessionCompaction: a secret in a dropped message is redacted in the summary", () => {
    const messages = longHistoryWithSecret();
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const summary = outcome.messages[1]?.content ?? "";
    expect(summary).not.toContain(SECRET);
  });

  it("longSessionCompaction: the compaction record validates", () => {
    const messages = longHistoryWithSecret();
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeDefined();
    expect(validateContextCompactionRecord(outcome.compaction).ok).toBe(true);
  });

  it("longSessionCompaction: record itemsBefore equals the dropped count and itemsAfter is 0", () => {
    const messages = history(30);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction?.itemsBefore).toBe(30 - MAX_CONTEXT_MESSAGES);
    expect(outcome.compaction?.itemsAfter).toBe(0);
    expect(outcome.compaction?.sourceSpans?.length).toBe(30 - MAX_CONTEXT_MESSAGES);
  });

  it("longSessionCompaction: every source span is a message ref with a deterministic stableId", () => {
    const messages = history(30);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    for (const span of outcome.compaction?.sourceSpans ?? []) {
      expect(span.kind).toBe("message");
      expect(span.stableId.length).toBeGreaterThan(0);
    }
    expect(outcome.compaction?.sourceSpans?.[0]?.stableId).toBe("history-msg-0");
  });

  it("determinism: identical input yields identical output (no clock, no random)", () => {
    const a = conversationForGatewayWithCompaction(history(30), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const b = conversationForGatewayWithCompaction(history(30), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(a).toEqual(b);
  });
});
