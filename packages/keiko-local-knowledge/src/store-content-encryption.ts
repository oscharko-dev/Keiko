// Content-encryption lifecycle for the Local Knowledge capsule store (Issue #1322, Epic #1319;
// ADR-0047 D4). Runs once at store-open, AFTER the schema migrations and BEFORE any content read.
//
// Case matrix (marker in schema_meta records that a store is encrypted):
//
//   marker present, opened WITH a key provider     → verify the sealed probe (fail-closed on a wrong
//                                                     key / tampered probe), then proceed.
//   marker present, opened WITHOUT a key provider   → throw: the store is encrypted, a key is required.
//   marker absent,  opened WITHOUT a key provider   → plaintext store opened plaintext: no-op.
//   marker absent,  opened WITH a key provider      → forward migration: seal every plaintext content
//                                                     row, write the probe, set the marker, then flush
//                                                     plaintext from the WAL and freelist.
//
// The migration is crash-aware and idempotent: it is wrapped in a transaction and gated on the marker,
// so an interrupted run simply re-runs on the next open (re-sealing is skipped for already-sealed rows).

import type { DatabaseSync } from "node:sqlite";

import { KnowledgeStoreError } from "./errors.js";
import type { StoreContentCipher } from "./store-content-cipher.js";

const ENCRYPTION_MARKER_KEY = "content_encryption";
const ENCRYPTION_MARKER_VALUE = "aes-256-gcm/v1";
const ENCRYPTION_PROBE_KEY = "content_encryption_probe";
// Fixed, non-secret sentinel. Sealed at migration time and re-opened on every encrypted open to prove
// the resolved key matches the one the store was sealed with. Never carries customer content.
const ENCRYPTION_PROBE_PLAINTEXT = "keiko-local-knowledge-content-encryption-v1";

const BYTES_PER_FLOAT32 = 4;

interface MetaRow {
  readonly value: string;
}

function readSchemaMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = :k").get({ k: key }) as
    | MetaRow
    | undefined;
  return row?.value;
}

function writeSchemaMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (:k, :v)").run({
    k: key,
    v: value,
  });
}

// Collects a table's rowids up front so the seal pass holds at most one row's content in memory at a
// time, and never UPDATEs the table while a SELECT cursor over it is still open (SQLite does not
// guarantee a consistent enumeration in that case). rowids are integers, so the collection is tiny
// relative to the content it gates — the Issue #1286 bounded-memory invariant holds during migration.
function collectRowIds(db: DatabaseSync, table: string): number[] {
  const ids: number[] = [];
  for (const row of db.prepare(`SELECT rowid AS rowid FROM ${table}`).iterate()) {
    ids.push((row as unknown as { readonly rowid: number }).rowid);
  }
  return ids;
}

interface DocumentTextSweepRow {
  readonly normalized_text: string;
}

// Seals every TEXT content row that is not already sealed, one row at a time. Idempotent via
// cipher.isSealed, so a re-run after an interrupted migration only seals the rows it has not reached.
function sealTextColumn(db: DatabaseSync, table: string, cipher: StoreContentCipher): void {
  const select = db.prepare(`SELECT normalized_text FROM ${table} WHERE rowid = :id`);
  const update = db.prepare(`UPDATE ${table} SET normalized_text = :t WHERE rowid = :id`);
  for (const id of collectRowIds(db, table)) {
    const row = select.get({ id }) as DocumentTextSweepRow | undefined;
    if (row === undefined || cipher.isSealed(row.normalized_text)) continue;
    update.run({ t: cipher.sealText(row.normalized_text), id });
  }
}

interface VectorSweepRow {
  readonly embedding: Uint8Array;
  readonly vector_dimensions: number;
}

