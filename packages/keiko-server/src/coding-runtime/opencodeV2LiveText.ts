// OpenCode 2.0.10 reports a streamed answer and its reasoning to `GET /api/session/{id}/message` only
// twice (#3873 review, PR #3876): as an empty part when the block starts and as the complete part
// when it ends. `session.text.delta` and `session.reasoning.delta` are ephemeral events: they reach
// the live event stream, are never persisted, and the history a read returns never contains them.
// Measured against the pinned 2.0.10 runtime: a reasoning phase of a few seconds left the history
// read at `""` until the response finished, while the event stream carried each delta as it arrived.
//
// The timeline reads history, so what the history cannot show it takes from here: this overlay
// keeps, per text or reasoning part, the deltas the event stream delivered between the part's
// `started` event and the moment the history shows the part complete. The history projection
// (`opencodeV2History.ts`) reads the part's text through it, so the live timeline grows as the model
// writes and reconciles with the durable part at the end without appending anything twice.
//
// A delta names its part by `(assistantMessageID, ordinal)` and its kind by its event type. The
// ordinal numbers the text blocks (and, separately, the reasoning blocks) of one assistant message
// from zero in the order they start, so it is the part's position among the same-kind parts of that
// message in the history; the projection resolves it that way. An assistant message belongs to one
// model step, and a retried step produced no output before it was retried, so the numbering never
// restarts under a message that already holds parts.
//
// Trust and bounds. Event content is untrusted runtime output. An event of another session is not
// ours and is ignored. A delta of this session whose part name is outside its shape, whose text is
// not a string, or whose part is not being tracked is dropped and counted. Each part's live text is
// bounded (text by the history's own part bound, reasoning by the projection bound the history
// applies to a reasoning part) and cut on a character boundary, never short of what the projection
// keeps of the finished part, so the live text is always a true prefix of what the history later
// shows. Only a bounded number of unfinished parts is tracked. A part that was never seen starting
// (the stream reconnected after it began) or whose stream was interrupted since is not extended: a
// gap in the middle of a text would show the operator words the model never wrote in that order.
// Everything is counted, never recorded: counts are body-free and reach the Activity Log through the
// history projection's line.

import { CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

export type LiveTextKind = "text" | "reasoning";

/** A text part is never longer than this many UTF-8 bytes, as the history projection admits it. */
export const MAX_LIVE_TEXT_UTF8_BYTES = 65_536;
/** The projection's bound on a reasoning part: it shows at most this much of one. */
export const MAX_LIVE_REASONING_UTF8_BYTES = 2 * CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES;

const MAX_LIVE_PARTS = 32;
const MAX_RETIRED_PARTS = 128;
const MAX_ORDINAL = 1_024;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,251}$/u;

interface PartEvent {
  readonly kind: LiveTextKind;
  readonly step: "started" | "delta";
}

// A map, not an object literal: an event type is untrusted text, and a literal would answer for
// inherited names such as `constructor`.
const PART_EVENTS: ReadonlyMap<string, PartEvent> = new Map<string, PartEvent>([
  ["session.text.started", { kind: "text", step: "started" }],
  ["session.text.delta", { kind: "text", step: "delta" }],
  ["session.reasoning.started", { kind: "reasoning", step: "started" }],
  ["session.reasoning.delta", { kind: "reasoning", step: "delta" }],
]);

/** What the overlay did since the counts were last taken. Counts only. */
export interface LiveTextCounts {
  /** Deltas appended to a live part, however little of them fitted its bound. */
  readonly applied: number;
  /** Deltas that extended nothing: the part was never seen starting, was frozen, or was full. */
  readonly dropped: number;
  /** Parts whose complete text did not extend the live text the timeline had shown. */
  readonly diverged: number;
}

interface LivePart {
  text: string;
  bytes: number;
  // The part reached its bound: the rest of what the model wrote is not kept.
  full: boolean;
  // The event stream that fed the part was interrupted: it is not extended again.
  frozen: boolean;
  lastEventId: string | undefined;
  // The history has already shown a text that does not extend this part's: counted once.
  diverged: boolean;
}

export interface OpenCodeV2LiveText {
  /** Notes one event of the runtime's event stream; only a text or reasoning part's own events count. */
  observe(sessionId: string, event: Readonly<Record<string, unknown>>): void;
  /** What the part has shown so far, never ending in half a surrogate pair; `undefined` when untracked. */
  textOf(messageId: string, kind: LiveTextKind, ordinal: number): string | undefined;
  /** The history shows the part complete: its live text is spent, and a late delta for it is ignored. */
  retire(messageId: string, kind: LiveTextKind, ordinal: number): void;
  /**
   * The history shows a text for the part that does not extend what the part showed, so the part keeps
   * what it showed. Counted once per part, however many reads see it.
   */
  markDiverged(messageId: string, kind: LiveTextKind, ordinal: number): void;
  /** The event stream was interrupted: no tracked part is extended again. */
  freeze(): void;
  /** The counts since the previous call, which reset. */
  takeCounts(): LiveTextCounts;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function partKey(messageId: string, kind: LiveTextKind, ordinal: number): string {
  return `${kind}\u0000${messageId}\u0000${String(ordinal)}`;
}

// The part an event of this session names, or `undefined` when the name is outside its shape.
function eventPartKey(
  data: Readonly<Record<string, unknown>>,
  kind: LiveTextKind,
): string | undefined {
  const { assistantMessageID, ordinal } = data;
  if (typeof assistantMessageID !== "string" || !MESSAGE_ID.test(assistantMessageID)) {
    return undefined;
  }
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)) return undefined;
  if (ordinal < 0 || ordinal >= MAX_ORDINAL) return undefined;
  return partKey(assistantMessageID, kind, ordinal);
}

