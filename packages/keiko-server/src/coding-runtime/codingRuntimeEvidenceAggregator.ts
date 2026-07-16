// Content-free evidence aggregation for runtime lifecycle transitions. Observations are memory-only;
// a single manifest is emitted only when a run is terminal or explicitly recovery-settled.
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

const MAX_COUNT = 1_000_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SETTLEMENT_STATES = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
  "recovery-required",
]);

export interface CodingRuntimeEvidenceObservation {
  readonly kind: "state-transition" | "tool-call" | "patch" | "model-request" | "authority-denied";
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  readonly authorityDigest?: string | undefined;
  readonly bindingDigest?: string | undefined;
}

export interface CodingRuntimeEvidenceSettlement {
  readonly runId: string;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly settledAt: string;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  readonly taskDigest: string;
  readonly workspaceDigest: string;
  readonly operatorDigest: string;
  readonly authorityDigest: string;
  readonly bindingDigest: string;
  readonly provenanceDigest: string;
}

export interface CodingRuntimeEvidenceAggregator {
  /** Hot path: bounded in-memory counters/enums/digests only; never writes evidence. */
  readonly observe: (runId: string, observation: CodingRuntimeEvidenceObservation) => void;
  /** Emits exactly one atomically-written manifest for a terminal/recovery settlement. */
  readonly settle: (settlement: CodingRuntimeEvidenceSettlement) => string;
  /** Called with DB-pruned ids; does not enumerate the evidence directory. */
  readonly deletePruned: (runIds: readonly string[]) => void;
}

interface Aggregate {
  readonly counts: Record<CodingRuntimeEvidenceObservation["kind"], number>;
  readonly states: Set<CodingWorkbenchRuntimeStateName>;
  readonly failures: Set<CodingWorkbenchRuntimeFailureCode>;
  readonly authorityDigests: Set<string>;
  readonly bindingDigests: Set<string>;
}

export function createCodingRuntimeEvidenceAggregator(
  store: EvidenceStore,
): CodingRuntimeEvidenceAggregator {
  const aggregates = new Map<string, Aggregate>();
  const settled = new Set<string>();
  return {
    observe: (runId, observation): void => {
      observe(aggregates, settled, runId, observation);
    },
    settle: (settlement): string => settle(store, aggregates, settled, settlement),
    deletePruned: (runIds): void => {
      deletePruned(store, aggregates, settled, runIds);
    },
  };
}

function observe(
  aggregates: Map<string, Aggregate>,
  settled: ReadonlySet<string>,
  runId: string,
  observation: CodingRuntimeEvidenceObservation,
): void {
  assertId(runId, "runId");
  if (settled.has(runId)) return;
  const aggregate = aggregates.get(runId) ?? newAggregate();
  aggregates.set(runId, aggregate);
  aggregate.counts[observation.kind] = increment(aggregate.counts[observation.kind]);
  aggregate.states.add(observation.state);
  if (observation.failureCode) aggregate.failures.add(observation.failureCode);
  addDigest(observation.authorityDigest, "authorityDigest", aggregate.authorityDigests);
  addDigest(observation.bindingDigest, "bindingDigest", aggregate.bindingDigests);
}

function addDigest(value: string | undefined, name: string, target: Set<string>): void {
  if (value === undefined) return;
  assertDigest(value, name);
  target.add(value);
}

function settle(
  store: EvidenceStore,
  aggregates: Map<string, Aggregate>,
  settled: Set<string>,
  settlement: CodingRuntimeEvidenceSettlement,
): string {
  assertSettlement(settlement);
  if (settled.has(settlement.runId))
    return store.location?.(settlement.runId) ?? `${settlement.runId}.json`;
  const aggregate = aggregates.get(settlement.runId) ?? newAggregate();
  const location = store.put(settlement.runId, JSON.stringify(manifest(settlement, aggregate)));
  settled.add(settlement.runId);
  aggregates.delete(settlement.runId);
  return location;
}

function manifest(settlement: CodingRuntimeEvidenceSettlement, aggregate: Aggregate): object {
  return {
    evidenceSchemaVersion: "1",
    kind: "coding-runtime-lifecycle",
    run: {
      runId: settlement.runId,
      state: settlement.state,
      revision: settlement.revision,
      settledAt: settlement.settledAt,
      ...(settlement.failureCode ? { failureCode: settlement.failureCode } : {}),
    },
    digests: {
      task: settlement.taskDigest,
      workspace: settlement.workspaceDigest,
      operator: settlement.operatorDigest,
      authority: settlement.authorityDigest,
      binding: settlement.bindingDigest,
      provenance: settlement.provenanceDigest,
      observedAuthority: [...aggregate.authorityDigests].sort(),
      observedBinding: [...aggregate.bindingDigests].sort(),
    },
    counts: aggregate.counts,
    states: [...aggregate.states].sort(),
    failureCodes: [...aggregate.failures].sort(),
  };
}

function deletePruned(
  store: EvidenceStore,
  aggregates: Map<string, Aggregate>,
  settled: Set<string>,
  runIds: readonly string[],
): void {
  for (const runId of runIds) {
    assertId(runId, "runId");
    store.delete(runId);
    aggregates.delete(runId);
    settled.delete(runId);
  }
}

function newAggregate(): Aggregate {
  return {
    counts: {
      "state-transition": 0,
      "tool-call": 0,
      patch: 0,
      "model-request": 0,
      "authority-denied": 0,
    },
    states: new Set(),
    failures: new Set(),
    authorityDigests: new Set(),
    bindingDigests: new Set(),
  };
}
function increment(value: number): number {
  return value >= MAX_COUNT ? MAX_COUNT : value + 1;
}
function assertSettlement(v: CodingRuntimeEvidenceSettlement): void {
  assertId(v.runId, "runId");
  if (!SETTLEMENT_STATES.has(v.state))
    throw new Error("runtime evidence requires terminal or recovery settlement");
  if (!Number.isSafeInteger(v.revision) || v.revision < 0) throw new Error("invalid revision");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.settledAt) ||
    Number.isNaN(Date.parse(v.settledAt))
  )
    throw new Error("invalid settledAt");
  for (const [name, digest] of Object.entries({
    taskDigest: v.taskDigest,
    workspaceDigest: v.workspaceDigest,
    operatorDigest: v.operatorDigest,
    authorityDigest: v.authorityDigest,
    bindingDigest: v.bindingDigest,
    provenanceDigest: v.provenanceDigest,
  }))
    assertDigest(digest, name);
}
function assertId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`invalid ${name}`);
}
function assertDigest(value: string, name: string): void {
  if (!DIGEST.test(value)) throw new Error(`invalid ${name}`);
}
