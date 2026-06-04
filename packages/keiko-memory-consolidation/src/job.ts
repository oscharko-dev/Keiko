// ConsolidationJob value-object lifecycle. NOT a process. The package does not spawn jobs,
// schedule them, or persist them; callers (a scheduler / UI button / workflow orchestrator)
// drive the state machine via `buildConsolidationJob` + `transitionJob`. This keeps the layer
// purely deterministic — id allocation, clock reads, and persistence stay outside.
//
// State machine (see ConsolidationJobState in types.ts):
//
//   queued --> running     (start)
//   queued --> canceled    (operator cancels before start)
//   queued --> skipped     (engine returned state "skipped" before any cluster inspection)
//   running --> completed  (engine returned "completed")
//   running --> failed     (engine returned "failed")
//   running --> canceled   (engine returned "canceled" mid-run)
//
// All terminal states (completed, failed, canceled, skipped) are absorbing: any transition
// out of them throws `ConsolidationJobError("invalid-transition")`. There is no transition
// queued -> completed: the engine must observe at least the "running" state for the lifecycle
// to remain auditable.

import type { ConsolidationJob, ConsolidationJobState, ConsolidationResult } from "./types.js";

export type ConsolidationJobErrorCode = "invalid-transition";

export class ConsolidationJobError extends Error {
  public readonly code: ConsolidationJobErrorCode;
  public readonly from: ConsolidationJobState;
  public readonly to: ConsolidationJobState;
  public constructor(
    code: ConsolidationJobErrorCode,
    from: ConsolidationJobState,
    to: ConsolidationJobState,
  ) {
    super(`ConsolidationJobError(${code}): ${from} -> ${to}`);
    this.name = "ConsolidationJobError";
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

// Static transition matrix. Encoded as a Readonly<Record<...>> so adding a new state is a
// compile-time error (every key must be supplied).
const ALLOWED_TRANSITIONS: Readonly<
  Record<ConsolidationJobState, readonly ConsolidationJobState[]>
> = {
  queued: ["running", "canceled", "skipped"],
  running: ["completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
  skipped: [],
};

function isLegalTransition(from: ConsolidationJobState, to: ConsolidationJobState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// Constructs a fresh queued job. `startedAt` is recorded eagerly so the caller can compute
// elapsedMs at the terminal-transition site without a separate clock read in this layer.
export function buildConsolidationJob(id: string, startedAtMs: number): ConsolidationJob {
  return { id, state: "queued", startedAt: startedAtMs };
}

// Transitions a job to a new state, optionally merging in a result, completedAt, or error.
// Throws ConsolidationJobError when the transition is illegal. The input job is never
// mutated — every successful call returns a NEW object.
export function transitionJob(
  job: ConsolidationJob,
  to: ConsolidationJobState,
  patch?: Partial<Pick<ConsolidationJob, "result" | "completedAt" | "error">>,
): ConsolidationJob {
  if (!isLegalTransition(job.state, to)) {
    throw new ConsolidationJobError("invalid-transition", job.state, to);
  }
  const next: ConsolidationJob = { ...job, state: to };
  return applyPatch(next, patch);
}

function applyPatch(
  job: ConsolidationJob,
  patch: Partial<Pick<ConsolidationJob, "result" | "completedAt" | "error">> | undefined,
): ConsolidationJob {
  if (patch === undefined) return job;
  const merged: ConsolidationJob = { ...job };
  if (patch.result !== undefined) {
    return mergeResult(merged, patch.result, patch.completedAt, patch.error);
  }
  if (patch.completedAt !== undefined) {
    return {
      ...merged,
      completedAt: patch.completedAt,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    };
  }
  if (patch.error !== undefined) {
    return { ...merged, error: patch.error };
  }
  return merged;
}

function mergeResult(
  job: ConsolidationJob,
  result: ConsolidationResult,
  completedAt: number | undefined,
  error: string | undefined,
): ConsolidationJob {
  const withResult: ConsolidationJob = { ...job, result };
  const withCompletedAt: ConsolidationJob =
    completedAt !== undefined ? { ...withResult, completedAt } : withResult;
  return error !== undefined ? { ...withCompletedAt, error } : withCompletedAt;
}
