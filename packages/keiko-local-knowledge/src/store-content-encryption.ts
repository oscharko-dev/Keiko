// Content-encryption lifecycle for the Local Knowledge capsule store (Issue #1322, Epic #1319;
// ADR-0047 D4). Runs once at store-open, AFTER the schema migrations and BEFORE any content read.
//
// Case matrix (marker in schema_meta records that a store is encrypted):
//
//   marker present, opened WITH a key provider     → verify the sealed probe (fail-closed on a wrong
//                                                     key / tampered probe), then proceed.
//   marker present, opened WITHOUT a key provider   → throw: the store is encrypted, a key is required.
//   marker absent,  probe present, WITHOUT a key    → throw: incomplete encrypted migration, a key is
//                                                     required.
//   marker absent,  probe present, WITH a key       → verify the existing probe before any mutation,
//                                                     then finish the idempotent migration.
//   marker absent,  probe absent,  opened WITHOUT a key → plaintext store opened plaintext: no-op.
//   marker absent,  opened WITH a key provider      → forward migration: seal every plaintext content
//                                                     row, write the probe, set the marker, then flush
//                                                     plaintext from the WAL and freelist.
//
// The migration is crash-aware and idempotent: it verifies any existing probe before retrying, seals
// only rows that do not authenticate with the current key, and sets the marker only after plaintext
// has been checkpointed and vacuumed away.

import type { DatabaseSync } from "node:sqlite";

import { KnowledgeStoreError } from "./errors.js";
import {
  emitKnowledgeLogEvent,
  knowledgeErrorKind,
  startKnowledgeLogTimer,
  type KnowledgeLogSink,
} from "./knowledge-log.js";
import { sectionPathHashFromJson } from "./section-path-hash.js";
import type { StoreContentCipher } from "./store-content-cipher.js";

// Sentinel `fromScope` reported on a store that had never been encrypted before this migration —
// there is no prior `content_encryption_scope` value to report, and this reads clearly next to
// the real scope-version strings (`ENCRYPTION_SCOPE_VALUE` and its predecessors).
const UNENCRYPTED_SCOPE_LABEL = "plaintext";
// Reported when an already-encrypted store predates the scope-marker key entirely (pre-v2).
const UNSCOPED_ENCRYPTED_SCOPE_LABEL = "unscoped";

const ENCRYPTION_MARKER_KEY = "content_encryption";
const ENCRYPTION_MARKER_VALUE = "aes-256-gcm/v1";
const ENCRYPTION_PROBE_KEY = "content_encryption_probe";
const ENCRYPTION_SCOPE_KEY = "content_encryption_scope";
const ENCRYPTION_SCOPE_VALUE = "reconstructive-columns/v3";
const UPGRADEABLE_ENCRYPTION_SCOPE_VALUES = new Set<string>(["reconstructive-columns/v2"]);
// Fixed, non-secret sentinel. Sealed at migration time and re-opened on every encrypted open to prove
// the resolved key matches the one the store was sealed with. Never carries customer content.
const ENCRYPTION_PROBE_PLAINTEXT = "keiko-local-knowledge-content-encryption-v1";

const BYTES_PER_FLOAT32 = 4;

interface MetaRow {
  readonly value: string;
}

function readSchemaMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = :k").get({ k: key }) as
    MetaRow | undefined;
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

interface TextTarget {
  readonly table: string;
  readonly column: string;
}

const LEGACY_TEXT_TARGETS: readonly TextTarget[] = [
  { table: "document_texts", column: "normalized_text" },
  { table: "document_text_windows", column: "normalized_text" },
  { table: "chunks", column: "context_prefix" },
  { table: "chunks", column: "augmented_text" },
];

// Deliberately excludes chunk_lexical_index.text/exact_text. That table is the FTS5/BM25 search
// projection; SQLite cannot MATCH sealed randomized envelopes, so the schema owns that narrow
// plaintext retrieval-index exception while source-of-truth extracted text remains sealed here.
const PATH_TEXT_TARGETS: readonly TextTarget[] = [
  { table: "sections", column: "section_path_json" },
  { table: "parsed_units", column: "section_path_json" },
  { table: "parsed_units", column: "heading_path_json" },
  { table: "parsed_units", column: "anchor_id" },
];

