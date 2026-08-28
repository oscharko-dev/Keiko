// The public session/run API. createSession() builds the run context, kicks off the loop
// asynchronously, and exposes the run id, config fingerprint, a result Promise, and a
// cancel() that aborts the single per-run AbortController (ADR-0004 D4, D9).

import { HARNESS_VERSION } from "@oscharko-dev/keiko-contracts/runtime/harness";
import type { Clock } from "@oscharko-dev/keiko-model-gateway";
import { systemClock } from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import { newCounters, type RunContext } from "./context.js";
import type { HarnessCompactionPort } from "./context-compaction-port.js";
import { Emitter } from "./emitter.js";
import { HARNESS_CODES, toFailure } from "./errors.js";
import { defaultFingerprinter, defaultIdSource } from "./fingerprint.js";
import { runLoop, terminalFailure } from "./loop.js";
import type { EventSink, Fingerprinter, IdSource, ModelPort, ToolPort } from "./ports.js";
import type { HarnessShaperPort } from "./shaper-port.js";
import { MemoryEventSink } from "./sinks.js";
import { resolveTaskPlan } from "./tasks/policy.js";
import {
  DEFAULT_LIMITS,
  type HarnessLimits,
  type RunOutcome,
  type RunResult,
  type TaskInput,
} from "./types.js";

// HARNESS_VERSION lives in @oscharko-dev/keiko-contracts and is re-exported here as
// part of the harness session surface.
export { HARNESS_VERSION };

export interface AgentConfig {
  readonly model: string;
  readonly workingDirectory: string;
  readonly limits?: Partial<HarnessLimits> | undefined;
  // Defaults true. Wave 1 never applies a patch regardless; the flag documents intent and
  // is the seam a future apply-mode issue toggles without changing the harness API.
  readonly dryRun?: boolean | undefined;
}

export interface HarnessDeps {
  readonly model: ModelPort;
  readonly tools: ToolPort;
  readonly sink: EventSink;
  readonly clock?: Clock | undefined;
  readonly idSource?: IdSource | undefined;
  readonly fingerprinter?: Fingerprinter | undefined;
  // Optional injected shaped-observation port (ADR-0055 D4). When omitted, the harness performs no
  // shaping and the run is byte-identical to today. The production wiring tier (which already
  // depends on keiko-workflows) injects an implementation backed by the workflow shapers.
  readonly shaperPort?: HarnessShaperPort | undefined;
  // Optional injected message-history compaction port (KEIKO-0726, #3323). When omitted, the
  // harness performs no compaction and checkModelCallLimits keeps its original byte-only
  // hard-fail. The production wiring tier (which already depends on keiko-workflows) injects an
  // implementation backed by the context-budget allocator.
  readonly compactionPort?: HarnessCompactionPort | undefined;
}

export interface AgentSession {
  readonly runId: string;
  readonly fingerprint: string;
  readonly result: Promise<RunResult>;
  readonly cancel: (reason?: string) => void;
}

function resolveLimits(config: AgentConfig): HarnessLimits {
  return { ...DEFAULT_LIMITS, ...config.limits };
}

function resolveDryRun(config: AgentConfig): boolean {
  return config.dryRun ?? true;
}

interface ResultIdentity {
  readonly runId: string;
  readonly fingerprint: string;
}

function buildResult(
  ctx: RunContext,
  outcome: RunOutcome,
  sink: MemoryEventSink,
  identity: ResultIdentity,
): RunResult {
  // Gate on outcome via the same terminalFailure rule emitTerminal uses (loop.ts), not on
  // ctx.failure's mere presence: a raced wall-time deadline callback can write ctx.failure after
  // the run has already reached "completed"/"cancelled" (see armWallTimeDeadline below), and the
  // returned RunResult must never contradict its own outcome (KEIKO-0774).
  const failure = terminalFailure(ctx, outcome);
  return {
    runId: identity.runId,
    fingerprint: identity.fingerprint,
    outcome,
    taskType: ctx.taskType,
    ...(ctx.report === undefined ? {} : { report: ctx.report }),
    ...(ctx.patchDiff === undefined ? {} : { patchDiff: ctx.patchDiff }),
    ...(failure === undefined ? {} : { failure }),
    startedAt: ctx.startedAt,
    finishedAt: ctx.clock.now(),
    events: sink.events(),
  };
}

