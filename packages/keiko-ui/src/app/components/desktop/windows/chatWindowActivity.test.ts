import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chatWindowRuntimeTarget,
  registerChatWindowRuntime,
  groundingIntensity,
  beginChatScopeTransition,
  chatScopeTransition,
  clearChatScopeTransitions,
  releaseFailedChatScopeTransition,
  releaseObsoleteFailedChatScopeTransitions,
  releaseDetachedFailedChatScopeTransitions,
  chatScopeSourceTransition,
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

  it("releases only an explicitly forgotten failed source and refuses pending work", () => {
    const failed = beginChatScopeTransition(TARGET.conversationId, "files-a");
    const pending = beginChatScopeTransition(TARGET.conversationId, "files-b");
    failed.settle(false);
    expect(releaseFailedChatScopeTransition(TARGET.conversationId, "files-b")).toBe(false);
    expect(releaseFailedChatScopeTransition(TARGET.conversationId, "files-a")).toBe(true);
    expect(chatScopeTransition(TARGET.conversationId)).toBe("pending");
    pending.settle(false);
    expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
    expect(releaseFailedChatScopeTransition("other-chat", "files-b")).toBe(true);
    expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
    expect(releaseFailedChatScopeTransition(TARGET.conversationId, "files-b")).toBe(true);
    expect(chatScopeTransition(TARGET.conversationId)).toBeUndefined();
    expect(releaseFailedChatScopeTransition(TARGET.conversationId, "files-b")).toBe(true);
  });

  it("retires only settled obsolete owners while independent and pending holds remain", () => {
    let current = true;
    const failed = beginChatScopeTransition(TARGET.conversationId, "files-a", () => current);
    const pending = beginChatScopeTransition(TARGET.conversationId, "files-b", () => current);
    const independent = beginChatScopeTransition(TARGET.conversationId, "files-c");
    failed.settle(false);
    independent.settle(false);
    current = false;
    releaseObsoleteFailedChatScopeTransitions();
    expect(chatScopeSourceTransition(TARGET.conversationId, "files-a")).toBeUndefined();
    expect(chatScopeSourceTransition(TARGET.conversationId, "files-b")).toBe("pending");
    expect(chatScopeSourceTransition(TARGET.conversationId, "files-c")).toBe("failed");
    pending.settle(false);
    expect(chatScopeSourceTransition(TARGET.conversationId, "files-b")).toBeUndefined();
    expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
  });

  it("does not let an obsolete owner's settlement release its newer replacement", () => {
    const obsolete = beginChatScopeTransition(TARGET.conversationId, "files-a", () => false);
    const current = beginChatScopeTransition(TARGET.conversationId, "files-a");
    current.settle(false);
    obsolete.settle(true);
    releaseObsoleteFailedChatScopeTransitions();
    expect(chatScopeTransition(TARGET.conversationId)).toBe("failed");
  });
});

describe("verified detached source recovery", () => {
  it("releases only failed detached intents for the verified owner", () => {
    const failed = beginChatScopeTransition(
      TARGET.conversationId,
      "old-edge",
      () => true,
      () => "source-a",
    );
    const live = beginChatScopeTransition(
      TARGET.conversationId,
      "live-edge",
      () => true,
      () => "source-a",
    );
    const pending = beginChatScopeTransition(
      TARGET.conversationId,
      "pending-edge",
      () => true,
      () => "source-a",
    );
    const independent = beginChatScopeTransition(
      TARGET.conversationId,
      "other-edge",
      () => true,
      () => "source-b",
    );
    const unowned = beginChatScopeTransition(TARGET.conversationId, "unowned-edge");
    failed.settle(false);
    live.settle(false);
    independent.settle(false);
    unowned.settle(false);
    releaseDetachedFailedChatScopeTransitions("other-chat", "source-a", new Set());
    expect(chatScopeSourceTransition(TARGET.conversationId, "old-edge")).toBe("failed");
    releaseDetachedFailedChatScopeTransitions(
      TARGET.conversationId,
      "source-a",
      new Set(["live-edge"]),
    );
    expect(chatScopeSourceTransition(TARGET.conversationId, "old-edge")).toBeUndefined();
    expect(chatScopeSourceTransition(TARGET.conversationId, "live-edge")).toBe("failed");
    expect(chatScopeSourceTransition(TARGET.conversationId, "pending-edge")).toBe("pending");
    expect(chatScopeSourceTransition(TARGET.conversationId, "other-edge")).toBe("failed");
    expect(chatScopeSourceTransition(TARGET.conversationId, "unowned-edge")).toBe("failed");
    pending.settle(false);
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
