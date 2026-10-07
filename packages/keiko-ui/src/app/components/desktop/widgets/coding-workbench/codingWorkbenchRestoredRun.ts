import { useEffect, useMemo, useRef } from "react";
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
  CODING_SAFE_ACTIVITY_MAX_TURNS,
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { ClientDiagnosticCodingRunRestore } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
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
// ..._MAX_MESSAGES_PER_TURN messages, the whole feed to at most ..._MAX_UTF8_BYTES over at most
// ..._MAX_TURNS turns, and one text segment holds at most ..._TEXT_SEGMENT_CHARS characters of text
// free of bidi, zero-width and control characters. Coding History keeps up to 65,536 characters per
// message and lists up to 200 messages per task, so the restored feed is held to the same bounds,
// measured the way the contract measures them (UTF-8 bytes of the serialized object).
//
// The feed carries the newest messages of the run that those bounds admit, packed into as many
// turns as they need. Every older message stays out of the feed and the transcript shows it whole
// instead (#3876 review): a message is never shown nowhere because a bound dropped it. Only text
// that really is shown nowhere is reported as truncated — a message cut to its own byte bound, and
// the older messages Coding History itself cut. The byte bound of a message (16 KiB, one character
// is at least one byte) keeps it within the 32 segments the contract allows, so no segment count is
// enforced separately.
//
// The work follows the bounds, from the newest end (#3876 review): the run's messages are examined
// one at a time, newest first — stripped of the characters the contract refuses, dated, fitted to
// the per-message bound — and only as far as the feed can still hold them. Nothing older than the
// message that ends the packing is stripped, trimmed, dated or measured; it is named for the
// transcript by its position alone.
const utf8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

function serializedBytes(value: object): number {
  return utf8Bytes(JSON.stringify(value));
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
  /** Where the message sits in Coding History's list: every older message sits before it. */
  readonly position: number;
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
// measure so no escaping or overhead rule is restated here. One character costs at least one byte,
// so a text as long as the bound never fits whole and no prefix that long fits either: the search
// never looks at more text than the bound, however much Coding History kept.
function fittedMessage(source: RestorableMessage): CodingSafeActivityMessage {
  const bound = CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES;
  if (source.text.length < bound) {
    const whole = restoredMessage(source, source.text, false);
    if (serializedBytes(whole) <= bound) return whole;
  }
  let fits = 0;
  let overflows = Math.min(source.text.length, bound);
  while (overflows - fits > 1) {
    const middle = Math.floor((fits + overflows) / 2);
    const candidate = restoredMessage(
      source,
      source.text.slice(0, safeCut(source.text, middle)),
      true,
    );
    if (serializedBytes(candidate) <= bound) fits = middle;
    else overflows = middle;
  }
  return restoredMessage(source, source.text.slice(0, safeCut(source.text, fits)), true);
}

// The message at `position` as the timeline can show it, or undefined when it is not one of the
// run's own user or assistant messages or has no text left once the characters the contract refuses
// are removed.
function restorableMessage(
  message: ChatMessage,
  position: number,
  runId: string,
): RestorableMessage | undefined {
  if (message.runId !== runId) return undefined;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = stripUnsafeFormatChars(message.content);
  if (text.trim().length === 0) return undefined;
  const occurredAt = new Date(message.timestamp).toISOString();
  return { messageId: message.id, role: message.role, occurredAt, text, position };
}

// The run's restorable messages, newest first, examined one at a time: a consumer that stops early
// never strips, trims or dates an older message (#3876 review).
function* newestRestorableMessages(
  messages: readonly ChatMessage[],
  runId: string,
): Generator<RestorableMessage> {
  for (const [position, message] of [...messages.entries()].toReversed()) {
    const restorable = restorableMessage(message, position, runId);
    if (restorable !== undefined) yield restorable;
  }
}

interface RestoreContext {
  readonly runId: string;
  readonly updatedAt: string;
  /** Coding History cut the task's stored messages: older ones exist that it no longer lists. */
  readonly historyCut: boolean;
}

/** The messages of one turn, oldest first. A turn is never empty. */
type TurnMessages = readonly [CodingSafeActivityMessage, ...CodingSafeActivityMessage[]];

// A turn takes the id of its first message, as the live feed's turn takes the id of the operator
// message that opened it. It is truncated when a message in it was cut and — the oldest turn alone —
// when Coding History cut the messages before it.
function restoredTurn(
  messages: TurnMessages,
  oldest: boolean,
  historyCut: boolean,
): CodingSafeActivityTurn {
  return {
    turnId: messages[0].messageId,
    messages,
    tools: [],
    truncated: (oldest && historyCut) || messages.some((message) => message.truncated),
  };
}

// The feed of `turns`, oldest first. It is truncated, as Coding History is, only when stored history
// was cut: the messages its turns leave out are shown in the transcript, so nothing is lost.
function restoredFeed(
  context: RestoreContext,
  turns: readonly TurnMessages[],
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    availability: "available",
    runId: context.runId,
    updatedAt: context.updatedAt,
    turns: turns.map((messages, index) => restoredTurn(messages, index === 0, context.historyCut)),
    truncated: context.historyCut,
    droppedEventCount: 0,
  };
}

