// Public-surface pin test, mirroring keiko-evidence / keiko-tools / keiko-workspace /
// keiko-model-gateway. Every symbol that lives on the package's main entry point is touched
// here so a future refactor that accidentally drops a named export — or downgrades a value to
// a type-only re-export — fails this test instead of silently breaking a downstream caller.
//
// The harness is the orchestration package: the session/state-machine, the ports, the
// adapters, the event sinks, the fingerprint sources, the error taxonomy, the typed event
// schema. Every consumer wave (#6 tools, #10 evidence, #13 UI, #11 evaluations, the BFF run
// engine, the verification orchestrator) depends on this surface — so the "stable public
// surface" guarantee is load-bearing.

import { describe, expect, it } from "vitest";
import * as harness from "./index.js";
import type {
  AgentConfig,
  AgentSession,
  ChatModel,
  EventSink,
  EventWriter,
  ExplainPlanInput,
  Fingerprinter,
  FingerprintInput,
  GenerateUnitTestsInput,
  HarnessCode,
  HarnessDeps,
  HarnessEvent,
  HarnessFailure,
  HarnessLimits,
  HarnessStateName,
  IdSource,
  InvestigateBugInput,
  ManifestSeed,
  ModelCallCompletedEvent,
  ModelCallFailedEvent,
  ModelCallStartedEvent,
  ModelPort,
  OrchestrationAuthorityBoundary,
  OrchestrationChildOutcome,
  OrchestrationChildRequest,
  OrchestrationChildResult,
  OrchestrationChildPlan,
  OrchestrationChildRole,
  OrchestrationChildSettlement,
  OrchestrationConfig,
  OrchestrationDeps,
  OrchestrationExecutionMode,
  OrchestrationInvalidTransition,
  OrchestrationLimits,
  OrchestrationPlan,
  OrchestrationRunIdentity,
  OrchestrationRunKind,
  OrchestrationSchedulerHooks,
  OrchestrationSession,
  OrchestrationSessionResult,
  OrchestrationState,
  OrchestrationStateTransition,
  PatchProposedEvent,
  ReasoningTraceEvent,
  RecordedToolCall,
  ResourceAccessMode,
  ResourceClaim,
  ResourceConflict,
  ResourceConflictPolicy,
  ResourceKind,
  SettlementPolicy,
  RolePolicy,
  RunCancelledEvent,
  RunCompletedEvent,
  RunCounters,
  RunFailedEvent,
  RunManifest,
  RunOutcome,
  RunResult,
  RunStartedEvent,
  StateTransition,
  StateTransitionEvent,
  TaskInput,
  TaskPlan,
  TaskType,
  TerminalState,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  ToolCallMetadata,
  ToolCallRequest,
  ToolCallResult,
  ToolCallStartedEvent,
  ToolPort,
  VerificationResultEvent,
} from "./index.js";

