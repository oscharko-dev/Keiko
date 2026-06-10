// Quality Intelligence review audit-event producer (Epic #270, Issue #282).
//
// Pure-domain envelope builder. Emits versioned audit events for the review
// lifecycle. PRODUCTION ONLY — persistence belongs to keiko-evidence (#274)
// and the audit ledger. No IO, no clock, no allocations beyond the returned
// frozen envelope.
//
// Schema-version policy mirrors QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION:
// future evolutions land as new numeric literals, never as a mutation of "1".

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import type { NextReviewState, QualityIntelligenceReviewTransitionEvent } from "./stateMachine.js";

export const QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_SCHEMA_VERSION = 1 as const;

export type QualityIntelligenceReviewAuditEventKind =
  | "qi:review:opened"
  | "qi:review:transitioned"
  | "qi:review:four-eyes-paired"
  | "qi:review:terminated";

export const QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_KINDS: readonly QualityIntelligenceReviewAuditEventKind[] =
  [
    "qi:review:opened",
    "qi:review:transitioned",
    "qi:review:four-eyes-paired",
    "qi:review:terminated",
  ] as const;

export interface QualityIntelligenceReviewOpenedPayload {
  readonly kind: "qi:review:opened";
  readonly reviewerKind: QualityIntelligence.QualityIntelligenceReviewerKind;
}

export interface QualityIntelligenceReviewTransitionedPayload {
  readonly kind: "qi:review:transitioned";
  readonly from: QualityIntelligence.QualityIntelligenceReviewState;
  readonly to: QualityIntelligence.QualityIntelligenceReviewState;
  readonly event: QualityIntelligenceReviewTransitionEvent;
}

export interface QualityIntelligenceReviewFourEyesPairedPayload {
  readonly kind: "qi:review:four-eyes-paired";
  readonly pairedRecordId: QualityIntelligence.QualityIntelligenceReviewRecordId;
}

export interface QualityIntelligenceReviewTerminatedPayload {
  readonly kind: "qi:review:terminated";
  readonly terminalState: QualityIntelligence.QualityIntelligenceReviewState;
}

export type QualityIntelligenceReviewAuditEventPayload =
  | QualityIntelligenceReviewOpenedPayload
  | QualityIntelligenceReviewTransitionedPayload
  | QualityIntelligenceReviewFourEyesPairedPayload
  | QualityIntelligenceReviewTerminatedPayload;

export interface QualityIntelligenceReviewAuditEvent {
  readonly eventSchemaVersion: typeof QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_SCHEMA_VERSION;
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly recordId: QualityIntelligence.QualityIntelligenceReviewRecordId;
  /** Monotonic per-run non-negative integer. Assigned by the runtime. */
  readonly sequence: number;
  /** ISO 8601 timestamp supplied by the caller. */
  readonly timestamp: string;
  /** Display-only actor label. NO PII guarantee — same rule as reviewerLabel. */
  readonly by: string;
  readonly payload: QualityIntelligenceReviewAuditEventPayload;
}

export interface BuildReviewAuditEventInput {
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly recordId: QualityIntelligence.QualityIntelligenceReviewRecordId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly by: string;
  readonly payload: QualityIntelligenceReviewAuditEventPayload;
}

/**
 * Build a frozen audit-event envelope. Pure: does not consult any clock, does
 * not allocate beyond the returned envelope, does not validate `timestamp`
 * beyond presence. The runtime (#273) assigns `sequence` in observed order;
 * callers should pass the next integer for the run.
 *
 * Throws `RangeError` if `sequence` is not a non-negative integer — this is
 * the same guarantee as `assertRunEventSequenceMonotonic`.
 */
export const buildReviewAuditEvent = (
  input: BuildReviewAuditEventInput,
): QualityIntelligenceReviewAuditEvent => {
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    throw new RangeError(
      `Review audit event sequence must be a non-negative integer, got ${String(input.sequence)}`,
    );
  }
  return Object.freeze({
    eventSchemaVersion: QUALITY_INTELLIGENCE_REVIEW_AUDIT_EVENT_SCHEMA_VERSION,
    runId: input.runId,
    recordId: input.recordId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    by: input.by,
    payload: input.payload,
  });
};

/**
 * Convenience derivation: build the `qi:review:transitioned` payload from a
 * `NextReviewState` produced by `applyReviewTransition`. Exposed so the
 * runtime can compose the two pure functions without re-deriving fields.
 */
export const transitionedPayloadFromNext = (
  next: NextReviewState,
): QualityIntelligenceReviewTransitionedPayload =>
  Object.freeze({
    kind: "qi:review:transitioned",
    from: next.from,
    to: next.state,
    event: next.event,
  });
