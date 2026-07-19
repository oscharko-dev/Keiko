// Issue #2521, ADR-0146 D3/D8 — canonical workspace-trust row CRUD. All SQL is module-scope
// constants; no string interpolation into SQL. This layer is deliberately dumb: it persists and
// returns opaque, content-free rows and holds no trust semantics. Derivation, contract validation,
// projection, and fail-closed decisions all live above the UiStore port (workspace-script-trust.ts).

import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceTrustRecordRow, WorkspaceTrustRecordRowInput } from "./types.js";

interface WorkspaceTrustRow {
  readonly root_ref: string;
  readonly revision: number;
  readonly trust: string;
  readonly record_json: string;
  readonly updated_at: number;
}

function rowToRecord(row: WorkspaceTrustRow): WorkspaceTrustRecordRow {
  return {
    rootRef: row.root_ref,
    revision: row.revision,
    trust: row.trust,
    recordJson: row.record_json,
    updatedAt: row.updated_at,
  };
}

const SQL_GET =
  "SELECT root_ref, revision, trust, record_json, updated_at FROM workspace_trust_records WHERE root_ref = ?";

// UPSERT keyed by the derived opaque root reference. Monotonic by construction: the DO UPDATE is
// guarded by `excluded.revision > current.revision`, so the row only ever moves forward. A stale or
// replayed write at an equal-or-lower revision is silently ignored, so a restored older manifest (or
// a rolled-back store) can never resurrect a prior grant — the invariant is enforced at the DB layer,
// not only by caller discipline (ADR-0146 D3).
const SQL_UPSERT = `
INSERT INTO workspace_trust_records (root_ref, revision, trust, record_json, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(root_ref) DO UPDATE SET
  revision = excluded.revision,
  trust = excluded.trust,
  record_json = excluded.record_json,
  updated_at = excluded.updated_at
WHERE excluded.revision > workspace_trust_records.revision
`;

// Deterministic bounded pruning: keep the newest `max` rows by recency, delete the rest. Ordering is
// total (updated_at then root_ref) so pruning is reproducible and never depends on insertion order.
const SQL_PRUNE = `
DELETE FROM workspace_trust_records
WHERE root_ref IN (
  SELECT root_ref FROM workspace_trust_records
  ORDER BY updated_at DESC, root_ref DESC
  LIMIT -1 OFFSET ?
)
`;

export function readWorkspaceTrustRecord(
  db: DatabaseSync,
  rootRef: string,
): WorkspaceTrustRecordRow | undefined {
  const row = db.prepare(SQL_GET).get(rootRef) as unknown as WorkspaceTrustRow | undefined;
  return row === undefined ? undefined : rowToRecord(row);
}

export function writeWorkspaceTrustRecord(
  db: DatabaseSync,
  input: WorkspaceTrustRecordRowInput,
  now: number,
): void {
  db.prepare(SQL_UPSERT).run(input.rootRef, input.revision, input.trust, input.recordJson, now);
}

export function pruneWorkspaceTrustRecords(db: DatabaseSync, max: number): void {
  const keep = Number.isSafeInteger(max) && max > 0 ? max : 0;
  db.prepare(SQL_PRUNE).run(keep);
}
