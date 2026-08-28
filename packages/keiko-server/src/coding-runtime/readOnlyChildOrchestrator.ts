// One-layer, read-only sub-agent orchestration for Epic #2384 Code-task auxiliary capabilities
// (Issue #2387, Module C). `createReadOnlyChildOrchestrator` handles one
// `AuxiliaryCapabilityRequestV1` with `capability: "child-agent"` and returns exactly one
// normalized `AuxiliaryCapabilityOutcomeV1`. It REUSES a bounded runner (injected; in production the
// keiko-harness `runLoop`, in tests a fake) rather than building a second engine, and it owns every
// governance boundary around that runner through a single tool gate:
//   • one layer — a nested child request is denied (`nested-child-denied`);
//   • read-only — any mutation / delivery / command / connector attempt is denied;
//   • budget — every child tool call is charged against the PARENT budget; exhaustion ⇒ limit-reached
//     (both the request's `maxToolCalls` and the parent's remaining budget bound the child);
//   • cancellation — a parent pause / stop / question / approval / revocation / timeout cascades to
//     `stopped`, and the latched gate leaves no orphan tool call behind.
// Lifecycle is surfaced content-free: a `child-run-started` event, then a `child-run-completed`
// event carrying the normalized outcome and an EXPLICIT child result count (zero is a valid,
// accepted result). Evidence is ids, counts, and bounded reason codes only.
import {
  CODE_TASK_AUXILIARY_SCHEMA_VERSION,
  isCodeTaskChildRunId,
  validateAuxiliaryCapabilityOutcomeV1,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type {
  AuxiliaryCapabilityOutcomeV1,
  AuxiliaryCapabilityRequestV1,
  AuxiliaryResearchScopeV1,
  AuxiliaryOutcomeStatus,
  CodeTaskChildRunId,
  CodeTaskFact,
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  assertChildCannotSpawnChild,
  deriveReadOnlyChildEnvelope,
} from "./readOnlyChildEnvelope.js";
import type { ChildAgentRequestV1, ReadOnlyChildEnvelope } from "./readOnlyChildEnvelope.js";

/** A governance terminal from the gate or the orchestrator — every non-accepted outcome status. */
export type ReadOnlyChildTerminal = Exclude<AuxiliaryOutcomeStatus, "accepted">;

/** The action class a child intends before the orchestrator lets it touch anything. */
export type ReadOnlyChildToolClass = CodingWorkbenchActionClass | "child-agent";

export interface ReadOnlyChildToolAttempt {
  readonly toolClass: ReadOnlyChildToolClass;
}

export type ReadOnlyChildGateDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly terminal: ReadOnlyChildTerminal; readonly reasonCode: string };

/** Bounded content-free reasons a run must cascade to `stopped`. */
export type ReadOnlyChildStopReason =
  | "parent-paused"
  | "parent-stopped"
  | "parent-question"
  | "awaiting-approval"
  | "authority-revoked"
  | "timeout";

export interface ReadOnlyChildRunnerInput {
  readonly envelope: ReadOnlyChildEnvelope;
  readonly objective: string;
  readonly modelId: string;
  readonly workspaceRoot: string;
  /**
   * Upper bound on child tool calls: the request's own ceiling, clamped to the parent authority's
   * total budget ceiling. The parent's true LIVE remaining budget is still enforced per call by the
   * charger — this bound only stops an over-broad request value from ever reaching the runner.
   */
  readonly maxToolCalls: number;
  /** Aborts on a parent stop AND at the wall-clock deadline, so a non-cooperative runner is stopped. */
  readonly signal: AbortSignal;
  /** The runner MUST route every intended tool call through this gate and stop on a non-ok result. */
  readonly gate: (attempt: ReadOnlyChildToolAttempt) => ReadOnlyChildGateDecision;
}

export interface ReadOnlyChildRunnerResult {
  /** Number of read observations the child produced; zero is valid. */
  readonly resultCount: number;
  /** Content-free digest fact of the child result summary (sha256 known, or an explicit absence). */
  readonly resultDigest: CodeTaskFact<string>;
}

/** The bounded child engine. In production an adapter over keiko-harness `runLoop`. */
export interface ReadOnlyChildRunner {
  readonly run: (input: ReadOnlyChildRunnerInput) => Promise<ReadOnlyChildRunnerResult>;
}

/** Charges the PARENT authority budget one read-only tool call; false ⇒ parent budget exhausted. */
export interface ReadOnlyChildBudgetCharger {
  readonly chargeParentToolCall: () => boolean;
}

/** The live parent guard state; a defined reason means the run must stop now. */
export interface ReadOnlyChildCancellationSource {
  readonly stopReason: () => ReadOnlyChildStopReason | undefined;
}

