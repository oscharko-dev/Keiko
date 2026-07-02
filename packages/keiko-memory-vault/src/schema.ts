// Memory vault schema V1. Forward-only migration runner keyed off PRAGMA user_version, applied
// inside a single transaction so a partial failure leaves user_version unchanged. STRICT tables
// pin the column types at runtime so SQLite cannot silently coerce a wrong-shape insert.
//
// Index strategy:
//   - (scope_kind, scope_coordinate)               for the canonical scoped list (#206 AC)
//   - (scope_kind, scope_coordinate, created_at)   for bounded retrieval scans (#210)
//   - (scope_kind, scope_coordinate, type|status) for the common filter combinations
//   - pinned partial index                         for "list pinned in scope X"
//   - valid_until                                  for the consolidation sweep (#208)
//   - updated_at                                   for the "recently changed" surface
//   - edges from/to and created_at                 for graph traversal (#210)
//   - tombstones scope                             for the forgetting audit surface (#214)
//
// `provenance_*` columns are denormalised onto `memories` so a single SELECT can answer
// "give me this memory plus its capture lineage" without joining a sidecar table. The structural
// payload is JSON-encoded into `payload_json` because storing it as a normalised table would
// require a schema change every time a payload kind landed (#205 ships only two kinds today).

import type { DatabaseSync } from "node:sqlite";
import type { MemoryContentCipher } from "./cipher.js";
import { encryptExistingContent } from "./migrate-encrypt.js";

// v2 = encryption-at-rest (ADR-0035). v1 stored content columns in plaintext; v2 seals them via an
// eager code sweep (no column changes). The bump is one-way: a v2 DB is unreadable by v1 code.
// v3 = access tracking (#204). Adds the `memory_access` counter table that feeds the decay /
// reinforcement maintenance cycle. The table holds ONLY counters + timestamps (no memory
// content), so it stays CLEARTEXT — the cipher is never applied to it.
// v4 = tombstone provenance hardening (#209). Adds reviewer_id and original_status to deletion
// tombstones so audit consumers can distinguish who initiated deletion and what lifecycle state
// was removed without storing memory body content.
// v5 = retrieval-path performance indexes (#210). Adds additive composite indexes matching the
// scoped retrieval ORDER BY and per-memory edge ORDER BY shapes; no data rewrite.
// v6 = outcome-driven forgetting (#204, O-V1). Adds two counters to memory_access — outcome_count
// and utility_sum — recording governed retention OUTCOMES (a proposal accepted/rejected, a conflict
// won/lost, an accepted correction superseding its origin). The maintenance strength model folds
// their mean into a utility factor so proven-useful memories resist disuse-forgetting and proven-bad
// ones fade sooner. Counters only (no content) => the table stays CLEARTEXT. Additive: the columns
// default 0, which yields a neutral factor of 1, so the strength model is byte-identical until a
// real outcome lands.
// v7 = forget suppression fingerprint. Adds body_hash to tombstones so the capture boundary can
// suppress re-capture of the same canonical body without storing deleted body text.
// v8 = embedding identity index. Adds an additive model/provider/revision/metric/dimension index so
// re-embedding scans can detect compatible rows without touching sealed vector blobs.
export const MEMORY_VAULT_SCHEMA_VERSION = 8;

const ENCRYPTION_VERSION = 2;

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
CREATE INDEX idx_memories_scope_created ON memories(scope_kind, scope_coordinate, created_at DESC);
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
CREATE INDEX idx_edges_from_created ON memory_edges(from_memory_id, created_at ASC);
CREATE INDEX idx_edges_to_created ON memory_edges(to_memory_id, created_at ASC);

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

// v3 access-tracking table. STRICT pins the column types; ON DELETE CASCADE removes the access
// row when its memory is hard-deleted (FK enforcement is enabled via PRAGMA foreign_keys = ON in
// db.ts). No content column => no cipher. The index on last_accessed_at supports a future
// "least-recently-touched" sweep without scanning the whole table.
const V3_SQL = `
CREATE TABLE memory_access (
  memory_id TEXT NOT NULL PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_memory_access_last ON memory_access(last_accessed_at);
`;

