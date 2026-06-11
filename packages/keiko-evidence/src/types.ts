// Re-export shim: all Evidence* interfaces, retention/redaction config, and the frozen
// EVIDENCE_SCHEMA_VERSION / DEFAULT_RETENTION tables live in @oscharko-dev/keiko-contracts
// (issue #158). All existing import sites (`from "../audit/types.js"`) continue to resolve unchanged.
// verbatimModuleSyntax is on: type-only names use `export type`, value-emitting tables use `export`.

export type {
  EvidenceRunIdentity,
  EvidenceModel,
  EvidenceUsageTotals,
  EvidenceStateTransition,
  EvidenceToolCall,
  EvidenceCommandExecution,
  EvidenceSandboxConfiguration,
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
  EvidenceConnectedContextScope,
  EvidenceConnectedContextQuery,
  EvidenceConnectedContextExcerpt,
  EvidenceConnectedContextFile,
  EvidenceConnectedContextOmitted,
  EvidenceConnectedContextUncertainty,
  EvidenceConnectedContextPlan,
  EvidenceConnectedContextAudit,
  EvidenceManifest,
  AuditRedactionConfig,
  RetentionPolicy,
  BuildOptions,
  EvidenceBuildInput,
  EvidenceDeps,
  EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
export { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION } from "@oscharko-dev/keiko-contracts";
