// The public session/run API. createSession() builds the run context, kicks off the loop
// asynchronously, and exposes the run id, config fingerprint, a result Promise, and a
// cancel() that aborts the single per-run AbortController (ADR-0004 D4, D9).

import { HARNESS_VERSION } from "@oscharko-dev/keiko-contracts";
import { systemClock } from "../gateway/resilience.js";
import type { Clock } from "../gateway/types.js";
import { newCounters, type RunContext } from "./context.js";
import { Emitter } from "./emitter.js";
import { HARNESS_CODES, toFailure } from "./errors.js";
import { defaultFingerprinter, defaultIdSource } from "./fingerprint.js";
import { runLoop } from "./loop.js";
import type { EventSink, Fingerprinter, IdSource, ModelPort, ToolPort } from "./ports.js";
import { MemoryEventSink } from "./sinks.js";
import { resolveTaskPlan } from "./tasks/policy.js";
import {
  DEFAULT_LIMITS,
  type HarnessLimits,
  type RunOutcome,
  type RunResult,
  type TaskInput,
} from "./types.js";

// HARNESS_VERSION lives in @oscharko-dev/keiko-contracts (issue #162); re-exported here so
// every existing `import { HARNESS_VERSION } from "../harness/session.js"` keeps resolving.
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
  return {
    runId: identity.runId,
    fingerprint: identity.fingerprint,
    outcome,
    taskType: ctx.taskType,
    ...(ctx.report === undefined ? {} : { report: ctx.report }),
    ...(ctx.patchDiff === undefined ? {} : { patchDiff: ctx.patchDiff }),
    ...(ctx.failure === undefined ? {} : { failure: ctx.failure }),
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
): () => void {
  let cleared = false;
  const deadlineController = new AbortController();
  void clock
    .sleep(ctx.limits.maxWallTimeMs, deadlineController.signal)
    .then(() => {
      if (cleared || controller.signal.aborted) {
        return;
      }
      ctx.failure = toFailure(HARNESS_CODES.LIMIT_WALL_TIME, "wall-time budget exhausted");
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
  const clearDeadline = armWallTimeDeadline(ctx, controller, ctx.clock);
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
    .finally(clearDeadline)
    .then((outcome) => buildResult(ctx, outcome, memory, { runId, fingerprint }));
  return {
    runId,
    fingerprint,
    result,
    cancel: (reason?: string): void => {
      ctx.cancelReason = reason;
      controller.abort(reason);
    },
  };
}
