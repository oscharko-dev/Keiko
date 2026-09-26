// Quality Intelligence review record (Epic #270, Issue #277).
//
// A review record tracks the lifecycle of a single review (human author / human
// reviewer / model judge) over a QI run. The `fourEyesPairedRecordId` field is
// the optional reference linking two paired reviews when four-eyes governance
// (#282) requires it. Identifier semantics:
//   * `reviewerLabel` is a display string only; this contract makes NO PII guarantee.
//   * `reviewerKind` is the structural role.

import type { QualityIntelligenceReviewRecordId, QualityIntelligenceRunId } from "./ids.js";

// KEIKO-0522: const-first + `(typeof X)[number]` (matches retentionPolicy.ts / testQualityRubric.ts).
// The union type IS the array's element type rather than a hand-maintained mirror of it, so a
// member added, removed, or mistyped in the array is automatically reflected in the type — there is
// nothing left for the two to drift apart from.
export const QUALITY_INTELLIGENCE_REVIEWER_KINDS = [
  "human-author",
  "human-reviewer",
  "judge",
] as const;

export type QualityIntelligenceReviewerKind = (typeof QUALITY_INTELLIGENCE_REVIEWER_KINDS)[number];

export const QUALITY_INTELLIGENCE_REVIEW_STATES = [
  "open",
  "approved",
  "changes-requested",
  "rejected",
  "withdrawn",
] as const;

export type QualityIntelligenceReviewState = (typeof QUALITY_INTELLIGENCE_REVIEW_STATES)[number];

export const QUALITY_INTELLIGENCE_REVIEW_ACTIONS = [
  "approve",
  "reject",
  "request-changes",
  "reopen",
  "withdraw",
] as const;

export type QualityIntelligenceReviewAction = (typeof QUALITY_INTELLIGENCE_REVIEW_ACTIONS)[number];

export function isQualityIntelligenceReviewAction(
  value: unknown,
): value is QualityIntelligenceReviewAction {
  return (
    typeof value === "string" &&
    QUALITY_INTELLIGENCE_REVIEW_ACTIONS.includes(value as QualityIntelligenceReviewAction)
  );
}

// Terminal review states + the action→state projection (GEN-DUP-SEMANTIC-008 /
// GEN-DUP-SEMANTIC-009). The set of states from which a review no longer transitions, and the
// canonical mapping from a reviewer action to the state it produces, were both re-implemented
// inline across the server review runtime and the UI. Reuses the existing
// `QualityIntelligenceReviewState` literal type as the projection codomain so a new review state
// cannot be introduced here without the compiler noticing.
export const QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES = [
  "approved",
  "rejected",
  "withdrawn",
] as const;

// KEIKO-0522: QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES is a DELIBERATE subset of
// QualityIntelligenceReviewState, not the whole union, so it cannot bind via `satisfies readonly
// QualityIntelligenceReviewState[]` the way a full-coverage array can (bffWire.ts's
// QUALITY_INTELLIGENCE_RUN_STATUSES) — `satisfies` on an array only rejects an invalid element, it
// never requires a member to be present, so a state added to the union without a terminality
// decision would pass silently. This Record is a completeness witness instead: its type requires
// an explicit boolean for EVERY current QualityIntelligenceReviewState, so a state added to the
// union without an entry here fails to compile (missing property) rather than leaving a silent
// runtime gap. `isTerminalReviewState` is implemented directly against this witness — not against
// `.includes()` on the array above — so the predicate is always the exhaustive, compiler-checked
// classification; the array above stays the enumerable, order-pinned public constant existing
// consumers iterate (reviewStore.terminalMatrix.test.ts, reviewRecord.test.ts).
const QUALITY_INTELLIGENCE_REVIEW_STATE_IS_TERMINAL: Readonly<
  Record<QualityIntelligenceReviewState, boolean>
> = {
  open: false,
  approved: true,
  "changes-requested": false,
  rejected: true,
  withdrawn: true,
};

export function isTerminalReviewState(state: QualityIntelligenceReviewState): boolean {
  // Indexing with the exact key union `QualityIntelligenceReviewState` against
  // `Record<QualityIntelligenceReviewState, boolean>` is total — TypeScript proves every key is
  // present, so this can never observe `undefined` for a well-typed caller (a caller that bypasses
  // the parameter type, e.g. via `@ts-expect-error`, gets the plain-object `undefined` a
  // non-existent key always produces in JS; that boundary is expected to validate before it ever
  // reaches this predicate — see reviewRecord.test.ts's compile-time pin).
  return QUALITY_INTELLIGENCE_REVIEW_STATE_IS_TERMINAL[state];
}

export const QUALITY_INTELLIGENCE_REVIEW_ACTION_TARGET: Readonly<
  Record<QualityIntelligenceReviewAction, QualityIntelligenceReviewState>
> = {
  approve: "approved",
  reject: "rejected",
  "request-changes": "changes-requested",
  reopen: "open",
  withdraw: "withdrawn",
};

export function reviewActionResultState(
  action: QualityIntelligenceReviewAction,
): QualityIntelligenceReviewState {
  return QUALITY_INTELLIGENCE_REVIEW_ACTION_TARGET[action];
}

export interface QualityIntelligenceReviewRecord {
  readonly id: QualityIntelligenceReviewRecordId;
  readonly runId: QualityIntelligenceRunId;
  readonly reviewerKind: QualityIntelligenceReviewerKind;
  /** Display only; no PII guarantee. Callers must redact upstream. */
  readonly reviewerLabel: string;
  readonly state: QualityIntelligenceReviewState;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
  /** ISO 8601 timestamp. */
  readonly lastUpdatedAt: string;
  readonly fourEyesPairedRecordId?: QualityIntelligenceReviewRecordId;
}