describe("keiko-harness public surface", () => {
  it("exposes the documented value barrel members", () => {
    // Package version (distinct from HARNESS_VERSION which is the runtime/event-schema
    // version re-exported from @oscharko-dev/keiko-contracts).
    expect(harness.KEIKO_HARNESS_VERSION).toBe("0.1.0");
    // Session API:
    expect(typeof harness.createSession).toBe("function");
    expect(typeof harness.runAgent).toBe("function");
    expect(harness.runAgent).toBe(harness.createSession);
    expect(typeof harness.createOrchestrationSession).toBe("function");
    expect(typeof harness.HARNESS_VERSION).toBe("string");
    // Frozen tables (re-exported from keiko-contracts):
    expect(harness.DEFAULT_LIMITS).toBeDefined();
    expect(harness.HARNESS_CODES).toBeDefined();
    expect(harness.TERMINAL_STATES).toBeDefined();
    expect(harness.ORCHESTRATION_SCHEMA_VERSION).toBe("1");
    expect(harness.ORCHESTRATION_RUN_KINDS).toContain("child-run");
    expect(harness.ORCHESTRATION_EXECUTION_MODES).toContain("parallel");
    expect(harness.ORCHESTRATION_STATES).toContain("dispatching");
    expect(harness.ORCHESTRATION_TERMINAL_STATES.has("failed")).toBe(true);
    expect(harness.ORCHESTRATION_CHILD_ROLES).toContain("reviewer");
    expect(harness.ORCHESTRATION_CHILD_OUTCOMES).toContain("discarded");
    expect(harness.ORCHESTRATION_ALLOWED_STATE_TRANSITIONS.running).toContain("merging");
    expect(typeof harness.isOrchestrationStateTransitionAllowed).toBe("function");
    expect(typeof harness.assertOrchestrationStateTransition).toBe("function");
    expect(harness.DEFAULT_ORCHESTRATION_LIMITS.maxConcurrentChildren).toBeGreaterThan(0);
    expect(harness.DEFAULT_ROLE_POLICIES.implementer.allowsParallel).toBe(true);
    expect(harness.DEFAULT_SETTLEMENT_POLICY.escalateOnConflicts).toBe(true);
    // Error taxonomy (re-exported from keiko-security):
    expect(typeof harness.HarnessError).toBe("function");
    expect(typeof harness.HarnessInternalError).toBe("function");
    expect(typeof harness.HarnessModelError).toBe("function");
    expect(typeof harness.HarnessToolError).toBe("function");
    expect(typeof harness.LimitExceededError).toBe("function");
    expect(typeof harness.toFailure).toBe("function");
    // Port adapters:
    expect(typeof harness.DryRunToolPort).toBe("function");
    expect(typeof harness.GatewayModelPort).toBe("function");
    // Event sinks:
    expect(typeof harness.CliEventSink).toBe("function");
    expect(typeof harness.MemoryEventSink).toBe("function");
    // Fingerprinting / ID sources:
    expect(typeof harness.canonicalise).toBe("function");
    expect(typeof harness.configFingerprint).toBe("function");
    expect(typeof harness.counterIdSource).toBe("function");
    expect(harness.defaultFingerprinter).toBeDefined();
    expect(harness.defaultIdSource).toBeDefined();
    // Task-policy resolver:
    expect(typeof harness.resolveTaskPlan).toBe("function");
  });

  it("every type-only re-export is reachable by name at compile time", () => {
    // verbatimModuleSyntax requires the type imports above to be USED in a type position. A
    // phantom generic `pin<T>()` references the type argument at the call site without producing
    // any runtime value, so each symbol stays load-bearing on the public surface.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<AgentConfig>();
    pin<AgentSession>();
    pin<ChatModel>();
    pin<EventSink>();
    pin<EventWriter>();
    pin<ExplainPlanInput>();
    pin<Fingerprinter>();
    pin<FingerprintInput>();
    pin<GenerateUnitTestsInput>();
    pin<HarnessCode>();
    pin<HarnessDeps>();
    pin<HarnessEvent>();
    pin<HarnessFailure>();
    pin<HarnessLimits>();
    pin<HarnessStateName>();
    pin<IdSource>();
    pin<InvestigateBugInput>();
    pin<ManifestSeed>();
    pin<ModelCallCompletedEvent>();
    pin<ModelCallFailedEvent>();
    pin<ModelCallStartedEvent>();
    pin<ModelPort>();
    pin<OrchestrationAuthorityBoundary>();
    pin<OrchestrationChildOutcome>();
    pin<OrchestrationChildRequest>();
    pin<OrchestrationChildResult>();
    pin<OrchestrationChildPlan>();
    pin<OrchestrationChildRole>();
    pin<OrchestrationChildSettlement>();
    pin<OrchestrationConfig>();
    pin<OrchestrationDeps>();
    pin<OrchestrationExecutionMode>();
    pin<OrchestrationInvalidTransition>();
    pin<OrchestrationLimits>();
    pin<OrchestrationPlan>();
    pin<OrchestrationRunIdentity>();
    pin<OrchestrationRunKind>();
    pin<OrchestrationSchedulerHooks>();
    pin<OrchestrationSession>();
    pin<OrchestrationSessionResult>();
    pin<OrchestrationState>();
    pin<OrchestrationStateTransition>();
    pin<PatchProposedEvent>();
    pin<ReasoningTraceEvent>();
    pin<RecordedToolCall>();
    pin<RunCancelledEvent>();
    pin<RunCompletedEvent>();
    pin<RunCounters>();
    pin<RunFailedEvent>();
    pin<RunManifest>();
    pin<RunOutcome>();
    pin<RunResult>();
    pin<RunStartedEvent>();
    pin<StateTransition>();
    pin<StateTransitionEvent>();
    pin<TaskInput>();
    pin<TaskPlan>();
    pin<TaskType>();
    pin<TerminalState>();
    pin<ToolCallCompletedEvent>();
    pin<ToolCallFailedEvent>();
    pin<ToolCallMetadata>();
    pin<ToolCallRequest>();
    pin<ToolCallResult>();
    pin<ToolCallStartedEvent>();
    pin<ToolPort>();
    pin<VerificationResultEvent>();
    pin<ResourceAccessMode>();
    pin<ResourceClaim>();
    pin<ResourceConflict>();
    pin<ResourceConflictPolicy>();
    pin<ResourceKind>();
    pin<SettlementPolicy>();
    pin<RolePolicy>();
  });
});
