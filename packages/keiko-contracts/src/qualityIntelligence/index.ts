// Public barrel for the Quality Intelligence contract surface (Epic #270, Issue #277).
//
// Pure leaf module. Re-exports every type, constant, and validator from this directory
// for consumption via `@oscharko-dev/keiko-contracts` (which re-exports this barrel
// under the `QualityIntelligence` namespace).

export const QUALITY_INTELLIGENCE_SCHEMA_VERSION = "1" as const;

// ─── Branded IDs ───────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceRunId,
  QualityIntelligenceTestCaseId,
  QualityIntelligenceCoverageMapId,
  QualityIntelligenceValidationFindingId,
  QualityIntelligenceReviewRecordId,
  QualityIntelligenceExportBundleId,
  QualityIntelligenceSourceEnvelopeId,
  QualityIntelligenceEvidenceAtomId,
  QualityIntelligenceAuditSummaryId,
} from "./ids.js";
export {
  asQualityIntelligenceRunId,
  asQualityIntelligenceTestCaseId,
  asQualityIntelligenceCoverageMapId,
  asQualityIntelligenceValidationFindingId,
  asQualityIntelligenceReviewRecordId,
  asQualityIntelligenceExportBundleId,
  asQualityIntelligenceSourceEnvelopeId,
  asQualityIntelligenceEvidenceAtomId,
  asQualityIntelligenceAuditSummaryId,
  validateQualityIntelligenceIdString,
} from "./ids.js";

// ─── Exhaustiveness helper ─────────────────────────────────────────────────────
export { assertQualityIntelligenceNever } from "./assertNever.js";

// ─── Source envelope ───────────────────────────────────────────────────────────
export type {
  QualityIntelligenceSourceKind,
  QualityIntelligenceSourceProvenance,
  QualityIntelligenceRepositoryContextEnvelope,
  QualityIntelligenceLocalKnowledgeCapsuleEnvelope,
  QualityIntelligenceFigmaEvidenceEnvelope,
  QualityIntelligenceHumanContextEnvelope,
  QualityIntelligenceConnectorDocumentEnvelope,
  QualityIntelligenceSourceEnvelope,
} from "./sourceEnvelope.js";
export {
  QUALITY_INTELLIGENCE_SOURCE_KINDS,
  looksLikeBrowserSafeSourceEnvelope,
} from "./sourceEnvelope.js";

// ─── Evidence atom ─────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceEvidenceAtomKind,
  QualityIntelligenceRedactionStatus,
  QualityIntelligenceLifecycleStatus,
  QualityIntelligenceRequirementAtom,
  QualityIntelligenceDesignFragmentAtom,
  QualityIntelligenceCodeFragmentAtom,
  QualityIntelligenceDocumentExcerptAtom,
  QualityIntelligenceHumanStatementAtom,
  QualityIntelligenceEvidenceAtom,
} from "./evidenceAtom.js";
export {
  QUALITY_INTELLIGENCE_EVIDENCE_ATOM_KINDS,
  QUALITY_INTELLIGENCE_REDACTION_STATUSES,
  QUALITY_INTELLIGENCE_LIFECYCLE_STATUSES,
  hasCanonicalSha256Hash,
} from "./evidenceAtom.js";

// ─── Test-case candidate ───────────────────────────────────────────────────────
export type {
  QualityIntelligencePriority,
  QualityIntelligenceRiskClass,
  QualityIntelligenceTestCaseStatus,
  QualityIntelligenceTestCaseCandidate,
} from "./testCaseCandidate.js";
export {
  QUALITY_INTELLIGENCE_PRIORITIES,
  QUALITY_INTELLIGENCE_RISK_CLASSES,
  QUALITY_INTELLIGENCE_TEST_CASE_STATUSES,
} from "./testCaseCandidate.js";

// ─── Inline-edit revision (Epic #712, Issue #725) ────────────────────────────────
export type {
  QualityIntelligenceCandidateEditProvenance,
  QualityIntelligenceCandidateEditableFields,
  QualityIntelligenceCandidateEditedRevision,
} from "./editableRevision.js";

// ─── Coverage map ──────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceCoverageKind,
  QualityIntelligenceCoverageMapping,
  QualityIntelligenceCoverageMap,
} from "./coverageMap.js";
export { QUALITY_INTELLIGENCE_COVERAGE_KINDS, assertCoverageMapInvariant } from "./coverageMap.js";

