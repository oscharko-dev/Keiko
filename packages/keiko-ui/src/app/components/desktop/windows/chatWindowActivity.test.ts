import { describe, expect, it, vi } from "vitest";

import { EDITOR_SELECTION_HANDOFF_TTL_MS } from "../editorSelectionHandoffPolicy";
import { registerChatWindowRuntime, routeSelectionHandoffToOpenChat } from "./chatWindowActivity";

function runtime(
  acceptSelectionHandoff: (selectionHandoffId: string) => void,
  acceptingSelectionHandoff = true,
): {
  readonly conversationId: string;
  readonly projectPath: string;
  readonly acceptingSelectionHandoff: boolean;
  readonly acceptSelectionHandoff: (selectionHandoffId: string) => void;
} {
  return {
    conversationId: "chat-a",
    projectPath: "/repo",
    acceptingSelectionHandoff,
    acceptSelectionHandoff,
  };
}

describe("chat window runtime routing", () => {
  it("queues overlapping selection handoffs on the reserved chat window", () => {
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterFirst = registerChatWindowRuntime("chat-window", runtime(firstConsumer));

    expect(routeSelectionHandoffToOpenChat("/repo", "selection-1")).toBe("chat-window");
    expect(routeSelectionHandoffToOpenChat("/repo", "selection-2")).toBe("chat-window");
    expect(firstConsumer).toHaveBeenCalledExactlyOnceWith("selection-1");

    unregisterFirst();
    const busyConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterBusy = registerChatWindowRuntime("chat-window", runtime(busyConsumer, false));
    expect(busyConsumer).not.toHaveBeenCalled();

    unregisterBusy();
    const readyConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterReady = registerChatWindowRuntime("chat-window", runtime(readyConsumer));
    expect(readyConsumer).toHaveBeenCalledExactlyOnceWith("selection-2");
    unregisterReady();
  });

  it("routes to the frontmost matching chat instead of registration order", () => {
    const backgroundConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const frontConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterBackground = registerChatWindowRuntime(
      "chat-background",
      runtime(backgroundConsumer),
    );
    const unregisterFront = registerChatWindowRuntime("chat-front", runtime(frontConsumer));

    expect(
      routeSelectionHandoffToOpenChat("/repo", "selection-front", [
        "chat-front",
        "chat-background",
      ]),
    ).toBe("chat-front");
    expect(frontConsumer).toHaveBeenCalledExactlyOnceWith("selection-front");
    expect(backgroundConsumer).not.toHaveBeenCalled();

    unregisterFront();
    unregisterBackground();
  });

  it("returns null when no registered chat belongs to the target project", () => {
    const consumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregister = registerChatWindowRuntime("chat-window", runtime(consumer));

    expect(routeSelectionHandoffToOpenChat("/other", "selection-other")).toBeNull();
    expect(consumer).not.toHaveBeenCalled();
    unregister();
  });

  it("re-routes a queued handoff when its reserved chat closes", async () => {
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const backupConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unavailable = vi.fn<() => void>();
    const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));
    const unregisterBackup = registerChatWindowRuntime("chat-backup", runtime(backupConsumer));

    expect(
      routeSelectionHandoffToOpenChat("/repo", "selection-active", ["chat-first"], unavailable),
    ).toBe("chat-first");
    expect(
      routeSelectionHandoffToOpenChat("/repo", "selection-queued", ["chat-first"], unavailable),
    ).toBe("chat-first");
    unregisterFirst();
    await Promise.resolve();

    expect(backupConsumer).toHaveBeenCalledExactlyOnceWith("selection-queued");
    expect(unavailable).not.toHaveBeenCalled();
    unregisterBackup();
  });

  it("notifies the caller when a queued handoff has no reroute destination", async () => {
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unavailable = vi.fn<() => void>();
    const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));

    routeSelectionHandoffToOpenChat("/repo", "selection-active", ["chat-first"], unavailable);
    routeSelectionHandoffToOpenChat("/repo", "selection-queued", ["chat-first"], unavailable);
    unregisterFirst();
    await Promise.resolve();

    expect(unavailable).toHaveBeenCalledExactlyOnceWith();
  });

  it("preserves abandonment cleanup across successive runtime closures", async () => {
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const backupConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unavailable = vi.fn<() => null>(() => null);
    const abandoned = vi.fn<() => void>();
    const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));
    const unregisterBackup = registerChatWindowRuntime(
      "chat-backup",
      runtime(backupConsumer, false),
    );

    routeSelectionHandoffToOpenChat("/repo", "selection-active", ["chat-first"]);
    routeSelectionHandoffToOpenChat(
      "/repo",
      "selection-queued",
      ["chat-first", "chat-backup"],
      unavailable,
      abandoned,
    );
    unregisterFirst();
    await Promise.resolve();
    expect(backupConsumer).not.toHaveBeenCalled();

    unregisterBackup();
    await Promise.resolve();
    expect(unavailable).toHaveBeenCalledExactlyOnceWith();
    expect(abandoned).toHaveBeenCalledExactlyOnceWith();
  });

  it("stages multiple queued handoffs behind one replacement runtime", async () => {
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const openFallback = vi.fn<() => string | null>(() => "chat-fallback");
    const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));

    routeSelectionHandoffToOpenChat("/repo", "selection-active", ["chat-first"], openFallback);
    routeSelectionHandoffToOpenChat("/repo", "selection-queued-1", ["chat-first"], openFallback);
    routeSelectionHandoffToOpenChat("/repo", "selection-queued-2", ["chat-first"], openFallback);
    unregisterFirst();
    await Promise.resolve();

    expect(openFallback).toHaveBeenCalledExactlyOnceWith();
    const busyConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterBusy = registerChatWindowRuntime("chat-fallback", runtime(busyConsumer, false));
    expect(busyConsumer).not.toHaveBeenCalled();

    unregisterBusy();
    const readyConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterReady = registerChatWindowRuntime("chat-fallback", runtime(readyConsumer));
    expect(readyConsumer).toHaveBeenCalledExactlyOnceWith("selection-queued-2");
    unregisterReady();
  });

  it("bounds staged handoffs globally across replacement runtime targets", async () => {
    vi.useFakeTimers();
    try {
      const abandonedFirst = vi.fn<() => void>();
      const abandonedSecond = vi.fn<() => void>();
      const batches = [
        { source: "source-first", fallback: "fallback-first", abandoned: abandonedFirst },
        { source: "source-second", fallback: "fallback-second", abandoned: abandonedSecond },
      ];

      for (const [batchIndex, batch] of batches.entries()) {
        const consumer = vi.fn<(selectionHandoffId: string) => void>();
        const openFallback = vi.fn<() => string>(() => batch.fallback);
        const unregister = registerChatWindowRuntime(batch.source, runtime(consumer));
        routeSelectionHandoffToOpenChat("/repo", `active-${String(batchIndex)}`, [batch.source]);
        routeSelectionHandoffToOpenChat(
          "/repo",
          `fallback-${String(batchIndex)}`,
          [batch.source],
          openFallback,
        );
        for (let handoffIndex = 0; handoffIndex < 33; handoffIndex += 1) {
          routeSelectionHandoffToOpenChat(
            "/repo",
            `staged-${String(batchIndex)}-${String(handoffIndex)}`,
            [batch.source],
            openFallback,
            batch.abandoned,
          );
        }
        unregister();
        await Promise.resolve();
        expect(openFallback).toHaveBeenCalledExactlyOnceWith();
      }

      expect(abandonedFirst).toHaveBeenCalledTimes(33);
      expect(abandonedSecond).not.toHaveBeenCalled();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("rejects an empty replacement runtime id without staging the handoff", async () => {
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const invalidFallback = vi.fn<() => string>(() => "");
    const abandoned = vi.fn<() => void>();
    const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));

    routeSelectionHandoffToOpenChat("/repo", "selection-active", ["chat-first"]);
    routeSelectionHandoffToOpenChat(
      "/repo",
      "selection-queued",
      ["chat-first"],
      invalidFallback,
      abandoned,
    );
    unregisterFirst();
    await Promise.resolve();

    expect(invalidFallback).toHaveBeenCalledExactlyOnceWith();
    expect(abandoned).toHaveBeenCalledExactlyOnceWith();
    const emptyIdConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterEmptyId = registerChatWindowRuntime("", runtime(emptyIdConsumer));
    expect(emptyIdConsumer).not.toHaveBeenCalled();
    unregisterEmptyId();
  });

  it("abandons staged handoffs when a replacement runtime never registers", async () => {
    vi.useFakeTimers();
    try {
      const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
      const openFallback = vi.fn<() => string>(() => "chat-never-registers");
      const abandoned = vi.fn<() => void>();
      const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));

      routeSelectionHandoffToOpenChat("/repo", "selection-active", ["chat-first"]);
      routeSelectionHandoffToOpenChat("/repo", "selection-fallback", ["chat-first"], openFallback);
      routeSelectionHandoffToOpenChat(
        "/repo",
        "selection-staged",
        ["chat-first"],
        openFallback,
        abandoned,
      );
      unregisterFirst();
      await Promise.resolve();

      expect(openFallback).toHaveBeenCalledExactlyOnceWith();
      await vi.advanceTimersByTimeAsync(EDITOR_SELECTION_HANDOFF_TTL_MS - 1);
      expect(abandoned).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(abandoned).toHaveBeenCalledExactlyOnceWith();
      const lateConsumer = vi.fn<(selectionHandoffId: string) => void>();
      const unregisterLate = registerChatWindowRuntime(
        "chat-never-registers",
        runtime(lateConsumer),
      );
      expect(lateConsumer).not.toHaveBeenCalled();
      unregisterLate();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves front-to-back preference when rerouting a queued handoff", async () => {
    const backgroundConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const frontConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const firstConsumer = vi.fn<(selectionHandoffId: string) => void>();
    const unregisterBackground = registerChatWindowRuntime(
      "chat-background",
      runtime(backgroundConsumer),
    );
    const unregisterFront = registerChatWindowRuntime("chat-front", runtime(frontConsumer));
    const unregisterFirst = registerChatWindowRuntime("chat-first", runtime(firstConsumer));
    const preferred = ["chat-first", "chat-front", "chat-background"];

    routeSelectionHandoffToOpenChat("/repo", "selection-active", preferred);
    routeSelectionHandoffToOpenChat("/repo", "selection-queued", preferred);
    unregisterFirst();
    await Promise.resolve();

    expect(frontConsumer).toHaveBeenCalledExactlyOnceWith("selection-queued");
    expect(backgroundConsumer).not.toHaveBeenCalled();
    unregisterFront();
    unregisterBackground();
  });
});
