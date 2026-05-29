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
