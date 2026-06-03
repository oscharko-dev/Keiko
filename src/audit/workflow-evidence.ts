// Re-export shim: the workflow→EvidenceManifest mapping lives in @oscharko-dev/keiko-evidence
// (issue #163, ADR-0019).

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
