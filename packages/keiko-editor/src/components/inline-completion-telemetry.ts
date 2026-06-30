/**
 * Content-free inline-completion acceptance/rejection telemetry (Issue #1200, Acceptance Criterion 6;
 * ADR-0042 D5).
 *
 * The Monaco inline-completion bridge feeds this accumulator from Monaco's content-free lifecycle
 * callbacks (an item is offered, shown, partially accepted, or reaches end-of-life as accepted /
 * rejected / ignored) and request-latency durations. It holds nothing but counts and latency
 * aggregates — never buffer text, never the inserted ghost text, never a prompt — so the running
 * snapshot is safe to forward to the host (which posts it to the governed telemetry BFF) for
 * content-free acceptance-rate and p50/p95 latency evidence.
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
  /** Count of host inline-completion requests observed by the bridge. */
  readonly requestCount: number;
  /** Content-free nearest-rank p50 host request latency, in milliseconds. */
  readonly requestLatencyMsP50: number;
  /** Content-free nearest-rank p95 host request latency, in milliseconds. */
  readonly requestLatencyMsP95: number;
}

/** The content-free lifecycle events the bridge records. */
export type InlineCompletionTelemetryEvent =
  "offered" | "shown" | "accepted" | "rejected" | "ignored" | "partially-accepted";

/** A zeroed snapshot; the identity used to seed a fresh accumulator. */
export const EMPTY_INLINE_COMPLETION_TELEMETRY: InlineCompletionTelemetrySnapshot = {
  offered: 0,
  shown: 0,
  accepted: 0,
  rejected: 0,
  ignored: 0,
  partiallyAccepted: 0,
  requestCount: 0,
  requestLatencyMsP50: 0,
  requestLatencyMsP95: 0,
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

function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

function normaliseLatencyMs(latencyMs: number): number {
  if (!Number.isFinite(latencyMs)) {
    return 0;
  }
  return Math.max(0, Math.round(latencyMs));
}

export function inlineCompletionTelemetryLatencyReducer(
  state: InlineCompletionTelemetrySnapshot,
  latenciesMs: readonly number[],
  latencyMs: number,
): { readonly state: InlineCompletionTelemetrySnapshot; readonly latenciesMs: readonly number[] } {
  const nextLatencies = [...latenciesMs, normaliseLatencyMs(latencyMs)].sort((a, b) => a - b);
  return {
    latenciesMs: nextLatencies,
    state: {
      ...state,
      requestCount: nextLatencies.length,
      requestLatencyMsP50: nearestRank(nextLatencies, 0.5),
      requestLatencyMsP95: nearestRank(nextLatencies, 0.95),
    },
  };
}

/** A stateful recorder over {@link inlineCompletionTelemetryReducer}. */
export interface InlineCompletionTelemetry {
  /** The current cumulative snapshot. */
  snapshot(): InlineCompletionTelemetrySnapshot;
  /** Record one lifecycle event and notify the optional observer with the new snapshot. */
  record(event: InlineCompletionTelemetryEvent): void;
  /** Record one host resolver latency and notify the optional observer with the new snapshot. */
  recordLatency(latencyMs: number): void;
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
  let latenciesMs: readonly number[] = [];
  return {
    snapshot(): InlineCompletionTelemetrySnapshot {
      return state;
    },
    record(event: InlineCompletionTelemetryEvent): void {
      state = inlineCompletionTelemetryReducer(state, event);
      onChange?.(state);
    },
    recordLatency(latencyMs: number): void {
      const reduced = inlineCompletionTelemetryLatencyReducer(state, latenciesMs, latencyMs);
      state = reduced.state;
      latenciesMs = reduced.latenciesMs;
      onChange?.(state);
    },
  };
}
