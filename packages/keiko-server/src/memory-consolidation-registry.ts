import type {
  ConsolidationJob,
  ConsolidationResult,
} from "@oscharko-dev/keiko-memory-consolidation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  MemoryConsolidationApplicationWire,
  MemoryId,
  MemoryStatus,
} from "@oscharko-dev/keiko-contracts";

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
  readonly reviewSnapshots?: readonly ConsolidationReviewSnapshot[];
  readonly applications?: readonly MemoryConsolidationApplicationWire[];
}

export interface ConsolidationReviewMemorySnapshot {
  readonly memoryId: MemoryId;
  readonly status: MemoryStatus;
  readonly updatedAt: number;
}

export interface ConsolidationReviewSnapshot {
  readonly itemId: string;
  readonly memories: readonly ConsolidationReviewMemorySnapshot[];
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
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly evidenceRunId?: string | undefined;
}

export class ConsolidationJobRegistryLimitError extends Error {
  public constructor(limit: number) {
    super(`consolidation job registry limit reached (${String(limit)})`);
    this.name = "ConsolidationJobRegistryLimitError";
  }
}

const DEFAULT_MAX_JOBS = 32;
const DEFAULT_EVIDENCE_RUN_ID = "memory-consolidation-jobs";

interface PersistedRegistrySnapshot {
  readonly schemaVersion: "1";
  readonly records: readonly ConsolidationJobRecord[];
}

interface PersistedRegistrySnapshotPayload {
  readonly schemaVersion?: unknown;
  readonly records?: unknown;
}

interface PersistedRegistryRecordPayload {
  readonly job?: unknown;
}

interface PersistedRegistryJobPayload {
  readonly id?: unknown;
}

interface RegistryState {
  readonly records: Map<string, ConsolidationJobRecord>;
  readonly maxJobs: number;
  readonly now: () => number;
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly evidenceRunId: string;
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

function persistedRecordsFrom(json: string | undefined): Map<string, ConsolidationJobRecord> {
  if (json === undefined) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return new Map();
  }
  const snapshot = parsed as PersistedRegistrySnapshotPayload;
  if (snapshot.schemaVersion !== "1" || !Array.isArray(snapshot.records)) return new Map();
  const records = new Map<string, ConsolidationJobRecord>();
  for (const record of snapshot.records) {
    const jobId = persistedRecordJobId(record);
    if (jobId !== undefined) records.set(jobId, record as ConsolidationJobRecord);
  }
  return records;
}

function persistedRecordJobId(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const job = (record as PersistedRegistryRecordPayload).job;
  if (typeof job !== "object" || job === null) return undefined;
  const id = (job as PersistedRegistryJobPayload).id;
  return typeof id === "string" ? id : undefined;
}

function sortedRecords(state: RegistryState): readonly ConsolidationJobRecord[] {
  return [...state.records.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.job.id.localeCompare(b.job.id);
  });
}

function bodyFreeEvidence(
  evidence: ConsolidationResult["reviewItems"][number]["evidence"],
): ConsolidationResult["reviewItems"][number]["evidence"] {
  return evidence?.map(({ detail: _detail, ...safe }) => safe);
}