// Whether the feed keeps to the contract's turn, message and byte bounds, each measured the way the
// contract measures it.
function withinFeedBounds(feed: AvailableCodingSafeActivityFeed): boolean {
  return (
    feed.turns.length <= CODING_SAFE_ACTIVITY_MAX_TURNS &&
    feed.turns.every(
      (turn) =>
        turn.messages.length <= CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN &&
        serializedBytes(turn) <= CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
    ) &&
    serializedBytes(feed) <= CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES
  );
}

// The turns with `message` added as their new oldest message: to the oldest turn when the bounds
// still admit it there, else as a turn of its own. Undefined when the bounds admit neither.
function withOlderMessage(
  context: RestoreContext,
  turns: readonly TurnMessages[],
  message: CodingSafeActivityMessage,
): readonly TurnMessages[] | undefined {
  const [oldest, ...newer] = turns;
  const candidates: (readonly TurnMessages[])[] = [[[message], ...turns]];
  if (oldest !== undefined) candidates.unshift([[message, ...oldest], ...newer]);
  return candidates.find((candidate) => withinFeedBounds(restoredFeed(context, candidate)));
}

interface PackedConversation {
  /** The feed's turns, oldest first. */
  readonly turns: readonly TurnMessages[];
  /** The newest message the bounds did not admit; absent when every message was carried. */
  readonly unplaced: RestorableMessage | undefined;
}

// Fills the feed from the run's newest message backwards for as long as the bounds admit one more,
// drawing messages one at a time so that nothing past the end of the packing is ever examined. A
// message that does not fit even cut ends the packing: it is `unplaced`, and it and every older
// message go to the transcript whole, so the transcript above the timeline continues exactly where
// the timeline begins.
function packedConversation(
  context: RestoreContext,
  newestFirst: Iterable<RestorableMessage>,
): PackedConversation {
  let turns: readonly TurnMessages[] = [];
  for (const source of newestFirst) {
    const next = withOlderMessage(context, turns, fittedMessage(source));
    if (next === undefined) return { turns, unplaced: source };
    turns = next;
  }
  return { turns, unplaced: undefined };
}

// The run's messages the feed leaves to the transcript: the one that ended the packing and every
// older one. Nothing older was examined, so they are named by position alone, whatever they hold.
function overflowMessages(
  messages: readonly ChatMessage[],
  runId: string,
  unplaced: RestorableMessage | undefined,
): readonly ChatMessage[] {
  if (unplaced === undefined) return [];
  return messages.slice(0, unplaced.position + 1).filter((message) => message.runId === runId);
}

function restoreCounts(
  feed: AvailableCodingSafeActivityFeed,
  overflow: readonly ChatMessage[],
  historyCut: boolean,
): ClientDiagnosticCodingRunRestore {
  const carried = feed.turns.flatMap((turn) => turn.messages);
  return {
    timelineCount: carried.length,
    transcriptCount: overflow.length,
    cutCount: carried.filter((message) => message.truncated).length,
    turnCount: feed.turns.length,
    feedBytes: serializedBytes(feed),
    transcriptChars: overflow.reduce((chars, message) => chars + message.content.length, 0),
    historyTruncated: historyCut,
  };
}

export interface RestoredConversation {
  /** The run's newest messages the contract's bounds admit, packed into turns. */
  readonly feed: AvailableCodingSafeActivityFeed;
  /** The run's older messages the feed leaves out: the transcript shows exactly these, whole. */
  readonly overflowMessageIds: ReadonlySet<string>;
  /** What the restoration did, for the body-free client diagnostic. */
  readonly counts: ClientDiagnosticCodingRunRestore;
}

