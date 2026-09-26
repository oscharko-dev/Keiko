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
import type { QualityIntelligenceConfidence } from "./coverageMap.js";

// KEIKO-0522: const-first + `(typeof X)[number]` (matches retentionPolicy.ts / testQualityRubric.ts)
// so each union type can never drift from the enumerable array it is derived from.
export const QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS = [
  "logic-defect",
  "faithfulness-defect",
  "semantic-defect",
  "mutation-defect",
  "policy-violation",
  "manual-rejection",
  "coverage-gap",
  "requirement-quality",
  "test-quality",
] as const;

export type QualityIntelligenceValidationFindingKind =
  (typeof QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS)[number];

export const QUALITY_INTELLIGENCE_REQUIREMENT_QUALITY_CATEGORIES = [
  "ambiguity",
  "non-verifiable",
  "open-placeholder",
  "compound-requirement",
  "weak-modality",
  "cross-atom-contradiction",
] as const;

export type QualityIntelligenceRequirementQualityCategory =
  (typeof QUALITY_INTELLIGENCE_REQUIREMENT_QUALITY_CATEGORIES)[number];

export const QUALITY_INTELLIGENCE_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type QualityIntelligenceSeverity = (typeof QUALITY_INTELLIGENCE_SEVERITIES)[number];

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

export interface QualityIntelligenceRequirementQualityFinding extends QualityIntelligenceValidationFindingCommon {
  readonly kind: "requirement-quality";
  readonly category: QualityIntelligenceRequirementQualityCategory;
  /** Confidence in `[0, 1]` (not a percentage) — see `QualityIntelligenceConfidence`. */
  readonly confidence: QualityIntelligenceConfidence;
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
  | QualityIntelligenceRequirementQualityFinding
  | QualityIntelligenceTestQualityFinding;
