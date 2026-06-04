// Public-surface pin test, mirroring keiko-tools / keiko-workspace / keiko-model-gateway. Every
// symbol that lives on the package's main entry point is touched here so a future refactor that
// accidentally drops a named export — or downgrades a value to a type-only re-export — fails this
// test instead of silently breaking a downstream caller. The trust-boundary nature of this
// package (it owns the only redacted-by-construction evidence-manifest path) makes the "stable
// public surface" guarantee load-bearing.

import { describe, expect, it } from "vitest";
import * as evidence from "./index.js";
import type {
  AuditCode,
  AuditRedactionConfig,
  BuildOptions,
  ConnectedContextEvidenceContext,
  ConnectedContextEvidenceInput,
  ConnectedContextEvidencePersistResult,
  EvidenceBrowserCapture,
  EvidenceBrowserContentCapture,
  EvidenceBrowserEvent,
  EvidenceBrowserEventType,
  EvidenceBrowserScreenshot,
  EvidenceBrowserViewportPx,
  EvidenceBuildInput,
  EvidenceCommandExecution,
  EvidenceConnectedContextAudit,
  EvidenceConnectedContextExcerpt,
  EvidenceConnectedContextFile,
  EvidenceConnectedContextOmitted,
  EvidenceConnectedContextQuery,
  EvidenceConnectedContextScope,
  EvidenceConnectedContextUncertainty,
  EvidenceDeps,
  EvidenceFailure,
  EvidenceListEntry,
  EvidenceManifest,
  EvidenceModel,
  EvidencePatch,
  EvidencePersistContext,
  EvidenceReasoningEntry,
  EvidenceReport,
  EvidenceRunIdentity,
  EvidenceStateTransition,
  EvidenceStore,
  EvidenceTaskType,
  EvidenceToolCall,
  EvidenceUsageTotals,
  EvidenceVerificationResult,
  PersistResult,
  RetentionPolicy,
  SideFileWriteResult,
  SideFileWriterOptions,
  WorkflowEventLike,
  WorkflowRunIdentity,
  WorkflowRunKind,
  WorkflowTerminalStatus,
} from "./index.js";

describe("keiko-evidence public surface", () => {
  it("exposes the documented value barrel members", () => {
    expect(evidence.KEIKO_EVIDENCE_VERSION).toBe("0.1.0");
    // Builders and orchestration:
    expect(typeof evidence.buildEvidenceManifest).toBe("function");
    expect(typeof evidence.persistEvidence).toBe("function");
    expect(typeof evidence.buildEvidenceReport).toBe("function");
    expect(typeof evidence.renderEvidenceReport).toBe("function");
    expect(typeof evidence.aggregateUsage).toBe("function");
    expect(typeof evidence.applyRetention).toBe("function");
    // Index/list API:
    expect(typeof evidence.listEvidence).toBe("function");
    expect(typeof evidence.loadEvidence).toBe("function");
    // Workflow-evidence mapping:
    expect(typeof evidence.buildWorkflowManifest).toBe("function");
    expect(typeof evidence.foldWorkflowUsage).toBe("function");
    expect(typeof evidence.persistWorkflowEvidence).toBe("function");
    expect(typeof evidence.persistConnectedContextEvidence).toBe("function");
    // Store port + adapters:
    expect(typeof evidence.createInMemoryEvidenceStore).toBe("function");
    expect(typeof evidence.createNodeEvidenceStore).toBe("function");
    expect(typeof evidence.resolveEvidenceDir).toBe("function");
    expect(evidence.DEFAULT_EVIDENCE_DIR).toBe("./.keiko/evidence");
    // Side-file writer:
    expect(typeof evidence.writeSideFile).toBe("function");
    // RunId validation:
    expect(typeof evidence.assertValidRunId).toBe("function");
    // Redactor (re-exported from keiko-security):
    expect(typeof evidence.createAuditRedactor).toBe("function");
    expect(typeof evidence.deepRedactStrings).toBe("function");
    // Error taxonomy (re-exported from keiko-security):
    expect(evidence.AUDIT_CODES).toBeDefined();
    expect(typeof evidence.AuditError).toBe("function");
    expect(typeof evidence.InvalidRunIdError).toBe("function");
    expect(typeof evidence.EvidenceWriteError).toBe("function");
    expect(typeof evidence.EvidenceReadError).toBe("function");
    expect(typeof evidence.EvidenceSchemaError).toBe("function");
    // Frozen schema + retention constants (re-exported from keiko-contracts):
    expect(evidence.EVIDENCE_SCHEMA_VERSION).toBe("1");
    expect(evidence.DEFAULT_RETENTION).toEqual({ maxRuns: 50 });
  });

  it("every type-only re-export is reachable by name at compile time", () => {
    // verbatimModuleSyntax requires the type imports above to be USED in a type position. A
    // phantom generic `pin<T>()` references the type argument at the call site without producing
    // any runtime value, so each symbol stays load-bearing on the public surface.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<AuditCode>();
    pin<AuditRedactionConfig>();
    pin<BuildOptions>();
    pin<ConnectedContextEvidenceContext>();
    pin<ConnectedContextEvidenceInput>();
    pin<ConnectedContextEvidencePersistResult>();
    pin<EvidenceBrowserCapture>();
    pin<EvidenceBrowserContentCapture>();
    pin<EvidenceBrowserEvent>();
    pin<EvidenceBrowserEventType>();
    pin<EvidenceBrowserScreenshot>();
    pin<EvidenceBrowserViewportPx>();
    pin<EvidenceBuildInput>();
    pin<EvidenceCommandExecution>();
    pin<EvidenceConnectedContextAudit>();
    pin<EvidenceConnectedContextExcerpt>();
    pin<EvidenceConnectedContextFile>();
    pin<EvidenceConnectedContextOmitted>();
    pin<EvidenceConnectedContextQuery>();
    pin<EvidenceConnectedContextScope>();
    pin<EvidenceConnectedContextUncertainty>();
    pin<EvidenceDeps>();
    pin<EvidenceFailure>();
    pin<EvidenceListEntry>();
    pin<EvidenceManifest>();
    pin<EvidenceModel>();
    pin<EvidencePatch>();
    pin<EvidencePersistContext>();
    pin<EvidenceReasoningEntry>();
    pin<EvidenceReport>();
    pin<EvidenceRunIdentity>();
    pin<EvidenceStateTransition>();
    pin<EvidenceStore>();
    pin<EvidenceTaskType>();
    pin<EvidenceToolCall>();
    pin<EvidenceUsageTotals>();
    pin<EvidenceVerificationResult>();
    pin<PersistResult>();
    pin<RetentionPolicy>();
    pin<SideFileWriteResult>();
    pin<SideFileWriterOptions>();
    pin<WorkflowEventLike>();
    pin<WorkflowRunIdentity>();
    pin<WorkflowRunKind>();
    pin<WorkflowTerminalStatus>();
  });
});
