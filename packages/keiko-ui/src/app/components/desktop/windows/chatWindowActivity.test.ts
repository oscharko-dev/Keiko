import { describe, expect, it } from "vitest";

import {
  chatWindowRuntimeTarget,
  registerChatWindowRuntime,
  groundingIntensity,
} from "./chatWindowActivity";

const TARGET = { conversationId: "chat-a", projectPath: "/repo" };

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
