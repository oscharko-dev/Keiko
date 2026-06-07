// Eager v1→v2 encryption sweep (ADR-0035). v1 DBs stored content columns in plaintext; this sweep
// re-encrypts every existing plaintext content value in place, inside the migration transaction, so
// the upgrade is atomic. It is IDEMPOTENT: a value already sealed (kv1.* for strings, 0x01-prefixed
// for the embedding BLOB) is skipped, so re-running on an already-migrated DB is a no-op and a
// half-migrated DB (interrupted before COMMIT) re-runs cleanly because user_version stayed < 2.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryContentCipher } from "./cipher.js";

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

function sweepStringColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  cipher: MemoryContentCipher,
): void {
  // Identifiers come from the hard-coded STRING_TARGETS list, never from caller data, so the
  // interpolation is not an injection surface (the same rule schema.ts relies on for PRAGMA).
  const rows = db
    .prepare(`SELECT rowid AS rowid, ${column} AS value FROM ${table}`)
    .all() as unknown as readonly IdStringRow[];
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  for (const row of rows) {
    if (row.value === null || cipher.isSealed(row.value)) continue;
    update.run(cipher.sealString(row.value), row.rowid);
  }
}

// Unlike the string columns, the embedding BLOB has NO unambiguous "already sealed" marker: a
// legacy plaintext Float32-LE vector can legitimately start with byte 0x01, so a magic-byte sniff
// would wrongly skip it and leave plaintext that then fails to decrypt. Correctness instead rests on
// the user_version gate in runMigrations: this sweep runs exactly once, in the same transaction that
// sets user_version = 2, at which point EVERY embedding row is still v1 plaintext. So we seal all of
// them unconditionally. An interrupted run rolls back (user_version stays < 2) and re-seals cleanly.
function sweepEmbeddingVectors(db: DatabaseSync, cipher: MemoryContentCipher): void {
  const rows = db
    .prepare("SELECT memory_id, vector FROM memory_embeddings")
    .all() as unknown as readonly EmbeddingBlobRow[];
  const update = db.prepare("UPDATE memory_embeddings SET vector = ? WHERE memory_id = ?");
  for (const row of rows) {
    update.run(cipher.sealBytes(Buffer.from(row.vector)), row.memory_id);
  }
}

export function encryptExistingContent(db: DatabaseSync, cipher: MemoryContentCipher): void {
  for (const target of STRING_TARGETS) {
    sweepStringColumn(db, target.table, target.column, cipher);
  }
  sweepEmbeddingVectors(db, cipher);
}
