import { useMemo } from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityTextSegment,
  CodingSafeActivityTurn,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { ChatMessage, CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { settledRunState } from "./codingWorkbenchRunFacts";

// #3873 live review: after a reload a settled run showed only "Previous conversation" and
// "0 changed files". The runtime event stream is opened for live runs only, the server drops a
// settled run's ordinary events and expires its activity projection, so the timeline had nothing to
// show — not even how the run ended, although the restored snapshot carries exactly that. These
// helpers rebuild the run's timeline from what the server does keep: the settled snapshot and the
// conversation Coding History captured from the run's display projection.

function settledRunId(snapshot: CodingWorkbenchRuntimeSnapshot | null): string | undefined {
  return snapshot !== null && settledRunState(snapshot.state) ? snapshot.runId : undefined;
}

function heldSettlement(events: readonly CodingWorkbenchRuntimeSseEvent[], runId: string): boolean {
  return events.some(
    (event) => event.runId === runId && event.kind === "status" && settledRunState(event.state),
  );
}

/**
 * The run's events, completed with its settlement when the Workbench holds none: the settled
 * snapshot is the server's own terminal state, revision and failure code, shown as the terminal
 * status row the live stream would have delivered. A run whose settlement was streamed is unchanged.
 */
export function eventsWithRestoredSettlement(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
): readonly CodingWorkbenchRuntimeSseEvent[] {
  const runId = settledRunId(snapshot);
  if (snapshot === null || runId === undefined || heldSettlement(events, runId)) return events;
  const sequence = events.reduce(
    (next, event) => (event.runId === runId ? Math.max(next, event.sequence + 1) : next),
    0,
  );
  return [
    ...events,
    {
      schemaVersion: snapshot.schemaVersion,
      cursor: `${runId}:settled`,
      sequence,
      occurredAt: snapshot.updatedAt,
      kind: "status",
      runId,
      state: snapshot.state,
      revision: snapshot.revision,
      ...(snapshot.failureCode === undefined ? {} : { failureCode: snapshot.failureCode }),
    },
  ];
}

// The feed contract bounds what the timeline renders: a message serializes to at most
// CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES, a turn to at most ..._TURN_UTF8_BYTES with at most
// ..._MAX_MESSAGES_PER_TURN messages, and one text segment holds at most ..._TEXT_SEGMENT_CHARS
// characters of text free of bidi, zero-width and control characters. Coding History keeps up to
// 65,536 characters per message and lists up to 200 messages per task, so the restored feed is held
// to the same bounds, measured the way the contract measures them (UTF-8 bytes of the serialized
// object), and says so when it dropped or cut anything: a restored conversation never reads as
// complete when it is not (#3873 review). The byte bound of a message (16 KiB, one character is at
// least one byte) keeps it within the 32 segments the contract allows, so no segment count is
// enforced separately; the turn bound (32 KiB) keeps the whole feed within its 60 KiB.
function serializedBytes(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// The largest cut at or before `index` that does not split a surrogate pair in two: a code point
// above U+FFFF that starts just before the cut would be cut in the middle.
function safeCut(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const before = text.codePointAt(index - 1);
  return before !== undefined && before > 0xffff ? index - 1 : index;
}

function textSegments(text: string): CodingSafeActivityTextSegment[] {
  const segments: CodingSafeActivityTextSegment[] = [];
  for (let start = 0; start < text.length;) {
    const end = safeCut(text, start + CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS);
    segments.push({ kind: "text", text: text.slice(start, end), truncated: false });
    start = end;
  }
  return segments;
}

interface RestorableMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly occurredAt: string;
  /** The message's text, free of the characters the contract refuses. Never blank. */
  readonly text: string;
}

// A message holding `text`; when `cut`, the text was shortened to fit and its last segment says so.
function restoredMessage(
  source: RestorableMessage,
  text: string,
  cut: boolean,
): CodingSafeActivityMessage {
  const segments = textSegments(text);
  const last = segments.pop();
  return {
    messageId: source.messageId,
    role: source.role,
    occurredAt: source.occurredAt,
    segments: last === undefined ? segments : [...segments, { ...last, truncated: cut }],
    truncated: cut,
  };
}

// The message with as much of its text as the contract's per-message byte bound admits: the whole
// text when it fits, else the longest prefix that does, found by bisection on the contract's own
// measure so no escaping or overhead rule is restated here.
function fittedMessage(source: RestorableMessage): CodingSafeActivityMessage {
  const whole = restoredMessage(source, source.text, false);
  if (serializedBytes(whole) <= CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES) return whole;
  let fits = 0;
  let overflows = source.text.length;
  while (overflows - fits > 1) {
    const middle = Math.floor((fits + overflows) / 2);
    const candidate = restoredMessage(
      source,
      source.text.slice(0, safeCut(source.text, middle)),
      true,
    );
    if (serializedBytes(candidate) <= CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES) fits = middle;
    else overflows = middle;
  }
  return restoredMessage(source, source.text.slice(0, safeCut(source.text, fits)), true);
}

// The run's own conversation messages that can be shown, oldest first: user and assistant messages
// with text left once the characters the contract refuses are removed.
function restorableMessages(messages: readonly ChatMessage[], runId: string): RestorableMessage[] {
  return messages.flatMap((message) => {
    if (message.runId !== runId) return [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = stripUnsafeFormatChars(message.content);
    if (text.trim().length === 0) return [];
    const occurredAt = new Date(message.timestamp).toISOString();
    return [{ messageId: message.id, role: message.role, occurredAt, text }];
  });
}

function restoredTurnOf(
  runId: string,
  messages: readonly CodingSafeActivityMessage[],
  truncated: boolean,
): CodingSafeActivityTurn {
  return { turnId: `${runId}:restored`, messages, tools: [], truncated };
}

// The newest messages that fit one turn: the oldest are dropped until the turn fits its byte bound
// (a message is never cut a second time). The turn is truncated when `droppedBefore` older messages
// were left out already (the contract's message count, or stored history cut), when a message was
// dropped here and when any message was cut.
function fittedTurn(
  runId: string,
  messages: readonly CodingSafeActivityMessage[],
  droppedBefore: boolean,
): CodingSafeActivityTurn {
  let kept = messages;
  while (
    kept.length > 1 &&
    serializedBytes(restoredTurnOf(runId, kept, false)) > CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES
  ) {
    kept = kept.slice(1);
  }
  const truncated =
    droppedBefore || kept.length < messages.length || kept.some((message) => message.truncated);
  return restoredTurnOf(runId, kept, truncated);
}

/**
 * The run's activity feed, or — when the server no longer holds one for a settled run — the
 * conversation Coding History captured for it. Only the restored run's own messages enter its
 * timeline; earlier runs of the same task stay in the previous conversation. Coding History keeps
 * no tool calls or verification results, so a restored timeline never invents them. The feed keeps
 * to the safe-activity contract's bounds (the newest messages that fit, each cut to its byte
 * bound) and is truncated, on the turn and on the feed, when stored history was cut
 * (`CodingHistoryDetail.truncated`), and on the turn when a bound dropped or cut content.
 */
export function feedWithRestoredConversation(
  feed: AvailableCodingSafeActivityFeed | null,
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  detail: CodingHistoryDetail | null,
): AvailableCodingSafeActivityFeed | null {
  const runId = settledRunId(snapshot);
  if (feed !== null || snapshot === null || runId === undefined || detail === null) return feed;
  const restorable = restorableMessages(detail.messages, runId);
  if (restorable.length === 0) return feed;
  const newest = restorable.slice(-CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN);
  const droppedBefore = detail.truncated || newest.length < restorable.length;
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    availability: "available",
    runId,
    updatedAt: snapshot.updatedAt,
    turns: [fittedTurn(runId, newest.map(fittedMessage), droppedBefore)],
    truncated: detail.truncated,
    droppedEventCount: 0,
  };
}

export interface RestoredRunTimeline {
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly activity: UseCodingWorkbenchSafeActivityResult;
}

/** The timeline input for the shown run, restored from its snapshot and history after a reload. */
export function useRestoredRunTimeline(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  activity: UseCodingWorkbenchSafeActivityResult,
  detail: CodingHistoryDetail | null,
): RestoredRunTimeline {
  const restoredEvents = useMemo(
    () => eventsWithRestoredSettlement(events, snapshot),
    [events, snapshot],
  );
  const feed = useMemo(
    () => feedWithRestoredConversation(activity.feed, snapshot, detail),
    [activity.feed, detail, snapshot],
  );
  return {
    events: restoredEvents,
    activity: feed === activity.feed ? activity : { ...activity, feed },
  };
}