export interface ReadOnlyChildOrchestratorDeps {
  readonly runner: ReadOnlyChildRunner;
  readonly charger: ReadOnlyChildBudgetCharger;
  readonly cancellation: ReadOnlyChildCancellationSource;
  readonly emit: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly clock: { readonly now: () => number };
  /** Produces an evidence-safe unique event id for each emitted lifecycle event. */
  readonly newEventId: () => string;
}

export interface ReadOnlyChildInvocationContext {
  readonly parentAuthority: CodingWorkbenchAuthorityEnvelope;
  readonly objective: string;
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly research?: AuxiliaryResearchScopeV1 | undefined;
  /** Present only when the caller is itself a read-only child ⇒ the request is a nested child. */
  readonly originChildEnvelope?: ReadOnlyChildEnvelope | undefined;
  /** Absolute wall-clock deadline (epoch ms) after which the run cascades to `stopped` (timeout). */
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

export interface ReadOnlyChildOrchestrator {
  readonly handleChildRequest: (
    request: AuxiliaryCapabilityRequestV1,
    context: ReadOnlyChildInvocationContext,
  ) => Promise<AuxiliaryCapabilityOutcomeV1>;
}

interface GateState {
  latched: { readonly terminal: ReadOnlyChildTerminal; readonly reasonCode: string } | undefined;
  childToolCalls: number;
}

interface PreparedChildRun {
  readonly childRequest: ChildAgentRequestV1;
  readonly envelope: ReadOnlyChildEnvelope;
  /** The request's own tool-call ceiling, clamped to the parent authority's total budget ceiling. */
  readonly maxToolCalls: number;
}

type PrepareResult =
  | { readonly ok: true; readonly prepared: PreparedChildRun }
  | { readonly ok: false; readonly outcome: AuxiliaryCapabilityOutcomeV1 };

const READ_ONLY_DENIAL_BY_CLASS: Readonly<Record<CodingWorkbenchActionClass, string>> =
  Object.freeze({
    "workspace-read": "workspace-read-denied",
    "workspace-write": "workspace-write-denied",
    "command-execution": "command-execution-denied",
    verification: "verification-denied",
    "connector-access": "connector-access-denied",
    "network-egress": "network-egress-denied",
    "delivery-substrate": "delivery-denied",
  });

export function createReadOnlyChildOrchestrator(
  deps: ReadOnlyChildOrchestratorDeps,
): ReadOnlyChildOrchestrator {
  return {
    handleChildRequest: (
      request: AuxiliaryCapabilityRequestV1,
      context: ReadOnlyChildInvocationContext,
    ): Promise<AuxiliaryCapabilityOutcomeV1> => handleChildRequest(deps, request, context),
  };
}

async function handleChildRequest(
  deps: ReadOnlyChildOrchestratorDeps,
  request: AuxiliaryCapabilityRequestV1,
  context: ReadOnlyChildInvocationContext,
): Promise<AuxiliaryCapabilityOutcomeV1> {
  const childRunId = extractChildRunId(request);
  const prepared = prepareChildRun(deps, request, context);
  if (!prepared.ok) {
    emitRejectedAdmission(deps, context.parentAuthority.runId, childRunId, prepared.outcome);
    return prepared.outcome;
  }
  const preStop = currentStopReason(deps, context);
  if (preStop !== undefined) {
    const outcome = rejectedOutcome("stopped", preStop);
    emitRejectedAdmission(deps, context.parentAuthority.runId, childRunId, outcome);
    return outcome;
  }
  const { childRequest, envelope, maxToolCalls } = prepared.prepared;
  emitStarted(deps, context.parentAuthority.runId, childRequest.childRunId);
  const outcome = await runChild(deps, context, childRequest, envelope, maxToolCalls);
  emitCompleted(deps, context.parentAuthority.runId, childRequest.childRunId, outcome);
  return outcome;
}

/** The request's child run id when syntactically valid, regardless of whether admission succeeds. */
function extractChildRunId(request: AuxiliaryCapabilityRequestV1): CodeTaskChildRunId | undefined {
  return request.capability === "child-agent" && isCodeTaskChildRunId(request.childRunId)
    ? request.childRunId
    : undefined;
}

/** Makes a denied/invalid/nested spawn visible on the event hub, content-free, when attributable. */
function emitRejectedAdmission(
  deps: ReadOnlyChildOrchestratorDeps,
  parentRunId: string,
  childRunId: CodeTaskChildRunId | undefined,
  outcome: AuxiliaryCapabilityOutcomeV1,
): void {
  if (childRunId === undefined) return;
  emitCompleted(deps, parentRunId, childRunId, outcome);
}

function prepareChildRun(
  deps: ReadOnlyChildOrchestratorDeps,
  request: AuxiliaryCapabilityRequestV1,
  context: ReadOnlyChildInvocationContext,
): PrepareResult {
  const admission = assertChildCannotSpawnChild(request, context.originChildEnvelope);
  if (!admission.ok) {
    return { ok: false, outcome: rejectedOutcome("denied", admission.reasonCode) };
  }
  const childRequest = admission.request;
  const derived = deriveReadOnlyChildEnvelope(context.parentAuthority, childRequest.childRunId, {
    ...(context.research === undefined ? {} : { research: context.research }),
    nowMs: deps.clock.now(),
  });
  if (!derived.ok) {
    const status: ReadOnlyChildTerminal =
      derived.reasonCode === "parent-envelope-invalid" ? "unavailable" : "denied";
    return { ok: false, outcome: rejectedOutcome(status, derived.reasonCode) };
  }
  if (!isPositiveSafeInteger(childRequest.maxToolCalls)) {
    return { ok: false, outcome: rejectedOutcome("denied", "invalid-max-tool-calls") };
  }
  const maxToolCalls = Math.min(
    childRequest.maxToolCalls,
    context.parentAuthority.budget.maxToolCalls,
  );
  return { ok: true, prepared: { childRequest, envelope: derived.envelope, maxToolCalls } };
}

async function runChild(
  deps: ReadOnlyChildOrchestratorDeps,
  context: ReadOnlyChildInvocationContext,
  childRequest: ChildAgentRequestV1,
  envelope: ReadOnlyChildEnvelope,
  maxToolCalls: number,
): Promise<AuxiliaryCapabilityOutcomeV1> {
  const state: GateState = { latched: undefined, childToolCalls: 0 };
  const gate = createGate(deps, context, envelope, maxToolCalls, state);
  const { signal, cleanup } = composeDeadlineSignal(deps, context);
  try {
    const result = await deps.runner.run({
      envelope,
      objective: context.objective,
      modelId: context.modelId,
      workspaceRoot: context.workspaceRoot,
      maxToolCalls,
      signal,
      gate,
    });
    return finalizeOutcome(deps, context, state, result);
  } catch {
    // Fail closed on a runner fault: prefer a latched governance terminal, else content-free error.
    // Either way, a redacted diagnostic ties the opaque outcome to a correlatable event record.
    emitRunnerFault(deps, context.parentAuthority.runId);
    return state.latched !== undefined
      ? rejectedOutcome(state.latched.terminal, state.latched.reasonCode)
      : rejectedOutcome("unavailable", "child-runner-error");
  } finally {
    cleanup();
  }
}

interface DeadlineSignal {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

/**
 * Composes the parent abort signal with a real timer firing at the wall-clock deadline, so a
 * non-cooperative runner that never re-checks the gate is actually stopped — not just reported
 * `stopped` late once it eventually returns on its own.
 */
function composeDeadlineSignal(
  deps: ReadOnlyChildOrchestratorDeps,
  context: ReadOnlyChildInvocationContext,
): DeadlineSignal {
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort();
  };
  if (context.signal.aborted) {
    controller.abort();
  } else {
    context.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const delayMs = Math.max(0, context.deadlineMs - deps.clock.now());
  const timer = setTimeout(() => {
    controller.abort();
  }, delayMs);
  timer.unref();
  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onParentAbort);
    },
  };
}

