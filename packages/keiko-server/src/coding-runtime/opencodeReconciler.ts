/**
 * Every event kind the protocol classifier may emit. Validation derives from this single list so
 * a classifier extension can never silently diverge from the reconciliation admission gates.
 */
export const OPEN_CODE_EVENT_KINDS = [
  "observation",
  "permission",
  "question",
  "tool",
  "terminal",
  "terminal-control",
  "terminal-failure",
] as const;
export type OpenCodeEventKind = (typeof OPEN_CODE_EVENT_KINDS)[number];
export type OpenCodeCompactionActivity =
  | {
      readonly event: "started";
      readonly compactionIdSha256: string;
      readonly auto: boolean;
      readonly overflow: boolean;
      readonly retainedTail: false;
    }
  | {
      readonly event: "tail-retained";
      readonly compactionIdSha256: string;
      readonly tailStartIdSha256: string;
      readonly auto: boolean;
      readonly overflow: boolean;
      readonly retainedTail: true;
    }
  | {
      readonly event: "completed";
      readonly compactionIdSha256: string;
    }
  | {
      readonly event: "failed";
      readonly compactionIdSha256: string;
      readonly errorKind: string;
      readonly finishReason: string;
    };
export interface OpenCodeReconciliationEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly digest: string;
  readonly kind: OpenCodeEventKind;
  readonly compaction?: OpenCodeCompactionActivity | undefined;
}
export interface OpenCodeProjection {
  readonly id: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly kind: OpenCodeEventKind;
  readonly digest: string;
  readonly compaction?: OpenCodeCompactionActivity | undefined;
}
export type OpenCodeReconciliationResult =
  | {
      readonly ok: true;
      readonly applied: number;
      readonly projections: readonly OpenCodeProjection[];
    }
  | {
      readonly ok: false;
      readonly reason: "sequence-gap" | "sequence-conflict" | "staging-overflow" | "invalid-event";
    };
export type OpenCodeReconciliationPreparation =
  | (Extract<OpenCodeReconciliationResult, { readonly ok: true }> & {
      readonly commit: () => boolean;
    })
  | Extract<OpenCodeReconciliationResult, { readonly ok: false }>;
export interface OpenCodeReconcilerStaging {
  readonly events: number;
  readonly bytes: number;
  readonly observations: number;
  readonly critical: number;
  readonly identities: number;
  readonly digests: number;
  readonly checkpoints: number;
}
export interface OpenCodeReconciler {
  ingest(events: readonly OpenCodeReconciliationEvent[]): OpenCodeReconciliationResult;
  prepare(events: readonly OpenCodeReconciliationEvent[]): OpenCodeReconciliationPreparation;
  checkpoints(): Readonly<Record<string, number>>;
  staging(): Readonly<OpenCodeReconcilerStaging>;
}
export interface OpenCodeReconcilerOptions {
  readonly now?: (() => number) | undefined;
  readonly maxEvents?: number | undefined;
  readonly maxBytes?: number | undefined;
}
type ReconciliationFailure = Extract<OpenCodeReconciliationResult, { readonly ok: false }>;
interface ReconcilerStore {
  readonly now: () => number;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly checkpoint: Map<string, number>;
  readonly identities: Map<string, string>;
  readonly digests: Set<string>;
  readonly staged: OpenCodeReconciliationEvent[];
  stagedBytes: number;
  lastObservationAt: number;
  revision: number;
}
interface PreparedReconciliationState {
  readonly checkpoint: Map<string, number>;
  readonly identities: Map<string, string>;
  readonly digests: Set<string>;
  readonly staged: OpenCodeReconciliationEvent[];
  readonly projections: OpenCodeProjection[];
  stagedBytes: number;
  lastObservationAt: number;
  applied: number;
}
const MAX_EVENTS = 256;
const MAX_BYTES = 1024 * 1024;

/** In-memory, content-free reconciliation gate. It never executes effects or recharges budgets. */
export function createOpenCodeReconciler(
  options: OpenCodeReconcilerOptions = {},
): OpenCodeReconciler {
  const store: ReconcilerStore = {
    now: options.now ?? Date.now,
    maxEvents: options.maxEvents ?? MAX_EVENTS,
    maxBytes: options.maxBytes ?? MAX_BYTES,
    checkpoint: new Map(),
    identities: new Map(),
    digests: new Set(),
    staged: [],
    stagedBytes: 0,
    lastObservationAt: Number.NEGATIVE_INFINITY,
    revision: 0,
  };
  const prepare = (
    events: readonly OpenCodeReconciliationEvent[],
  ): OpenCodeReconciliationPreparation => prepareReconciliation(store, events);
  return {
    ingest(events): OpenCodeReconciliationResult {
      const prepared = prepare(events);
      if (!prepared.ok) return prepared;
      if (!prepared.commit()) return { ok: false, reason: "sequence-conflict" };
      return { ok: true, applied: prepared.applied, projections: prepared.projections };
    },
    prepare,
    checkpoints(): Readonly<Record<string, number>> {
      return Object.freeze(Object.fromEntries(store.checkpoint));
    },
    staging(): Readonly<OpenCodeReconcilerStaging> {
      const observations = store.staged.filter((event) => event.kind === "observation").length;
      return Object.freeze({
        events: store.staged.length,
        bytes: store.stagedBytes,
        observations,
        critical: store.staged.length - observations,
        identities: store.identities.size,
        digests: store.digests.size,
        checkpoints: store.checkpoint.size,
      });
    },
  };
}