function buildContext(
  task: TaskInput,
  config: AgentConfig,
  deps: HarnessDeps,
  signal: AbortSignal,
  runId: string,
  fingerprint: string,
): { ctx: RunContext; memory: MemoryEventSink } {
  const clock = deps.clock ?? systemClock;
  const memory = new MemoryEventSink();
  const plan = resolveTaskPlan(task);
  const ctx: RunContext = {
    model: deps.model,
    tools: deps.tools,
    emitter: new Emitter([memory, deps.sink], clock, runId, fingerprint),
    clock,
    signal,
    limits: resolveLimits(config),
    modelId: config.model,
    taskType: task.taskType,
    plan,
    startedAt: clock.now(),
    counters: newCounters(),
    ...(deps.shaperPort === undefined ? {} : { shaperPort: deps.shaperPort }),
    ...(deps.compactionPort === undefined ? {} : { compactionPort: deps.compactionPort }),
    shapedObservations: [],
    compactedToolMessages: new Map(),
    messages: [...plan.messages],
    lastResponse: undefined,
    patchDiff: undefined,
    report: undefined,
    failure: undefined,
    cancelReason: undefined,
    cancelledAtState: undefined,
  };
  return { ctx, memory };
}

function armWallTimeDeadline(
  ctx: RunContext,
  controller: AbortController,
  clock: Clock,
  isSettled: () => boolean,
): () => void {
  let cleared = false;
  const deadlineController = new AbortController();
  void clock
    .sleep(ctx.limits.maxWallTimeMs, deadlineController.signal)
    .then(() => {
      // isSettled() bails out one tick earlier than `cleared` (set only once clearDeadline, a
      // `.finally` reaction, actually runs) — see createSession's `settled` flag. This narrows,
      // but per buildResult/terminalFailure above does not need to eliminate, the window in which
      // a deadline callback already in flight when runLoop resolves can still write ctx.failure
      // for a run that has already finished (KEIKO-0774): that write is harmless because
      // buildResult never surfaces it for a non-failure outcome.
      if (cleared || isSettled() || controller.signal.aborted) {
        return;
      }
      // Claim the failure slot only while it is unclaimed: a handler that already recorded why the
      // run stopped owns that record, and the deadline must not relabel it as budget exhaustion.
      // The abort below still stops the run either way.
      ctx.failure ??= toFailure(HARNESS_CODES.LIMIT_WALL_TIME, "wall-time budget exhausted");
      ctx.cancelReason = "maxWallTimeMs exceeded";
      controller.abort("maxWallTimeMs exceeded");
    })
    .catch(() => undefined);
  return (): void => {
    cleared = true;
    deadlineController.abort("run finished");
  };
}

export function createSession(
  task: TaskInput,
  config: AgentConfig,
  deps: HarnessDeps,
): AgentSession {
  const limits = resolveLimits(config);
  const dryRun = resolveDryRun(config);
  const runId = (deps.idSource ?? defaultIdSource).newRunId();
  const fingerprint = (deps.fingerprinter ?? defaultFingerprinter).compute({
    taskType: task.taskType,
    taskInput: task,
    limits,
    modelId: config.model,
    workingDirectory: config.workingDirectory,
    dryRun,
    harnessVersion: HARNESS_VERSION,
  });
  const controller = new AbortController();
  const { ctx, memory } = buildContext(task, config, deps, controller.signal, runId, fingerprint);
  // Flipped true as soon as runLoop's promise settles — one microtask ahead of clearDeadline
  // (itself a `.finally` reaction) — so both the wall-time deadline guard and cancel() below have
  // an earlier "the run is over" signal than `cleared` alone (KEIKO-0774).
  let settled = false;
  const clearDeadline = armWallTimeDeadline(ctx, controller, ctx.clock, () => settled);
  ctx.emitter.emit({
    type: "run:started",
    taskType: task.taskType,
    modelId: config.model,
    limits,
  });
  // Defer the loop to a microtask so a cancel() issued synchronously after createSession is
  // observed at the loop's first abort check, before any model or tool call is made.
  const result = Promise.resolve()
    .then(() => runLoop(ctx))
    .then((outcome) => {
      settled = true;
      return outcome;
    })
    .finally(clearDeadline)
    .then((outcome) => buildResult(ctx, outcome, memory, { runId, fingerprint }));
  return {
    runId,
    fingerprint,
    result,
    // A silent no-op once the run has already reached a terminal state — matching cancel()'s
    // existing best-effort character (it never throws) rather than relabeling a finished run.
    cancel: (reason?: string): void => {
      if (settled) {
        return;
      }
      ctx.cancelReason = reason;
      controller.abort(reason);
    },
  };
}