function bodyFreeReviewItem(
  item: ConsolidationResult["reviewItems"][number],
): ConsolidationResult["reviewItems"][number] {
  const evidence = bodyFreeEvidence(item.evidence);
  return {
    id: item.id,
    reason: item.reason,
    relatedMemoryIds: item.relatedMemoryIds,
    ...(item.sourceMemoryIds !== undefined ? { sourceMemoryIds: item.sourceMemoryIds } : {}),
    ...(item.proposedAction !== undefined ? { proposedAction: item.proposedAction } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(item.proposedEdges !== undefined
      ? {
          proposedEdges: item.proposedEdges.map(({ provenanceSummary: _summary, ...edge }) => edge),
        }
      : {}),
    detectedAt: item.detectedAt,
  };
}

function bodyFreeResult(result: ConsolidationResult): ConsolidationResult {
  return {
    ...result,
    edgesProposed: result.edgesProposed.map(({ provenanceSummary: _summary, ...edge }) => edge),
    // MemoryUpdate carries bodyPatch/reviewerNote. The operative in-memory record retains those
    // proposals; the evidence snapshot retains their count in summaryStatus only.
    updatesProposed: [],
    reviewItems: result.reviewItems.map(bodyFreeReviewItem),
  };
}

function bodyFreePersistedRecord(record: ConsolidationJobRecord): ConsolidationJobRecord {
  return {
    ...record,
    // Snapshots are the optimistic-concurrency authority for Apply. An evidence projection cannot
    // restore that operative authority after restart, so restored review items are deliberately
    // non-applicable even though their body-free audit facts remain inspectable.
    reviewSnapshots: [],
    job: {
      ...record.job,
      ...(record.job.result === undefined ? {} : { result: bodyFreeResult(record.job.result) }),
      ...(record.job.error === undefined ? {} : { error: "Consolidation run failed." }),
    },
  };
}

function persistState(state: RegistryState): void {
  if (state.evidenceStore === undefined) return;
  const snapshot: PersistedRegistrySnapshot = {
    schemaVersion: "1",
    records: sortedRecords(state).map(bodyFreePersistedRecord),
  };
  state.evidenceStore.put(state.evidenceRunId, JSON.stringify(snapshot));
}

function updateRecord(
  state: RegistryState,
  jobId: string,
  patch: Partial<
    Pick<
      ConsolidationJobRecord,
      "job" | "memoryCount" | "cancelRequested" | "reviewSnapshots" | "applications"
    >
  >,
): ConsolidationJobRecord | undefined {
  const record = state.records.get(jobId);
  if (record === undefined) return undefined;
  const next: ConsolidationJobRecord = { ...record, ...patch };
  state.records.set(jobId, next);
  persistState(state);
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
  const evidenceRunId = options.evidenceRunId ?? DEFAULT_EVIDENCE_RUN_ID;
  return {
    records: persistedRecordsFrom(options.evidenceStore?.get(evidenceRunId)),
    maxJobs: options.maxJobs ?? DEFAULT_MAX_JOBS,
    now: options.now ?? Date.now,
    evidenceStore: options.evidenceStore,
    evidenceRunId,
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
    reviewSnapshots?: readonly ConsolidationReviewSnapshot[],
  ) => ConsolidationJobRecord | undefined;
  readonly fail: (
    jobId: string,
    job: ConsolidationJob,
    error: string,
    memoryCount: number,
  ) => ConsolidationJobRecord | undefined;
  readonly requestCancel: (jobId: string) => ConsolidationJobRecord | undefined;
  readonly recordApplication: (
    jobId: string,
    application: MemoryConsolidationApplicationWire,
  ) => ConsolidationJobRecord | undefined;
  readonly size: () => number;
}

function registerJob(
  state: RegistryState,
  input: RegisterConsolidationJobInput,
): ConsolidationJobRecord {
  enforceCapacity(state);
  const record: ConsolidationJobRecord = {
    job: input.job,
    createdAt: input.createdAt,
    selection: input.selection,
    settings: input.settings,
    memoryCount: input.memoryCount,
    cancelRequested: false,
    reviewSnapshots: [],
    applications: [],
  };
  state.records.set(input.job.id, record);
  persistState(state);
  return record;
}

function completeJob(
  state: RegistryState,
  jobId: string,
  job: ConsolidationJob,
  memoryCount: number,
  reviewSnapshots?: readonly ConsolidationReviewSnapshot[],
): ConsolidationJobRecord | undefined {
  const startedAt = job.startedAt ?? state.now();
  const completedAt = job.completedAt ?? state.now();
  const finalJob = finalizeJob(job, startedAt, completedAt);
  return updateRecord(state, jobId, {
    job: finalJob,
    memoryCount,
    ...(reviewSnapshots === undefined ? {} : { reviewSnapshots }),
  });
}

function failJob(
  state: RegistryState,
  jobId: string,
  job: ConsolidationJob,
  error: string,
  memoryCount: number,
): ConsolidationJobRecord | undefined {
  const startedAt = job.startedAt ?? state.now();
  const completedAt = job.completedAt ?? state.now();
  return updateRecord(state, jobId, {
    job: finalizeJob(job, startedAt, completedAt, error),
    memoryCount,
  });
}

function requestJobCancel(state: RegistryState, jobId: string): ConsolidationJobRecord | undefined {
  const record = state.records.get(jobId);
  if (record === undefined || record.cancelRequested) return record;
  return updateRecord(state, jobId, { cancelRequested: true });
}

function recordJobApplication(
  state: RegistryState,
  jobId: string,
  application: MemoryConsolidationApplicationWire,
): ConsolidationJobRecord | undefined {
  const record = state.records.get(jobId);
  if (record === undefined) return undefined;
  const applications = record.applications ?? [];
  if (applications.some((existing) => existing.itemId === application.itemId)) return record;
  return updateRecord(state, jobId, { applications: [...applications, application] });
}

export function createConsolidationJobRegistry(
  options: ConsolidationJobRegistryOptions = {},
): ConsolidationJobRegistry {
  const state = createRegistryState(options);
  return {
    register: (input): ConsolidationJobRecord => registerJob(state, input),
    get: (jobId): ConsolidationJobRecord | undefined => state.records.get(jobId),
    setRunning: (jobId, job): ConsolidationJobRecord | undefined =>
      updateRecord(state, jobId, { job }),
    complete: (jobId, job, memoryCount, snapshots): ConsolidationJobRecord | undefined =>
      completeJob(state, jobId, job, memoryCount, snapshots),
    fail: (jobId, job, error, memoryCount): ConsolidationJobRecord | undefined =>
      failJob(state, jobId, job, error, memoryCount),
    requestCancel: (jobId): ConsolidationJobRecord | undefined => requestJobCancel(state, jobId),
    recordApplication: (jobId, application): ConsolidationJobRecord | undefined =>
      recordJobApplication(state, jobId, application),
    size: (): number => state.records.size,
  };
}
