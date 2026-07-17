// Durable, content-free lifecycle ledger for coding runtimes (issue #2256).
// This port intentionally has no event/token append operation: hot-path observations stay in memory.
import type { DatabaseSync } from "node:sqlite";
import type {
  CodingWorkbenchModelSource,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

const MAX_ROWS = 10_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES = new Set<CodingWorkbenchRuntimeStateName>([
  "starting",
  "ready",
  "running",
  "paused",
  "awaiting-approval",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
  "recovery-required",
  "idle",
  "unavailable",
]);
const SETTLED = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

export interface CodingRuntimeSnapshot {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string | undefined;
  readonly recoveryAcknowledgedAt?: string | undefined;
  readonly predecessorRunId?: string | undefined;
  readonly taskDigest: string;
  readonly workspaceDigest: string;
  readonly operatorDigest: string;
  readonly authorityDigest: string;
  readonly bindingDigest: string;
  readonly provenanceDigest: string;
  readonly toolCallCount: number;
  readonly patchByteCount: number;
  readonly modelRequestCount: number;
  readonly recoveryHandle?: string | undefined;
}

export interface CodingRuntimeSnapshotTransition {
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly updatedAt: string;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
  readonly terminalAt?: string | undefined;
  readonly toolCallCount?: number | undefined;
  readonly patchByteCount?: number | undefined;
  readonly modelRequestCount?: number | undefined;
  readonly recoveryHandle?: string | undefined;
}

export interface CodingRuntimeSnapshotStore {
  readonly create: (snapshot: CodingRuntimeSnapshot) => CodingRuntimeSnapshot;
  readonly transition: (
    runId: string,
    transition: CodingRuntimeSnapshotTransition,
  ) => CodingRuntimeSnapshot;
  readonly get: (runId: string) => CodingRuntimeSnapshot | undefined;
  readonly listRecentActive: (limit?: number) => readonly CodingRuntimeSnapshot[];
  readonly listAll: (limit?: number) => readonly CodingRuntimeSnapshot[];
  /** Startup-only containment: marks persisted active rows recoverable; never replays them. */
  readonly markNonterminalRecoveryRequired: (updatedAt: string) => readonly string[];
  /** Retains the recovery slot; acknowledgement alone never makes a run startable. */
  readonly acknowledgeRecovery: (runId: string, acknowledgedAt: string) => CodingRuntimeSnapshot;
  /** Explicit fresh-retry boundary: settles an acknowledged recovery row without replaying it. */
  readonly releaseRecoveryForRetry: (runId: string, releasedAt: string) => CodingRuntimeSnapshot;
  readonly delete: (runId: string) => void;
  /** Selects oldest settled rows needed to reach the 10,000-row bound without deleting them. */
  readonly listPrunableSettled: () => readonly string[];
  /** Finalizes pruning only after evidence/replay cleanup succeeds. */
  readonly deletePruned: (runIds: readonly string[]) => void;
}

interface Row {
  readonly run_id: string;
  readonly schema_version: string;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly requested_mode: CodingWorkbenchMode;
  readonly runtime_source: CodingWorkbenchRuntimeSource;
  readonly model_source: CodingWorkbenchModelSource;
  readonly failure_code: CodingWorkbenchRuntimeFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
  readonly recovery_acknowledged_at: string | null;
  readonly predecessor_run_id: string | null;
  readonly task_digest: string;
  readonly workspace_digest: string;
  readonly operator_digest: string;
  readonly authority_digest: string;
  readonly binding_digest: string;
  readonly provenance_digest: string;
  readonly tool_call_count: number;
  readonly patch_byte_count: number;
  readonly model_request_count: number;
  readonly recovery_handle: string | null;
}

const COLUMNS =
  "run_id, schema_version, state, revision, requested_mode, runtime_source, model_source, failure_code, created_at, updated_at, terminal_at, recovery_acknowledged_at, predecessor_run_id, task_digest, workspace_digest, operator_digest, authority_digest, binding_digest, provenance_digest, tool_call_count, patch_byte_count, model_request_count, recovery_handle";

// Prepared statements must remain co-located with the closed store operations they support.
// eslint-disable-next-line max-lines-per-function
export function createCodingRuntimeSnapshotStore(db: DatabaseSync): CodingRuntimeSnapshotStore {
  const get = db.prepare(`SELECT ${COLUMNS} FROM coding_runtime_snapshots WHERE run_id = ?`);
  const listActive = db.prepare(
    `SELECT ${COLUMNS} FROM coding_runtime_snapshots WHERE terminal_at IS NULL ORDER BY updated_at DESC, run_id LIMIT ?`,
  );
  const listAll = db.prepare(
    `SELECT ${COLUMNS} FROM coding_runtime_snapshots ORDER BY updated_at DESC, run_id LIMIT ?`,
  );
  const insert = db.prepare(
    `INSERT INTO coding_runtime_snapshots (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE coding_runtime_snapshots SET state=?, revision=?, updated_at=?, failure_code=?, terminal_at=?, tool_call_count=?, patch_byte_count=?, model_request_count=?, recovery_handle=? WHERE run_id=?`,
  );
  const acknowledge = db.prepare(
    "UPDATE coding_runtime_snapshots SET recovery_acknowledged_at = ? WHERE run_id = ? AND state = 'recovery-required'",
  );
  const releaseRecovery = db.prepare(
    "UPDATE coding_runtime_snapshots SET terminal_at = ?, updated_at = ?, revision = revision + 1 WHERE run_id = ? AND state = 'recovery-required' AND recovery_acknowledged_at IS NOT NULL AND terminal_at IS NULL",
  );
  const remove = db.prepare("DELETE FROM coding_runtime_snapshots WHERE run_id = ?");

  const one = (runId: string): CodingRuntimeSnapshot | undefined =>
    map(get.get(runId) as Row | undefined);
  return {
    create(snapshot): CodingRuntimeSnapshot {
      assertSnapshot(snapshot);
      insert.run(...values(snapshot));
      return snapshot;
    },
    // The closed store operation keeps SQL binding adjacent to its validated state transition.
    // eslint-disable-next-line complexity
    transition(runId, transition): CodingRuntimeSnapshot {
      assertId(runId, "runId");
      assertTransition(transition);
      const current = one(runId);
      if (!current) throw new Error("runtime snapshot was not found");
      if (transition.revision <= current.revision)
        throw new Error("runtime revision must increase");
      const next: CodingRuntimeSnapshot = {
        ...current,
        ...transition,
        failureCode: transition.failureCode,
        terminalAt: SETTLED.has(transition.state)
          ? (transition.terminalAt ?? transition.updatedAt)
          : undefined,
        toolCallCount: transition.toolCallCount ?? current.toolCallCount,
        patchByteCount: transition.patchByteCount ?? current.patchByteCount,
        modelRequestCount: transition.modelRequestCount ?? current.modelRequestCount,
        recoveryHandle: transition.recoveryHandle ?? current.recoveryHandle,
      };
      assertSnapshot(next);
      update.run(
        next.state,
        next.revision,
        next.updatedAt,
        next.failureCode ?? null,
        next.terminalAt ?? null,
        next.toolCallCount,
        next.patchByteCount,
        next.modelRequestCount,
        next.recoveryHandle ?? null,
        runId,
      );
      return next;
    },
    get: one,
    listRecentActive: (limit = 100): readonly CodingRuntimeSnapshot[] =>
      rows(listActive.all(assertLimit(limit)) as unknown as Row[]),
    listAll: (limit = 100): readonly CodingRuntimeSnapshot[] =>
      rows(listAll.all(assertLimit(limit)) as unknown as Row[]),
    markNonterminalRecoveryRequired(updatedAt): readonly string[] {
      assertIso(updatedAt, "updatedAt");
      const active = db
        .prepare(
          "SELECT run_id, revision FROM coding_runtime_snapshots WHERE terminal_at IS NULL AND state <> 'recovery-required'",
        )
        .all() as { run_id: string; revision: number }[];
      if (active.length === 0) return [];
      db.exec("BEGIN");
      try {
        const statement = db.prepare(
          "UPDATE coding_runtime_snapshots SET state='recovery-required', failure_code='recovery-required', revision=?, updated_at=? WHERE run_id=?",
        );
        for (const row of active) statement.run(row.revision + 1, updatedAt, row.run_id);
        db.exec("COMMIT");
        return active.map((row) => row.run_id);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    acknowledgeRecovery(runId, acknowledgedAt): CodingRuntimeSnapshot {
      assertId(runId, "runId");
      assertIso(acknowledgedAt, "acknowledgedAt");
      if (acknowledge.run(acknowledgedAt, runId).changes !== 1)
        throw new Error("recovery-required runtime snapshot was not found");
      return requireSnapshot(one(runId));
    },
    releaseRecoveryForRetry(runId, releasedAt): CodingRuntimeSnapshot {
      assertId(runId, "runId");
      assertIso(releasedAt, "releasedAt");
      if (releaseRecovery.run(releasedAt, releasedAt, runId).changes !== 1)
        throw new Error("acknowledged recovery runtime snapshot was not found");
      return requireSnapshot(one(runId));
    },
    delete(runId): void {
      assertId(runId, "runId");
      remove.run(runId);
    },
    listPrunableSettled(): readonly string[] {
      const count = (
        db.prepare("SELECT COUNT(*) AS count FROM coding_runtime_snapshots").get() as {
          count: number;
        }
      ).count;
      const excess = Math.max(0, count - MAX_ROWS);
      return excess === 0
        ? []
        : (
            db
              .prepare(
                "SELECT run_id FROM coding_runtime_snapshots WHERE terminal_at IS NOT NULL ORDER BY terminal_at, updated_at, run_id LIMIT ?",
              )
              .all(excess) as { run_id: string }[]
          ).map((row) => row.run_id);
    },
    deletePruned(runIds): void {
      if (runIds.length === 0) return;
      db.exec("BEGIN");
      try {
        const del = db.prepare(
          "DELETE FROM coding_runtime_snapshots WHERE run_id=? AND terminal_at IS NOT NULL",
        );
        for (const id of runIds) {
          assertId(id, "runId");
          del.run(id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function map(row: Row | undefined): CodingRuntimeSnapshot | undefined {
  if (!row) return undefined;
  const value: CodingRuntimeSnapshot = {
    schemaVersion: "1",
    runId: row.run_id,
    state: row.state,
    revision: row.revision,
    requestedMode: row.requested_mode,
    runtimeSource: row.runtime_source,
    modelSource: row.model_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    taskDigest: row.task_digest,
    workspaceDigest: row.workspace_digest,
    operatorDigest: row.operator_digest,
    authorityDigest: row.authority_digest,
    bindingDigest: row.binding_digest,
    provenanceDigest: row.provenance_digest,
    toolCallCount: row.tool_call_count,
    patchByteCount: row.patch_byte_count,
    modelRequestCount: row.model_request_count,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    ...(row.recovery_acknowledged_at
      ? { recoveryAcknowledgedAt: row.recovery_acknowledged_at }
      : {}),
    ...(row.predecessor_run_id ? { predecessorRunId: row.predecessor_run_id } : {}),
    ...(row.recovery_handle ? { recoveryHandle: row.recovery_handle } : {}),
  };
  assertSnapshot(value);
  return value;
}
function rows(values: Row[]): readonly CodingRuntimeSnapshot[] {
  return values.map((row) => requireSnapshot(map(row)));
}

function requireSnapshot(snapshot: CodingRuntimeSnapshot | undefined): CodingRuntimeSnapshot {
  if (snapshot === undefined) throw new Error("runtime snapshot was not found");
  return snapshot;
}
function values(v: CodingRuntimeSnapshot): readonly (string | number | null)[] {
  return [
    v.runId,
    v.schemaVersion,
    v.state,
    v.revision,
    v.requestedMode,
    v.runtimeSource,
    v.modelSource,
    v.failureCode ?? null,
    v.createdAt,
    v.updatedAt,
    v.terminalAt ?? null,
    v.recoveryAcknowledgedAt ?? null,
    v.predecessorRunId ?? null,
    v.taskDigest,
    v.workspaceDigest,
    v.operatorDigest,
    v.authorityDigest,
    v.bindingDigest,
    v.provenanceDigest,
    v.toolCallCount,
    v.patchByteCount,
    v.modelRequestCount,
    v.recoveryHandle ?? null,
  ];
}
function assertSnapshot(v: CodingRuntimeSnapshot): void {
  assertId(v.runId, "runId");
  if (!hasSchemaVersion(v.schemaVersion) || !STATES.has(v.state))
    throw new Error("invalid runtime snapshot state");
  if (!Number.isSafeInteger(v.revision) || v.revision < 0) throw new Error("invalid revision");
  assertIso(v.createdAt, "createdAt");
  assertIso(v.updatedAt, "updatedAt");
  if (v.terminalAt) assertIso(v.terminalAt, "terminalAt");
  if (v.recoveryAcknowledgedAt) assertIso(v.recoveryAcknowledgedAt, "recoveryAcknowledgedAt");
  if (v.predecessorRunId) assertId(v.predecessorRunId, "predecessorRunId");
  if (v.recoveryHandle) assertId(v.recoveryHandle, "recoveryHandle");
  assertSnapshotDigests(v);
  assertSnapshotCounts(v);
}

function hasSchemaVersion(value: string): boolean {
  return value === "1";
}

function assertSnapshotDigests(v: CodingRuntimeSnapshot): void {
  for (const [name, digest] of Object.entries({
    taskDigest: v.taskDigest,
    workspaceDigest: v.workspaceDigest,
    operatorDigest: v.operatorDigest,
    authorityDigest: v.authorityDigest,
    bindingDigest: v.bindingDigest,
    provenanceDigest: v.provenanceDigest,
  }))
    if (!DIGEST.test(digest)) throw new Error(`invalid ${name}`);
}

function assertSnapshotCounts(v: CodingRuntimeSnapshot): void {
  for (const [name, count, max] of [
    ["toolCallCount", v.toolCallCount, 1_000_000],
    ["patchByteCount", v.patchByteCount, 1_073_741_824],
    ["modelRequestCount", v.modelRequestCount, 1_000_000],
  ] as const)
    if (!Number.isSafeInteger(count) || count < 0 || count > max)
      throw new Error(`invalid ${name}`);
}
function assertTransition(v: CodingRuntimeSnapshotTransition): void {
  if (!STATES.has(v.state)) throw new Error("invalid runtime snapshot state");
  if (!Number.isSafeInteger(v.revision) || v.revision < 0) throw new Error("invalid revision");
  assertIso(v.updatedAt, "updatedAt");
  if (v.terminalAt) assertIso(v.terminalAt, "terminalAt");
  if (v.recoveryHandle) assertId(v.recoveryHandle, "recoveryHandle");
}
function assertId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`invalid ${name}`);
}
function assertIso(value: string, name: string): void {
  if (!ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`invalid ${name}`);
}
function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ROWS)
    throw new Error("invalid list limit");
  return value;
}
