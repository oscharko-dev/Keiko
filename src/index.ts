// Package-root boundary: the public surface is the agent harness, the model gateway, and
// the SDK version constant. The harness barrel already re-exports the session/run API the
// SDK surfaces, so we pull SDK_VERSION explicitly and avoid duplicate star re-exports.
export {
  SDK_VERSION,
  runAgent,
  type SdkAgentConfig,
  type SdkEvidenceOptions,
} from "./sdk/index.js";
export * from "./harness/index.js";
export * from "./gateway/index.js";
export * from "./workspace/index.js";
export * from "./verification/index.js";
// Both the workspace and verification barrels expose a `summarizeForAudit`. An explicit re-export
// takes precedence over the two star exports and resolves the ambiguity at the package root: the
// canonical root `summarizeForAudit` is the workspace one (established by ADR-0005), and the
// verification audit projection is additionally surfaced under an unambiguous alias. Inside
// ./verification/index.js the function keeps its layer-local name `summarizeForAudit` (ADR-0007).
export { summarizeForAudit } from "./workspace/index.js";
export { summarizeForAudit as summarizeVerificationForAudit } from "./verification/index.js";

// Reviewable developer-assist workflows (ADR-0008). Exported explicitly rather than via `export *`
// because the workflow event family reuses the harness event-type NAMES (ModelCallStartedEvent,
// ModelCallCompletedEvent) by structural convention — a star re-export would collide with the
// harness ones already surfaced above. The WorkflowEvent union is surfaced; the two name-colliding
// member interfaces are reachable via that union.
export {
  generateUnitTests,
  renderMarkdownReport as renderUnitTestReport,
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  DEFAULT_WORKFLOW_LIMITS,
  detectConventions,
  isTestPath,
  type AddedTestFile,
  type FileNamingStyle,
  type TestConventions,
  type UnitTestTarget,
  type UnitTestWorkflowDeps,
  type UnitTestWorkflowInput,
  type UnitTestWorkflowReport,
  type WorkflowDescriptor,
  type WorkflowEvent,
  type WorkflowEventSink,
  type WorkflowInputSpec,
  type WorkflowLimits,
  type WorkflowStatus,
} from "./workflows/index.js";

// Bug-investigation workflow (ADR-0009). Exported explicitly (not via `export *`) for the same
// reason as the unit-test workflow: the event family reuses harness event-type NAMES by structural
// convention, so a star re-export would collide with the harness ones surfaced above. The Markdown
// renderer is aliased to renderBugInvestigationReport (mirroring renderUnitTestReport) so the two
// workflow renderers do not collide at the package root.
export {
  investigateBug,
  renderBugMarkdownReport as renderBugInvestigationReport,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
  DEFAULT_BUG_WORKFLOW_LIMITS,
  isSensitivePath,
  isElevatedReviewPath,
  parseFailureEvidence,
  type BugInvestigationDeps,
  type BugInvestigationEvent,
  type BugInvestigationInput,
  type BugInvestigationReport,
  type BugReportInput,
  type BugWorkflowEventSink,
  type BugWorkflowLimits,
  type BugWorkflowStatus,
  type ChangedFile,
  type FailureEvidence,
  type FailureFrame,
  type Hypothesis,
  type VerifiedFindings,
} from "./workflows/index.js";

// Audit ledger / evidence manifests (ADR-0010). Exported explicitly (not via `export *`) to keep the
// public surface auditable, matching the workflow precedent above. None of these names collides with
// an existing root export; in particular the layer does NOT export a bare `summarizeForAudit` or
// `redact` (it composes them internally), so the canonical root `summarizeForAudit` is unaffected.
export {
  buildEvidenceManifest,
  persistEvidence,
  createAuditRedactor,
  createNodeEvidenceStore,
  createInMemoryEvidenceStore,
  aggregateUsage,
  listEvidence,
  loadEvidence,
  applyRetention,
  buildEvidenceReport,
  renderEvidenceReport,
  assertValidRunId,
  EVIDENCE_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  type AuditRedactionConfig,
  type EvidenceBuildInput,
  type EvidenceCommandExecution,
  type EvidenceDeps,
  type EvidenceListEntry,
  type EvidenceManifest,
  type EvidenceModel,
  type EvidencePatch,
  type EvidenceReasoningEntry,
  type EvidenceReport,
  type EvidenceRunIdentity,
  type EvidenceStateTransition,
  type EvidenceStore,
  type EvidenceToolCall,
  type EvidenceUsageTotals,
  type EvidenceVerificationResult,
  type RetentionPolicy,
} from "./audit/index.js";

// Cost-class resolver (relocated to the model gateway in issue #163 so the evidence package stays
// leaf-clean against ADR-0019 rule 3d). Re-exported on the root surface here to preserve the
// pre-#163 public API for downstream callers that imported `resolveCostClass` from "keiko".
// The `export * from "./gateway/index.js"` at the top of this file already re-exports it via the
// gateway shim; the explicit line below makes the surface guarantee auditable and survives a
// future barrel refactor.
export { resolveCostClass } from "./gateway/index.js";

// Wave 1 evaluation harness (ADR-0012 D11). Exported explicitly (not via `export *`) to keep the
// public surface auditable, matching the workflow/audit precedent above. None of these names
// collides with an existing root export.
export {
  runEvaluationSuite,
  createScriptedModelPort,
  EVAL_SCORECARD_SCHEMA_VERSION,
  type ScriptedModelPort,
  type EvalScorecard,
  type EvaluationFixture,
  type EvaluationDimension,
  type EvaluationMode,
  type DimensionResult,
  type DimensionOutcome,
  type ScorecardEntry,
  type ScorecardSummary,
  type SurfaceParityResult,
  type FixtureRunResult,
  type FixtureOracle,
  type WorkflowKind,
} from "./evaluations/index.js";