function prepareReconciliation(
  store: ReconcilerStore,
  events: readonly OpenCodeReconciliationEvent[],
): OpenCodeReconciliationPreparation {
  const preparedRevision = store.revision;
  const state = transactionalState(store);
  for (const event of events) {
    const failure = stageEvent(store, state, event);
    if (failure !== undefined) return failure;
  }
  let committed = false;
  return {
    ok: true,
    applied: state.applied,
    projections: state.projections,
    commit: (): boolean => {
      if (committed) return true;
      if (store.revision !== preparedRevision) return false;
      commitPreparedState(store, state);
      committed = true;
      return true;
    },
  };
}

function transactionalState(store: ReconcilerStore): PreparedReconciliationState {
  return {
    checkpoint: new Map(store.checkpoint),
    identities: new Map(store.identities),
    digests: new Set(store.digests),
    staged: [...store.staged],
    projections: [],
    stagedBytes: store.stagedBytes,
    lastObservationAt: store.lastObservationAt,
    applied: 0,
  };
}

function stageEvent(
  store: ReconcilerStore,
  state: PreparedReconciliationState,
  event: OpenCodeReconciliationEvent,
): ReconciliationFailure | undefined {
  if (!valid(event)) return { ok: false, reason: "invalid-event" };
  const identity = eventIdentity(event);
  const known = state.identities.get(identity);
  if (known !== undefined)
    return known === event.digest ? undefined : { ok: false, reason: "sequence-conflict" };
  const sequence = sequenceDisposition(state.checkpoint, event);
  if (sequence !== "next") return sequence === "historical" ? undefined : sequence;
  if (state.digests.has(event.digest)) return undefined;
  const size = eventBytes(event);
  const evicted = makeRoom(state.staged, store.maxEvents, store.maxBytes, state.stagedBytes, size);
  if (evicted === undefined) return { ok: false, reason: "staging-overflow" };
  releaseEvictedIndexes(state, evicted);
  if (!makeCheckpointRoom(state, event.aggregateId, store.maxEvents))
    return { ok: false, reason: "staging-overflow" };
  state.stagedBytes = state.staged.reduce((total, item) => total + eventBytes(item), 0);
  state.staged.push(event);
  state.stagedBytes += size;
  state.identities.set(identity, event.digest);
  state.digests.add(event.digest);
  state.checkpoint.set(event.aggregateId, event.sequence);
  state.applied += 1;
  projectEvent(store, state, event);
  return undefined;
}

function sequenceDisposition(
  checkpoint: ReadonlyMap<string, number>,
  event: OpenCodeReconciliationEvent,
): ReconciliationFailure | "historical" | "next" {
  const expected = checkpoint.get(event.aggregateId);
  if (expected === undefined && event.sequence !== 0) return { ok: false, reason: "sequence-gap" };
  if (expected === undefined || event.sequence === expected + 1) return "next";
  return event.sequence <= expected ? "historical" : { ok: false, reason: "sequence-gap" };
}

function projectEvent(
  store: ReconcilerStore,
  state: PreparedReconciliationState,
  event: OpenCodeReconciliationEvent,
): void {
  const observedAt = store.now();
  if (
    event.kind === "observation" &&
    event.compaction === undefined &&
    observedAt - state.lastObservationAt < 100
  )
    return;
  state.projections.push(project(event));
  if (event.kind === "observation") state.lastObservationAt = observedAt;
}

function commitPreparedState(store: ReconcilerStore, state: PreparedReconciliationState): void {
  replaceMap(store.checkpoint, state.checkpoint);
  replaceMap(store.identities, state.identities);
  replaceSet(store.digests, state.digests);
  store.staged.splice(0, store.staged.length, ...state.staged);
  store.stagedBytes = state.stagedBytes;
  store.lastObservationAt = state.lastObservationAt;
  store.revision += 1;
}

