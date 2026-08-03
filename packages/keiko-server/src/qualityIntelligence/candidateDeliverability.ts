import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceCandidateRow } from "@oscharko-dev/keiko-evidence";
import {
  candidateReviewStateOf,
  runReviewStateOf,
  type QiReviewStateArtifact,
} from "./reviewStore.js";

const NON_DELIVERABLE_REVIEW_STATES: ReadonlySet<QI.QualityIntelligenceReviewState> = new Set([
  "changes-requested",
  "rejected",
  "withdrawn",
]);

function isDeliverableReviewState(state: QI.QualityIntelligenceReviewState): boolean {
  return !NON_DELIVERABLE_REVIEW_STATES.has(state);
}

// The single quality gate shared by every candidate-backed export surface. A candidate that still
// needs review, was rejected, or received a weak judge verdict is useful diagnostic material, but
// is not a deliverable test case and must not substantiate traceability coverage.
export function isDeliverableQualityRow(
  row: QualityIntelligenceCandidateRow,
  review: QiReviewStateArtifact | undefined,
): boolean {
  return (
    row.status !== "needs-review" &&
    row.status !== "rejected" &&
    row.qualityVerdict?.verdict !== "weak" &&
    isDeliverableReviewState(runReviewStateOf(review)) &&
    isDeliverableReviewState(candidateReviewStateOf(review, row.id))
  );
}