const TEXT_TARGETS: readonly TextTarget[] = [...LEGACY_TEXT_TARGETS, ...PATH_TEXT_TARGETS];

interface TextSweepRow {
  readonly value: string | null;
}

function isAlreadySealed(cipher: StoreContentCipher, value: string): boolean {
  if (!cipher.isSealed(value)) return false;
  try {
    cipher.openText(value);
    return true;
  } catch {
    return false;
  }
}

function openMaybeSealedText(cipher: StoreContentCipher, value: string): string {
  return cipher.isEncrypted && isAlreadySealed(cipher, value) ? cipher.openText(value) : value;
}

// Seals every TEXT content row that does not authenticate under the current key, one row at a time.
// This intentionally does NOT trust the "kv1." prefix alone: a legacy plaintext value can literally
// start with "kv1.", and must be sealed as plaintext instead of skipped.
function sealTextColumn(db: DatabaseSync, target: TextTarget, cipher: StoreContentCipher): void {
  const select = db.prepare(
    `SELECT ${target.column} AS value FROM ${target.table} WHERE rowid = :id`,
  );
  const update = db.prepare(`UPDATE ${target.table} SET ${target.column} = :t WHERE rowid = :id`);
  for (const id of collectRowIds(db, target.table)) {
    const row = select.get({ id }) as TextSweepRow | undefined;
    const value = row?.value;
    if (value === undefined || value === null || isAlreadySealed(cipher, value)) continue;
    update.run({ t: cipher.sealText(value), id });
  }
}

interface SectionHashRow {
  readonly section_path_json: string;
  readonly section_path_hash: string | null;
}

function ensureSectionPathHashes(db: DatabaseSync, cipher: StoreContentCipher): void {
  const select = db.prepare(
    "SELECT section_path_json, section_path_hash FROM sections WHERE rowid = :id",
  );
  const update = db.prepare("UPDATE sections SET section_path_hash = :h WHERE rowid = :id");
  for (const id of collectRowIds(db, "sections")) {
    const row = select.get({ id }) as SectionHashRow | undefined;
    if (row === undefined) continue;
    const canonicalJson = openMaybeSealedText(cipher, row.section_path_json);
    const hash = sectionPathHashFromJson(canonicalJson);
    if (row.section_path_hash !== hash) update.run({ h: hash, id });
  }
}

function sealTextColumns(db: DatabaseSync, cipher: StoreContentCipher): void {
  for (const target of TEXT_TARGETS) {
    sealTextColumn(db, target, cipher);
  }
}

function sealPathTextColumns(db: DatabaseSync, cipher: StoreContentCipher): void {
  for (const target of PATH_TEXT_TARGETS) {
    sealTextColumn(db, target, cipher);
  }
}

function assertTextColumnSealed(
  db: DatabaseSync,
  target: TextTarget,
  cipher: StoreContentCipher,
): void {
  const select = db.prepare(
    `SELECT ${target.column} AS value FROM ${target.table} WHERE rowid = :id`,
  );
  for (const id of collectRowIds(db, target.table)) {
    const row = select.get({ id }) as TextSweepRow | undefined;
    const value = row?.value;
    if (value === undefined || value === null) continue;
    if (isAlreadySealed(cipher, value)) continue;
    throw new KnowledgeStoreError(
      `encrypted Local Knowledge store contains unsealed ${target.table}.${target.column}`,
    );
  }
}

function assertLegacyTextColumnsSealed(db: DatabaseSync, cipher: StoreContentCipher): void {
  for (const target of LEGACY_TEXT_TARGETS) {
    assertTextColumnSealed(db, target, cipher);
  }
}

function assertVectorOpens(row: VectorSweepRow, cipher: StoreContentCipher): void {
  const plaintextByteLength = row.vector_dimensions * BYTES_PER_FLOAT32;
  try {
    cipher.openVector(row.embedding, plaintextByteLength);
  } catch (cause) {
    throw new KnowledgeStoreError(
      "encrypted Local Knowledge vector row is neither plaintext nor a valid sealed envelope",
      { cause },
    );
  }
}

