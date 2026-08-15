import { describe, expect, it, vi } from "vitest";

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
});