// The longest prefix of `delta` whole characters that fits `room` more UTF-8 bytes. A lone surrogate
// is one character of its own, exactly as the projection's own cut treats it.
function fittingPrefix(delta: string, room: number): string {
  let used = 0;
  let end = 0;
  for (const character of delta) {
    used += Buffer.byteLength(character, "utf8");
    if (used > room) break;
    end += character.length;
  }
  return delta.slice(0, end);
}

// Appends what fits; true when anything did. A part that reaches its bound keeps what it has.
function append(part: LivePart, delta: string, bound: number): boolean {
  if (part.full) return false;
  const room = bound - part.bytes;
  const taken =
    Buffer.byteLength(delta, "utf8") <= room ? delta : fittingPrefix(delta, Math.max(0, room));
  part.full = taken.length < delta.length || part.bytes + Buffer.byteLength(taken, "utf8") >= bound;
  if (taken.length === 0) return false;
  part.text += taken;
  part.bytes += Buffer.byteLength(taken, "utf8");
  return true;
}

// Half of a surrogate pair is no character: it waits for its other half, which the next delta may
// bring, instead of reaching the timeline as a replacement character.
function withoutDanglingSurrogate(text: string): string {
  // A lone high surrogate at the end has no pair to combine with, so its code point is itself.
  const last = text.codePointAt(text.length - 1);
  return last !== undefined && last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

class LiveTextOverlay implements OpenCodeV2LiveText {
  private readonly parts = new Map<string, LivePart>();
  // The parts the history already shows complete, remembered briefly: a delta still in flight on the
  // event stream when the history read overtook it is not a lost delta.
  private readonly retired = new Set<string>();
  private applied = 0;
  private dropped = 0;
  private diverged = 0;

  observe(sessionId: string, event: Readonly<Record<string, unknown>>): void {
    const partEvent = typeof event.type === "string" ? PART_EVENTS.get(event.type) : undefined;
    const data = record(event.data);
    if (partEvent === undefined || data?.sessionID !== sessionId) return;
    const key = eventPartKey(data, partEvent.kind);
    if (partEvent.step === "started") {
      if (key !== undefined) this.start(key);
    } else if (key === undefined) this.dropped += 1;
    else this.extend(key, partEvent.kind, event.id, data.delta);
  }

  textOf(messageId: string, kind: LiveTextKind, ordinal: number): string | undefined {
    const part = this.parts.get(partKey(messageId, kind, ordinal));
    return part === undefined ? undefined : withoutDanglingSurrogate(part.text);
  }

  retire(messageId: string, kind: LiveTextKind, ordinal: number): void {
    const key = partKey(messageId, kind, ordinal);
    if (!this.parts.delete(key)) return;
    this.retired.add(key);
    if (this.retired.size > MAX_RETIRED_PARTS) this.forgetOldestRetired();
  }

  markDiverged(messageId: string, kind: LiveTextKind, ordinal: number): void {
    const part = this.parts.get(partKey(messageId, kind, ordinal));
    // Untracked, or already counted.
    if (part?.diverged !== false) return;
    part.diverged = true;
    this.diverged += 1;
  }

  freeze(): void {
    for (const part of this.parts.values()) part.frozen = true;
  }

  takeCounts(): LiveTextCounts {
    const counts = { applied: this.applied, dropped: this.dropped, diverged: this.diverged };
    this.applied = 0;
    this.dropped = 0;
    this.diverged = 0;
    return counts;
  }

  // A set iterates in insertion order, so the first key it yields is the oldest spent part.
  private forgetOldestRetired(): void {
    const oldest = this.retired.values().next();
    if (!oldest.done) this.retired.delete(oldest.value);
  }

  private start(key: string): void {
    if (this.parts.has(key) || this.retired.has(key) || this.parts.size >= MAX_LIVE_PARTS) return;
    this.parts.set(key, {
      text: "",
      bytes: 0,
      full: false,
      frozen: false,
      lastEventId: undefined,
      diverged: false,
    });
  }

  // A delta of this session that extended nothing is counted, whatever the reason: the timeline
  // then shows less than the model wrote, and the count is how a reader of the log learns it.
  private extend(key: string, kind: LiveTextKind, eventId: unknown, delta: unknown): void {
    // A delta still in flight when the history read overtook it is not a lost delta.
    if (this.retired.has(key)) return;
    const part = this.parts.get(key);
    if (part === undefined || part.frozen) {
      this.dropped += 1;
      return;
    }
    if (typeof delta !== "string") {
      // The runtime sent a delta that is not text, so its content is lost and the part would have a
      // gap: it is not extended again.
      part.frozen = true;
      this.dropped += 1;
      return;
    }
    // An empty delta carries nothing, and the same event twice is one delta.
    if (delta.length === 0 || isRepeatedEvent(part, eventId)) return;
    const bound = kind === "text" ? MAX_LIVE_TEXT_UTF8_BYTES : MAX_LIVE_REASONING_UTF8_BYTES;
    if (append(part, delta, bound)) this.applied += 1;
    else this.dropped += 1;
  }
}

// Notes the event as the part's latest; true when the part has already taken this very event.
function isRepeatedEvent(part: LivePart, eventId: unknown): boolean {
  if (typeof eventId !== "string") return false;
  if (eventId === part.lastEventId) return true;
  part.lastEventId = eventId;
  return false;
}

export function createOpenCodeV2LiveText(): OpenCodeV2LiveText {
  return new LiveTextOverlay();
}
