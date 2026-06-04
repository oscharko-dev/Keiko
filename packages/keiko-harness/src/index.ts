// Public barrel for the agent harness: the session API, all ports/adapters/sinks, the
// task types, the event schema, the limit/error taxonomy, and the deterministic ID and
// fingerprint sources. Downstream issues (#6 tools, #10 audit, #13 UI) depend only on
// these typed seams (ADR-0004 D2). After issue #164 (ADR-0019) the harness lives in
// `packages/keiko-harness/`; the legacy `src/harness/` directory now contains only
// enumerated re-export shims that keep every consumer's existing import path resolving
// unchanged.

export { KEIKO_HARNESS_VERSION } from "./version.js";

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

// Harness internals re-exported on the package barrel so the legacy
// `src/harness/<file>.ts` shims (issue #164) and the package's own
// `src/<file>.test.ts` suites can both reach them through one import source. These
// symbols are NOT documented in the harness public-API surface — they are exposed
// here purely so a) the legacy `src/harness/` shim layer can keep `from
// "../harness/loop.js"` style imports resolving without subpath-importing into the
// package, and b) the in-package tests can use the same `@oscharko-dev/keiko-harness`
// entry point as production consumers. Downstream consumers should depend on the
// documented surface above, not on these.
export { Emitter } from "./emitter.js";
export { runLoop } from "./loop.js";
export { handleModelCall, handleToolCall } from "./executor.js";
export { handlePatchProposal, handleReporting, handleVerification } from "./patcher.js";
export { handleContextSelection, handlePlanning } from "./planner.js";
export { contextBytes, newCounters, type RunContext, type StateStep } from "./context.js";
export { buildExplainPlan } from "./tasks/explain-plan.js";
export { buildGenerateUnitTests } from "./tasks/generate-unit-tests.js";
export { buildInvestigateBug } from "./tasks/investigate-bug.js";
export { buildVerify } from "./tasks/verify.js";
