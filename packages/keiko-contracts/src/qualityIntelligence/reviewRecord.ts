// Quality Intelligence review record (Epic #270, Issue #277).
//
// A review record tracks the lifecycle of a single review (human author / human
// reviewer / model judge) over a QI run. The `fourEyesPairedRecordId` field is
// the optional reference linking two paired reviews when four-eyes governance
// (#282) requires it. Identifier semantics:
//   * `reviewerLabel` is a display string only; this contract makes NO PII guarantee.
//   * `reviewerKind` is the structural role.

import type { QualityIntelligenceReviewRecordId, QualityIntelligenceRunId } from "./ids.js";

export type QualityIntelligenceReviewerKind = "human-author" | "human-reviewer" | "judge";

export const QUALITY_INTELLIGENCE_REVIEWER_KINDS: readonly QualityIntelligenceReviewerKind[] = [
  "human-author",
  "human-reviewer",
  "judge",
] as const;

export type QualityIntelligenceReviewState =
  "open" | "approved" | "changes-requested" | "rejected" | "withdrawn";

export const QUALITY_INTELLIGENCE_REVIEW_STATES: readonly QualityIntelligenceReviewState[] = [
  "open",
  "approved",
  "changes-requested",
  "rejected",
  "withdrawn",
] as const;

export type QualityIntelligenceReviewAction =
  "approve" | "reject" | "request-changes" | "reopen" | "withdraw";

export const QUALITY_INTELLIGENCE_REVIEW_ACTIONS: readonly QualityIntelligenceReviewAction[] = [
  "approve",
  "reject",
  "request-changes",
  "reopen",
  "withdraw",
] as const;

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

export function isTerminalReviewState(state: string): boolean {
  return (QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES as readonly string[]).includes(state);
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