function finalizeOutcome(
  deps: ReadOnlyChildOrchestratorDeps,
  context: ReadOnlyChildInvocationContext,
  state: GateState,
  result: ReadOnlyChildRunnerResult,
): AuxiliaryCapabilityOutcomeV1 {
  if (state.latched !== undefined) {
    return rejectedOutcome(state.latched.terminal, state.latched.reasonCode);
  }
  // Re-check authority AFTER the runner resolves: a revocation or deadline that lands after its
  // last gate call but before it returns must never surface as an accepted result.
  const stop = currentStopReason(deps, context);
  if (stop !== undefined) return rejectedOutcome("stopped", stop);
  return acceptedOutcome(result);
}

function createGate(
  deps: ReadOnlyChildOrchestratorDeps,
  context: ReadOnlyChildInvocationContext,
  envelope: ReadOnlyChildEnvelope,
  maxToolCalls: number,
  state: GateState,
): (attempt: ReadOnlyChildToolAttempt) => ReadOnlyChildGateDecision {
  return (attempt): ReadOnlyChildGateDecision => {
    // Once a terminal is latched every further attempt is refused, so no orphan work can run.
    if (state.latched !== undefined) {
      return { ok: false, terminal: state.latched.terminal, reasonCode: state.latched.reasonCode };
    }
    const decision = evaluateAttempt(deps, context, envelope, maxToolCalls, state, attempt);
    if (!decision.ok) {
      state.latched = { terminal: decision.terminal, reasonCode: decision.reasonCode };
    }
    return decision;
  };
}