// ─── Validation finding ────────────────────────────────────────────────────────
export type {
  QualityIntelligenceValidationFindingKind,
  QualityIntelligenceSeverity,
  QualityIntelligenceLogicDefectFinding,
  QualityIntelligenceFaithfulnessDefectFinding,
  QualityIntelligenceSemanticDefectFinding,
  QualityIntelligenceMutationDefectFinding,
  QualityIntelligencePolicyViolationFinding,
  QualityIntelligenceManualRejectionFinding,
  QualityIntelligenceCoverageGapFinding,
  QualityIntelligenceTestQualityFinding,
  QualityIntelligenceValidationFinding,
} from "./validationFinding.js";
export {
  QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS,
  QUALITY_INTELLIGENCE_SEVERITIES,
  QUALITY_INTELLIGENCE_SEVERITY_RANK,
} from "./validationFinding.js";

// ─── Run plan + events ─────────────────────────────────────────────────────────
export type {
  QualityIntelligencePlannerKind,
  QualityIntelligenceRunStage,
  QualityIntelligenceRunPlan,
  QualityIntelligenceRunQueuedPayload,
  QualityIntelligenceRunStartedPayload,
  QualityIntelligenceStageStartedPayload,
  QualityIntelligenceStageCompletedPayload,
  QualityIntelligenceStageFailedPayload,
  QualityIntelligenceCandidateProposedPayload,
  QualityIntelligenceFindingRecordedPayload,
  QualityIntelligenceReviewRequestedPayload,
  QualityIntelligenceReviewCompletedPayload,
  QualityIntelligenceRunSucceededPayload,
  QualityIntelligenceRunFailedPayload,
  QualityIntelligenceRunCancelledPayload,
  QualityIntelligenceRunEventPayload,
  QualityIntelligenceRunEventKind,
  QualityIntelligenceRunEvent,
} from "./runPlanAndEvents.js";
export {
  QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION,
  QUALITY_INTELLIGENCE_PLANNER_KINDS,
  QUALITY_INTELLIGENCE_RUN_EVENT_KINDS,
  assertRunEventSequenceMonotonic,
} from "./runPlanAndEvents.js";

// ─── Review record ─────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceReviewerKind,
  QualityIntelligenceReviewState,
  QualityIntelligenceReviewRecord,
} from "./reviewRecord.js";
export {
  QUALITY_INTELLIGENCE_REVIEWER_KINDS,
  QUALITY_INTELLIGENCE_REVIEW_STATES,
} from "./reviewRecord.js";

// ─── Export bundle ─────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceExportAdapter,
  QualityIntelligenceExportBundleEntry,
  QualityIntelligenceExportBundle,
} from "./exportBundle.js";
export {
  QUALITY_INTELLIGENCE_EXPORT_ADAPTERS,
  QUALITY_INTELLIGENCE_TMS_ADAPTERS,
  assertExportBundleInvariant,
} from "./exportBundle.js";

// ─── Audit summary ─────────────────────────────────────────────────────────────
export type {
  QualityIntelligenceAuditTotals,
  QualityIntelligenceEvidenceRetentionSummary,
  QualityIntelligenceAuditSummary,
} from "./auditSummary.js";
export { QUALITY_INTELLIGENCE_AUDIT_MANIFEST_SCHEMA_VERSION } from "./auditSummary.js";

// ─── Conversation Center handoff ───────────────────────────────────────────────
export type {
  QualityIntelligenceHandoffPromptedAction,
  QualityIntelligenceHandoffChatMessageRef,
  QualityIntelligenceConversationCenterHandoff,
} from "./handoffEnvelope.js";
export { QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS } from "./handoffEnvelope.js";

// ─── Test-quality rubric (Epic #736, Issue #746) ─────────────────────────────
export type {
  TestQualityDimensionName,
  TestQualityRubricDimension,
  TestQualityJudgeVerdict,
} from "./testQualityRubric.js";

// ─── BFF wire shapes (Issue #280) ─────────────────────────────────────────────
export type {
  QualityIntelligenceUiRunTotals,
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunListResponse,
  QualityIntelligenceUiFindingSummary,
  QualityIntelligenceUiEvidenceRef,
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiAtomCoverage,
  QualityIntelligenceUiWeakTestFlag,
  QualityIntelligenceUiCandidate,
  QualityIntelligenceInlineSourceKind,
  QualityIntelligenceRequirementsSource,
  QualityIntelligenceWorkspaceSource,
  QualityIntelligenceFileSource,
  QualityIntelligenceCapsuleSource,
  QualityIntelligenceCapsuleSetSource,
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiStalenessEntry,
  QualityIntelligenceUiStalenessReport,
  QualityIntelligenceUiRegenerateResult,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceRunStreamAccepted,
  QualityIntelligenceRunStreamEvent,
  QualityIntelligenceRunStreamDone,
  QualityIntelligenceRunStreamError,
  QualityIntelligenceRunStreamMessage,
} from "./bffWire.js";
