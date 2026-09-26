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

// KEIKO-0522: const-first + `(typeof X)[number]` (matches retentionPolicy.ts / testQualityRubric.ts)
// so the union type can never drift from the enumerable array it is derived from.
export const QUALITY_INTELLIGENCE_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export type QualityIntelligencePriority = (typeof QUALITY_INTELLIGENCE_PRIORITIES)[number];

export const QUALITY_INTELLIGENCE_RISK_CLASSES = [
  "safety",
  "compliance",
  "regression",
  "functional",
  "visual",
] as const;

export type QualityIntelligenceRiskClass = (typeof QUALITY_INTELLIGENCE_RISK_CLASSES)[number];

export const QUALITY_INTELLIGENCE_TEST_CASE_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "needs-review",
] as const;

export type QualityIntelligenceTestCaseStatus =
  (typeof QUALITY_INTELLIGENCE_TEST_CASE_STATUSES)[number];

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
