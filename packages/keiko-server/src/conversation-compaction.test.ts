// PR4-W2 hard gates (ADR-0055 D3 / D6). These pin the unchanged-guarantee:
//  - noProfileUnchanged: > MAX_CONTEXT_MESSAGES history with NO profile -> shim returns exactly
//    conversationForGateway(messages) (deep-equal), and buildGatewayMessages output is unchanged.
//  - shortSessionByteIdentical: EXACTLY MAX_CONTEXT_MESSAGES messages WITH profile -> fast path.
//  - manyShortTurnsStayVerbatim: count > MAX_CONTEXT_MESSAGES but budget-safe history remains
//    byte-identical to conversationForGateway(messages).
//  - fewOversizedTurnsCompact: a small below-24 history whose assembled token cost exceeds the
//    effective input budget triggers deterministic compaction before assembly.
//  - determinism: same input -> same output (no clock / no random).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PROFILE,
  validateContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import { conversationForGatewayWithCompaction } from "./conversation-compaction.js";
import { conversationForGateway, MAX_CONTEXT_MESSAGES } from "./chat-handlers.js";
import type { ChatMessage } from "./store/index.js";

const SECRET = "sk-test-ABCDEF0123456789ABCDEF0123456789";

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

function oversizedHistory(): ChatMessage[] {
  const huge = "x".repeat(150_000);
  return [
    msg("user", `here is my key ${SECRET} keep it ${huge}`, 0),
    msg("assistant", `assistant reply ${huge}`, 1),
    msg("user", `latest question ${huge}`, 2),
  ];
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

  it("manyShortTurnsStayVerbatim: count above MAX_CONTEXT_MESSAGES still stays byte-identical when under budget", () => {
    const messages = history(30);
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeUndefined();
    expect(outcome.messages).toEqual(conversationForGateway(messages));
  });
});

describe("conversationForGatewayWithCompaction — slow path (compaction)", () => {
  const messages = oversizedHistory();

  it("fewOversizedTurnsCompact: keeps the system message first and inserts a user-role summary second", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const first = outcome.messages[0];
    const second = outcome.messages[1];
    expect(first?.role).toBe("system");
    expect(second?.role).toBe("user");
    expect(second?.content).toContain("Automated summary");
  });

  it("fewOversizedTurnsCompact: the retained recent window after the summary is preserved verbatim", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.messages[0]).toEqual(conversationForGateway(messages)[0]);
    expect(outcome.messages.slice(2)).toEqual(messages.slice(1).map((message) => ({
      role: message.role,
      content: message.content,
    })));
  });

  it("fewOversizedTurnsCompact: the current (latest) user turn is preserved exactly", () => {
    const latestUser = [...messages].reverse().find((m) => m.role === "user");
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const present = outcome.messages.some(
      (m) => m.role === "user" && m.content === latestUser?.content,
    );
    expect(present).toBe(true);
  });

  it("fewOversizedTurnsCompact: dropped content is NOT present verbatim", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const summary = outcome.messages[1]?.content ?? "";
    // The full dropped turn-1 text ("here is my key <secret> keep it") never appears verbatim.
    expect(summary).not.toContain(`here is my key ${SECRET} keep it`);
  });

  it("fewOversizedTurnsCompact: a secret in a dropped message is redacted in the summary", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const summary = outcome.messages[1]?.content ?? "";
    expect(summary).not.toContain(SECRET);
  });

  it("fewOversizedTurnsCompact: the compaction record validates", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction).toBeDefined();
    expect(validateContextCompactionRecord(outcome.compaction).ok).toBe(true);
    expect(outcome.compaction?.reason).toContain("budget");
  });

  it("fewOversizedTurnsCompact: record itemsBefore equals the dropped count and itemsAfter is 0", () => {
    const outcome = conversationForGatewayWithCompaction(messages, {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(outcome.compaction?.itemsBefore).toBe(1);
    expect(outcome.compaction?.itemsAfter).toBe(0);
    expect(outcome.compaction?.sourceSpans?.length).toBe(1);
  });

  it("fewOversizedTurnsCompact: every source span is a message ref with a deterministic stableId", () => {
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
    const a = conversationForGatewayWithCompaction(oversizedHistory(), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    const b = conversationForGatewayWithCompaction(oversizedHistory(), {
      contextProfile: DEFAULT_CONTEXT_PROFILE,
    });
    expect(a).toEqual(b);
  });
});
