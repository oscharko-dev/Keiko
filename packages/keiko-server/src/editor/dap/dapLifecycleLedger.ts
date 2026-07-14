import {
  isDebugLifecycleEvidence,
  type DebugLifecycleEvidence,
  type DebugLifecycleEvent,
} from "@oscharko-dev/keiko-contracts";

export interface DebugLiveEvidenceProjection {
  readonly records: readonly DebugLifecycleEvent[];
  readonly cumulativeEvictedCount: number;
}
export interface DapLifecycleLedgerDeps {
  readonly appendJournal: (
    workspacePartitionKey: string,
    evidence: DebugLifecycleEvidence,
  ) => Promise<void>;
  readonly projectLive?:
    | ((workspacePartitionKey: string, projection: DebugLiveEvidenceProjection) => Promise<void>)
    | undefined;
  readonly onProjectionFailure?: ((error: unknown) => void) | undefined;
}
export interface DapLifecycleLedger {
  append(
    workspacePartitionKey: string,
    evidence: DebugLifecycleEvidence,
  ): Promise<DebugLifecycleEvent>;
  list(workspacePartitionKey: string): DebugLiveEvidenceProjection;
}

const MAX_EVENTS_PER_WORKSPACE = 128;
interface PartitionState {
  readonly events: DebugLifecycleEvent[];
  nextSequence: number;
  cumulativeEvictedCount: number;
}

export function createDapLifecycleLedger(deps: DapLifecycleLedgerDeps): DapLifecycleLedger {
  const partitions = new Map<string, PartitionState>();
  return {
    append: (partition, evidence) => append(partitions, deps, partition, evidence),
    list: (partition) => projection(partitions.get(partition)),
  };
}

async function append(
  partitions: Map<string, PartitionState>,
  deps: DapLifecycleLedgerDeps,
  partition: string,
  evidence: DebugLifecycleEvidence,
): Promise<DebugLifecycleEvent> {
  if (!validPartition(partition) || !isDebugLifecycleEvidence(evidence)) {
    throw new Error("INVALID_DEBUG_EVIDENCE");
  }
  const copy = { ...evidence };
  await deps.appendJournal(partition, copy);
  const state = partitionState(partitions, partition);
  const event = { ...copy, sequence: state.nextSequence++ };
  state.events.push(event);
  if (state.events.length === MAX_EVENTS_PER_WORKSPACE + 1) {
    state.events.shift();
    state.cumulativeEvictedCount += 1;
  }
  await projectBestEffort(deps, partition, projection(state));
  return event;
}

async function projectBestEffort(
  deps: DapLifecycleLedgerDeps,
  partition: string,
  live: DebugLiveEvidenceProjection,
): Promise<void> {
  if (deps.projectLive === undefined) return;
  try {
    await deps.projectLive(partition, live);
  } catch (error: unknown) {
    if (deps.onProjectionFailure !== undefined) deps.onProjectionFailure(error);
  }
}

function partitionState(
  partitions: Map<string, PartitionState>,
  partition: string,
): PartitionState {
  const existing = partitions.get(partition);
  if (existing !== undefined) return existing;
  const created = { events: [], nextSequence: 1, cumulativeEvictedCount: 0 };
  partitions.set(partition, created);
  return created;
}

function projection(state: PartitionState | undefined): DebugLiveEvidenceProjection {
  return {
    records: state?.events.map((event) => ({ ...event })) ?? [],
    cumulativeEvictedCount: state?.cumulativeEvictedCount ?? 0,
  };
}

function validPartition(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