function releaseEvictedIndexes(
  state: PreparedReconciliationState,
  evicted: readonly OpenCodeReconciliationEvent[],
): void {
  for (const event of evicted) {
    state.identities.delete(eventIdentity(event));
    state.digests.delete(event.digest);
  }
}

function makeCheckpointRoom(
  state: PreparedReconciliationState,
  aggregateId: string,
  maxCheckpoints: number,
): boolean {
  if (state.checkpoint.has(aggregateId) || state.checkpoint.size < maxCheckpoints) return true;
  const retained = new Set(state.staged.map((event) => event.aggregateId));
  for (const knownAggregate of state.checkpoint.keys()) {
    if (retained.has(knownAggregate)) continue;
    state.checkpoint.delete(knownAggregate);
    return true;
  }
  return false;
}

function eventIdentity(event: OpenCodeReconciliationEvent): string {
  return `${event.aggregateId}\u0000${String(event.sequence)}`;
}
function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
  target.clear();
  for (const value of source) target.add(value);
}
function makeRoom(
  staged: OpenCodeReconciliationEvent[],
  maxEvents: number,
  maxBytes: number,
  currentBytes: number,
  incomingBytes: number,
): readonly OpenCodeReconciliationEvent[] | undefined {
  let bytes = currentBytes;
  const evicted: OpenCodeReconciliationEvent[] = [];
  while (staged.length >= maxEvents || bytes + incomingBytes > maxBytes) {
    const index = staged.findIndex((event) => event.kind === "observation");
    if (index < 0) return undefined;
    const removed = staged.splice(index, 1)[0];
    if (removed === undefined) return undefined;
    bytes -= eventBytes(removed);
    evicted.push(removed);
  }
  return evicted;
}
function eventBytes(event: OpenCodeReconciliationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).length;
}
function valid(event: OpenCodeReconciliationEvent): boolean {
  return (
    event.id.length > 0 &&
    event.aggregateId.length > 0 &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 0 &&
    /^[0-9a-f]{64}$/u.test(event.digest) &&
    OPEN_CODE_EVENT_KINDS.includes(event.kind) &&
    isOpenCodeCompactionActivity(event.compaction)
  );
}

export function isOpenCodeCompactionActivity(
  value: unknown,
): value is OpenCodeCompactionActivity | undefined {
  if (value === undefined) return true;
  if (!recordValue(value) || typeof value.event !== "string") return false;
  return COMPACTION_ACTIVITY_VALIDATORS[value.event]?.(value) ?? false;
}

const REVIEWED_COMPACTION_FAILURE_REASONS = new Set([
  "content-filter",
  "error",
  "length",
  "unknown",
]);

type CompactionActivityRecord = Readonly<Record<string, unknown>>;
const COMPACTION_ACTIVITY_VALIDATORS: Readonly<
  Record<string, (value: CompactionActivityRecord) => boolean>
> = {
  started: (value) =>
    exactActivity(value, ["event", "compactionIdSha256", "auto", "overflow", "retainedTail"]) &&
    validCompactionId(value) &&
    typeof value.auto === "boolean" &&
    typeof value.overflow === "boolean" &&
    value.retainedTail === false,
  "tail-retained": (value) =>
    exactActivity(value, [
      "event",
      "compactionIdSha256",
      "tailStartIdSha256",
      "auto",
      "overflow",
      "retainedTail",
    ]) &&
    validCompactionId(value) &&
    typeof value.tailStartIdSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.tailStartIdSha256) &&
    typeof value.auto === "boolean" &&
    typeof value.overflow === "boolean" &&
    value.retainedTail === true,
  completed: (value) =>
    exactActivity(value, ["event", "compactionIdSha256"]) && validCompactionId(value),
  failed: (value) =>
    exactActivity(value, ["event", "compactionIdSha256", "errorKind", "finishReason"]) &&
    validCompactionId(value) &&
    typeof value.errorKind === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value.errorKind) &&
    typeof value.finishReason === "string" &&
    REVIEWED_COMPACTION_FAILURE_REASONS.has(value.finishReason),
};

function recordValue(value: unknown): value is CompactionActivityRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactActivity(value: CompactionActivityRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validCompactionId(value: CompactionActivityRecord): boolean {
  return (
    typeof value.compactionIdSha256 === "string" && /^[0-9a-f]{64}$/u.test(value.compactionIdSha256)
  );
}

function project(event: OpenCodeReconciliationEvent): OpenCodeProjection {
  return {
    id: event.id,
    aggregateId: event.aggregateId,
    sequence: event.sequence,
    kind: event.kind,
    digest: event.digest,
    ...(event.compaction === undefined ? {} : { compaction: event.compaction }),
  };
}
