// Package-root boundary: the root package is an intentional facade over workspace package
// surfaces. The SDK now lives in @oscharko-dev/keiko-sdk, so the root keeps only the minimal
// 0.2.0 product facade plus the installed CLI entrypoint under src/cli/index.ts.
export {
  SDK_VERSION,
  runAgent,
  type SdkAgentConfig,
  type SdkEvidenceOptions,
} from "@oscharko-dev/keiko-sdk";
export * from "@oscharko-dev/keiko-harness";
export * from "@oscharko-dev/keiko-model-gateway";
export * from "@oscharko-dev/keiko-workspace";
export * from "@oscharko-dev/keiko-verification";
// Both the workspace and verification barrels expose a `summarizeForAudit`. An explicit re-export
// takes precedence over the two star exports and resolves the ambiguity at the package root: the
// canonical root `summarizeForAudit` is the workspace one (established by ADR-0005), and the
// verification audit projection is additionally surfaced under an unambiguous alias. Inside
// ./verification/index.js the function keeps its layer-local name `summarizeForAudit` (ADR-0007).
export { summarizeForAudit } from "@oscharko-dev/keiko-workspace";
export { summarizeForAudit as summarizeVerificationForAudit } from "@oscharko-dev/keiko-verification";

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
} from "@oscharko-dev/keiko-workflows";

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
} from "@oscharko-dev/keiko-workflows";

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
} from "@oscharko-dev/keiko-evidence";

// Cost-class resolver. Re-exported explicitly so the root package keeps a stable,
// auditable named export even if the model-gateway barrel changes later.
export { resolveCostClass } from "@oscharko-dev/keiko-model-gateway";

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
} from "@oscharko-dev/keiko-evaluations";
