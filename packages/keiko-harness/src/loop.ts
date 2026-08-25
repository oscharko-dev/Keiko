// The state-machine driver. The harness owns all control flow: it checks abort and limit
// guards at the top of the loop and before each port call, dispatches the current state to
// its handler, and emits a state:transition before every change (ADR-0004 D1, D3, D4).

import { HARNESS_CODES, toFailure } from "./errors.js";
import { contextBytes, type RunContext, type StateStep } from "./context.js";
import { handleModelCall, handleToolCall } from "./executor.js";
import { handlePatchProposal, handleReporting, handleVerification } from "./patcher.js";
import { handleContextSelection, handlePlanning } from "./planner.js";
import {
  isTerminalHarnessState,
  type HarnessFailure,
  type HarnessStateName,
  type RunOutcome,
} from "./types.js";

const MAX_LOOP_STEPS = 10_000; // absolute safety net; bounded states make this unreachable.

function abortStep(reason: string): StateStep {
  return { to: "cancelled", reason };
}

function checkWallTime(ctx: RunContext): StateStep | null {
  if (ctx.clock.now() - ctx.startedAt > ctx.limits.maxWallTimeMs) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_WALL_TIME, "wall-time budget exhausted");
    return { to: "limit-exceeded", reason: "maxWallTimeMs exceeded" };
  }
  return null;
}

// A handler may have already recorded why the run is stopping for a reason UNRELATED to the
// deadline: a real failure (onModelError's HARNESS_MODEL_ERROR) or a real abort (cancelled). Those
// two outcomes are the run's own decision and must not be relabelled. An ordinary successful
// completion is NOT protected: the wall-time budget is a hard cap, so a model port that never
// errors and only exceeds the budget must still resolve to limit-exceeded even when the dispatch
// that finishes the run lands in one hop with no further loop iteration to catch it.
const PROTECTED_POST_DISPATCH_STATES: ReadonlySet<HarnessStateName> = new Set([
  "failed",
  "cancelled",
]);

// Post-dispatch the deadline may have passed while a handler was running. Detecting it here must
// not overwrite a protected outcome above, and the failure slot is only claimed while still
// unclaimed. A non-protected step past the deadline still terminates the run rather than
// continuing (including a step that already reached a terminal, non-protected state like
// "completed" — see PROTECTED_POST_DISPATCH_STATES above).
function checkWallTimePostDispatch(ctx: RunContext, dispatched: StateStep): StateStep | null {
  if (PROTECTED_POST_DISPATCH_STATES.has(dispatched.to)) {
    return null;
  }
  if (ctx.clock.now() - ctx.startedAt <= ctx.limits.maxWallTimeMs) {
    return null;
  }
  ctx.failure ??= toFailure(HARNESS_CODES.LIMIT_WALL_TIME, "wall-time budget exhausted");
  return { to: "limit-exceeded", reason: "maxWallTimeMs exceeded" };
}

// Limit checks evaluated when re-entering planning (iterations) plus the wall-time gate for
// the run as a whole.
function checkLoopLimits(ctx: RunContext): StateStep | null {
  const wallTime = checkWallTime(ctx);
  if (wallTime !== null) {
    return wallTime;
  }
  if (ctx.counters.iterations >= ctx.limits.maxIterations) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_ITERATIONS, "iteration budget exhausted");
    return { to: "limit-exceeded", reason: "maxIterations exceeded" };
  }
  return null;
}

// Context-size and model-call-count checks, evaluated at every model-call entry so the
// limit bounds calls that follow tool-call (not only the initial context-selection path).
function checkModelCallLimits(ctx: RunContext): StateStep | null {
  if (ctx.counters.modelCalls >= ctx.limits.maxModelCalls) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_MODEL_CALLS, "model-call budget exhausted");
    return { to: "limit-exceeded", reason: "maxModelCalls exceeded" };
  }
  const bytes = contextBytes(ctx.messages);
  if (bytes > ctx.limits.maxContextBytes) {
    ctx.failure = toFailure(
      HARNESS_CODES.LIMIT_CONTEXT_SIZE,
      `context ${String(bytes)} bytes exceeds limit ${String(ctx.limits.maxContextBytes)}`,
    );
    return { to: "limit-exceeded", reason: "maxContextBytes exceeded" };
  }
  return null;
}

// Per-state-entry guards: abort is honoured before any state; call-count limits are
// enforced immediately before the state that consumes the bounded resource.
function checkEntryGuards(ctx: RunContext, state: HarnessStateName): StateStep | null {
  const wallTime = checkWallTime(ctx);
  if (wallTime !== null) {
    return wallTime;
  }
  if (ctx.signal.aborted) {
    return abortStep("abort detected before state entry");
  }
  if (state === "model-call") {
    return checkModelCallLimits(ctx);
  }
  if (state === "tool-call") {
    return checkToolLimits(ctx);
  }
  return null;
}