// Seals every plaintext embedding BLOB, one row at a time. A stored blob whose byte length equals
// dimensions * 4 is legacy plaintext (Float32 packed) and is sealed; a longer blob is already a sealed
// envelope and is left untouched, so the sweep is idempotent.
function sealVectorColumn(db: DatabaseSync, cipher: StoreContentCipher): void {
  const select = db.prepare("SELECT embedding, vector_dimensions FROM vectors WHERE rowid = :id");
  const update = db.prepare("UPDATE vectors SET embedding = :e WHERE rowid = :id");
  for (const id of collectRowIds(db, "vectors")) {
    const row = select.get({ id }) as VectorSweepRow | undefined;
    if (row === undefined) continue;
    if (row.embedding.byteLength !== row.vector_dimensions * BYTES_PER_FLOAT32) continue;
    update.run({ e: cipher.sealVector(row.embedding), id });
  }
}

function migrateToEncrypted(db: DatabaseSync, cipher: StoreContentCipher): void {
  // Phase 1 (transactional): seal every content row and write the sealed key-verification probe. The
  // completion MARKER is deliberately NOT written here — see phase 2.
  db.exec("BEGIN");
  try {
    sealTextColumn(db, "document_texts", cipher);
    sealTextColumn(db, "document_text_windows", cipher);
    sealVectorColumn(db, cipher);
    writeSchemaMeta(db, ENCRYPTION_PROBE_KEY, cipher.sealText(ENCRYPTION_PROBE_PLAINTEXT));
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new KnowledgeStoreError(
      "failed to migrate Local Knowledge store content to encrypted storage",
      { cause },
    );
  }
  // Phase 2: after the in-place UPDATEs, plaintext can linger in the WAL and on freed pages. Truncate
  // the WAL and VACUUM so the rewritten file holds no plaintext extracted text or vector bytes
  // (ADR-0047 D4). These run outside the transaction; VACUUM cannot run inside one.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  // Phase 3: mark the store encrypted ONLY after the file has been rewritten free of plaintext. If
  // phase 2 throws (I/O error, disk full), the marker stays unset, this open fails closed, and the
  // next open re-runs the idempotent migration instead of skipping it over a WAL that still holds
  // plaintext. The seal sweep is a no-op on the already-sealed rows, so the retry only re-checkpoints
  // and re-VACUUMs.
  writeSchemaMeta(db, ENCRYPTION_MARKER_KEY, ENCRYPTION_MARKER_VALUE);
}

function verifyProbe(db: DatabaseSync, cipher: StoreContentCipher): void {
  const probe = readSchemaMeta(db, ENCRYPTION_PROBE_KEY);
  if (probe === undefined || !cipher.isSealed(probe)) {
    throw new KnowledgeStoreError(
      "encrypted Local Knowledge store is missing or has a malformed key-verification probe " +
        "(corrupt store or incomplete migration)",
    );
  }
  let opened: string;
  try {
    opened = cipher.openText(probe);
  } catch (cause) {
    throw new KnowledgeStoreError(
      "cannot open encrypted Local Knowledge store: wrong key or tampered content",
      { cause },
    );
  }
  if (opened !== ENCRYPTION_PROBE_PLAINTEXT) {
    throw new KnowledgeStoreError(
      "cannot open encrypted Local Knowledge store: key-verification probe mismatch",
    );
  }
}

// Reconciles the store's on-disk encryption state with the resolved cipher. Called once from
// openKnowledgeStore after migrations and before the handle is returned.
export function applyStoreContentEncryption(db: DatabaseSync, cipher: StoreContentCipher): void {
  const marker = readSchemaMeta(db, ENCRYPTION_MARKER_KEY);
  if (marker !== undefined) {
    if (!cipher.isEncrypted) {
      throw new KnowledgeStoreError(
        "this Local Knowledge store is encrypted; a key provider is required to open it",
      );
    }
    verifyProbe(db, cipher);
    return;
  }
  if (!cipher.isEncrypted) return;
  migrateToEncrypted(db, cipher);
}

export const STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS = {
  markerKey: ENCRYPTION_MARKER_KEY,
  markerValue: ENCRYPTION_MARKER_VALUE,
  probeKey: ENCRYPTION_PROBE_KEY,
  probePlaintext: ENCRYPTION_PROBE_PLAINTEXT,
} as const;
