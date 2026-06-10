// Quality Intelligence test-case candidate (Epic #270, Issue #277).
//
// A candidate is a generated, reviewable, executable-shaped test case. It carries the
// authored shape (title/preconditions/steps/expected results) and the provenance
// references to the evidence atoms it was derived from. The candidate is the
// review surface used by #282 (review governance) and the export surface used by
// #283 (export adapters).

import type {
  QualityIntelligenceEvidenceAtomId,
  QualityIntelligenceRunId,
  QualityIntelligenceTestCaseId,
} from "./ids.js";

export type QualityIntelligencePriority = "P0" | "P1" | "P2" | "P3";

export const QUALITY_INTELLIGENCE_PRIORITIES: readonly QualityIntelligencePriority[] = [
  "P0",
  "P1",
  "P2",
  "P3",
] as const;

export type QualityIntelligenceRiskClass =
  | "safety"
  | "compliance"
  | "regression"
  | "functional"
  | "visual";

export const QUALITY_INTELLIGENCE_RISK_CLASSES: readonly QualityIntelligenceRiskClass[] = [
  "safety",
  "compliance",
  "regression",
  "functional",
  "visual",
] as const;

export type QualityIntelligenceTestCaseStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "needs-review";

export const QUALITY_INTELLIGENCE_TEST_CASE_STATUSES: readonly QualityIntelligenceTestCaseStatus[] =
  ["proposed", "accepted", "rejected", "needs-review"] as const;

export interface QualityIntelligenceTestCaseCandidate {
  readonly id: QualityIntelligenceTestCaseId;
  readonly runId: QualityIntelligenceRunId;
  readonly derivedFromAtomIds: readonly QualityIntelligenceEvidenceAtomId[];
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly expectedResults: readonly string[];
  readonly priority: QualityIntelligencePriority;
  readonly riskClass: QualityIntelligenceRiskClass;
  readonly tags: readonly string[];
  readonly status: QualityIntelligenceTestCaseStatus;
}