// Issue #2638: the command budget is intentionally NOT checked here. Refusing tool-call
// entry on `commandExecutions >= maxCommandExecutions` is over-broad — it would also block
// read-only tools once the budget is spent, and refuse EVERY tool call (including read-only)
// when a caller wires `maxCommandExecutions: 0` to forbid commands outright. The budget is
// enforced by handleToolCall (pre-execution, name-scoped to `run_command`) and runOneTool
// (post-execution, contract-violation guard when any other tool claims `commandExecuted:true`);
// a read-only tool never trips it.
function checkToolLimits(ctx: RunContext): StateStep | null {
  const pending = ctx.lastResponse?.toolCalls.length ?? 0;
  if (ctx.counters.toolCalls + pending > ctx.limits.maxToolCalls) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_TOOL_CALLS, "tool-call budget exhausted");
    return { to: "limit-exceeded", reason: "maxToolCalls exceeded" };
  }
  return null;
}

async function dispatch(ctx: RunContext, state: HarnessStateName): Promise<StateStep> {
  switch (state) {
    case "planning":
      ctx.counters.iterations += 1;
      return handlePlanning(ctx);
    case "context-selection":
      return handleContextSelection(ctx);
    case "model-call":
      return handleModelCall(ctx);
    case "tool-call":
      return handleToolCall(ctx);
    case "patch-proposal":
      return handlePatchProposal(ctx);
    case "verification":
      return handleVerification(ctx);
    case "reporting":
      return handleReporting(ctx);
    default:
      ctx.failure = toFailure(HARNESS_CODES.INTERNAL, `no handler for state ${state}`);
      return { to: "failed", reason: "internal: unhandled state" };
  }
}

function transition(ctx: RunContext, from: HarnessStateName, step: StateStep): HarnessStateName {
  if (step.to === "cancelled") {
    ctx.cancelledAtState = from;
  }
  ctx.emitter.emit({ type: "state:transition", from, to: step.to, reason: step.reason });
  return step.to;
}

// Ties a terminal outcome to its failure record: only "failed"/"limit-exceeded" ever carry one,
// synthesizing the HARNESS_INTERNAL fallback when that state was reached without ctx.failure being
// set. Exported so session.ts's buildResult can apply the identical rule to the RunResult it
// returns — the emitted event stream (emitTerminal, below) and the returned RunResult can then
// never disagree about whether a run failed, even if something else (e.g. a raced wall-time
// deadline callback) writes to ctx.failure after the run has already reached a non-failure
// terminal state (KEIKO-0774).
export function terminalFailure(
  ctx: Pick<RunContext, "failure">,
  state: HarnessStateName,
): HarnessFailure | undefined {
  if (state !== "failed" && state !== "limit-exceeded") {
    return undefined;
  }
  return ctx.failure ?? toFailure(HARNESS_CODES.INTERNAL, "run failed without a failure record");
}

function emitTerminal(ctx: RunContext, state: HarnessStateName): void {
  if (state === "completed") {
    ctx.emitter.emit({
      type: "run:completed",
      report: ctx.report ?? "no model output",
      ...(ctx.patchDiff === undefined ? {} : { patchDiff: ctx.patchDiff }),
    });
    return;
  }
  if (state === "cancelled") {
    ctx.emitter.emit({
      type: "run:cancelled",
      atState: ctx.cancelledAtState ?? state,
      ...(ctx.cancelReason === undefined ? {} : { reason: ctx.cancelReason }),
    });
    return;
  }
  const failure = terminalFailure(ctx, state);
  // terminalFailure returns undefined only for a non-failure state; this branch is reached only
  // for "failed"/"limit-exceeded" (the two states not handled above), so failure is always defined
  // here. The check keeps the compiler honest without a non-null assertion.
  if (failure !== undefined) {
    ctx.failure = failure;
    ctx.emitter.emit({ type: "run:failed", failure, atState: state });
  }
}

// Runs the state machine from `intake` to a terminal state and returns the outcome.
export async function runLoop(ctx: RunContext): Promise<RunOutcome> {
  let state: HarnessStateName = transition(ctx, "intake", {
    to: "planning",
    reason: "task validated",
  });
  for (let step = 0; step < MAX_LOOP_STEPS && !isTerminalHarnessState(state); step += 1) {
    if (ctx.signal.aborted) {
      state = transition(ctx, state, abortStep("abort detected at top of loop"));
      break;
    }
    const guard = state === "planning" ? checkLoopLimits(ctx) : checkEntryGuards(ctx, state);
    if (guard !== null) {
      state = transition(ctx, state, guard);
      continue;
    }
    const dispatched = await dispatch(ctx, state);
    const postDispatchGuard = checkWallTimePostDispatch(ctx, dispatched);
    state = transition(ctx, state, postDispatchGuard ?? dispatched);
  }
  if (!isTerminalHarnessState(state)) {
    ctx.failure = toFailure(HARNESS_CODES.INTERNAL, "state-machine safety step limit exceeded");
    state = transition(ctx, state, {
      to: "failed",
      reason: "internal: state-machine step limit exceeded",
    });
  }
  emitTerminal(ctx, state);
  return state as RunOutcome;
}
