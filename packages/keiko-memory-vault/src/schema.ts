// Memory vault schema V1. Forward-only migration runner keyed off PRAGMA user_version, applied
// inside a single transaction so a partial failure leaves user_version unchanged. STRICT tables
// pin the column types at runtime so SQLite cannot silently coerce a wrong-shape insert.
//
// Index strategy:
//   - (scope_kind, scope_coordinate)               for the canonical scoped list (#206 AC)
//   - (scope_kind, scope_coordinate, type|status) for the common filter combinations
//   - pinned partial index                         for "list pinned in scope X"
//   - valid_until                                  for the consolidation sweep (#208)
//   - updated_at                                   for the "recently changed" surface
//   - edges from/to                                for graph traversal
//   - tombstones scope                             for the forgetting audit surface (#214)
//
// `provenance_*` columns are denormalised onto `memories` so a single SELECT can answer
// "give me this memory plus its capture lineage" without joining a sidecar table. The structural
// payload is JSON-encoded into `payload_json` because storing it as a normalised table would
// require a schema change every time a payload kind landed (#205 ships only two kinds today).

import type { DatabaseSync } from "node:sqlite";

export const MEMORY_VAULT_SCHEMA_VERSION = 1;

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const V1_SQL = `
CREATE TABLE memories (
  id TEXT NOT NULL PRIMARY KEY,
  schema_version TEXT NOT NULL,
  type TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_coordinate TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  stale_reason TEXT,
  tags_json TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_conversation_id TEXT,
  source_workflow_run_id TEXT,
  source_evidence_manifest_id TEXT,
  captured_at INTEGER NOT NULL,
  capture_rationale TEXT,
  model_provider TEXT,
  model_id TEXT,
  model_revision TEXT,
  retention_policy_key TEXT,
  retention_retain_until INTEGER,
  retention_notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_memories_scope ON memories(scope_kind, scope_coordinate);
CREATE INDEX idx_memories_scope_type ON memories(scope_kind, scope_coordinate, type);
CREATE INDEX idx_memories_scope_status ON memories(scope_kind, scope_coordinate, status);
CREATE INDEX idx_memories_pinned ON memories(scope_kind, scope_coordinate) WHERE pinned = 1;
CREATE INDEX idx_memories_valid_until ON memories(valid_until);
CREATE INDEX idx_memories_updated_at ON memories(updated_at);

CREATE TABLE memory_edges (
  id TEXT NOT NULL PRIMARY KEY,
  schema_version TEXT NOT NULL,
  from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confidence REAL,
  provenance_summary TEXT
) STRICT;

CREATE INDEX idx_edges_from ON memory_edges(from_memory_id, kind);
CREATE INDEX idx_edges_to ON memory_edges(to_memory_id, kind);

CREATE TABLE memory_embeddings (
  memory_id TEXT NOT NULL PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT,
  vector_dimensions INTEGER NOT NULL,
  vector_metric TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE memory_tombstones (
  id TEXT NOT NULL PRIMARY KEY,
  memory_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_coordinate TEXT NOT NULL,
  type TEXT NOT NULL,
  forgotten_at INTEGER NOT NULL,
  forgetter_surface TEXT NOT NULL,
  reason TEXT
) STRICT;

CREATE INDEX idx_tombstones_scope ON memory_tombstones(scope_kind, scope_coordinate);
CREATE INDEX idx_tombstones_memory_id ON memory_tombstones(memory_id);
`;

const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: V1_SQL }];

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function setUserVersion(db: DatabaseSync, v: number): void {
  // user_version cannot be parameter-bound. `v` is a hard-coded integer from MIGRATIONS, never
  // caller-supplied, so string interpolation here is not an injection surface.
  db.exec(`PRAGMA user_version = ${String(v)}`);
}

export function runMigrations(db: DatabaseSync): void {
  const start = currentUserVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > start);
  if (pending.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const m of pending) {
      db.exec(m.sql);
      setUserVersion(db, m.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
