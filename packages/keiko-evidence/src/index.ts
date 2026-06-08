// Public surface of @oscharko-dev/keiko-evidence (ADR-0010 D12 + ADR-0019). Re-exports the public
// evidence surface — the builder, the persist orchestration, the redactor, the store port +
// adapters, aggregation, the index/list API, retention, the report, runId validation, side-file
// writing, and the workflow-evidence mapping — alongside the package version constant. The layer
// does NOT export a bare `summarizeForAudit` or `redact` (it composes them internally).

export { KEIKO_EVIDENCE_VERSION } from "./version.js";
export { buildEvidenceManifest } from "./build.js";
export { persistEvidence, type PersistResult } from "./persist.js";
export { createAuditRedactor, deepRedactStrings } from "./redaction.js";
export { aggregateUsage } from "./aggregate.js";
export { listEvidence, loadEvidence, type EvidenceListEntry } from "./index-api.js";
export { applyRetention } from "./retention.js";
export { buildEvidenceReport, renderEvidenceReport, type EvidenceReport } from "./report.js";
export { assertValidRunId } from "./runid.js";
export {
  buildWorkflowManifest,
  foldWorkflowUsage,
  persistWorkflowEvidence,
  type EvidencePersistContext,
  type WorkflowEventLike,
  type WorkflowRunIdentity,
  type WorkflowRunKind,
  type WorkflowTerminalStatus,
} from "./workflow-evidence.js";
export {
  persistConnectedContextEvidence,
  type ConnectedContextEvidenceContext,
  type ConnectedContextEvidenceInput,
  type ConnectedContextEvidencePersistResult,
} from "./connected-context-evidence.js";
export {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  DEFAULT_EVIDENCE_DIR,
  resolveEvidenceDir,
  type EvidenceStore,
} from "./store.js";
export {
  writeSideFile,
  type SideFileWriteResult,
  type SideFileWriterOptions,
} from "./side-file.js";
export {
  AUDIT_CODES,
  AuditError,
  EvidenceReadError,
  EvidenceSchemaError,
  EvidenceWriteError,
  InvalidRunIdError,
  type AuditCode,
} from "./errors.js";
// QualityIntelligence sub-module (Issue #274, ADR-0023 D8). Mirrors the contracts barrel layout —
// callers may use it either as a namespace import
// (`import { QualityIntelligence } from '@oscharko-dev/keiko-evidence'`) OR as a flat
// import of the public surface (`import { recordQualityIntelligenceRun, ... } from
// '@oscharko-dev/keiko-evidence'`). The flat re-exports below mirror what the
// `QualityIntelligence` namespace exposes — flat-named symbols are added per ADR-0019
// trust rule 6 to let downstream consumers (Issue #273 workflow runners, future
// orchestrators) avoid namespace plumbing in hot paths.
export * as QualityIntelligence from "./qualityIntelligence/index.js";
export {
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
  QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
  QUALITY_INTELLIGENCE_RETENTION_PROFILES,
  applyQualityIntelligenceRetention,
  createInMemoryQualityIntelligenceLocalStore,
  createNodeQualityIntelligenceLocalStore,
  deleteQualityIntelligenceRun,
  getQualityIntelligenceRetentionProfile,
  listQualityIntelligenceRuns,
  loadQualityIntelligenceRun,
  quarantineCorruptQualityIntelligenceManifest,
  recordQualityIntelligenceRun,
  recordQualityIntelligenceCandidates,
  loadQualityIntelligenceCandidates,
  deleteQualityIntelligenceCandidates,
  applyQualityIntelligenceCandidateEdit,
  QUALITY_INTELLIGENCE_CANDIDATES_SCHEMA_VERSION,
  createNodeContainedJsonArtifactStore,
  redactQualityIntelligenceEvidence,
  snapshotQualityIntelligenceRunsForRecovery,
  validateQualityIntelligenceEvidenceManifest,
  type QualityIntelligenceCandidateRow,
  type QualityIntelligenceCandidatesArtifact,
  type RecordQualityIntelligenceCandidatesInput,
  type ApplyQualityIntelligenceCandidateEditInput,
  type ApplyQualityIntelligenceCandidateEditResult,
  type QualityIntelligenceCandidateEditErrorReason,
  type ContainedJsonArtifactStore,
  type ContainedJsonArtifactStoreOptions,
  type QualityIntelligenceDeleteOptions,
  type QualityIntelligenceDeletionReceipt,
  type QualityIntelligenceDeletionStatus,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceEvidenceRefRow,
  type QualityIntelligenceExportRow,
  type QualityIntelligenceFindingRow,
  type QualityIntelligenceIntegrityHashes,
  type QualityIntelligenceLoadOptions,
  type QualityIntelligenceLocalStore,
  type QualityIntelligenceManifestTotals,
  type QualityIntelligenceNodeStoreOptions,
  type QualityIntelligenceProvenanceRefs,
  type QualityIntelligenceQuarantineOptions,
  type QualityIntelligenceQuarantineReceipt,
  type QualityIntelligenceRecordInput,
  type QualityIntelligenceRecordOptions,
  type QualityIntelligenceRecordResult,
  type QualityIntelligenceRecoverySnapshot,
  type QualityIntelligenceRedactionOptions,
  type QualityIntelligenceRedactionResult,
  type QualityIntelligenceRedactionSummary,
  type QualityIntelligenceRetentionDecision,
  type QualityIntelligenceRetentionDecisionInput,
  type QualityIntelligenceRetentionResult,
  type QualityIntelligenceRunDeletedEvent,
  type QualityIntelligenceRunSnapshotEntry,
  type QualityIntelligenceSchemaValidationResult,
  type QualityIntelligenceCoverageMatrixRow,
} from "./qualityIntelligence/index.js";

export {
  EVIDENCE_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  type AuditRedactionConfig,
  type BuildOptions,
  type EvidenceBuildInput,
  type EvidenceCommandExecution,
  type EvidenceDeps,
  type EvidenceFailure,
  type EvidenceManifest,
  type EvidenceModel,
  type EvidenceBrowserCapture,
  type EvidenceBrowserContentCapture,
  type EvidenceBrowserEvent,
  type EvidenceBrowserEventType,
  type EvidenceBrowserScreenshot,
  type EvidenceBrowserViewportPx,
  type EvidenceConnectedContextAudit,
  type EvidenceConnectedContextExcerpt,
  type EvidenceConnectedContextFile,
  type EvidenceConnectedContextOmitted,
  type EvidenceConnectedContextQuery,
  type EvidenceConnectedContextScope,
  type EvidenceConnectedContextUncertainty,
  type EvidencePatch,
  type EvidenceReasoningEntry,
  type EvidenceRunIdentity,
  type EvidenceStateTransition,
  type EvidenceTaskType,
  type EvidenceToolCall,
  type EvidenceUsageTotals,
  type EvidenceVerificationResult,
  type RetentionPolicy,
} from "./types.js";