function sealVectorColumn(db: DatabaseSync, cipher: StoreContentCipher): void {
  const select = db.prepare("SELECT embedding, vector_dimensions FROM vectors WHERE rowid = :id");
  const update = db.prepare("UPDATE vectors SET embedding = :e WHERE rowid = :id");
  for (const id of collectRowIds(db, "vectors")) {
    const row = select.get({ id }) as VectorSweepRow | undefined;
    if (row === undefined) continue;
    if (row.embedding.byteLength === row.vector_dimensions * BYTES_PER_FLOAT32) {
      update.run({ e: cipher.sealVector(row.embedding), id });
      continue;
    }
    assertVectorOpens(row, cipher);
  }
}

interface VectorSweepRow {
  readonly embedding: Uint8Array;
  readonly vector_dimensions: number;
}

interface BlobSweepRow {
  readonly blob_bytes: Uint8Array;
  readonly byte_length: number;
}

function assertBlobOpens(row: BlobSweepRow, cipher: StoreContentCipher): void {
  try {
    const opened = cipher.openBlob(row.blob_bytes);
    if (opened.byteLength !== row.byte_length) {
      throw new KnowledgeStoreError(
        "encrypted Local Knowledge blob content length does not match byte_length",
      );
    }
  } catch (cause) {
    if (cause instanceof KnowledgeStoreError) throw cause;
    throw new KnowledgeStoreError(
      "encrypted Local Knowledge blob row is neither plaintext nor a valid sealed envelope",
      { cause },
    );
  }
}

function sealBlobColumn(db: DatabaseSync, cipher: StoreContentCipher): void {
  const select = db.prepare("SELECT blob_bytes, byte_length FROM document_blobs WHERE rowid = :id");
  const update = db.prepare(
    "UPDATE document_blobs SET blob_bytes = :b, storage_kind = 'sealed', seal_version = 'aes-256-gcm/v1' WHERE rowid = :id",
  );
  for (const id of collectRowIds(db, "document_blobs")) {
    const row = select.get({ id }) as BlobSweepRow | undefined;
    if (row === undefined) continue;
    if (row.blob_bytes.byteLength === row.byte_length) {
      update.run({ b: cipher.sealBlob(row.blob_bytes), id });
      continue;
    }
    assertBlobOpens(row, cipher);
  }
}

function assertVectorColumnSealed(db: DatabaseSync, cipher: StoreContentCipher): void {
  const select = db.prepare("SELECT embedding, vector_dimensions FROM vectors WHERE rowid = :id");
  for (const id of collectRowIds(db, "vectors")) {
    const row = select.get({ id }) as VectorSweepRow | undefined;
    if (row !== undefined) assertVectorOpens(row, cipher);
  }
}

function assertBlobColumnSealed(db: DatabaseSync, cipher: StoreContentCipher): void {
  const select = db.prepare("SELECT blob_bytes, byte_length FROM document_blobs WHERE rowid = :id");
  for (const id of collectRowIds(db, "document_blobs")) {
    const row = select.get({ id }) as BlobSweepRow | undefined;
    if (row !== undefined) assertBlobOpens(row, cipher);
  }
}

function sealReconstructiveContent(db: DatabaseSync, cipher: StoreContentCipher): void {
  ensureSectionPathHashes(db, cipher);
  sealTextColumns(db, cipher);
  sealVectorColumn(db, cipher);
  sealBlobColumn(db, cipher);
}

// The number of times the post-migration WAL TRUNCATE checkpoint is retried when SQLite reports
// `busy=1` (another connection holds an open read/write) or a partial checkpoint (fewer frames
// checkpointed than the WAL holds). Bounded on purpose so a sustained contending reader cannot hang
// the store-open call indefinitely; mirrors keiko-memory-vault's schema.ts retry bound (#2906
// KEIKO-0877).
const WAL_CHECKPOINT_MAX_ATTEMPTS = 3;

