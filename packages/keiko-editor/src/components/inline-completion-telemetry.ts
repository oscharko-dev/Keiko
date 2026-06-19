/**
 * Content-free inline-completion acceptance/rejection telemetry (Issue #1200, Acceptance Criterion 6;
 * ADR-0042 D5).
 *
 * The Monaco inline-completion bridge feeds this accumulator from Monaco's content-free lifecycle
 * callbacks (an item is offered, shown, partially accepted, or reaches end-of-life as accepted /
 * rejected / ignored). It holds nothing but counts — never buffer text, never the inserted ghost
 * text, never a prompt — so the running snapshot is safe to forward to the host (which posts it to
 * the governed telemetry BFF) for content-free acceptance-rate evidence.
 *
 * Pure and deterministic: a total reducer plus a tiny stateful recorder built over it. No clock, no
 * randomness, no I/O, no Monaco import — unit-testable in isolation.
 */

/** Cumulative, content-free inline-completion counters. */
export interface InlineCompletionTelemetrySnapshot {
  /** An inline request produced a candidate the editor could render. */
  readonly offered: number;
  /** A ghost-text item was actually shown to the user. */
  readonly shown: number;
  /** The user explicitly accepted a ghost-text item (Tab / accept action). */
  readonly accepted: number;
  /** A shown item was dismissed by an explicit gesture. */
  readonly rejected: number;
  /** A shown item fell out of use with no explicit accept/reject (superseded, typed past). */
  readonly ignored: number;
  /** The user accepted part of an item (word/line partial accept). */
  readonly partiallyAccepted: number;
}

/** The content-free lifecycle events the bridge records. */
export type InlineCompletionTelemetryEvent =
  | "offered"
  | "shown"
  | "accepted"
  | "rejected"
  | "ignored"
  | "partially-accepted";

/** A zeroed snapshot; the identity used to seed a fresh accumulator. */
export const EMPTY_INLINE_COMPLETION_TELEMETRY: InlineCompletionTelemetrySnapshot = {
  offered: 0,
  shown: 0,
  accepted: 0,
  rejected: 0,
  ignored: 0,
  partiallyAccepted: 0,
};

// The single field each event increments. Total over the event union, so the reducer needs no
// fall-through branch and a new event member fails to compile until it is mapped here.
const EVENT_FIELD: Readonly<
  Record<InlineCompletionTelemetryEvent, keyof InlineCompletionTelemetrySnapshot>
> = {
  offered: "offered",
  shown: "shown",
  accepted: "accepted",
  rejected: "rejected",
  ignored: "ignored",
  "partially-accepted": "partiallyAccepted",
};

/** Apply one event to a snapshot, returning a new snapshot (the previous one is never mutated). */
export function inlineCompletionTelemetryReducer(
  state: InlineCompletionTelemetrySnapshot,
  event: InlineCompletionTelemetryEvent,
): InlineCompletionTelemetrySnapshot {
  const field = EVENT_FIELD[event];
  return { ...state, [field]: state[field] + 1 };
}

/** A stateful recorder over {@link inlineCompletionTelemetryReducer}. */
export interface InlineCompletionTelemetry {
  /** The current cumulative snapshot. */
  snapshot(): InlineCompletionTelemetrySnapshot;
  /** Record one lifecycle event and notify the optional observer with the new snapshot. */
  record(event: InlineCompletionTelemetryEvent): void;
}

/**
 * Create an inline-completion telemetry accumulator. `onChange`, when supplied, is invoked with the
 * new content-free snapshot after every recorded event so the host can forward it to the governed
 * telemetry route. The accumulator owns no I/O of its own.
 */
export function createInlineCompletionTelemetry(
  onChange?: (snapshot: InlineCompletionTelemetrySnapshot) => void,
): InlineCompletionTelemetry {
  let state: InlineCompletionTelemetrySnapshot = EMPTY_INLINE_COMPLETION_TELEMETRY;
  return {
    snapshot(): InlineCompletionTelemetrySnapshot {
      return state;
    },
    record(event: InlineCompletionTelemetryEvent): void {
      state = inlineCompletionTelemetryReducer(state, event);
      onChange?.(state);
    },
  };
}
