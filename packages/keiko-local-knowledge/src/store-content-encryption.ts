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

interface DocumentTextSweepRow {
  readonly rowid: number;
  readonly normalized_text: string;
}

// Seals every TEXT content row that is not already sealed. Idempotent via cipher.isSealed, so a
// re-run after an interrupted migration only seals the rows it has not reached yet.
function sealTextColumn(db: DatabaseSync, table: string, cipher: StoreContentCipher): void {
  const rows = db
    .prepare(`SELECT rowid AS rowid, normalized_text FROM ${table}`)
    .all() as unknown as readonly DocumentTextSweepRow[] | undefined;
  if (rows === undefined) return;
  const update = db.prepare(`UPDATE ${table} SET normalized_text = :t WHERE rowid = :id`);
  for (const row of rows) {
    if (cipher.isSealed(row.normalized_text)) continue;
    update.run({ t: cipher.sealText(row.normalized_text), id: row.rowid });
  }
}

interface VectorSweepRow {
  readonly id: string;
  readonly embedding: Uint8Array;
  readonly vector_dimensions: number;
}

// Seals every plaintext embedding BLOB. A stored blob whose byte length equals dimensions * 4 is
// legacy plaintext (Float32 packed) and is sealed; a longer blob is already a sealed envelope and is
// left untouched, so the sweep is idempotent.
function sealVectorColumn(db: DatabaseSync, cipher: StoreContentCipher): void {
  const rows = db
    .prepare("SELECT id, embedding, vector_dimensions FROM vectors")
    .all() as unknown as readonly VectorSweepRow[] | undefined;
  if (rows === undefined) return;
  const update = db.prepare("UPDATE vectors SET embedding = :e WHERE id = :id");
  for (const row of rows) {
    const plaintextByteLength = row.vector_dimensions * BYTES_PER_FLOAT32;
    if (row.embedding.byteLength !== plaintextByteLength) continue;
    update.run({ e: cipher.sealVector(row.embedding), id: row.id });
  }
}

function migrateToEncrypted(db: DatabaseSync, cipher: StoreContentCipher): void {
  db.exec("BEGIN");
  try {
    sealTextColumn(db, "document_texts", cipher);
    sealTextColumn(db, "document_text_windows", cipher);
    sealVectorColumn(db, cipher);
    writeSchemaMeta(db, ENCRYPTION_PROBE_KEY, cipher.sealText(ENCRYPTION_PROBE_PLAINTEXT));
    writeSchemaMeta(db, ENCRYPTION_MARKER_KEY, ENCRYPTION_MARKER_VALUE);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new KnowledgeStoreError(
      "failed to migrate Local Knowledge store content to encrypted storage",
      { cause },
    );
  }
  // After the in-place UPDATEs, plaintext can linger in the WAL and on freed pages. Truncate the WAL
  // and VACUUM so the rewritten file holds no plaintext extracted text or vector bytes (ADR-0047 D4).
  // These run outside the transaction; VACUUM cannot run inside one.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
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