interface WalCheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

type WalCheckpointAttempt =
  | { readonly kind: "ok"; readonly result: WalCheckpointResult }
  | { readonly kind: "threw"; readonly cause: unknown }
  // #2906 round-3 review: an undefined row, `{}`, or non-numeric columns must fail closed into the
  // retry/report path rather than being coerced to a trivially-satisfied 0/0/0 result -- otherwise
  // `busy === 0 && checkpointed >= log` is vacuously true and migration can write the encryption
  // marker without a verified WAL truncation. Mirrors keiko-memory-vault's schema.ts "malformed" kind.
  | { readonly kind: "malformed" };

function isWellFormedCheckpointRow(
  row: Partial<WalCheckpointResult> | undefined,
): row is WalCheckpointResult {
  return (
    Number.isInteger(row?.busy) && Number.isInteger(row?.log) && Number.isInteger(row?.checkpointed)
  );
}

// The PRAGMA itself is also a possible failure mode, not only its returned `busy` row: depending on
// the connection's busy-timeout configuration, SQLite can raise SQLITE_BUSY as a thrown error
// instead of returning `{ busy: 1, ... }`. Both are transient-contention shapes and both are retried
// identically below.
function attemptWalCheckpointTruncate(db: DatabaseSync): WalCheckpointAttempt {
  try {
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      Partial<WalCheckpointResult> | undefined;
    if (!isWellFormedCheckpointRow(row)) return { kind: "malformed" };
    return { kind: "ok", result: row };
  } catch (cause) {
    return { kind: "threw", cause };
  }
}

function isCheckpointComplete(attempt: WalCheckpointAttempt): boolean {
  return (
    attempt.kind === "ok" &&
    attempt.result.busy === 0 &&
    attempt.result.checkpointed >= attempt.result.log
  );
}

// #2906 round-3 review: errorKind was previously present only when the PRAGMA itself threw, so the
// two primary new failure modes -- a persistently busy/partial checkpoint and a malformed result
// row -- had no closed, body-free kind to cluster or reconstruct through the structured log
// contract (AGENTS.md §8). Every non-complete outcome now gets one: the real cause's classified
// code/name when the statement threw, and a literal, stable identifier for each of the three
// still-incomplete "ok" shapes otherwise, so busy-exhaustion, a partial flush, and a malformed row
// are distinguishable from each other in the log alone.
function checkpointErrorKind(attempt: WalCheckpointAttempt): string {
  if (attempt.kind === "threw") return knowledgeErrorKind(attempt.cause);
  if (attempt.kind === "malformed") return "checkpoint-malformed";
  return attempt.result.busy === 1 ? "checkpoint-busy" : "checkpoint-partial";
}

function reportCheckpointDegraded(
  logSink: KnowledgeLogSink | undefined,
  attempts: number,
  last: WalCheckpointAttempt,
): void {
  emitKnowledgeLogEvent(logSink, {
    level: "error",
    category: "diagnostic",
    op: "store.encryption-checkpoint-degraded",
    errorKind: checkpointErrorKind(last),
    extra: { attempts, busy: last.kind === "ok" ? last.result.busy === 1 : true },
  });
}

function checkpointDegradedError(last: WalCheckpointAttempt): KnowledgeStoreError {
  const cause =
    last.kind === "malformed"
      ? "the checkpoint returned a missing or non-numeric result row"
      : "a held-open reader prevented a full checkpoint";
  const message =
    "failed to flush plaintext residue from the Local Knowledge store WAL after encrypting " +
    `content: ${cause} after ${String(WAL_CHECKPOINT_MAX_ATTEMPTS)} attempts`;
  return last.kind === "threw"
    ? new KnowledgeStoreError(message, { cause: last.cause })
    : new KnowledgeStoreError(message);
}

