// Quality Intelligence four-eyes pairing guard (Epic #270, Issue #282).
//
// Pure-domain check that two review records may be paired under four-eyes
// governance. The contract guarantees `reviewerLabel` is display-only with NO
// PII guarantee; this module compares labels as opaque strings only (post
// trim + case-fold for the same-label check) and never persists them.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

export type QualityIntelligenceFourEyesViolationCode =
  | "SELF_REVIEW_FORBIDDEN"
  | "SAME_REVIEWER_LABEL"
  | "ALREADY_PAIRED";

export class QualityIntelligenceFourEyesViolationError extends Error {
  public readonly code: QualityIntelligenceFourEyesViolationCode;
  public readonly recordId: QualityIntelligence.QualityIntelligenceReviewRecordId;
  public readonly candidateId: QualityIntelligence.QualityIntelligenceReviewRecordId;

  constructor(
    code: QualityIntelligenceFourEyesViolationCode,
    record: QualityIntelligence.QualityIntelligenceReviewRecord,
    candidate: QualityIntelligence.QualityIntelligenceReviewRecord,
    detail: string,
  ) {
    super(`[${code}] record="${record.id}" candidate="${candidate.id}": ${detail}`);
    this.name = "QualityIntelligenceFourEyesViolationError";
    this.code = code;
    this.recordId = record.id;
    this.candidateId = candidate.id;
  }
}

const normaliseLabel = (label: string): string => label.trim().toLowerCase();

/**
 * Assert that `record` and `candidate` may be paired for four-eyes governance.
 * Throws a typed `QualityIntelligenceFourEyesViolationError` on:
 *
 *   * SELF_REVIEW_FORBIDDEN — both records have `reviewerKind === "human-author"`.
 *     A human author may not also be the four-eyes second reviewer of their own
 *     authored output.
 *   * SAME_REVIEWER_LABEL — both records share the same (trimmed, case-folded)
 *     `reviewerLabel`. Display-only string comparison; no identity guarantee.
 *   * ALREADY_PAIRED — either record already references a `fourEyesPairedRecordId`.
 *
 * Returns `void` on success. The caller is responsible for actually wiring
 * `fourEyesPairedRecordId` on both records when pairing succeeds.
 */
export const assertFourEyesPair = (
  record: QualityIntelligence.QualityIntelligenceReviewRecord,
  candidate: QualityIntelligence.QualityIntelligenceReviewRecord,
): void => {
  if (
    record.fourEyesPairedRecordId !== undefined ||
    candidate.fourEyesPairedRecordId !== undefined
  ) {
    throw new QualityIntelligenceFourEyesViolationError(
      "ALREADY_PAIRED",
      record,
      candidate,
      "One or both records already have fourEyesPairedRecordId set",
    );
  }
  if (record.reviewerKind === "human-author" && candidate.reviewerKind === "human-author") {
    throw new QualityIntelligenceFourEyesViolationError(
      "SELF_REVIEW_FORBIDDEN",
      record,
      candidate,
      "Two human-author reviewers cannot pair under four-eyes governance",
    );
  }
  if (normaliseLabel(record.reviewerLabel) === normaliseLabel(candidate.reviewerLabel)) {
    throw new QualityIntelligenceFourEyesViolationError(
      "SAME_REVIEWER_LABEL",
      record,
      candidate,
      "Both records share the same reviewerLabel",
    );
  }
};