const V4_SQL = `
ALTER TABLE memory_tombstones ADD COLUMN reviewer_id TEXT;
ALTER TABLE memory_tombstones ADD COLUMN original_status TEXT;
`;

const V5_SQL = `
CREATE INDEX IF NOT EXISTS idx_memories_scope_created
  ON memories(scope_kind, scope_coordinate, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edges_from_created
  ON memory_edges(from_memory_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_edges_to_created
  ON memory_edges(to_memory_id, created_at ASC);
`;

// v6 outcome counters on the existing access table (#204, O-V1). STRICT-compatible ALTERs with a
// constant DEFAULT, so the rewrite is metadata-only and every pre-existing row reads 0/0 (neutral
// utility factor). No content column => the table stays CLEARTEXT, like the rest of memory_access.
const V6_SQL = `
ALTER TABLE memory_access ADD COLUMN outcome_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_access ADD COLUMN utility_sum REAL NOT NULL DEFAULT 0;
`;

const V7_SQL = `
ALTER TABLE memory_tombstones ADD COLUMN body_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_tombstones_scope_body_hash
  ON memory_tombstones(scope_kind, scope_coordinate, body_hash)
  WHERE body_hash IS NOT NULL;
`;

const V8_SQL = `
CREATE INDEX IF NOT EXISTS idx_embeddings_identity
  ON memory_embeddings(provider, model_id, model_revision, vector_metric, vector_dimensions);
`;

const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 3, sql: V3_SQL },
  { version: 4, sql: V4_SQL },
  { version: 5, sql: V5_SQL },
  { version: 6, sql: V6_SQL },
  { version: 7, sql: V7_SQL },
  { version: 8, sql: V8_SQL },
];

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function setUserVersion(db: DatabaseSync, v: number): void {
  // user_version cannot be parameter-bound. `v` is a hard-coded integer from MIGRATIONS, never
  // caller-supplied, so string interpolation here is not an injection surface.
  db.exec(`PRAGMA user_version = ${String(v)}`);
}

export function runMigrations(db: DatabaseSync, cipher: MemoryContentCipher): void {
  const start = currentUserVersion(db);
  if (start > MEMORY_VAULT_SCHEMA_VERSION) {
    throw new Error(
      `Memory vault schema version ${String(start)} is newer than this binary supports (${String(
        MEMORY_VAULT_SCHEMA_VERSION,
      )}).`,
    );
  }
  const pendingDdl = MIGRATIONS.filter((m) => m.version > start);
  const needsEncryption = start < ENCRYPTION_VERSION;
  if (pendingDdl.length === 0 && !needsEncryption) return;
  // An EXISTING (already-created) DB crossing into the encryption version had plaintext on disk;
  // its superseded pages must be purged from the WAL so the plaintext does not linger after upgrade.
  const upgradedExistingDb = start > 0 && needsEncryption;
  db.exec("BEGIN");
  try {
    for (const m of pendingDdl) {
      db.exec(m.sql);
      setUserVersion(db, m.version);
    }
    if (needsEncryption) {
      // Idempotent: skips values already sealed, so a fresh DB (no rows) and a re-run are no-ops.
      // The encryption sweep is keyed to ENCRYPTION_VERSION (2) but is NOT a user_version write:
      // post-v2 migrations (v3+) own the version. Setting the version is deferred to the line below
      // so encryption never regresses a DB that already applied a later DDL migration.
      encryptExistingContent(db, cipher);
    }
    // Pin the final version to the current schema head once every pending DDL and the encryption
    // sweep have run. A fresh DB applies v1 + later DDL and the encryption sweep, then lands on
    // the current schema head; older encrypted DBs apply only the later DDL they missed.
    setUserVersion(db, MEMORY_VAULT_SCHEMA_VERSION);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (upgradedExistingDb) {
    // Outside the transaction (checkpoint cannot run inside one): truncate the WAL so pages that
    // held the now-re-encrypted plaintext are reclaimed immediately, not at the next close.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}
