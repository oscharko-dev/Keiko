import type { QualityIntelligenceCandidateRow } from "@oscharko-dev/keiko-evidence";

// The single quality gate shared by every candidate-backed export surface. A candidate that still
// needs review, was rejected, or received a weak judge verdict is useful diagnostic material, but
// is not a deliverable test case and must not substantiate traceability coverage.
export function isDeliverableQualityRow(row: QualityIntelligenceCandidateRow): boolean {
  return (
    row.status !== "needs-review" &&
    row.status !== "rejected" &&
    row.qualityVerdict?.verdict !== "weak"
  );
}
