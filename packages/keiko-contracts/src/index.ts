// Public surface of @oscharko-dev/keiko-contracts. Issue #158 carries the first real type surface
// out of `src/<layer>/types.ts` into this leaf package. Re-exports use the explicit `export type`
// form for type-only names and `export` for value-emitting frozen const tables because
// verbatimModuleSyntax is on in tsconfig.base.json.
//
// The workflow event families (unit-test, bug-investigation) reuse the harness event-type NAMES
// (ModelCallStartedEvent, ModelCallCompletedEvent, PatchAppliedEvent, VerificationResultEvent) by
// structural convention. We surface only the workflow event UNION types here; the harness member
// names own the bare identifiers. Callers narrow on the union to reach the member shapes — the
// same pattern src/index.ts already uses.

export const KEIKO_CONTRACTS_VERSION = "0.1.0" as const;

// ─── Harness ───────────────────────────────────────────────────────────────────
export type {
  HarnessStateName,
  TerminalState,
  StateTransition,
  HarnessLimits,
  TaskType,
  GenerateUnitTestsInput,
  InvestigateBugInput,
  ExplainPlanInput,
  VerifyInput,
  TaskInput,
  RunCounters,
  RunOutcome,
  RunResult,
  RunManifest,
  HarnessCode,
  HarnessFailure,
  RunStartedEvent,
  StateTransitionEvent,
  ModelCallStartedEvent,
  ModelCallCompletedEvent,
  ModelCallFailedEvent,
  ToolCallStartedEvent,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  CommandExecutedEvent,
  SandboxConfiguredEvent,
  PatchAppliedEvent,
  ReasoningTraceEvent,
  PatchProposedEvent,
  VerificationResultEvent,
  RunCompletedEvent,
  RunCancelledEvent,
  RunFailedEvent,
  BrowserSessionCloseReason,
  BrowserSessionOpenedEvent,
  BrowserNavigatedEvent,
  BrowserScreenshotCapturedEvent,
  BrowserPageContentCapturedEvent,
  BrowserSessionClosedEvent,
  BrowserTrustWarningEvent,
  BrowserErrorEvent,
  BrowserEvent,
  HarnessEvent,
} from "./harness.js";
export { TERMINAL_STATES, DEFAULT_LIMITS, HARNESS_CODES } from "./harness.js";

// ─── Workflow descriptor ────────────────────────────────────────────────────────
export type { WorkflowDescriptor, WorkflowInputSpec } from "./workflow-descriptor.js";

// ─── Workspace ──────────────────────────────────────────────────────────────────
export type {
  WorkspaceLanguage,
  TestFramework,
  WorkspaceInfo,
  DiscoveredFile,
  DiscoveryOptions,
  DiscoveryStats,
  ReadOptions,
  FileContent,
  SelectionReason,
  ContextRequest,
  ContextEntry,
  ContextPack,
  ContextEntrySummary,
  ContextPackSummary,
  WorkspaceSummary,
  AuditEntry,
  AuditSummary,
} from "./workspace.js";
export {
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_READ_OPTIONS,
  SELECTION_REASON_PRIORITY,
  DEFAULT_CONTEXT_REQUEST,
} from "./workspace.js";

// ─── Gateway (wire-safe subset only — credential-bearing shapes stay in src/gateway/types.ts) ──
export type {
  ModelKind,
  CostClass,
  LatencyClass,
  ModelCapability,
  ChatMessage,
  ToolDefinition,
  ResponseFormat,
  GatewayRequest,
  NormalizedToolCall,
  UsageMetadata,
  NormalizedResponse,
  FinishReason,
  StreamDelta,
  StreamEvent,
} from "./gateway.js";

// ─── Tools ──────────────────────────────────────────────────────────────────────
export type {
  NetworkPolicy,
  SandboxPolicy,
  CommandRule,
  CommandRunInput,
  CommandResult,
  PatchChangeKind,
  PatchHunk,
  PatchFileChange,
  PatchRejectionCode,
  PatchRejection,
  PatchConflict,
  PatchValidation,
  PatchLimits,
  PatchApplyResult,
  ToolHostConfig,
  ToolHostConfigInput,
} from "./tools.js";
export {
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_COMMAND_RULES,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_TOOL_HOST_CONFIG,
} from "./tools.js";

// ─── Verification ───────────────────────────────────────────────────────────────
export type {
  VerificationKind,
  VerificationStatus,
  ResourceDimension,
  ResourceLimitDecision,
  VerificationResourceLimits,
  VerificationStep,
  VerificationPlan,
  VerificationResult,
  VerificationReport,
  ScriptCatalog,
  ScriptMapping,
} from "./verification.js";
export { DEFAULT_VERIFICATION_LIMITS } from "./verification.js";

// ─── Evaluations ────────────────────────────────────────────────────────────────
export type {
  EvaluationDimension,
  FixtureOracle,
  WorkflowKind,
  EvaluationFixture,
  DimensionOutcome,
  DimensionResult,
  FixtureRunResult,
  ScorecardEntry,
  SurfaceParityCheckResult,
  SurfaceParityResult,
  LiveRunContext,
  ScorecardSummary,
  EvalScorecard,
  EvaluationMode,
} from "./evaluations.js";
export { EVALUATION_DIMENSIONS, EVAL_SCORECARD_SCHEMA_VERSION } from "./evaluations.js";

// ─── Unit-test workflow events (member names collide with harness; only union surfaces) ───
export type {
  WorkflowStatus,
  FileNamingStyle,
  WorkflowLimits,
  WorkflowEvent,
  WorkflowEventSink,
} from "./unit-test-events.js";
export { DEFAULT_WORKFLOW_LIMITS } from "./unit-test-events.js";

// ─── Bug-investigation workflow events (distinct member names by ADR-0009 D5) ─────
export type {
  BugWorkflowStatus,
  BugWorkflowLimits,
  BugInvestigationStartedEvent,
  FailureParsedEvent,
  BugContextSelectedEvent,
  BugModelCallStartedEvent,
  BugModelCallCompletedEvent,
  RootCauseProposedEvent,
  BugPatchValidatedEvent,
  BugPatchAppliedEvent,
  BugVerificationResultEvent,
  BugInvestigationCompletedEvent,
  BugInvestigationFailedEvent,
  BugInvestigationEvent,
  BugWorkflowEventSink,
} from "./bug-investigation-events.js";
export { DEFAULT_BUG_WORKFLOW_LIMITS } from "./bug-investigation-events.js";

// ─── Verification summary (pure types; runtime functions stay in src/verification/summary.ts) ──
export type {
  VerificationResultSummary,
  VerificationSummary,
  AuditResultEntry,
  VerificationAuditSummary,
} from "./verification-summary.js";

// ─── Evidence (ADR-0010; store port + manifest types + retention config) ────────────────────
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
  EvidenceManifest,
  AuditRedactionConfig,
  RetentionPolicy,
  BuildOptions,
  EvidenceBuildInput,
  EvidenceDeps,
  EvidenceStore,
} from "./evidence.js";
export { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION } from "./evidence.js";

// ─── BFF wire types (ADR-0013; entity shapes that travel over the HTTP wire) ──────────────
// NOTE: WorkflowStatus and ChatMessage are NOT re-exported here because those names are already
// taken by unit-test-events.ts and gateway.ts respectively. Import them directly from
// "@oscharko-dev/keiko-contracts/bff-wire" when needed (the subpath key has no .js suffix).
export type {
  Project,
  Chat,
  ChatRole,
  CreateChatOptions,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
} from "./bff-wire.js";
