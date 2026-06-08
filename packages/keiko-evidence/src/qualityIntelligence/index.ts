// Public barrel for the QualityIntelligence sub-module of `@oscharko-dev/keiko-evidence`
// (Issue #274, Epic #270, ADR-0023 D8). Re-exports the manifest schema, redactor, retention
// profiles, and (Milestone 2+) the local-store + retention + deletion API. The package barrel
// re-exports this directory under the `QualityIntelligence` namespace, matching the contracts
// layout.

// ─── Manifest schema (M1) ──────────────────────────────────────────────────────────
export {
  QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
  validateQualityIntelligenceEvidenceManifest,
} from "./manifestSchema.js";
export type {
  QualityIntelligenceEvidenceManifest,
  QualityIntelligenceEvidenceRefRow,
  QualityIntelligenceExportRow,
  QualityIntelligenceFindingRow,
  QualityIntelligenceIntegrityHashes,
  QualityIntelligenceManifestTotals,
  QualityIntelligenceProvenanceRefs,
  QualityIntelligenceRedactionSummary,
  QualityIntelligenceSchemaValidationResult,
  QualityIntelligenceCoverageMatrixRow,
} from "./manifestSchema.js";

// ─── Redaction (M1) ────────────────────────────────────────────────────────────────
export { redactQualityIntelligenceEvidence } from "./redaction.js";
export type {
  QualityIntelligenceRedactionOptions,
  QualityIntelligenceRedactionResult,
} from "./redaction.js";

// ─── Retention profiles (M1) ───────────────────────────────────────────────────────
export {
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
  QUALITY_INTELLIGENCE_RETENTION_PROFILES,
  getQualityIntelligenceRetentionProfile,
} from "./retentionPolicy.js";
export type { QualityIntelligenceRetentionProfile } from "./retentionPolicy.js";

// ─── Local-state store + CRUD (M2) ─────────────────────────────────────────────────
export {
  createInMemoryQualityIntelligenceLocalStore,
  createNodeQualityIntelligenceLocalStore,
  listQualityIntelligenceRuns,
  loadQualityIntelligenceRun,
  recordQualityIntelligenceRun,
  QI_SUBDIR,
} from "./store.js";
export type {
  QualityIntelligenceLoadOptions,
  QualityIntelligenceLocalStore,
  QualityIntelligenceNodeStoreOptions,
  QualityIntelligenceRecordInput,
  QualityIntelligenceRecordOptions,
  QualityIntelligenceRecordResult,
} from "./store.js";

// ─── Generated-candidate companion artifact (Issue #280) ────────────────────────────
export {
  QUALITY_INTELLIGENCE_CANDIDATES_SCHEMA_VERSION,
  recordQualityIntelligenceCandidates,
  loadQualityIntelligenceCandidates,
  deleteQualityIntelligenceCandidates,
  applyQualityIntelligenceCandidateEdit,
} from "./candidatesArtifact.js";
export type {
  QualityIntelligenceCandidateRow,
  QualityIntelligenceCandidatesArtifact,
  QualityIntelligenceCandidatesStoreOptions,
  RecordQualityIntelligenceCandidatesInput,
  ApplyQualityIntelligenceCandidateEditInput,
  ApplyQualityIntelligenceCandidateEditResult,
  QualityIntelligenceCandidateEditErrorReason,
} from "./candidatesArtifact.js";
export {
  createNodeContainedJsonArtifactStore,
  type ContainedJsonArtifactStore,
  type ContainedJsonArtifactStoreOptions,
} from "./companionStore.js";

// ─── Retention, deletion, recovery (M3) ────────────────────────────────────────────
export {
  applyQualityIntelligenceRetention,
  deleteQualityIntelligenceRun,
  quarantineCorruptQualityIntelligenceManifest,
  snapshotQualityIntelligenceRunsForRecovery,
} from "./retention.js";
export type {
  QualityIntelligenceDeleteOptions,
  QualityIntelligenceDeletionReceipt,
  QualityIntelligenceDeletionStatus,
  QualityIntelligenceQuarantineOptions,
  QualityIntelligenceQuarantineReceipt,
  QualityIntelligenceRecoverySnapshot,
  QualityIntelligenceRetentionDecision,
  QualityIntelligenceRetentionDecisionInput,
  QualityIntelligenceRetentionResult,
  QualityIntelligenceRunDeletedEvent,
  QualityIntelligenceRunSnapshotEntry,
} from "./retention.js";
