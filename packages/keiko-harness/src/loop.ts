// The state-machine driver. The harness owns all control flow: it checks abort and limit
// guards at the top of the loop and before each port call, dispatches the current state to
// its handler, and emits a state:transition before every change (ADR-0004 D1, D3, D4).

import { HARNESS_CODES, toFailure } from "./errors.js";
import { contextBytes, type RunContext, type StateStep } from "./context.js";
import { handleModelCall, handleToolCall } from "./executor.js";
import { handlePatchProposal, handleReporting, handleVerification } from "./patcher.js";
import { handleContextSelection, handlePlanning } from "./planner.js";
import { TERMINAL_STATES, type HarnessStateName, type RunOutcome } from "./types.js";

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

function checkToolLimits(ctx: RunContext): StateStep | null {
  const pending = ctx.lastResponse?.toolCalls.length ?? 0;
  if (ctx.counters.toolCalls + pending > ctx.limits.maxToolCalls) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_TOOL_CALLS, "tool-call budget exhausted");
    return { to: "limit-exceeded", reason: "maxToolCalls exceeded" };
  }
  if (ctx.counters.commandExecutions >= ctx.limits.maxCommandExecutions) {
    ctx.failure = toFailure(HARNESS_CODES.LIMIT_COMMAND_EXEC, "command-execution budget exhausted");
    return { to: "limit-exceeded", reason: "maxCommandExecutions exceeded" };
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
  if (state === "failed" || state === "limit-exceeded") {
    const failure =
      ctx.failure ?? toFailure(HARNESS_CODES.INTERNAL, "run failed without a failure record");
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
  for (let step = 0; step < MAX_LOOP_STEPS && !TERMINAL_STATES.has(state); step += 1) {
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
    const postDispatchGuard = checkWallTime(ctx);
    state = transition(ctx, state, postDispatchGuard ?? dispatched);
  }
  if (!TERMINAL_STATES.has(state)) {
    ctx.failure = toFailure(HARNESS_CODES.INTERNAL, "state-machine safety step limit exceeded");
    state = transition(ctx, state, {
      to: "failed",
      reason: "internal: state-machine step limit exceeded",
    });
  }
  emitTerminal(ctx, state);
  return state as RunOutcome;
}
