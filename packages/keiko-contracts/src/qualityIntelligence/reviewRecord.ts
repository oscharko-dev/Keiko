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
  | "open"
  | "approved"
  | "changes-requested"
  | "rejected"
  | "withdrawn";

export const QUALITY_INTELLIGENCE_REVIEW_STATES: readonly QualityIntelligenceReviewState[] = [
  "open",
  "approved",
  "changes-requested",
  "rejected",
  "withdrawn",
] as const;

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