// Per ADR-0047 D4, the encryption-scope marker must only be written after this rewrite has fully
// completed. Unlike keiko-memory-vault's sibling flush (#2906 KEIKO-0713: warn-and-continue, because
// its marker had already been committed before that flush runs), this package's callers write the
// marker AFTER flushPlaintextResidue returns -- see migrateToEncrypted's and upgradeEncryptedScope's
// phase-3 comments. So a persistently busy or partial TRUNCATE checkpoint here must fail the whole
// migration CLOSED: throwing leaves the marker unset, and the next store-open retries the idempotent
// migration instead of silently accepting a WAL that may still hold plaintext (AGENTS.md §7 forbids
// swallowing this with an empty catch).
//
// Exported so store-content-encryption.test.ts can exercise the retry/report path directly against
// a fake DatabaseSync, without reconstructing an end-to-end migration timeline. Not part of the
// public package surface -- consumed only by migrateToEncrypted/upgradeEncryptedScope above and by
// co-located tests.
export function flushPlaintextResidue(
  db: DatabaseSync,
  logSink: KnowledgeLogSink | undefined,
): void {
  let last: WalCheckpointAttempt = { kind: "threw", cause: undefined };
  for (let attempt = 1; attempt <= WAL_CHECKPOINT_MAX_ATTEMPTS; attempt += 1) {
    last = attemptWalCheckpointTruncate(db);
    if (isCheckpointComplete(last)) {
      db.exec("VACUUM");
      return;
    }
  }
  reportCheckpointDegraded(logSink, WAL_CHECKPOINT_MAX_ATTEMPTS, last);
  throw checkpointDegradedError(last);
}

// Fires only after the migration function it is called from has ALREADY returned without
// throwing — never inside the transactional try/catch above it, and never for a branch of
// `applyStoreContentEncryption` that migrates nothing (a store already at the current scope).
// `durationMs` rides the envelope's own field, not `extra`, matching every other timed line this
// package writes (`startKnowledgeLogTimer`, ADR-0019 seam).
function logEncryptionMigrated(
  logSink: KnowledgeLogSink | undefined,
  fromScope: string,
  toScope: string,
  durationMs: number,
): void {
  emitKnowledgeLogEvent(logSink, {
    category: "diagnostic",
    op: "store.encryption-migrated",
    durationMs,
    extra: { fromScope, toScope },
  });
}

