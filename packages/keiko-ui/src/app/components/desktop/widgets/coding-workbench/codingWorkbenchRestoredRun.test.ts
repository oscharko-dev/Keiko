import { describe, expect, it } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage, CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  eventsWithRestoredSettlement,
  feedWithRestoredConversation,
} from "./codingWorkbenchRestoredRun";

const SETTLED_AT = "2026-10-06T10:12:05.000Z";

function snapshot(
  state: CodingWorkbenchRuntimeStateName,
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state,
    revision: 9,
    updatedAt: SETTLED_AT,
    runId: "run-7",
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function status(
  sequence: number,
  state: CodingWorkbenchRuntimeStateName,
  runId = "run-7",
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `${runId}:${String(sequence)}`,
    sequence,
    occurredAt: SETTLED_AT,
    kind: "status",
    runId,
    state,
    revision: sequence + 1,
  };
}

function message(
  id: string,
  runId: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id,
    chatId: "task-7",
    role,
    content,
    timestamp: Date.parse("2026-10-06T10:00:00.000Z"),
    runId,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function detail(messages: readonly ChatMessage[]): CodingHistoryDetail {
  return {
    task: {
      id: "task-7",
      title: "Repair the parser",
      projectPath: "/repo",
      modelId: "gemma-4-31b-it",
      branch: "issue/7",
      workspaceId: "workspace-1",
      taskId: "task-1",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    },
    messages,
    truncated: false,
  };
}

describe("eventsWithRestoredSettlement", () => {
  it("completes a restored settled run with its settlement and failure code", () => {
    const events = [status(0, "starting"), status(3, "running")];
    const restored = eventsWithRestoredSettlement(
      events,
      snapshot("failed", { failureCode: "runtime-failed" }),
    );

    expect(restored.slice(0, 2)).toEqual(events);
    expect(restored[2]).toEqual({
      schemaVersion: "1",
      cursor: "run-7:settled",
      sequence: 4,
      occurredAt: SETTLED_AT,
      kind: "status",
      runId: "run-7",
      state: "failed",
      revision: 9,
      failureCode: "runtime-failed",
    });
  });

  it("adds a settlement without a failure code to an empty restored run", () => {
    const [settled] = eventsWithRestoredSettlement([], snapshot("succeeded"));
    expect(settled).toMatchObject({ kind: "status", state: "succeeded", sequence: 0 });
    expect(settled).not.toHaveProperty("failureCode");
  });

  it("leaves the events of a streamed settlement, a live run and an idle Workbench alone", () => {
    const streamed = [status(8, "failed")];
    expect(eventsWithRestoredSettlement(streamed, snapshot("failed"))).toBe(streamed);
    const live = [status(2, "running")];
    expect(eventsWithRestoredSettlement(live, snapshot("running"))).toBe(live);
    expect(eventsWithRestoredSettlement(live, null)).toBe(live);
    expect(eventsWithRestoredSettlement(live, snapshot("failed", { runId: undefined }))).toBe(live);
  });

  it("does not take another run's settlement for this run's", () => {
    const restored = eventsWithRestoredSettlement(
      [status(8, "failed", "run-6")],
      snapshot("failed"),
    );
    expect(restored).toHaveLength(2);
    expect(restored[1]).toMatchObject({ runId: "run-7", sequence: 0 });
  });
});

describe("feedWithRestoredConversation", () => {
  const history = detail([
    message("m-1", "run-6", "user", "Earlier request"),
    message("m-2", "run-7", "user", "Repair the parser"),
    message("m-3", "run-7", "system", "hidden"),
    message("m-4", "run-7", "assistant", "  "),
    message("m-5", "run-7", "assistant", "I read the parser."),
  ]);

  it("restores only the settled run's own visible conversation", () => {
    const feed = feedWithRestoredConversation(null, snapshot("failed"), history);

    expect(feed).toMatchObject({ availability: "available", runId: "run-7", truncated: false });
    expect(feed?.turns).toHaveLength(1);
    expect(feed?.turns[0]?.tools).toEqual([]);
    expect(feed?.turns[0]?.messages.map((entry) => [entry.messageId, entry.role])).toEqual([
      ["m-2", "user"],
      ["m-5", "assistant"],
    ]);
    expect(feed?.turns[0]?.messages[1]?.segments).toEqual([
      { kind: "text", text: "I read the parser.", truncated: false },
    ]);
  });

  it("keeps a feed the server still holds, and restores nothing for a live run", () => {
    const held = { runId: "run-7" } as AvailableCodingSafeActivityFeed;
    expect(feedWithRestoredConversation(held, snapshot("failed"), history)).toBe(held);
    expect(feedWithRestoredConversation(null, snapshot("running"), history)).toBeNull();
    expect(feedWithRestoredConversation(null, snapshot("failed"), null)).toBeNull();
  });

  it("restores nothing when history holds no message of the run", () => {
    const earlier = detail([message("m-1", "run-6", "user", "Earlier request")]);
    expect(feedWithRestoredConversation(null, snapshot("failed"), earlier)).toBeNull();
  });
});
