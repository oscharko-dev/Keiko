// Quality Intelligence review state machine (Epic #270, Issue #282).
//
// Pure-domain transitions over the QualityIntelligenceReviewState enum from
// @oscharko-dev/keiko-contracts. Inspired structurally by the review-governance
// scaffolding under Test Intelligence reference (TI) — modelled freshly here.
//
// No IO, no persistence, no clock. Callers pass `by` (display label of the actor)
// and `at` (ISO 8601 timestamp produced by the caller's clock). The function is
// total over the typed event enum: every illegal transition raises a typed
// `QualityIntelligenceReviewTransitionError` with the offending `from`, `event`,
// and a fail-closed reason code.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

export type QualityIntelligenceReviewTransitionEvent =
  | "approve"
  | "request-changes"
  | "reject"
  | "withdraw"
  | "revise";

export const QUALITY_INTELLIGENCE_REVIEW_TRANSITION_EVENTS: readonly QualityIntelligenceReviewTransitionEvent[] =
  ["approve", "request-changes", "reject", "withdraw", "revise"] as const;

export type QualityIntelligenceReviewTransitionErrorCode =
  | "TRANSITION_NOT_ALLOWED"
  | "UNKNOWN_FROM_STATE"
  | "UNKNOWN_EVENT";

export class QualityIntelligenceReviewTransitionError extends Error {
  public readonly code: QualityIntelligenceReviewTransitionErrorCode;
  public readonly from: QualityIntelligence.QualityIntelligenceReviewState;
  public readonly event: QualityIntelligenceReviewTransitionEvent;

  constructor(
    code: QualityIntelligenceReviewTransitionErrorCode,
    from: QualityIntelligence.QualityIntelligenceReviewState,
    event: QualityIntelligenceReviewTransitionEvent,
    detail: string,
  ) {
    super(`[${code}] from="${from}" event="${event}": ${detail}`);
    this.name = "QualityIntelligenceReviewTransitionError";
    this.code = code;
    this.from = from;
    this.event = event;
  }
}

export interface NextReviewState {
  readonly state: QualityIntelligence.QualityIntelligenceReviewState;
  readonly by: string;
  readonly at: string;
  readonly event: QualityIntelligenceReviewTransitionEvent;
  readonly from: QualityIntelligence.QualityIntelligenceReviewState;
}

// Static transition table — pure data. Every legal `(from, event)` pair maps to
// the resulting state. Lookups against this table are O(1); absence raises a
// typed error.
const TRANSITIONS: ReadonlyMap<string, QualityIntelligence.QualityIntelligenceReviewState> =
  new Map([
    ["open|approve", "approved"],
    ["open|request-changes", "changes-requested"],
    ["open|reject", "rejected"],
    ["open|withdraw", "withdrawn"],
    ["changes-requested|revise", "open"],
    ["changes-requested|withdraw", "withdrawn"],
  ] as const);

const KNOWN_STATES: ReadonlySet<QualityIntelligence.QualityIntelligenceReviewState> = new Set([
  "open",
  "approved",
  "changes-requested",
  "rejected",
  "withdrawn",
]);

const KNOWN_EVENTS: ReadonlySet<QualityIntelligenceReviewTransitionEvent> = new Set(
  QUALITY_INTELLIGENCE_REVIEW_TRANSITION_EVENTS,
);

/**
 * Apply a review transition. Returns the next state record on success; throws a
 * typed `QualityIntelligenceReviewTransitionError` on every illegal combination
 * (including unknown `from` state or unknown event).
 *
 * `by` and `at` are pass-through metadata for the caller's audit envelope —
 * this function does not validate them beyond presence (it does not call
 * `Date.parse`; that is the caller's responsibility).
 */
export const applyReviewTransition = (
  currentState: QualityIntelligence.QualityIntelligenceReviewState,
  event: QualityIntelligenceReviewTransitionEvent,
  by: string,
  at: string,
): NextReviewState => {
  if (!KNOWN_STATES.has(currentState)) {
    throw new QualityIntelligenceReviewTransitionError(
      "UNKNOWN_FROM_STATE",
      currentState,
      event,
      `State "${currentState}" is not a known review state`,
    );
  }
  if (!KNOWN_EVENTS.has(event)) {
    throw new QualityIntelligenceReviewTransitionError(
      "UNKNOWN_EVENT",
      currentState,
      event,
      `Event "${event}" is not a known transition event`,
    );
  }
  const next = TRANSITIONS.get(`${currentState}|${event}`);
  if (next === undefined) {
    throw new QualityIntelligenceReviewTransitionError(
      "TRANSITION_NOT_ALLOWED",
      currentState,
      event,
      `No legal transition from "${currentState}" via "${event}"`,
    );
  }
  return Object.freeze({
    state: next,
    by,
    at,
    event,
    from: currentState,
  });
};
