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
