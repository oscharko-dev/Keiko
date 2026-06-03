// Re-export shim: the evidence layer now lives in @oscharko-dev/keiko-evidence (issue #163,
// ADR-0019). All existing import sites (`from "../audit/index.js"`) keep resolving unchanged via
// this barrel. Symbols enumerated explicitly to match the PRE-MOVE surface of src/audit/index.ts
// (per the keiko-tools / keiko-workspace precedent — never `export *` in a legacy shim).

export { buildEvidenceManifest } from "@oscharko-dev/keiko-evidence";
export { persistEvidence, type PersistResult } from "@oscharko-dev/keiko-evidence";
export { createAuditRedactor, deepRedactStrings } from "@oscharko-dev/keiko-evidence";
export { aggregateUsage } from "@oscharko-dev/keiko-evidence";
export { listEvidence, loadEvidence, type EvidenceListEntry } from "@oscharko-dev/keiko-evidence";
export { applyRetention } from "@oscharko-dev/keiko-evidence";
export {
  buildEvidenceReport,
  renderEvidenceReport,
  type EvidenceReport,
} from "@oscharko-dev/keiko-evidence";
export { assertValidRunId } from "@oscharko-dev/keiko-evidence";
export {
  buildWorkflowManifest,
  foldWorkflowUsage,
  persistWorkflowEvidence,
  type EvidencePersistContext,
  type WorkflowEventLike,
  type WorkflowRunIdentity,
  type WorkflowRunKind,
  type WorkflowTerminalStatus,
} from "@oscharko-dev/keiko-evidence";
export {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  resolveEvidenceDir,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
export {
  AUDIT_CODES,
  AuditError,
  EvidenceReadError,
  EvidenceSchemaError,
  EvidenceWriteError,
  InvalidRunIdError,
  type AuditCode,
} from "@oscharko-dev/keiko-evidence";
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
  type EvidencePatch,
  type EvidenceReasoningEntry,
  type EvidenceRunIdentity,
  type EvidenceStateTransition,
  type EvidenceTaskType,
  type EvidenceToolCall,
  type EvidenceUsageTotals,
  type EvidenceVerificationResult,
  type RetentionPolicy,
} from "@oscharko-dev/keiko-evidence";
