// Durable, deduplicated automatic-description job bookkeeping (Issue #3401, Epic #3384). Owns
// EXACTLY the terminal-run dispatch decision (dedup, coalesce, supersede, restart recovery) over
// the V29 `coding_runtime_description_jobs` table; it never captures a snapshot, calls a model, or
// applies a description — see codingRuntimeOrchestrator.ts for the caller and the sibling stores
// this mirrors (codingRuntimeDraftDeliveryStore.ts, codingRuntimeVerifiedCommitAuthorityStore.ts).
//
// One row per run, exactly like `draft_delivery_record` / `ci_readiness_record` are one fact per
// run: a new head for the same run REPLACES the row (supersede) rather than appending a second one.
// `revision` is the CAS guard — a caller's `settle` whose expected revision has moved underneath it
// (because a newer head superseded it) is rejected and discarded, never overwritten.

import type { DatabaseSync } from "node:sqlite";
import {
  isWorkbenchDescriptionStatus,
  WORKBENCH_DESCRIPTION_REASON_STATES,
  type WorkbenchDescriptionReason,
  type WorkbenchDescriptionStatus,
} from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";

/** The identity a description job is dispatched for — everything known BEFORE generation runs. */
export interface WorkbenchDescriptionScope {
  readonly runId: string;
  readonly remoteDigest: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export type WorkbenchDescriptionDispatchDecision =
  | {
      readonly kind: "dispatch";
      readonly generationVersion: number;
      readonly revision: number;
      readonly supersededPriorAttempt: boolean;
    }
  | { readonly kind: "coalesced"; readonly status: WorkbenchDescriptionStatus | undefined }
  | { readonly kind: "budget-exhausted" };

export interface CodingRuntimeDescriptionJobStore {
  /** Decides dispatch vs. coalesce vs. supersede for one terminal-success signal. */
  readonly beginDispatch: (
    scope: WorkbenchDescriptionScope,
    nowIso: string,
  ) => WorkbenchDescriptionDispatchDecision;
  /** Finalizes a dispatched attempt. Returns false when superseded meanwhile (stale, discarded). */
  readonly settle: (
    scope: WorkbenchDescriptionScope,
    generationVersion: number,
    revision: number,
    status: WorkbenchDescriptionStatus,
    nowIso: string,
  ) => boolean;
  /**
   * Records a closed blocked outcome for an attempt that WAS dispatched (a settle path). Returns
   * false, exactly like `settle`, when a newer head superseded this attempt meanwhile (the
   * `revision` guard rejected the write) — the caller logs that as `superseded`, never `blocked`,
   * so a race between a late provider failure and a fresh head never overwrites the newer status.
   */
  readonly recordBlocked: (
    scope: WorkbenchDescriptionScope,
    reason: WorkbenchDescriptionReason,
    generationVersion: number,
    revision: number,
    nowIso: string,
  ) => boolean;
  /**
   * Records a closed "budget-exhausted" outcome for a `beginDispatch` call that was rejected
   * BEFORE any attempt was allocated — no generationVersion/revision exists to settle against, so
   * this makes the run's current head visible as blocked directly, without ever touching `phase`
   * (`beginDispatch`'s own budget guard proves no row here is ever `'dispatched'`, so this can
   * never race a still-in-flight attempt for the same run).
   */
  readonly recordBudgetExhausted: (scope: WorkbenchDescriptionScope, nowIso: string) => void;
  readonly current: (runId: string) => WorkbenchDescriptionStatus | undefined;
  /** Startup-only containment: an attempt still in flight from a prior process is never resumed. */
  readonly reconcileInterrupted: (nowIso: string) => readonly string[];
}

interface Row {
  readonly run_id: string;
  readonly remote_digest: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly generation_version: number;
  readonly revision: number;
  readonly phase: "dispatched" | "settled";
  readonly status_json: string | null;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const DEFAULT_MAX_CONCURRENT_DESCRIPTION_DISPATCHES = 4;

function assertScope(scope: WorkbenchDescriptionScope): void {
  if (
    !RUN_ID.test(scope.runId) ||
    !DIGEST.test(scope.remoteDigest) ||
    !OBJECT_ID.test(scope.baseSha) ||
    !OBJECT_ID.test(scope.headSha)
  ) {
    throw new TypeError("invalid description job scope");
  }
}

function sameHead(row: Row, scope: WorkbenchDescriptionScope): boolean {
  return (
    row.remote_digest === scope.remoteDigest &&
    row.base_sha === scope.baseSha &&
    row.head_sha === scope.headSha
  );
}

// A row already `dispatched` for the same run already occupies one of the counted slots (this is
// a supersede, not a new claim on the budget); a `settled` row (or no row at all) claims a fresh
// slot. Without this distinction, a repaired-head regeneration for an already-settled run could
// exceed `maxConcurrentDispatches` unconditionally (#3401 review).
function claimsFreshBudgetSlot(row: Row | undefined): boolean {
  return row?.phase !== "dispatched";
}

function settledStatus(row: Row): WorkbenchDescriptionStatus | undefined {
  if (row.phase !== "settled" || row.status_json === null) return undefined;
  const parsed: unknown = JSON.parse(row.status_json);
  if (!isWorkbenchDescriptionStatus(parsed)) {
    throw new TypeError("invalid persisted description job status");
  }
  return parsed;
}

function blockedStatus(
  scope: WorkbenchDescriptionScope,
  reason: WorkbenchDescriptionReason,
  generationVersion: number,
  nowIso: string,
): WorkbenchDescriptionStatus {
  return {
    schemaVersion: "1",
    runId: scope.runId,
    remoteDigest: scope.remoteDigest,
    baseSha: scope.baseSha,
    headSha: scope.headSha,
    generationVersion,
    state: WORKBENCH_DESCRIPTION_REASON_STATES[reason],
    reason,
    snapshotDigest: null,
    draftDigest: null,
    artifactOutcome: null,
    observedAt: nowIso,
  };
}

interface Statements {
  readonly getRow: ReturnType<DatabaseSync["prepare"]>;
  readonly countInFlight: ReturnType<DatabaseSync["prepare"]>;
  readonly insert: ReturnType<DatabaseSync["prepare"]>;
  readonly upsertDispatch: ReturnType<DatabaseSync["prepare"]>;
  readonly settleRow: ReturnType<DatabaseSync["prepare"]>;
  readonly insertSettled: ReturnType<DatabaseSync["prepare"]>;
  readonly upsertSettled: ReturnType<DatabaseSync["prepare"]>;
  readonly interrupted: ReturnType<DatabaseSync["prepare"]>;
}

const ROW_COLUMNS =
  "run_id, remote_digest, base_sha, head_sha, generation_version, revision, phase, status_json";

function prepareStatements(db: DatabaseSync): Statements {
  return {
    getRow: db.prepare(
      `SELECT ${ROW_COLUMNS} FROM coding_runtime_description_jobs WHERE run_id = ?`,
    ),
    countInFlight: db.prepare(
      "SELECT COUNT(*) AS count FROM coding_runtime_description_jobs WHERE phase = 'dispatched'",
    ),
    insert: db.prepare(
      "INSERT INTO coding_runtime_description_jobs (run_id, remote_digest, base_sha, head_sha, generation_version, revision, phase, status_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'dispatched', NULL, ?)",
    ),
    upsertDispatch: db.prepare(
      "UPDATE coding_runtime_description_jobs SET remote_digest = ?, base_sha = ?, head_sha = ?, generation_version = ?, revision = ?, phase = 'dispatched', status_json = NULL, updated_at = ? WHERE run_id = ?",
    ),
    settleRow: db.prepare(
      "UPDATE coding_runtime_description_jobs SET phase = 'settled', status_json = ?, updated_at = ? WHERE run_id = ? AND revision = ?",
    ),
    // Budget-exhausted is rejected before any `dispatched` row is allocated, so there is nothing
    // to settle: these two make the run's current head visible as blocked directly, choosing
    // insert vs. update by whether a row for the run already exists.
    insertSettled: db.prepare(
      "INSERT INTO coding_runtime_description_jobs (run_id, remote_digest, base_sha, head_sha, generation_version, revision, phase, status_json, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'settled', ?, ?)",
    ),
    upsertSettled: db.prepare(
      "UPDATE coding_runtime_description_jobs SET remote_digest = ?, base_sha = ?, head_sha = ?, generation_version = ?, phase = 'settled', status_json = ?, updated_at = ? WHERE run_id = ?",
    ),
    interrupted: db.prepare(
      `SELECT ${ROW_COLUMNS} FROM coding_runtime_description_jobs WHERE phase = 'dispatched'`,
    ),
  };
}

function readRow(statements: Statements, runId: string): Row | undefined {
  return statements.getRow.get(runId) as Row | undefined;
}

function beginDispatch(
  statements: Statements,
  maxConcurrentDispatches: number,
  scope: WorkbenchDescriptionScope,
  nowIso: string,
): WorkbenchDescriptionDispatchDecision {
  assertScope(scope);
  const row = readRow(statements, scope.runId);
  if (row !== undefined && sameHead(row, scope)) {
    return { kind: "coalesced", status: settledStatus(row) };
  }
  const inFlight = (statements.countInFlight.get() as { count: number }).count;
  if (claimsFreshBudgetSlot(row) && inFlight >= maxConcurrentDispatches) {
    return { kind: "budget-exhausted" };
  }
  const generationVersion = (row?.generation_version ?? 0) + 1;
  const revision = (row?.revision ?? -1) + 1;
  if (row === undefined) {
    statements.insert.run(
      scope.runId,
      scope.remoteDigest,
      scope.baseSha,
      scope.headSha,
      generationVersion,
      revision,
      nowIso,
    );
  } else {
    statements.upsertDispatch.run(
      scope.remoteDigest,
      scope.baseSha,
      scope.headSha,
      generationVersion,
      revision,
      nowIso,
      scope.runId,
    );
  }
  return {
    kind: "dispatch",
    generationVersion,
    revision,
    supersededPriorAttempt: row !== undefined,
  };
}

function settle(
  statements: Statements,
  scope: WorkbenchDescriptionScope,
  generationVersion: number,
  revision: number,
  status: WorkbenchDescriptionStatus,
  nowIso: string,
): boolean {
  assertScope(scope);
  if (
    !isWorkbenchDescriptionStatus(status) ||
    status.runId !== scope.runId ||
    status.remoteDigest !== scope.remoteDigest ||
    status.baseSha !== scope.baseSha ||
    status.headSha !== scope.headSha ||
    status.generationVersion !== generationVersion
  ) {
    throw new TypeError("description job settle payload does not match its dispatched scope");
  }
  const result = statements.settleRow.run(JSON.stringify(status), nowIso, scope.runId, revision);
  return Number(result.changes) === 1;
}

function recordBudgetExhausted(
  statements: Statements,
  scope: WorkbenchDescriptionScope,
  nowIso: string,
): void {
  assertScope(scope);
  const row = readRow(statements, scope.runId);
  const generationVersion = (row?.generation_version ?? 0) + 1;
  const status = blockedStatus(scope, "budget-exhausted", generationVersion, nowIso);
  if (row === undefined) {
    statements.insertSettled.run(
      scope.runId,
      scope.remoteDigest,
      scope.baseSha,
      scope.headSha,
      generationVersion,
      JSON.stringify(status),
      nowIso,
    );
    return;
  }
  statements.upsertSettled.run(
    scope.remoteDigest,
    scope.baseSha,
    scope.headSha,
    generationVersion,
    JSON.stringify(status),
    nowIso,
    scope.runId,
  );
}

function reconcileInterrupted(statements: Statements, nowIso: string): readonly string[] {
  const rows = statements.interrupted.all() as unknown as Row[];
  const recovered: string[] = [];
  for (const row of rows) {
    const scope: WorkbenchDescriptionScope = {
      runId: row.run_id,
      remoteDigest: row.remote_digest,
      baseSha: row.base_sha,
      headSha: row.head_sha,
    };
    const status = blockedStatus(scope, "interrupted", row.generation_version, nowIso);
    statements.settleRow.run(JSON.stringify(status), nowIso, row.run_id, row.revision);
    recovered.push(row.run_id);
  }
  return recovered;
}

export function createCodingRuntimeDescriptionJobStore(
  db: DatabaseSync,
  maxConcurrentDispatches = DEFAULT_MAX_CONCURRENT_DESCRIPTION_DISPATCHES,
): CodingRuntimeDescriptionJobStore {
  const statements = prepareStatements(db);
  return {
    beginDispatch: (scope, nowIso): WorkbenchDescriptionDispatchDecision =>
      beginDispatch(statements, maxConcurrentDispatches, scope, nowIso),
    settle: (scope, generationVersion, revision, status, nowIso): boolean =>
      settle(statements, scope, generationVersion, revision, status, nowIso),
    recordBlocked(scope, reason, generationVersion, revision, nowIso): boolean {
      const status = blockedStatus(scope, reason, generationVersion, nowIso);
      const result = statements.settleRow.run(
        JSON.stringify(status),
        nowIso,
        scope.runId,
        revision,
      );
      return Number(result.changes) === 1;
    },
    recordBudgetExhausted(scope, nowIso): void {
      recordBudgetExhausted(statements, scope, nowIso);
    },
    current(runId): WorkbenchDescriptionStatus | undefined {
      const row = readRow(statements, runId);
      return row === undefined ? undefined : settledStatus(row);
    },
    reconcileInterrupted: (nowIso): readonly string[] => reconcileInterrupted(statements, nowIso),
  };
}
