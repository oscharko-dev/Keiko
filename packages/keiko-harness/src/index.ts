// Public barrel for the agent harness: the session API, all ports/adapters/sinks, the
// task types, the event schema, the limit/error taxonomy, and the deterministic ID and
// fingerprint sources. Downstream issues (#6 tools, #10 audit, #13 UI) depend only on
// these typed seams (ADR-0004 D2).

export {
  createSession,
  HARNESS_VERSION,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
} from "./session.js";

// runAgent is the ergonomic SDK alias of createSession; both start a bounded run.
export { createSession as runAgent } from "./session.js";

export {
  DEFAULT_LIMITS,
  HARNESS_CODES,
  TERMINAL_STATES,
  type ExplainPlanInput,
  type GenerateUnitTestsInput,
  type HarnessCode,
  type HarnessEvent,
  type HarnessFailure,
  type HarnessLimits,
  type HarnessStateName,
  type InvestigateBugInput,
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