function evaluateAttempt(
  deps: ReadOnlyChildOrchestratorDeps,
  context: ReadOnlyChildInvocationContext,
  envelope: ReadOnlyChildEnvelope,
  maxToolCalls: number,
  state: GateState,
  attempt: ReadOnlyChildToolAttempt,
): ReadOnlyChildGateDecision {
  const stop = currentStopReason(deps, context);
  if (stop !== undefined) return deny("stopped", stop);
  if (attempt.toolClass === "child-agent") return deny("denied", "nested-child-denied");
  const readOnlyDenial = readOnlyDenialReason(attempt.toolClass, envelope);
  if (readOnlyDenial !== undefined) return deny("denied", readOnlyDenial);
  if (state.childToolCalls >= maxToolCalls) return deny("limit-reached", "child-max-tool-calls");
  if (!deps.charger.chargeParentToolCall()) return deny("limit-reached", "parent-budget-exceeded");
  state.childToolCalls += 1;
  return { ok: true };
}

function deny(terminal: ReadOnlyChildTerminal, reasonCode: string): ReadOnlyChildGateDecision {
  return { ok: false, terminal, reasonCode };
}

function readOnlyDenialReason(
  toolClass: CodingWorkbenchActionClass,
  envelope: ReadOnlyChildEnvelope,
): string | undefined {
  return envelope.allowedActionClasses.includes(toolClass)
    ? undefined
    : READ_ONLY_DENIAL_BY_CLASS[toolClass];
}

function currentStopReason(
  deps: ReadOnlyChildOrchestratorDeps,
  context: ReadOnlyChildInvocationContext,
): ReadOnlyChildStopReason | undefined {
  if (context.signal.aborted) return "parent-stopped";
  const reason = deps.cancellation.stopReason();
  if (reason !== undefined) return reason;
  if (deps.clock.now() >= context.deadlineMs) return "timeout";
  return undefined;
}

function acceptedOutcome(result: ReadOnlyChildRunnerResult): AuxiliaryCapabilityOutcomeV1 {
  const outcome: AuxiliaryCapabilityOutcomeV1 = {
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    status: "accepted",
    capability: "child-agent",
    resultDigest: result.resultDigest,
    childResultCount: { outcome: "known", value: normalizeCount(result.resultCount) },
  };
  return validateAuxiliaryCapabilityOutcomeV1(outcome).ok
    ? outcome
    : rejectedOutcome("unavailable", "child-outcome-invalid");
}

function rejectedOutcome(
  status: ReadOnlyChildTerminal,
  reasonCode: string,
): AuxiliaryCapabilityOutcomeV1 {
  return {
    schemaVersion: CODE_TASK_AUXILIARY_SCHEMA_VERSION,
    status,
    capability: "child-agent",
    reasonCode,
  };
}

function emitStarted(
  deps: ReadOnlyChildOrchestratorDeps,
  parentRunId: string,
  childRunId: CodeTaskChildRunId,
): void {
  publishRuntimeEvent(deps, {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: deps.newEventId(),
    runId: parentRunId,
    occurredAt: new Date(deps.clock.now()).toISOString(),
    kind: "child-run-started",
    childRunId,
  });
}

function emitCompleted(
  deps: ReadOnlyChildOrchestratorDeps,
  parentRunId: string,
  childRunId: CodeTaskChildRunId,
  outcome: AuxiliaryCapabilityOutcomeV1,
): void {
  publishRuntimeEvent(deps, {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: deps.newEventId(),
    runId: parentRunId,
    occurredAt: new Date(deps.clock.now()).toISOString(),
    kind: "child-run-completed",
    childRunId,
    auxiliaryOutcome: outcome.status,
    childResultCount: eventResultCount(outcome),
  });
}

/** A content-free, redacted diagnostic tying an opaque runner fault to a correlatable event id. */
function emitRunnerFault(deps: ReadOnlyChildOrchestratorDeps, parentRunId: string): void {
  publishRuntimeEvent(deps, {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: deps.newEventId(),
    runId: parentRunId,
    occurredAt: new Date(deps.clock.now()).toISOString(),
    kind: "failure-redacted",
    failureCode: "failure-redacted",
    failureSummary: "runtime-failed",
    retryable: false,
  });
}

function eventResultCount(outcome: AuxiliaryCapabilityOutcomeV1): number {
  return outcome.status === "accepted" && outcome.childResultCount.outcome === "known"
    ? outcome.childResultCount.value
    : 0;
}

function publishRuntimeEvent(
  deps: ReadOnlyChildOrchestratorDeps,
  event: CodingWorkbenchRuntimeEvent,
): void {
  if (!validateCodingWorkbenchRuntimeEvent(event).ok) {
    throw new Error("read-only-child-runtime-event-invalid");
  }
  deps.emit(event);
}

function normalizeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
