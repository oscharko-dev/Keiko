// Public barrel for the agent harness: the session API, all ports/adapters/sinks, the
// task types, the event schema, the limit/error taxonomy, and the deterministic ID and
// fingerprint sources. Downstream tools, evidence, UI, and evaluation code depend only
// on these typed seams (ADR-0004 D2).

export { KEIKO_HARNESS_VERSION } from "./version.js";

export {
  createSession,
  HARNESS_VERSION,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
} from "./session.js";
export {
  createOrchestrationSession,
  DEFAULT_ORCHESTRATION_LIMITS,
  DEFAULT_ROLE_POLICIES,
  DEFAULT_SETTLEMENT_POLICY,
  type OrchestrationChildRequest,
  type OrchestrationChildResult,
  type OrchestrationConfig,
  type OrchestrationDeps,
  type OrchestrationLimits,
  type OrchestrationSchedulerHooks,
  type OrchestrationSession,
  type OrchestrationSessionResult,
  type ResourceAccessMode,
  type ResourceClaim,
  type ResourceConflict,
  type ResourceConflictPolicy,
  type ResourceKind,
  type SettlementPolicy,
  type RolePolicy,
} from "./orchestration.js";

// runAgent is the ergonomic SDK alias of createSession; both start a bounded run.
export { createSession as runAgent } from "./session.js";

export {
  DEFAULT_LIMITS,
  HARNESS_CODES,
  ORCHESTRATION_ALLOWED_STATE_TRANSITIONS,
  ORCHESTRATION_CHILD_OUTCOMES,
  ORCHESTRATION_CHILD_ROLES,
  ORCHESTRATION_EXECUTION_MODES,
  ORCHESTRATION_RUN_KINDS,
  ORCHESTRATION_SCHEMA_VERSION,
  ORCHESTRATION_STATES,
  ORCHESTRATION_TERMINAL_STATES,
  TERMINAL_STATES,
  assertOrchestrationStateTransition,
  isOrchestrationStateTransitionAllowed,
  type ExplainPlanInput,
  type GenerateUnitTestsInput,
  type HarnessCode,
  type HarnessEvent,
  type HarnessFailure,
  type HarnessLimits,
  type HarnessStateName,
  type InvestigateBugInput,
  type OrchestrationAuthorityBoundary,
  type OrchestrationChildOutcome,
  type OrchestrationChildPlan,
  type OrchestrationChildRole,
  type OrchestrationChildSettlement,
  type OrchestrationExecutionMode,
  type OrchestrationInvalidTransition,
  type OrchestrationPlan,
  type OrchestrationRunIdentity,
  type OrchestrationRunKind,
  type OrchestrationSettlementDecision,
  type OrchestrationSettlementOutcome,
  type OrchestrationSettlementReason,
  type OrchestrationSettlementStrategy,
  type OrchestrationState,
  type OrchestrationStateTransition,
  type ModelCallCompletedEvent,
  type ModelCallFailedEvent,
  type ModelCallStartedEvent,
  type PatchProposedEvent,
  type ReasoningTraceEvent,
  type RunCancelledEvent,
  type RunCompletedEvent,
  type RunCounters,
  type RunFailedEvent,
  type RunManifest,
  type RunOutcome,
  type RunResult,
  type RunStartedEvent,
  type StateTransition,
  type StateTransitionEvent,
  type TaskInput,
  type TaskType,
  type TerminalState,
  type ToolCallCompletedEvent,
  type ToolCallFailedEvent,
  type ToolCallStartedEvent,
  type VerificationResultEvent,
} from "./types.js";

export {
  HarnessError,
  HarnessInternalError,
  HarnessModelError,
  HarnessToolError,
  LimitExceededError,
  toFailure,
} from "./errors.js";

export type {
  EventSink,
  Fingerprinter,
  FingerprintInput,
  IdSource,
  ModelPort,
  ToolCallMetadata,
  ToolCallRequest,
  ToolCallResult,
  ToolPort,
} from "./ports.js";

export {
  DryRunToolPort,
  GatewayModelPort,
  type ChatModel,
  type RecordedToolCall,
} from "./adapters.js";

export { CliEventSink, MemoryEventSink, type EventWriter, type ManifestSeed } from "./sinks.js";

export {
  canonicalise,
  configFingerprint,
  counterIdSource,
  defaultFingerprinter,
  defaultIdSource,
} from "./fingerprint.js";

export { resolveTaskPlan, type TaskPlan } from "./tasks/policy.js";