/**
 * The conversation Coding History captured for a settled run, shaped for the timeline, or null when
 * there is nothing to restore: the run is not settled, History is not loaded or holds no message of
 * the run. Only the run's own messages enter its timeline; earlier runs of the same task stay in
 * the previous conversation. Coding History keeps no tool calls or verification results, so a
 * restored timeline never invents them.
 *
 * The feed keeps to the safe-activity contract's bounds: it carries the newest messages that fit,
 * each cut to its byte bound when it alone is too large. Every older message is named in
 * `overflowMessageIds`, for the transcript to show. The work follows those bounds from the newest
 * end: the messages the feed carries and the one that ends the packing are examined, and nothing
 * older is (#3876 review). The feed is truncated, on the feed and on its oldest turn, when stored
 * history was cut (`CodingHistoryDetail.truncated`), and on a turn that carries a cut message: what
 * the bounds moved to the transcript is not truncated, it is shown.
 */
export function restoreConversation(
  snapshot: CodingWorkbenchRuntimeSnapshot | null,
  detail: CodingHistoryDetail | null,
): RestoredConversation | null {
  const runId = settledRunId(snapshot);
  if (snapshot === null || runId === undefined || detail === null) return null;
  const context = { runId, updatedAt: snapshot.updatedAt, historyCut: detail.truncated };
  const { turns, unplaced } = packedConversation(
    context,
    newestRestorableMessages(detail.messages, runId),
  );
  if (turns.length === 0 && unplaced === undefined) return null;
  const feed = restoredFeed(context, turns);
  const overflow = overflowMessages(detail.messages, runId, unplaced);
  return {
    feed,
    overflowMessageIds: new Set(overflow.map((message) => message.id)),
    counts: restoreCounts(feed, overflow, detail.truncated),
  };
}

/** The run whose conversation the timeline shows, and the part of it the timeline cannot carry. */
export interface ShownRun {
  readonly runId: string;
  /** Coding History message ids of the run that the transcript shows because the feed has none. */
  readonly overflowMessageIds: ReadonlySet<string>;
}

const NO_MESSAGE_IDS: ReadonlySet<string> = new Set();

/**
 * Whether the transcript shows `message`. Every message of another run belongs to it. Of the shown
 * run's own messages it shows only those the timeline cannot carry, so each message of the run is
 * shown once, in the timeline or in the transcript above it — never in neither (#3876 review).
 */
export function transcriptShows(shownRun: ShownRun | undefined, message: ChatMessage): boolean {
  return (
    shownRun === undefined ||
    message.runId !== shownRun.runId ||
    shownRun.overflowMessageIds.has(message.id)
  );
}

// A feed the server holds carries the run's whole conversation, as it always did; a restored feed
// carries all of it but the overflow.
function shownRunOf(
  restoration: RestoredConversation | null,
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
  runId: string | undefined,
): ShownRun | undefined {
  if (restoration !== null) {
    return { runId: restoration.feed.runId, overflowMessageIds: restoration.overflowMessageIds };
  }
  return feed !== null && runId !== undefined
    ? { runId, overflowMessageIds: NO_MESSAGE_IDS }
    : undefined;
}

// One body-free line per distinct restoration: where the run's messages went and what the page said.
// The run id joins it to the server's own evidence of the run (`coding-runtime.history`).
function useReportedRestoration(restoration: RestoredConversation | null): void {
  const reported = useRef("");
  useEffect(() => {
    if (restoration === null) {
      reported.current = "";
      return;
    }
    const { runId } = restoration.feed;
    const picture = JSON.stringify([runId, restoration.counts]);
    if (reported.current === picture) return;
    reported.current = picture;
    reportClientDiagnostic("Keiko Coding Workbench restored a settled run's conversation.", {
      correlationId: runId,
      codingRunRestore: restoration.counts,
    });
  }, [restoration]);
}

export interface RestoredRunTimeline {
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly activity: UseCodingWorkbenchSafeActivityResult;
  /** The run the timeline shows; the transcript hides its messages except the overflow. */
  readonly shownRun: ShownRun | undefined;
}

/**
 * The timeline input for the shown run, restored from its snapshot and history after a reload:
 * the feed the server still holds wins, and a restored feed fills in only when it holds none.
 */
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
  const restoration = useMemo(
    () => (activity.feed === null ? restoreConversation(snapshot, detail) : null),
    [activity.feed, detail, snapshot],
  );
  useReportedRestoration(restoration);
  const runId = snapshot?.runId;
  const shownRun = useMemo(
    () => shownRunOf(restoration, activity.feed, runId),
    [restoration, activity.feed, runId],
  );
  const feed = restoration?.feed ?? activity.feed;
  return {
    events: restoredEvents,
    activity: feed === activity.feed ? activity : { ...activity, feed },
    shownRun,
  };
}
