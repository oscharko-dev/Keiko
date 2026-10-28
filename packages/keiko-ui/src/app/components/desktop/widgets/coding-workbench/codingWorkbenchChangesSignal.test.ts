import { describe, expect, it } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityToolState,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";

import { changesRefreshSignal } from "./codingWorkbenchChangesSignal";

const AT = "2026-10-23T12:00:00.000Z";

function statusEvent(cursor: string): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor,
    sequence: 1,
    occurredAt: AT,
    kind: "status",
    runId: "run-1",
    state: "running",
    revision: 1,
  };
}

function runtimeEvent(
  cursor: string,
  eventKind: "diff-summarized" | "observation-streamed",
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor,
    sequence: 2,
    occurredAt: AT,
    kind: "runtime-event",
    runId: "run-1",
    state: "running",
    revision: 2,
    eventKind,
  };
}

function feed(
  tools: readonly { readonly tool: string; readonly state: CodingSafeActivityToolState }[],
  text = "Working",
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: [
      {
        turnId: "turn-1",
        messages: [
          {
            messageId: "message-1",
            role: "assistant",
            occurredAt: AT,
            segments: [{ kind: "text", text, truncated: false }],
            truncated: false,
          },
        ],
        tools: tools.map((tool, index) => ({
          callId: `call-${String(index)}`,
          occurredAt: AT,
          ...tool,
        })),
        truncated: false,
      },
    ],
    truncated: false,
    droppedEventCount: 0,
  };
}

describe("changesRefreshSignal", () => {
  it("is null while nothing has happened that could change the workspace", () => {
    expect(changesRefreshSignal([], null)).toBeNull();
    expect(changesRefreshSignal([runtimeEvent("c1", "observation-streamed")], null)).toBeNull();
    expect(changesRefreshSignal([], feed([]))).toBeNull();
  });

  it("changes with the newest status or diff-summarized event", () => {
    const first = changesRefreshSignal([statusEvent("c1")], null);
    const second = changesRefreshSignal([statusEvent("c1"), statusEvent("c2")], null);
    const diff = changesRefreshSignal(
      [statusEvent("c1"), runtimeEvent("c3", "diff-summarized")],
      null,
    );

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(diff).not.toBe(second);
    expect(changesRefreshSignal([statusEvent("c1")], null)).toBe(first);
  });

  // The native OpenCode edit tools change the workspace without emitting either event above.
  it.each(["edit", "write", "patch", "shell", "subagent", "linear.create_issue"])(
    "changes when a %s tool call settles",
    (tool) => {
      const running = changesRefreshSignal([], feed([{ tool, state: "running" }]));
      const settled = changesRefreshSignal([], feed([{ tool, state: "succeeded" }]));

      expect(settled).not.toBeNull();
      expect(settled).not.toBe(running);
    },
  );

  it.each<CodingSafeActivityToolState>(["succeeded", "failed", "denied", "cancelled"])(
    "counts a %s tool call as settled",
    (state) => {
      expect(changesRefreshSignal([], feed([{ tool: "shell", state }]))).not.toBe(
        changesRefreshSignal([], feed([{ tool: "shell", state: "pending" }])),
      );
    },
  );

  it("changes once per further settled tool call", () => {
    const one = changesRefreshSignal([], feed([{ tool: "edit", state: "succeeded" }]));
    const two = changesRefreshSignal(
      [],
      feed([
        { tool: "edit", state: "succeeded" },
        { tool: "write", state: "succeeded" },
      ]),
    );

    expect(two).not.toBe(one);
  });

  it.each([
    "read",
    "glob",
    "grep",
    "list",
    "skill",
    "todo",
    "question",
    "webfetch",
    "websearch",
    "keiko_git_status",
    "keiko_repository_search",
    "keiko_workspace_discover",
    "keiko_workspace_read",
  ])("ignores a settled read-only %s tool call", (tool) => {
    expect(changesRefreshSignal([], feed([{ tool, state: "succeeded" }]))).toBe(
      changesRefreshSignal([], feed([{ tool, state: "running" }])),
    );
  });

  it("ignores streamed answer text, which grows on every delta", () => {
    const tools = [{ tool: "edit", state: "succeeded" as const }];

    expect(changesRefreshSignal([], feed(tools, "A"))).toBe(
      changesRefreshSignal([], feed(tools, "A much longer streamed answer")),
    );
  });

  it("keeps the event cursor and the settled count apart", () => {
    const events = [statusEvent("c1")];
    const settled = feed([{ tool: "edit", state: "succeeded" }]);

    expect(changesRefreshSignal(events, settled)).not.toBe(changesRefreshSignal(events, null));
    expect(changesRefreshSignal(events, settled)).not.toBe(changesRefreshSignal([], settled));
  });

  // Stability audit item 4: a turn at its tool bound still holds the same number of settled tools
  // while the server displaces the oldest for each new call; only the feed's monotonic loss counter
  // moves, so the signal must follow it or the Changes list stops refreshing mid-run.
  it("keeps changing after the turn's tool list is saturated", () => {
    const saturated = Array.from({ length: 64 }, () => ({
      tool: "edit",
      state: "succeeded" as const,
    }));
    const before = changesRefreshSignal([], feed(saturated));
    const after = changesRefreshSignal([], { ...feed(saturated), droppedEventCount: 1 });
    const later = changesRefreshSignal([], { ...feed(saturated), droppedEventCount: 2 });

    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
    expect(later).not.toBe(after);
  });

  it("is unchanged by a feed that has dropped nothing", () => {
    expect(
      changesRefreshSignal([statusEvent("c1")], feed([{ tool: "edit", state: "succeeded" }])),
    ).toBe("c1|1");
  });
});