function migrateToEncrypted(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  logSink?: KnowledgeLogSink,
): void {
  const elapsed = startKnowledgeLogTimer();
  // Phase 1 (transactional): seal every content row and write the sealed key-verification probe. The
  // completion MARKER is deliberately NOT written here — see phase 2.
  db.exec("BEGIN");
  try {
    sealReconstructiveContent(db, cipher);
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
  // the WAL and VACUUM so the rewritten file holds no plaintext extracted text, path labels, or
  // vector bytes (ADR-0047 D4). These run outside the transaction; VACUUM cannot run inside one.
  // Phase 3: mark the store encrypted ONLY after the file has been rewritten free of plaintext. If
  // phase 2 throws (I/O error, disk full), the marker stays unset, this open fails closed, and the
  // next open re-runs the idempotent migration instead of skipping it over a WAL that still holds
  // plaintext. The seal sweep is a no-op on the already-sealed rows, so the retry only re-checkpoints
  // and re-VACUUMs.
  flushPlaintextResidue(db, logSink);
  writeSchemaMeta(db, ENCRYPTION_MARKER_KEY, ENCRYPTION_MARKER_VALUE);
  writeSchemaMeta(db, ENCRYPTION_SCOPE_KEY, ENCRYPTION_SCOPE_VALUE);
  logEncryptionMigrated(logSink, UNENCRYPTED_SCOPE_LABEL, ENCRYPTION_SCOPE_VALUE, elapsed());
}

function upgradeEncryptedScope(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  fromScope: string,
  logSink?: KnowledgeLogSink,
): void {
  const elapsed = startKnowledgeLogTimer();
  db.exec("BEGIN");
  try {
    ensureSectionPathHashes(db, cipher);
    assertLegacyTextColumnsSealed(db, cipher);
    assertVectorColumnSealed(db, cipher);
    sealPathTextColumns(db, cipher);
    sealBlobColumn(db, cipher);
    assertBlobColumnSealed(db, cipher);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new KnowledgeStoreError("failed to upgrade Local Knowledge encrypted-content coverage", {
      cause,
    });
  }
  flushPlaintextResidue(db, logSink);
  writeSchemaMeta(db, ENCRYPTION_SCOPE_KEY, ENCRYPTION_SCOPE_VALUE);
  logEncryptionMigrated(logSink, fromScope, ENCRYPTION_SCOPE_VALUE, elapsed());
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

function assertSupportedEncryptionScope(scope: string | undefined): void {
  if (
    scope === undefined ||
    scope === ENCRYPTION_SCOPE_VALUE ||
    UPGRADEABLE_ENCRYPTION_SCOPE_VALUES.has(scope)
  ) {
    return;
  }
  throw new KnowledgeStoreError(
    `unsupported Local Knowledge content encryption scope marker: ${scope}`,
  );
}

// Reconciles the store's on-disk encryption state with the resolved cipher. Called once from
// openKnowledgeStore after migrations and before the handle is returned.
export function applyStoreContentEncryption(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  logSink?: KnowledgeLogSink,
): void {
  const marker = readSchemaMeta(db, ENCRYPTION_MARKER_KEY);
  const probe = readSchemaMeta(db, ENCRYPTION_PROBE_KEY);
  const scope = readSchemaMeta(db, ENCRYPTION_SCOPE_KEY);
  if (marker !== undefined) {
    if (marker !== ENCRYPTION_MARKER_VALUE) {
      throw new KnowledgeStoreError(
        `unsupported Local Knowledge content encryption marker: ${marker}`,
      );
    }
    if (!cipher.isEncrypted) {
      throw new KnowledgeStoreError(
        "this Local Knowledge store is encrypted; a key provider is required to open it",
      );
    }
    verifyProbe(db, cipher);
    assertSupportedEncryptionScope(scope);
    if (scope !== ENCRYPTION_SCOPE_VALUE) {
      upgradeEncryptedScope(db, cipher, scope ?? UNSCOPED_ENCRYPTED_SCOPE_LABEL, logSink);
    }
    return;
  }
  if (probe !== undefined) {
    if (!cipher.isEncrypted) {
      throw new KnowledgeStoreError(
        "this Local Knowledge store has an incomplete encrypted-content migration; " +
          "a key provider is required to finish opening it",
      );
    }
    verifyProbe(db, cipher);
    migrateToEncrypted(db, cipher, logSink);
    return;
  }
  if (!cipher.isEncrypted) {
    ensureSectionPathHashes(db, cipher);
    return;
  }
  migrateToEncrypted(db, cipher, logSink);
}

export type StoreContentEncryptionMode = "plaintext" | "encrypted" | "migrating";

// Read-only snapshot of the store's on-disk encryption state, independent of any resolved cipher
// and never throwing — used by `computeStoreFingerprint` (store.ts) to report `encryptionMode`
// in the support-bundle manifest (Wave 4a, epic #3233 §6.2) without re-deriving the marker/probe
// schema_meta keys a second time. Mirrors the case matrix documented at the top of this file: a
// malformed marker VALUE is still reported as "encrypted" here — validating it is
// `applyStoreContentEncryption`'s job, not a read-only reporter's.
export function readStoreEncryptionMode(db: DatabaseSync): StoreContentEncryptionMode {
  if (readSchemaMeta(db, ENCRYPTION_MARKER_KEY) !== undefined) return "encrypted";
  return readSchemaMeta(db, ENCRYPTION_PROBE_KEY) !== undefined ? "migrating" : "plaintext";
}

export const STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS = {
  markerKey: ENCRYPTION_MARKER_KEY,
  markerValue: ENCRYPTION_MARKER_VALUE,
  probeKey: ENCRYPTION_PROBE_KEY,
  probePlaintext: ENCRYPTION_PROBE_PLAINTEXT,
  scopeKey: ENCRYPTION_SCOPE_KEY,
  scopeValue: ENCRYPTION_SCOPE_VALUE,
} as const;
