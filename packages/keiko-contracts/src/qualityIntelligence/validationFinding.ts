// Quality Intelligence validation finding (Epic #270, Issue #277).
//
// A validation finding is the output of any QI validator stage: deterministic logic
// checks, faithfulness vs source atoms, semantic equivalence, mutation testing, policy
// gates, or a human reviewer rejection. Findings are the inputs to review governance
// (#282) and to the audit summary (this package).
//
// `summary` is a non-secret single-sentence description. Validators MUST redact before
// constructing the summary; the contract surface assumes redaction has already happened.

import type {
  QualityIntelligenceEvidenceAtomId,
  QualityIntelligenceRunId,
  QualityIntelligenceTestCaseId,
  QualityIntelligenceValidationFindingId,
} from "./ids.js";

export type QualityIntelligenceValidationFindingKind =
  | "logic-defect"
  | "faithfulness-defect"
  | "semantic-defect"
  | "mutation-defect"
  | "policy-violation"
  | "manual-rejection"
  | "coverage-gap"
  | "test-quality";

export const QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS: readonly QualityIntelligenceValidationFindingKind[] =
  [
    "logic-defect",
    "faithfulness-defect",
    "semantic-defect",
    "mutation-defect",
    "policy-violation",
    "manual-rejection",
    "coverage-gap",
    "test-quality",
  ] as const;

export type QualityIntelligenceSeverity = "critical" | "high" | "medium" | "low";

export const QUALITY_INTELLIGENCE_SEVERITIES: readonly QualityIntelligenceSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
] as const;

/**
 * Total ordering on severity, highest-first. `critical` < `high` < `medium` < `low`
 * in this ordering (lower number = more severe). Pure; used by callers that need to
 * sort or threshold findings.
 */
export const QUALITY_INTELLIGENCE_SEVERITY_RANK: Readonly<
  Record<QualityIntelligenceSeverity, number>
> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});

interface QualityIntelligenceValidationFindingCommon {
  readonly id: QualityIntelligenceValidationFindingId;
  readonly runId: QualityIntelligenceRunId;
  /** Absent for run-scoped findings (e.g. a policy violation against the whole run). */
  readonly candidateId?: QualityIntelligenceTestCaseId;
  readonly severity: QualityIntelligenceSeverity;
  /** Non-secret single-sentence summary; assumed already redacted by the producer. */
  readonly summary: string;
  readonly evidenceAtomIds: readonly QualityIntelligenceEvidenceAtomId[];
}

export interface QualityIntelligenceLogicDefectFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "logic-defect";
}

export interface QualityIntelligenceFaithfulnessDefectFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "faithfulness-defect";
}

export interface QualityIntelligenceSemanticDefectFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "semantic-defect";
}

export interface QualityIntelligenceMutationDefectFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "mutation-defect";
}

export interface QualityIntelligencePolicyViolationFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "policy-violation";
}

export interface QualityIntelligenceManualRejectionFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "manual-rejection";
}

export interface QualityIntelligenceCoverageGapFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "coverage-gap";
}

export interface QualityIntelligenceTestQualityFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "test-quality";
}

export type QualityIntelligenceValidationFinding =
  | QualityIntelligenceLogicDefectFinding
  | QualityIntelligenceFaithfulnessDefectFinding
  | QualityIntelligenceSemanticDefectFinding
  | QualityIntelligenceMutationDefectFinding
  | QualityIntelligencePolicyViolationFinding
  | QualityIntelligenceManualRejectionFinding
  | QualityIntelligenceCoverageGapFinding
  | QualityIntelligenceTestQualityFinding;
