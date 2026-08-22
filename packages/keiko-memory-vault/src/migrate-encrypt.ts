// Eager v1→v2 encryption sweep (ADR-0035). v1 DBs stored content columns in plaintext; this sweep
// re-encrypts every existing plaintext content value in place, inside the migration transaction, so
// the upgrade is atomic. It is IDEMPOTENT: the user_version gate in runMigrations ensures this sweep
// runs at most once (when user_version < ENCRYPTION_VERSION), so a half-migrated DB (interrupted
// before COMMIT) re-runs cleanly because user_version stayed < 2. Each string column is sealed
// unless it is already a genuine envelope (see isAlreadySealed: a try-open, NOT a "kv1." prefix
// sniff — a plaintext value that merely starts with "kv1." must still be encrypted, not skipped).
// That keeps the sweep idempotent for a genuinely sealed value without the prefix false-positive.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryContentCipher } from "./cipher.js";
import {
  emitMemoryVaultLogEvent,
  startMemoryVaultLogTimer,
  type MemoryVaultLogSink,
} from "./vault-log.js";

interface IdStringRow {
  readonly rowid: number;
  readonly value: string | null;
}

interface EmbeddingBlobRow {
  readonly memory_id: string;
  readonly vector: Uint8Array;
}

// (table, column) pairs whose TEXT values are sealed as kv1 string envelopes.
const STRING_TARGETS: readonly { readonly table: string; readonly column: string }[] = [
  { table: "memories", column: "body" },
  { table: "memories", column: "payload_json" },
  { table: "memories", column: "tags_json" },
  { table: "memories", column: "capture_rationale" },
  { table: "memories", column: "stale_reason" },
  { table: "memory_edges", column: "provenance_summary" },
  { table: "memory_tombstones", column: "reason" },
];

// A value is "already sealed" only if it actually AES-GCM-opens. The "kv1." prefix alone is
// ambiguous — a legacy plaintext body can literally start with "kv1." (see KV1_PREFIX_BODY in the
// tests); a prefix sniff would wrongly skip it, leave it as plaintext, and crash on the next read.
// A genuine envelope opens cleanly; a "kv1."-prefixed plaintext throws. This keeps the sweep
// idempotent (a genuinely sealed value — e.g. from an interrupted or mixed migration — is skipped
// rather than double-sealed) without the prefix false-positive.
function isAlreadySealed(cipher: MemoryContentCipher, value: string): boolean {
  if (!cipher.isSealed(value)) return false;
  try {
    cipher.openString(value);
    return true;
  } catch {
    return false;
  }
}

// Returns the count of rows actually sealed in THIS call (rows that were plaintext and are now
// sealed) — never rows merely visited. This is the signal `encryptExistingContent` uses to decide
// whether a `store.encryption-migrated` event describes a real transition: a fresh, empty table
// (every column skipped as "already sealed" trivially, zero rows) and a re-run against an
// already-encrypted DB (every row already sealed) both correctly report zero.
function sweepStringColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  cipher: MemoryContentCipher,
): number {
  // Identifiers come from the hard-coded STRING_TARGETS list, never from caller data, so the
  // interpolation is not an injection surface (the same rule schema.ts relies on for PRAGMA).
  const rows = db
    .prepare(`SELECT rowid AS rowid, ${column} AS value FROM ${table}`)
    .all() as unknown as readonly IdStringRow[];
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  let sealed = 0;
  for (const row of rows) {
    if (row.value === null || isAlreadySealed(cipher, row.value)) continue;
    update.run(cipher.sealString(row.value), row.rowid);
    sealed += 1;
  }
  return sealed;
}

// Unlike the string columns, the embedding BLOB has NO unambiguous "already sealed" marker: a
// legacy plaintext Float32-LE vector can legitimately start with byte 0x01, so a magic-byte sniff
// would wrongly skip it and leave plaintext that then fails to decrypt. Correctness instead rests on
// the user_version gate in runMigrations: this sweep runs exactly once, in the same transaction that
// sets user_version = 2, at which point EVERY embedding row is still v1 plaintext. So we seal all of
// them unconditionally — meaning the row count IS the sealed count — and an interrupted run rolls
// back (user_version stays < 2) and re-seals cleanly.
function sweepEmbeddingVectors(db: DatabaseSync, cipher: MemoryContentCipher): number {
  const rows = db
    .prepare("SELECT memory_id, vector FROM memory_embeddings")
    .all() as unknown as readonly EmbeddingBlobRow[];
  const update = db.prepare("UPDATE memory_embeddings SET vector = ? WHERE memory_id = ?");
  for (const row of rows) {
    update.run(cipher.sealBytes(Buffer.from(row.vector)), row.memory_id);
  }
  return rows.length;
}

/**
 * Emits `store.encryption-migrated` for a genuine transition (`rowsMigrated > 0`); a no-op
 * otherwise. Exported so `schema.ts`'s `runMigrations` can call it AFTER its own transaction
 * commits (see that file): the sweep runs inside `BEGIN`/`COMMIT` and can still roll back, so
 * emitting from inside the sweep itself — as this package used to — could log a migration that
 * never actually committed.
 */
export function emitEncryptionMigrated(
  sink: MemoryVaultLogSink | undefined,
  rowsMigrated: number,
  durationMs: number,
): void {
  if (rowsMigrated <= 0) return;
  emitMemoryVaultLogEvent(sink, {
    // "diagnostic", matching the same op emitted by Local Knowledge's
    // `store-content-encryption.ts` for the identical event — one shared op name should carry one
    // shared category so an analyzer grouping by (category, op) sees one cluster, not two.
    category: "diagnostic",
    op: "store.encryption-migrated",
    durationMs,
    extra: { fromScope: "plaintext", toScope: "encrypted", rowsMigrated },
  });
}

/**
 * Eager v1→v2 encryption sweep (see file header), WITHOUT emitting: the row rewrite is the only
 * effect, and the count of rows actually re-sealed (never rows merely visited) is returned so a
 * caller can decide, on its own success, whether and when to report it. `schema.ts`'s
 * `runMigrations` calls this (never `encryptExistingContent` below) from inside its migration
 * transaction, then calls `emitEncryptionMigrated` itself only after `COMMIT` succeeds.
 */
export function sweepExistingContent(db: DatabaseSync, cipher: MemoryContentCipher): number {
  let rowsMigrated = 0;
  for (const target of STRING_TARGETS) {
    rowsMigrated += sweepStringColumn(db, target.table, target.column, cipher);
  }
  rowsMigrated += sweepEmbeddingVectors(db, cipher);
  return rowsMigrated;
}

/**
 * Convenience wrapper over {@link sweepExistingContent} that also emits
 * `store.encryption-migrated` itself, timed around the sweep. `sink` is optional (ADR-0019 — this
 * package declares its own `MemoryVaultLogSink` port rather than importing the server's logger).
 * Kept for callers that sweep OUTSIDE a transaction they do not otherwise control (this package's
 * own direct tests); `schema.ts`'s `runMigrations` does NOT use this — see {@link sweepExistingContent}.
 */
export function encryptExistingContent(
  db: DatabaseSync,
  cipher: MemoryContentCipher,
  sink?: MemoryVaultLogSink,
): void {
  const elapsedMs = startMemoryVaultLogTimer();
  const rowsMigrated = sweepExistingContent(db, cipher);
  emitEncryptionMigrated(sink, rowsMigrated, elapsedMs());
}
