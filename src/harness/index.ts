// Re-export shim: the harness now lives in @oscharko-dev/keiko-harness (issue #164,
// ADR-0019). All existing import sites (`from "../harness/index.js"`) keep resolving
// unchanged via this barrel. Symbols enumerated explicitly to match the PRE-MOVE surface
// of src/harness/index.ts (per the keiko-tools / keiko-workspace / keiko-evidence
// precedent — never `export *` in a legacy shim).

export {
  createSession,
  HARNESS_VERSION,
  runAgent,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
} from "@oscharko-dev/keiko-harness";

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
} from "@oscharko-dev/keiko-harness";

export {
  HarnessError,
  HarnessInternalError,
  HarnessModelError,
  HarnessToolError,
  LimitExceededError,
  toFailure,
} from "@oscharko-dev/keiko-harness";

export type {
  EventSink,
  Fingerprinter,
  FingerprintInput,
  IdSource,
  ModelPort,
  ToolCallRequest,
  ToolCallResult,
  ToolPort,
} from "@oscharko-dev/keiko-harness";

export {
  DryRunToolPort,
  GatewayModelPort,
  type ChatModel,
  type RecordedToolCall,
} from "@oscharko-dev/keiko-harness";

export {
  CliEventSink,
  MemoryEventSink,
  type EventWriter,
  type ManifestSeed,
} from "@oscharko-dev/keiko-harness";

export {
  canonicalise,
  configFingerprint,
  counterIdSource,
  defaultFingerprinter,
  defaultIdSource,
} from "@oscharko-dev/keiko-harness";

export { resolveTaskPlan, type TaskPlan } from "@oscharko-dev/keiko-harness";
