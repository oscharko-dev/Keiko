// Public surface of @oscharko-dev/keiko-contracts. Issue #158 carries the first real type surface
// out of `src/<layer>/types.ts` into this leaf package. Re-exports use the explicit `export type`
// form for type-only names and `export` for value-emitting frozen const tables because
// verbatimModuleSyntax is on in tsconfig.base.json.

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
