// Re-export shim: all Evidence* interfaces, the retention/redaction config tables, and the frozen
// EVIDENCE_SCHEMA_VERSION / DEFAULT_RETENTION constants live in @oscharko-dev/keiko-contracts
// (#158) and reach @oscharko-dev/keiko-evidence's public surface in #163 (ADR-0019).

export type {
  EvidenceRunIdentity,
  EvidenceModel,
  EvidenceUsageTotals,
  EvidenceStateTransition,
  EvidenceToolCall,
  EvidenceCommandExecution,
  EvidenceVerificationResult,
  EvidencePatch,
  EvidenceReasoningEntry,
  EvidenceFailure,
  EvidenceTaskType,
  EvidenceBrowserViewportPx,
  EvidenceBrowserEventType,
  EvidenceBrowserEvent,
  EvidenceBrowserScreenshot,
  EvidenceBrowserContentCapture,
  EvidenceBrowserCapture,
  EvidenceManifest,
  AuditRedactionConfig,
  RetentionPolicy,
  BuildOptions,
  EvidenceBuildInput,
  EvidenceDeps,
  EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
export { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION } from "@oscharko-dev/keiko-evidence";
