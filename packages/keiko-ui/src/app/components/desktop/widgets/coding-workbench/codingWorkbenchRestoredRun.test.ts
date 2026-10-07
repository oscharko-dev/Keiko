import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES,
  validateCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { ClientDiagnosticMeta } from "@/lib/client-diagnostics";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import {
  eventsWithRestoredSettlement,
  restoreConversation,
  transcriptShows,
  useRestoredRunTimeline,
  type RestoredConversation,
} from "./codingWorkbenchRestoredRun";
import { largestHolding } from "./_restoredConversationTestSupport";

// A counting wrapper around the real character stripping: the restoration's cost is judged by how
// many stored messages it strips, and how much text it hands over to be stripped (#3876 review).
vi.mock("@oscharko-dev/keiko-contracts/text-safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-contracts/text-safety")>();
  return { ...actual, stripUnsafeFormatChars: vi.fn(actual.stripUnsafeFormatChars) };
});

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

describe("restoreConversation", () => {
  const history = detail([
    message("m-1", "run-6", "user", "Earlier request"),
    message("m-2", "run-7", "user", "Repair the parser"),
    message("m-3", "run-7", "system", "hidden"),
    message("m-4", "run-7", "assistant", "  "),
    message("m-5", "run-7", "assistant", "I read the parser."),
  ]);

  it("restores only the settled run's own visible conversation", () => {
    const restoration = restoreConversation(snapshot("failed"), history);
    if (restoration === null) throw new TypeError("expected a restored conversation");
    const [turn] = restoration.feed.turns;

    expect(restoration.feed).toMatchObject({
      availability: "available",
      runId: "run-7",
      truncated: false,
    });
    expect(restoration.feed.turns).toHaveLength(1);
    expect(turn?.tools).toEqual([]);
    expect(turn?.messages.map((entry) => [entry.messageId, entry.role])).toEqual([
      ["m-2", "user"],
      ["m-5", "assistant"],
    ]);
    expect(turn?.messages[1]?.segments).toEqual([
      { kind: "text", text: "I read the parser.", truncated: false },
    ]);
    expect(restoration.overflowMessageIds.size).toBe(0);
  });

  it("restores nothing for a live run, an unloaded history or a snapshot without a run", () => {
    expect(restoreConversation(snapshot("running"), history)).toBeNull();
    expect(restoreConversation(snapshot("failed"), null)).toBeNull();
    expect(restoreConversation(null, history)).toBeNull();
    expect(restoreConversation(snapshot("failed", { runId: undefined }), history)).toBeNull();
  });

  it("restores nothing when history holds no message of the run", () => {
    const earlier = detail([message("m-1", "run-6", "user", "Earlier request")]);
    expect(restoreConversation(snapshot("failed"), earlier)).toBeNull();
    expect(restoreConversation(snapshot("failed"), detail([]))).toBeNull();
  });

  it("restores nothing for a run whose messages hold no text once the contract's refused characters go", () => {
    const blank = detail([
      message("m-1", "run-7", "user", "  \n "),
      message("m-2", "run-7", "assistant", String.fromCodePoint(0x202e, 0x200b, 0x07)),
      message("m-3", "run-7", "system", "hidden"),
    ]);
    expect(restoreConversation(snapshot("failed"), blank)).toBeNull();
  });
});

// The transcript shows what the timeline does not: the messages of every other run, and of the
// shown run only those its feed could not carry (#3876 review).
describe("transcriptShows", () => {
  const own = message("m-2", "run-7", "user", "Repair the parser");
  const earlier = message("m-1", "run-6", "user", "Earlier request");
  const unbound = { ...message("m-0", "run-7", "user", "Loose"), runId: undefined };

  it("shows every message when no run is shown, a message without a run included", () => {
    for (const entry of [own, earlier, unbound]) {
      expect(transcriptShows(undefined, entry)).toBe(true);
    }
  });

  it("hides the shown run's messages except its overflow, and never another run's", () => {
    const shown = { runId: "run-7", overflowMessageIds: new Set(["m-9"]) };
    expect(transcriptShows(shown, own)).toBe(false);
    expect(transcriptShows(shown, { ...own, id: "m-9" })).toBe(true);
    expect(transcriptShows(shown, earlier)).toBe(true);
    expect(transcriptShows(shown, unbound)).toBe(true);
  });
});

