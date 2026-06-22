import type {
  ConsolidationJob,
  ConsolidationResult,
} from "@oscharko-dev/keiko-memory-consolidation";

export interface ConsolidationJobSettings {
  readonly jaccardThreshold: number;
  readonly staleConfidenceThreshold: number;
  readonly maxAgeMs: number;
  readonly maxClustersPerRun: number;
  readonly maxRecordsPerRun: number;
}

export interface ConsolidationJobSelection {
  readonly scopes: readonly import("@oscharko-dev/keiko-contracts").MemoryScope[];
  readonly types?: readonly import("@oscharko-dev/keiko-contracts").MemoryType[] | undefined;
  readonly statuses?: readonly import("@oscharko-dev/keiko-contracts").MemoryStatus[] | undefined;
  readonly includeExpired: boolean;
}

export interface ConsolidationJobRecord {
  readonly job: ConsolidationJob;
  readonly createdAt: number;
  readonly selection: ConsolidationJobSelection;
  readonly settings: ConsolidationJobSettings;
  readonly memoryCount: number;
  readonly cancelRequested: boolean;
}

export interface RegisterConsolidationJobInput {
  readonly job: ConsolidationJob;
  readonly createdAt: number;
  readonly selection: ConsolidationJobSelection;
  readonly settings: ConsolidationJobSettings;
  readonly memoryCount: number;
}

export interface ConsolidationJobRegistryOptions {
  readonly maxJobs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class ConsolidationJobRegistryLimitError extends Error {
  public constructor(limit: number) {
    super(`consolidation job registry limit reached (${String(limit)})`);
    this.name = "ConsolidationJobRegistryLimitError";
  }
}

const DEFAULT_MAX_JOBS = 32;

interface RegistryState {
  readonly records: Map<string, ConsolidationJobRecord>;
  readonly maxJobs: number;
  readonly now: () => number;
}

function isTerminal(job: ConsolidationJob): boolean {
  return (
    job.state === "completed" ||
    job.state === "failed" ||
    job.state === "canceled" ||
    job.state === "skipped"
  );
}

function oldestTerminalJobId(state: RegistryState): string | undefined {
  let candidateId: string | undefined;
  let candidateTs = Number.POSITIVE_INFINITY;
  for (const [jobId, record] of state.records) {
    if (!isTerminal(record.job)) continue;
    const ts = record.job.completedAt ?? record.createdAt;
    if (ts < candidateTs) {
      candidateTs = ts;
      candidateId = jobId;
    }
  }
  return candidateId;
}

function enforceCapacity(state: RegistryState): void {
  while (state.records.size >= state.maxJobs) {
    const evictId = oldestTerminalJobId(state);
    if (evictId === undefined) {
      throw new ConsolidationJobRegistryLimitError(state.maxJobs);
    }
    state.records.delete(evictId);
  }
}

function updateRecord(
  state: RegistryState,
  jobId: string,
  patch: Partial<Pick<ConsolidationJobRecord, "job" | "memoryCount" | "cancelRequested">>,
): ConsolidationJobRecord | undefined {
  const record = state.records.get(jobId);
  if (record === undefined) return undefined;
  const next: ConsolidationJobRecord = { ...record, ...patch };
  state.records.set(jobId, next);
  return next;
}

function withElapsedMs(
  result: ConsolidationResult,
  startedAt: number,
  completedAt: number,
): ConsolidationResult {
  return { ...result, elapsedMs: Math.max(0, completedAt - startedAt) };
}

function createRegistryState(options: ConsolidationJobRegistryOptions): RegistryState {
  return {
    records: new Map<string, ConsolidationJobRecord>(),
    maxJobs: options.maxJobs ?? DEFAULT_MAX_JOBS,
    now: options.now ?? Date.now,
  };
}

function finalizeJob(
  job: ConsolidationJob,
  startedAt: number,
  completedAt: number,
  error?: string,
): ConsolidationJob {
  const result = job.result;
  if (result === undefined) {
    return error === undefined ? job : { ...job, error };
  }
  return {
    ...job,
    ...(error === undefined ? {} : { error }),
    result: withElapsedMs(result, startedAt, completedAt),
  };
}

export interface ConsolidationJobRegistry {
  readonly register: (input: RegisterConsolidationJobInput) => ConsolidationJobRecord;
  readonly get: (jobId: string) => ConsolidationJobRecord | undefined;
  readonly setRunning: (jobId: string, job: ConsolidationJob) => ConsolidationJobRecord | undefined;
  readonly complete: (
    jobId: string,
    job: ConsolidationJob,
    memoryCount: number,
  ) => ConsolidationJobRecord | undefined;
  readonly fail: (
    jobId: string,
    job: ConsolidationJob,
    error: string,
    memoryCount: number,
  ) => ConsolidationJobRecord | undefined;
  readonly requestCancel: (jobId: string) => ConsolidationJobRecord | undefined;
  readonly size: () => number;
}

export function createConsolidationJobRegistry(
  options: ConsolidationJobRegistryOptions = {},
): ConsolidationJobRegistry {
  const state = createRegistryState(options);
  return {
    register: (input): ConsolidationJobRecord => {
      enforceCapacity(state);
      const record: ConsolidationJobRecord = {
        job: input.job,
        createdAt: input.createdAt,
        selection: input.selection,
        settings: input.settings,
        memoryCount: input.memoryCount,
        cancelRequested: false,
      };
      state.records.set(input.job.id, record);
      return record;
    },
    get: (jobId): ConsolidationJobRecord | undefined => state.records.get(jobId),
    setRunning: (jobId, job): ConsolidationJobRecord | undefined =>
      updateRecord(state, jobId, { job }),
    complete: (jobId, job, memoryCount): ConsolidationJobRecord | undefined => {
      const startedAt = job.startedAt ?? state.now();
      const completedAt = job.completedAt ?? state.now();
      const finalJob = finalizeJob(job, startedAt, completedAt);
      return updateRecord(state, jobId, { job: finalJob, memoryCount });
    },
    fail: (jobId, job, error, memoryCount): ConsolidationJobRecord | undefined => {
      const startedAt = job.startedAt ?? state.now();
      const completedAt = job.completedAt ?? state.now();
      const finalJob = finalizeJob(job, startedAt, completedAt, error);
      return updateRecord(state, jobId, { job: finalJob, memoryCount });
    },
    requestCancel: (jobId): ConsolidationJobRecord | undefined => {
      const record = state.records.get(jobId);
      if (record === undefined) return undefined;
      if (record.cancelRequested) return record;
      return updateRecord(state, jobId, { cancelRequested: true });
    },
    size: (): number => state.records.size,
  };
}
