import { describe, expect, it } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage, CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  validateCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
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

function detail(messages: readonly ChatMessage[], truncated = false): CodingHistoryDetail {
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
    truncated,
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

// #3873 review: the restored feed claimed `truncated: false` and applied no bound, although Coding
// History lists at most 200 messages of up to 65,536 characters each and says when it cut a task's
// history (`CodingHistoryDetail.truncated`). The feed reaches a renderer written for the safe
// activity contract's bounded input, so it keeps to those bounds. Every expectation below that a
// restored feed is valid asks the contract's own validator, never a restated limit.
describe("feedWithRestoredConversation bounds and truncation", () => {
  function restored(
    messages: readonly ChatMessage[],
    truncated = false,
  ): AvailableCodingSafeActivityFeed {
    const feed = feedWithRestoredConversation(
      null,
      snapshot("failed"),
      detail(messages, truncated),
    );
    if (feed === null) throw new TypeError("expected a restored feed");
    return feed;
  }

  function expectContractValid(feed: AvailableCodingSafeActivityFeed): void {
    const verdict = validateCodingSafeActivityFeed(feed);
    expect(verdict.ok ? [] : verdict.errors).toEqual([]);
  }

  function restoredMessages(
    feed: AvailableCodingSafeActivityFeed,
  ): readonly CodingSafeActivityMessage[] {
    return feed.turns.flatMap((turn) => turn.messages);
  }

  function restoredText(restoredMessage: CodingSafeActivityMessage | undefined): string {
    return (restoredMessage?.segments ?? []).map((segment) => segment.text).join("");
  }

  it("reads as complete only when stored history was not cut", () => {
    const feed = restored([message("m-1", "run-7", "user", "Repair the parser")]);
    expect(feed.truncated).toBe(false);
    expect(feed.turns[0]?.truncated).toBe(false);
    expectContractValid(feed);
  });

  it("carries a cut stored history into the turn and the feed", () => {
    const feed = restored([message("m-1", "run-7", "user", "Repair the parser")], true);
    expect(feed.truncated).toBe(true);
    expect(feed.turns[0]?.truncated).toBe(true);
    expect(restoredMessages(feed)[0]?.truncated).toBe(false);
    expectContractValid(feed);
  });

  it("cuts a message above the contract's byte bound and says so on the message and its turn", () => {
    const feed = restored([
      message("m-1", "run-7", "assistant", "The parser splits on commas. ".repeat(2_300)),
    ]);
    const [cut] = restoredMessages(feed);
    expect(cut?.truncated).toBe(true);
    expect(cut?.segments.at(-1)?.truncated).toBe(true);
    expect(cut?.segments.slice(0, -1).every((segment) => !segment.truncated)).toBe(true);
    expect(cut?.segments.length ?? 0).toBeLessThanOrEqual(
      CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
    );
    expect(new TextEncoder().encode(JSON.stringify(cut)).length).toBeLessThanOrEqual(
      CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
    );
    expect(feed.turns[0]?.truncated).toBe(true);
    expect(feed.truncated).toBe(false);
    expectContractValid(feed);
  });

  it("keeps as much of a cut message as the bound admits, from its start", () => {
    const text = `${"x".repeat(65_535)}y`;
    const feed = restored([message("m-1", "run-7", "assistant", text)]);
    const kept = restoredText(restoredMessages(feed)[0]);
    expect(text.startsWith(kept)).toBe(true);
    // A message's skeleton is a few hundred bytes, so nearly the whole bound is text.
    expect(kept.length).toBeGreaterThan(CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES - 512);
    expectContractValid(feed);
  });

  it("splits long text into segments of at most the contract's length without losing any", () => {
    const text = "y".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS * 2 + 10);
    const feed = restored([message("m-1", "run-7", "assistant", text)]);
    const [first] = restoredMessages(feed);
    expect(first?.truncated).toBe(false);
    expect(first?.segments.map((segment) => segment.text.length)).toEqual([
      CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
      CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
      10,
    ]);
    expect(restoredText(first)).toBe(text);
    expect(feed.turns[0]?.truncated).toBe(false);
    expectContractValid(feed);
  });

  it("never splits a surrogate pair at a segment boundary or at the cut", () => {
    const boundary = `${"a".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS - 1)}😀${"b".repeat(40)}`;
    const pairs = "😀".repeat(20_000);
    for (const text of [boundary, pairs]) {
      const feed = restored([message("m-1", "run-7", "assistant", text)]);
      for (const segment of restoredMessages(feed)[0]?.segments ?? []) {
        expect(/\p{Surrogate}/u.test(segment.text)).toBe(false);
      }
      expectContractValid(feed);
    }
  });

  it("measures escaping and multi-byte text the way the contract does", () => {
    const hostile = '"quoted"\n\t\\é€😀\r\n'.repeat(8_000);
    const feed = restored([message("m-1", "run-7", "user", hostile)]);
    expect(restoredMessages(feed)[0]?.truncated).toBe(true);
    expectContractValid(feed);
  });

  it("removes the characters the contract refuses and drops a message left with no text", () => {
    const feed = restored([
      message("m-1", "run-7", "user", "Fix\u202eit\u200b now\u0007"),
      message("m-2", "run-7", "assistant", "\u202e\u200b\u0007  "),
      message("m-3", "run-7", "assistant", "Done."),
    ]);
    expect(restoredMessages(feed).map((entry) => entry.messageId)).toEqual(["m-1", "m-3"]);
    expect(restoredText(restoredMessages(feed)[0])).toBe("Fixit now");
    expect(feed.turns[0]?.truncated).toBe(false);
    expectContractValid(feed);
  });

  it("keeps the newest messages when the run holds more than the contract allows in a turn", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(
        `m-${String(index)}`,
        "run-7",
        index % 2 === 0 ? "user" : "assistant",
        `Step ${String(index)}`,
      ),
    );
    const feed = restored(messages);
    const kept = restoredMessages(feed).map((entry) => entry.messageId);
    expect(kept).toHaveLength(CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN);
    expect(kept).toEqual(
      messages.slice(-CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN).map((entry) => entry.id),
    );
    expect(feed.turns[0]?.truncated).toBe(true);
    expect(feed.truncated).toBe(false);
    expectContractValid(feed);
  });

  it("keeps the newest messages that fit the turn's byte bound and drops the older ones", () => {
    const body = "z".repeat(12_000);
    const messages = Array.from({ length: 6 }, (_, index) =>
      message(`m-${String(index)}`, "run-7", "assistant", `${String(index)}${body}`),
    );
    const feed = restored(messages);
    const kept = restoredMessages(feed).map((entry) => entry.messageId);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(messages.length);
    expect(kept).toEqual(messages.slice(-kept.length).map((entry) => entry.id));
    expect(restoredMessages(feed).every((entry) => !entry.truncated)).toBe(true);
    expect(feed.turns[0]?.truncated).toBe(true);
    expectContractValid(feed);
  });

  it("holds a worst-case history of 200 maximum-size messages to the contract", () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      message(
        `m-${String(index)}`,
        "run-7",
        index % 2 === 0 ? "user" : "assistant",
        "w".repeat(65_536),
      ),
    );
    const feed = restored(messages, true);
    expect(feed.truncated).toBe(true);
    expect(feed.turns[0]?.truncated).toBe(true);
    expect(restoredMessages(feed).length).toBeGreaterThan(0);
    expectContractValid(feed);
  });

  it("needs no separate segment clamp: a message's byte bound admits fewer segments than allowed", () => {
    // Every character costs at least one byte, so a message held to its byte bound cannot hold
    // more segments than the contract allows. A change of these constants that breaks that must
    // add the clamp to the restored feed.
    expect(CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES).toBeLessThanOrEqual(
      CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE * CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
    );
  });
});