// The hook decides which feed the timeline shows and tells the transcript what that feed carries.
describe("useRestoredRunTimeline", () => {
  const history = detail([
    message("m-1", "run-6", "user", "Earlier request"),
    message("m-2", "run-7", "user", "Repair the parser"),
    message("m-3", "run-7", "assistant", "I read the parser."),
  ]);
  const idle: UseCodingWorkbenchSafeActivityResult = {
    status: "idle",
    feed: null,
    errorCode: null,
    retry: vi.fn(),
  };
  const writes: { message: string; meta: ClientDiagnosticMeta | undefined }[] = [];

  afterEach(() => {
    writes.length = 0;
    resetClientDiagnosticWriter();
  });

  function timelineOf(
    activity: UseCodingWorkbenchSafeActivityResult,
    runState: CodingWorkbenchRuntimeStateName = "failed",
  ): ReturnType<typeof useRestoredRunTimeline> {
    setClientDiagnosticWriter((text, meta) => writes.push({ message: text, meta }));
    return renderHook(() => useRestoredRunTimeline([], snapshot(runState), activity, history))
      .result.current;
  }

  it("keeps the feed the server holds, which carries the run's whole conversation", () => {
    const held = { runId: "run-7", availability: "available" } as AvailableCodingSafeActivityFeed;
    const timeline = timelineOf({ ...idle, feed: held });

    expect(timeline.activity.feed).toBe(held);
    expect(timeline.shownRun).toEqual({ runId: "run-7", overflowMessageIds: new Set() });
    expect(writes).toHaveLength(0);
  });

  it("names no shown run for a live run without a feed, and restores nothing for it", () => {
    const timeline = timelineOf(idle, "running");
    expect(timeline.shownRun).toBeUndefined();
    expect(timeline.activity.feed).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("restores the feed a settled run lost and names the messages the transcript must keep", () => {
    const timeline = timelineOf(idle);

    expect(timeline.activity.feed?.turns.flatMap((turn) => turn.messages)).toHaveLength(2);
    expect(timeline.shownRun).toEqual({ runId: "run-7", overflowMessageIds: new Set() });
    expect(timeline.events.at(-1)).toMatchObject({ kind: "status", state: "failed" });
  });

  it("reports the restoration once, as counts under the run's id, and again for a new one", () => {
    setClientDiagnosticWriter((text, meta) => writes.push({ message: text, meta }));
    const props = { snapshot: snapshot("failed"), detail: history };
    const { rerender } = renderHook(
      ({ snapshot: current, detail: stored }) => useRestoredRunTimeline([], current, idle, stored),
      { initialProps: props },
    );
    // A new snapshot object for the same settled run is the same restoration.
    rerender({ ...props, snapshot: snapshot("failed", { revision: 10 }) });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.meta?.correlationId).toBe("run-7");
    expect(writes[0]?.meta?.codingRunRestore).toEqual({
      timelineCount: 2,
      transcriptCount: 0,
      cutCount: 0,
      turnCount: 1,
      feedBytes: expect.any(Number) as number,
      transcriptChars: 0,
      historyTruncated: false,
    });

    rerender({ ...props, detail: { ...history, truncated: true } });
    expect(writes).toHaveLength(2);
    expect(writes[1]?.meta?.codingRunRestore?.historyTruncated).toBe(true);
  });
});

// #3873 review: the restored feed claimed `truncated: false` and applied no bound, although Coding
// History lists at most 200 messages of up to 65,536 characters each and says when it cut a task's
// history (`CodingHistoryDetail.truncated`). The feed reaches a renderer written for the safe
// activity contract's bounded input, so it keeps to those bounds. Every expectation below that a
// restored feed is valid asks the contract's own validator, never a restated limit.
describe("restoreConversation bounds and truncation", () => {
  function restoration(messages: readonly ChatMessage[], truncated = false): RestoredConversation {
    const restoredConversation = restoreConversation(
      snapshot("failed"),
      detail(messages, truncated),
    );
    if (restoredConversation === null) throw new TypeError("expected a restored conversation");
    return restoredConversation;
  }

  function restored(
    messages: readonly ChatMessage[],
    truncated = false,
  ): AvailableCodingSafeActivityFeed {
    return restoration(messages, truncated).feed;
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

  // #3876 review (PRRT_kwDOSqilAM6px-aO): the next three used to pin that a bound DROPPED the older
  // messages and flagged the turn — and the Window then hid the whole run from the transcript, so
  // the dropped messages were shown nowhere. What they guard is unchanged and now stricter: the feed
  // stays inside the contract's bounds, and nothing a bound leaves out is lost. The feed packs the
  // newest messages into as many turns as the bounds admit and names every older message, so the
  // transcript shows it whole. Where a message is shown is judged at the Window, in its own suite.
  it("carries a run holding more messages than one turn admits across turns, losing none", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(
        `m-${String(index)}`,
        "run-7",
        index % 2 === 0 ? "user" : "assistant",
        `Step ${String(index)}`,
      ),
    );
    const { feed, overflowMessageIds } = restoration(messages);
    expect(restoredMessages(feed).map((entry) => entry.messageId)).toEqual(
      messages.map((entry) => entry.id),
    );
    // The feed fills from the newest message backwards, so the oldest turn takes the remainder.
    expect(feed.turns.map((turn) => turn.messages.length)).toEqual([
      messages.length - 2 * CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
      CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
      CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
    ]);
    expect(overflowMessageIds.size).toBe(0);
    // Nothing was dropped or cut, so nothing reads as truncated.
    expect(feed.truncated).toBe(false);
    expect(feed.turns.some((turn) => turn.truncated)).toBe(false);
    expectContractValid(feed);
  });

  it("carries a conversation beyond one turn's byte bound that fits the feed, losing none", () => {
    // The reviewer's probe: the operator's prompt, then three answers with two follow-ups between
    // them, together beyond one turn and within the feed. Sized from the contract's own bounds.
    const answer = "a".repeat(Math.floor(CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES / 3));
    const messages = [
      message("m-0", "run-7", "user", "Repair the parser"),
      message("m-1", "run-7", "assistant", `A1 ${answer}`),
      message("m-2", "run-7", "user", "Also handle commas"),
      message("m-3", "run-7", "assistant", `A2 ${answer}`),
      message("m-4", "run-7", "user", "And the quotes"),
      message("m-5", "run-7", "assistant", `A3 ${answer}`),
    ];
    const { feed, overflowMessageIds, counts } = restoration(messages);

    expect(restoredMessages(feed).map((entry) => entry.messageId)).toEqual(
      messages.map((entry) => entry.id),
    );
    expect(feed.turns.length).toBeGreaterThan(1);
    expect(overflowMessageIds.size).toBe(0);
    expect(counts).toMatchObject({ timelineCount: 6, transcriptCount: 0, cutCount: 0 });
    expect(counts.turnCount).toBe(feed.turns.length);
    expect(feed.truncated).toBe(false);
    expect(feed.turns.some((turn) => turn.truncated)).toBe(false);
    expectContractValid(feed);
  });

  it("names the older messages the whole feed cannot carry, keeps the newest, and cuts nothing", () => {
    const body = "z".repeat(12_000);
    const messages = Array.from({ length: 8 }, (_, index) =>
      message(`m-${String(index)}`, "run-7", "assistant", `${String(index)}${body}`),
    );
    const { feed, overflowMessageIds, counts } = restoration(messages);
    const kept = restoredMessages(feed).map((entry) => entry.messageId);

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(messages.length);
    // The feed holds the newest messages, in order; the overflow is exactly the older ones.
    expect(kept).toEqual(messages.slice(-kept.length).map((entry) => entry.id));
    expect([...overflowMessageIds]).toEqual(
      messages.slice(0, messages.length - kept.length).map((entry) => entry.id),
    );
    expect(restoredMessages(feed).every((entry) => !entry.truncated)).toBe(true);
    // What the feed leaves out is shown whole in the transcript: nothing is lost, nothing is flagged.
    expect(feed.truncated).toBe(false);
    expect(feed.turns.some((turn) => turn.truncated)).toBe(false);
    expect(counts.timelineCount + counts.transcriptCount).toBe(messages.length);
    expect(counts.transcriptChars).toBeGreaterThanOrEqual(counts.transcriptCount * body.length);
    expectContractValid(feed);
  });

  it("uses the contract's whole feed budget: one byte more moves the oldest message out", () => {
    // Fillers of one segment each, and an oldest message `edge` of one segment whose size grows by
    // exactly one byte per character. The production projection finds where it draws the line; the
    // contract's own measure and validator say that line is the contract's.
    const fillers = (count: number): ChatMessage[] =>
      Array.from({ length: count }, (_, index) =>
        message(`f-${String(index)}`, "run-7", "assistant", "f".repeat(1_000)),
      );
    const withEdge = (count: number, chars: number): ChatMessage[] => [
      message("edge", "run-7", "user", "e".repeat(chars)),
      ...fillers(count),
    ];
    const carriesAll = (messages: readonly ChatMessage[]): boolean =>
      restoration(messages).overflowMessageIds.size === 0;
    const count = largestHolding(1, 400, (candidate) => carriesAll(withEdge(candidate, 1)));
    expect(count).toBeLessThan(400);
    const edge = largestHolding(1, CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS, (chars) =>
      carriesAll(withEdge(count, chars)),
    );
    expect(edge).toBeLessThan(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS);

    const exact = restoration(withEdge(count, edge));
    expect(exact.overflowMessageIds.size).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(exact.feed))).toHaveLength(
      CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES,
    );
    expectContractValid(exact.feed);
    // One character more is over the contract's budget...
    const over: AvailableCodingSafeActivityFeed = {
      ...exact.feed,
      turns: exact.feed.turns.map((turn, turnIndex) => ({
        ...turn,
        messages: turn.messages.map((entry, entryIndex) =>
          turnIndex === 0 && entryIndex === 0
            ? {
                ...entry,
                segments: entry.segments.map((segment) => ({
                  ...segment,
                  text: `${segment.text}e`,
                })),
              }
            : entry,
        ),
      })),
    };
    const verdict = validateCodingSafeActivityFeed(over);
    expect(verdict.ok ? [] : verdict.errors).toEqual([
      "safeActivityFeed exceeds the aggregate UTF-8 byte budget",
    ]);
    // ...and the projection moves exactly that message, the oldest, to the transcript.
    const spilled = restoration(withEdge(count, edge + 1));
    expect([...spilled.overflowMessageIds]).toEqual(["edge"]);
    expect(restoredMessages(spilled.feed)).toHaveLength(count);
    expectContractValid(spilled.feed);
  });

  it("counts the restoration in messages, turns and bytes, never in text", () => {
    const cutText = "The parser splits on commas. ".repeat(2_300);
    const { feed, counts } = restoration(
      [
        message("m-1", "run-7", "user", "Repair the parser"),
        message("m-2", "run-7", "assistant", cutText),
      ],
      true,
    );

    expect(counts).toEqual({
      timelineCount: 2,
      transcriptCount: 0,
      cutCount: 1,
      turnCount: feed.turns.length,
      feedBytes: new TextEncoder().encode(JSON.stringify(feed)).length,
      transcriptChars: 0,
      historyTruncated: true,
    });
    expect(JSON.stringify(counts)).not.toContain("parser");
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
    const { feed, overflowMessageIds, counts } = restoration(messages, true);
    const kept = restoredMessages(feed).map((entry) => entry.messageId);
    expect(feed.truncated).toBe(true);
    expect(feed.turns[0]?.truncated).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    // Whatever the bounds cannot carry, the transcript carries whole: the two sets split the run.
    expect(kept).toEqual(messages.slice(-kept.length).map((entry) => entry.id));
    expect([...overflowMessageIds]).toEqual(
      messages.slice(0, messages.length - kept.length).map((entry) => entry.id),
    );
    expect(counts.timelineCount + counts.transcriptCount).toBe(messages.length);
    expect(counts.transcriptChars).toBe(counts.transcriptCount * 65_536);
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

  // #3876 review (PRRT_kwDOSqilAM6pyd43): the restoration stripped, trimmed and dated every stored
  // message of the run before the bounds dropped most of them — about 220 ms for 200 messages of
  // 65,536 characters, one-off but needless. Its work now follows the bounds from the newest end:
  // it examines the messages the feed carries and the one that ends the packing, and names what is
  // older by position alone. The cost is judged by what the restoration does, not by a stopwatch.
  describe("the work a restoration does", () => {
    const stripped = vi.mocked(stripUnsafeFormatChars);
    beforeEach(() => {
      stripped.mockClear();
    });

    // Message `index` of a run of `count` maximum-size messages; the oldest `unreachable` of them
    // hold a timestamp no message can be dated from, so examining one throws.
    function hugeRun(count: number, unreachable: number): ChatMessage[] {
      return Array.from({ length: count }, (_, index) => {
        const entry = message(
          `m-${String(index)}`,
          "run-7",
          index % 2 === 0 ? "user" : "assistant",
          "w".repeat(65_536),
        );
        return index < unreachable ? { ...entry, timestamp: Number.NaN } : entry;
      });
    }

    it("strips only the messages the feed carries and the one that ends the packing", () => {
      const { counts, overflowMessageIds } = restoration(hugeRun(200, 100));

      expect(counts.transcriptCount).toBeGreaterThan(100);
      expect(overflowMessageIds.size).toBe(counts.transcriptCount);
      expect(stripped).toHaveBeenCalledTimes(counts.timelineCount + 1);
      const handed = stripped.mock.calls.reduce((chars, [text]) => chars + text.length, 0);
      expect(handed).toBe((counts.timelineCount + 1) * 65_536);
    });

    it("never dates, strips or bisects a message older than the one that ends the packing", () => {
      // Every message but the newest ten is unreachable: dating any of them throws a RangeError.
      const { counts, overflowMessageIds } = restoration(hugeRun(200, 190));

      expect(counts.timelineCount).toBeLessThan(10);
      expect(overflowMessageIds.size).toBe(200 - counts.timelineCount);
      expect(stripped.mock.calls.length).toBeLessThanOrEqual(counts.timelineCount + 1);
    });

    it("strips a run that fits whole once per message and a run of one message once", () => {
      const run = Array.from({ length: 4 }, (_, index) =>
        message(`m-${String(index)}`, "run-7", "assistant", `Step ${String(index)}`),
      );
      const { counts } = restoration(run);
      expect(counts).toMatchObject({ timelineCount: 4, transcriptCount: 0 });
      // Nothing ended the packing: every message was needed, none more than once.
      expect(stripped).toHaveBeenCalledTimes(4);

      stripped.mockClear();
      restoration([message("m-9", "run-7", "user", "Repair the parser")]);
      expect(stripped).toHaveBeenCalledTimes(1);
    });

    it("reads each blank message once and never carries one", () => {
      const blank = (id: string): ChatMessage => message(id, "run-7", "assistant", "  \n ");
      const { feed, counts } = restoration([
        message("m-1", "run-7", "user", "Repair the parser"),
        blank("m-2"),
        message("m-3", "run-7", "assistant", "Done."),
        blank("m-4"),
        blank("m-5"),
      ]);

      // The blanks between and after the carried messages are never carried; none is overflow.
      expect(restoredMessages(feed).map((entry) => entry.messageId)).toEqual(["m-1", "m-3"]);
      expect(counts).toMatchObject({ timelineCount: 2, transcriptCount: 0 });
      expect(stripped).toHaveBeenCalledTimes(5);
    });

    it("leaves whatever the feed does not reach to the transcript, blank or not, and nothing newer", () => {
      // A blank message older than the one that ends the packing is not examined, so it is named for
      // the transcript like every other older message; a blank one among the carried is hidden.
      const body = "z".repeat(12_000);
      const messages = [
        message("m-0", "run-7", "user", String.fromCodePoint(0x200b)),
        ...Array.from({ length: 6 }, (_, index) =>
          message(`m-${String(index + 1)}`, "run-7", "assistant", `${String(index)}${body}`),
        ),
        message("m-7", "run-7", "assistant", "  "),
        message("m-8", "run-7", "user", "Last follow-up"),
      ];
      const { feed, overflowMessageIds } = restoration(messages);
      const kept = restoredMessages(feed).map((entry) => entry.messageId);

      expect(kept.at(-1)).toBe("m-8");
      expect(kept).not.toContain("m-7");
      expect(overflowMessageIds.has("m-0")).toBe(true);
      expect(overflowMessageIds.has("m-7")).toBe(false);
      expect(overflowMessageIds.has("m-8")).toBe(false);
      // Carried, overflow and the one blank message among them make up the whole run.
      expect(kept.length + overflowMessageIds.size + 1).toBe(messages.length);
    });
  });
});
