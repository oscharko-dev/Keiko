// Single-sourced package version; CLI and SDK both read this to avoid drift.
export const SDK_VERSION = "0.1.0";

// The typed agent surface. AgentConfig, the session factory, the run result, and the
// session handle all live in the harness module (ADR-0004); the SDK re-exports them so
// callers import the agent API from one place.
export {
  createSession,
  runAgent,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
  type RunResult,
  type TaskInput,
  type TaskType,
} from "../harness/index.js";

// Safe workspace context surface (ADR-0005). The only file-read path is the
// boundary-checked one; no export returns raw arbitrary file content.
export {
  buildWorkspaceSummary,
  detectWorkspace,
  summarizeForAudit,
  type AuditEntry,
  type AuditSummary,
  type ContextEntrySummary,
  type ContextPackSummary,
  type WorkspaceInfo,
  type WorkspaceSummary,
} from "../workspace/index.js";

// Verification orchestrator surface (ADR-0007). Verification reuses the #6 command boundary
// unchanged; these are the plan/run/summary entry points and their JSON-serializable shapes
// (the stable contract the #10 audit ledger persists). The audit projection is exposed under an
// explicit alias because the workspace surface already owns `summarizeForAudit`.
export {
  buildVerificationPlan,
  buildVerificationSummary,
  classifyOutcome,
  detectScripts,
  renderMarkdownSummary,
  resolveTargetedTests,
  runVerification,
  summarizeForAudit as summarizeVerificationForAudit,
  DEFAULT_VERIFICATION_LIMITS,
  type ResourceLimitDecision,
  type VerificationAuditSummary,
  type VerificationDeps,
  type VerificationKind,
  type VerificationPlan,
  type VerificationReport,
  type VerificationResourceLimits,
  type VerificationResult,
  type VerificationStatus,
  type VerificationStep,
  type VerificationSummary,
} from "../verification/index.js";

// Reviewable developer-assist workflows (ADR-0008). The unit-test generation workflow is the first
// programmatic workflow surface: generateUnitTests is the single entry, the descriptor lets a UI
// (#13) render the workflow without the implementation, and the WorkflowEvent union plus report
// types are the stable contract the #10 audit ledger persists.
export {
  generateUnitTests,
  renderMarkdownReport,
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
} from "../workflows/index.js";

// Bug-investigation workflow (ADR-0009). The second programmatic workflow surface: investigateBug
// is the single entry, BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR lets a UI (#13) render it without the
// implementation, and the BugInvestigationReport (with its structural verified/hypothesis split)
// plus the BugInvestigationEvent union are the stable contract the #10 audit ledger persists. The
// Markdown renderer is aliased to avoid colliding with the unit-test workflow's renderMarkdownReport.
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
} from "../workflows/index.js";

// Audit ledger / evidence manifests (ADR-0010). The first persistent-artifact surface: persistEvidence
// builds → redacts-by-construction → writes a redacted, versioned EvidenceManifest, and listEvidence /
// loadEvidence are the #13 UI seam. Exported via an explicit named block (not `export *`) to keep the
// surface auditable; none of these names collides with an existing layer export (the layer does NOT
// export a bare `summarizeForAudit` or `redact` — it composes them internally).
export {
  buildEvidenceManifest,
  persistEvidence,
  createAuditRedactor,
  createNodeEvidenceStore,
  createInMemoryEvidenceStore,
  aggregateUsage,
  resolveCostClass,
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
  type RetentionPolicy,
} from "../audit/index.js";

// Wave 1 evaluation harness (ADR-0012 D11). The deterministic offline runner, the product-code
// scripted-model replay port, and the versioned scorecard schema, exported via an explicit named
// block (no `export *`). ScriptedModelPort is surfaced so external callers can build replay tooling
// without the full runner. No name collides with an existing SDK export.
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
} from "../evaluations/index.js";
