import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatWindowRuntimeTarget,
  registerChatWindowRuntime,
  groundingIntensity,
  beginChatScopeTransition,
  chatScopeTransition,
  clearChatScopeTransitions,
} from "./chatWindowActivity";

const TARGET = { conversationId: "chat-a", projectPath: "/repo" };
afterEach((): void => {
  clearChatScopeTransitions(TARGET.conversationId);
});

describe("chat source-intent admission", () => {
  it("cancels every runtime of the affected chat synchronously and preserves other chats", () => {
    const cancel = vi.fn();
    const other = vi.fn();
    const release = registerChatWindowRuntime("chat-window", TARGET, undefined, undefined, cancel);
    const releaseOther = registerChatWindowRuntime(
      "other-window",
      { conversationId: "other", projectPath: "/repo" },
      undefined,
      undefined,
      other,
    );
    try {
      const intent = beginChatScopeTransition(TARGET.conversationId, "files-a");
      expect(cancel).toHaveBeenCalledOnce();
      expect(other).not.toHaveBeenCalled();
      expect(chatScopeTransition(TARGET.conversationId)).toBe("pending");
      intent.settle(false);
      expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
      intent.settle(true);
      expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
    } finally {
      release();
      releaseOther();
    }
  });

  it("keeps independent source holds and refuses obsolete acknowledgements", () => {
    const old = beginChatScopeTransition(TARGET.conversationId, "files-a");
    const current = beginChatScopeTransition(TARGET.conversationId, "files-a");
    const other = beginChatScopeTransition(TARGET.conversationId, "files-b");
    old.settle(true);
    other.settle(false);
    current.settle(true);
    expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
    const recovery = beginChatScopeTransition(TARGET.conversationId, "files-b");
    expect(chatScopeTransition(TARGET.conversationId)).toBe("pending");
    recovery.settle(true);
    expect(chatScopeTransition(TARGET.conversationId)).toBeUndefined();
  });
});

describe("chat window runtime identity", () => {
  it("retains the exact chat and project identity for normal window actions", () => {
    const unregister = registerChatWindowRuntime("chat-window", TARGET);
    expect(chatWindowRuntimeTarget("chat-window")).toEqual(TARGET);
    unregister();
    expect(chatWindowRuntimeTarget("chat-window")).toBeUndefined();
  });

  it("does not let an obsolete registration remove its replacement", () => {
    const releaseFirst = registerChatWindowRuntime("chat-window", TARGET);
    const replacement = { conversationId: "chat-b", projectPath: "/other" };
    const releaseSecond = registerChatWindowRuntime("chat-window", replacement);
    releaseFirst();
    expect(chatWindowRuntimeTarget("chat-window")).toEqual(replacement);
    releaseSecond();
    expect(chatWindowRuntimeTarget("chat-window")).toBeUndefined();
  });
});

describe("chat grounding activity", () => {
  it("preserves folder grounding activity intensity", () => {
    expect(
      groundingIntensity({
        groundingKind: "connected-context",
        contextPack: { usage: { filesRead: 4, excerptBytes: 0 } },
      }),
    ).toBe("heavy");
    expect(
      groundingIntensity({
        groundingKind: "connected-context",
        contextPack: { usage: { filesRead: 1, excerptBytes: 100 } },
      }),
    ).toBe("light");
  });

  it("preserves hybrid and knowledge grounding intensity", () => {
    expect(
      groundingIntensity({
        groundingKind: "hybrid",
        contextPack: {
          folder: { usage: { filesRead: 1, excerptBytes: 100 } },
          knowledge: { referencesUsed: 4 },
        },
      }),
    ).toBe("heavy");
    expect(
      groundingIntensity({ groundingKind: "local-knowledge", contextPack: { referencesUsed: 1 } }),
    ).toBe("light");
  });
});
