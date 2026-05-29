// The in-memory run registry (ADR-0011 D7). It maps a runId to a live run record (the streaming
// sink, the run status, the captured final report, and a cancel handle). It is BOUNDED on two axes:
// a cap on simultaneously-active runs (a new run is refused past the cap) and a TTL after which a
// TERMINATED run's record — including its event ring buffer — is evicted to reclaim memory (D7's
// documented retention: buffers are dropped once the run terminates and its TTL elapses). The
// registry is created via `createRunRegistry` and hung off the handler deps, never a module global,
// so each server instance (and each test) owns an isolated registry with no cross-talk.

import type { QueueEventSink } from "./sink.js";

export type RunStatus = "running" | "completed" | "cancelled" | "failed";

// The appliable snapshot the gated apply path (route 9) re-invokes with `apply: true`. `kind`
// selects the workflow; `payload` is the original validated run input minus the apply flag; `limits`
// carries the per-run limits so the apply re-invocation matches the reviewed dry-run exactly.
// Stored opaquely (the run engine owns its shape) so the registry stays free of workflow types.
export interface AppliableSnapshot {
  readonly kind: "unit-tests" | "bug-investigation";
  readonly payload: unknown;
  readonly limits: Record<string, unknown> | undefined;
}

export interface RunRecord {
  readonly runId: string;
  readonly fingerprint: string;
  // The run's resolved model id, used by the gated apply path to rebuild the ModelPort (the
  // fingerprint is a config hash, NOT a model id — passing it to the factory was a defect).
  readonly modelId: string;
  readonly sink: QueueEventSink;
  status: RunStatus;
  // The redacted final report projection, set once the run terminates.
  report: unknown;
  // Cancels the underlying run (harness session or workflow AbortController). Idempotent.
  readonly cancel: (reason?: string) => void;
  // Present only for a workflow run that finished in a dry-run-success (appliable) state.
  appliable: AppliableSnapshot | undefined;
  // Epoch ms at which a terminated record becomes eligible for eviction; undefined while running.
  terminatedAt: number | undefined;
}

export interface RegisterRunInput {
  readonly runId: string;
  readonly fingerprint: string;
  readonly modelId: string;
  readonly sink: QueueEventSink;
  readonly cancel: (reason?: string) => void;
}

export interface RunRegistryOptions {
  // Maximum number of simultaneously non-terminal runs. `register` throws past this cap.
  readonly maxActiveRuns?: number | undefined;
  // Milliseconds a terminated record is retained before eviction.
  readonly terminatedTtlMs?: number | undefined;
  // Injectable clock for deterministic TTL tests. Defaults to Date.now.
  readonly now?: (() => number) | undefined;
}

export class ActiveRunLimitError extends Error {
  constructor(limit: number) {
    super(`active run limit reached (${String(limit)})`);
    this.name = "ActiveRunLimitError";
  }
}

const DEFAULT_MAX_ACTIVE_RUNS = 16;
const DEFAULT_TERMINATED_TTL_MS = 600_000;

export interface RunRegistry {
  register: (input: RegisterRunInput) => RunRecord;
  get: (runId: string) => RunRecord | undefined;
  // Marks a run terminal, captures its final report + appliable snapshot, and starts the TTL clock.
  complete: (
    runId: string,
    status: Exclude<RunStatus, "running">,
    report: unknown,
    appliable: AppliableSnapshot | undefined,
  ) => void;
  // Number of currently non-terminal runs (test/inspection aid).
  activeCount: () => number;
  // Number of records currently held (active + not-yet-evicted terminated).
  size: () => number;
}

function isTerminal(status: RunStatus): boolean {
  return status !== "running";
}

interface RegistryState {
  readonly records: Map<string, RunRecord>;
  readonly maxActive: number;
  readonly ttlMs: number;
  readonly now: () => number;
}

function evictExpired(state: RegistryState): void {
  const cutoff = state.now();
  for (const [runId, record] of state.records) {
    if (record.terminatedAt !== undefined && cutoff - record.terminatedAt >= state.ttlMs) {
      state.records.delete(runId);
    }
  }
}

function countActive(state: RegistryState): number {
  let count = 0;
  for (const record of state.records.values()) {
    if (!isTerminal(record.status)) {
      count += 1;
    }
  }
  return count;
}

function registerRun(state: RegistryState, input: RegisterRunInput): RunRecord {
  evictExpired(state);
  if (countActive(state) >= state.maxActive) {
    throw new ActiveRunLimitError(state.maxActive);
  }
  const record: RunRecord = {
    runId: input.runId,
    fingerprint: input.fingerprint,
    modelId: input.modelId,
    sink: input.sink,
    status: "running",
    report: undefined,
    cancel: input.cancel,
    appliable: undefined,
    terminatedAt: undefined,
  };
  state.records.set(input.runId, record);
  return record;
}

function completeRun(
  state: RegistryState,
  runId: string,
  status: Exclude<RunStatus, "running">,
  report: unknown,
  appliable: AppliableSnapshot | undefined,
): void {
  const record = state.records.get(runId);
  if (record === undefined) {
    return;
  }
  record.status = status;
  record.report = report;
  record.appliable = appliable;
  record.terminatedAt = state.now();
}

export function createRunRegistry(options: RunRegistryOptions = {}): RunRegistry {
  const state: RegistryState = {
    records: new Map<string, RunRecord>(),
    maxActive: options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS,
    ttlMs: options.terminatedTtlMs ?? DEFAULT_TERMINATED_TTL_MS,
    now: options.now ?? Date.now,
  };
  return {
    register: (input): RunRecord => registerRun(state, input),
    get: (runId): RunRecord | undefined => state.records.get(runId),
    complete: (runId, status, report, appliable): void => {
      completeRun(state, runId, status, report, appliable);
    },
    activeCount: (): number => countActive(state),
    size: (): number => state.records.size,
  };
}
