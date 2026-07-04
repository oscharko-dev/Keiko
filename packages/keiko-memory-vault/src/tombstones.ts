// Prepared SQL for the memory_tombstones table. Tombstones are intentionally NOT a foreign key
// against memories.id — the memory row is gone by the time the tombstone is written; the FK
// would either reject the insert or force ON DELETE SET NULL, both of which lose the audit
// signal. We therefore store memory_id as a denormalised TEXT column and accept that listing a
// tombstone tells you "this id existed in this scope at this time," not "follow the FK."

import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryId,
  MemoryReviewerId,
  MemoryScope,
  MemoryScopeKind,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";
import type { MemoryTombstone } from "./types.js";
import type { MemoryContentCipher } from "./cipher.js";
import { cachedPrepare } from "./statements.js";
import { sanitizeMemoryTombstoneReason } from "./tombstone-reason.js";
import { BYTES_PER_FLOAT32, decodeVectorLE, encodeVectorLE } from "./embeddings.js";

interface TombstoneRow {
  readonly id: string;
  readonly memory_id: string;
  readonly scope_kind: string;
  readonly scope_coordinate: string;
  readonly type: string;
  readonly forgotten_at: number;
  readonly forgetter_surface: string;
  readonly body_hash: string | null;
  readonly reviewer_id: string | null;
  readonly original_status: string | null;
  readonly reason: string | null;
  readonly body_embedding: Uint8Array | null;
}

const INSERT_SQL = `
INSERT INTO memory_tombstones (
  id, memory_id, scope_kind, scope_coordinate, type, forgotten_at,
  forgetter_surface, body_hash, reviewer_id, original_status, reason, body_embedding
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`;

// Forget-tombstone rows whose body_embedding is present, scoped for the semantic suppression scan
// (GEN-AI-MEMORY-003, RB-4). Selects only the sealed vector column so the cosine sweep never touches
// the (irrelevant here) reason/body_hash columns.
const LIST_FORGET_VECTORS_BY_SCOPE_SQL = `
SELECT body_embedding FROM memory_tombstones
WHERE scope_kind = ? AND scope_coordinate = ? AND body_embedding IS NOT NULL
`;

const LIST_BY_SCOPE_SQL = `
SELECT * FROM memory_tombstones
WHERE scope_kind = ? AND scope_coordinate = ?
ORDER BY forgotten_at ASC
`;

const DELETE_BY_SCOPE_BEFORE_SQL = `
DELETE FROM memory_tombstones
WHERE scope_kind = ? AND scope_coordinate = ? AND forgotten_at < ?
`;

const UPDATE_BODY_HASH_BY_SCOPE_SQL = `
UPDATE memory_tombstones
SET body_hash = ?
WHERE scope_kind = ? AND scope_coordinate = ? AND body_hash = ?
`;

// GEN-PERF-PERSISTENCE-014 — the forget-suppression check only needs to know whether a tombstone
// exists for the current OR legacy body-hash in the scope; it never needs the (sealed) reason. This
// query selects only body_hash for rows matching either candidate hash, so the suppression path
// performs ZERO reason decrypts and reads at most a couple of rows instead of the whole scope. Both
// candidate hashes are always bound (never NULL — the suppression hashes are deterministic), so the
// `IN (?, ?)` predicate stays index-eligible and matches nothing extra.
const SELECT_SUPPRESSION_BODY_HASHES_BY_SCOPE_SQL = `
SELECT body_hash FROM memory_tombstones
WHERE scope_kind = ? AND scope_coordinate = ? AND body_hash IN (?, ?)
`;

// `reason` is the only free-text tombstone column, so it is the only sealed one (ADR-0035).
function rowToTombstone(row: TombstoneRow, cipher: MemoryContentCipher): MemoryTombstone {
  const reason =
    row.reason === null ? undefined : sanitizeMemoryTombstoneReason(cipher.openString(row.reason));
  const base = {
    id: row.id,
    memoryId: row.memory_id as MemoryId,
    scopeKind: row.scope_kind as MemoryScopeKind,
    scopeCoordinate: row.scope_coordinate,
    type: row.type as MemoryType,
    forgottenAt: row.forgotten_at,
    forgetterSurface: row.forgetter_surface,
  };
  return {
    ...base,
    ...(row.body_hash === null ? {} : { bodyHash: row.body_hash }),
    ...(row.reviewer_id === null ? {} : { reviewerId: row.reviewer_id as MemoryReviewerId }),
    ...(row.original_status === null
      ? {}
      : { originalStatus: row.original_status as MemoryStatus }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function insertTombstoneRow(
  db: DatabaseSync,
  tombstone: MemoryTombstone,
  cipher: MemoryContentCipher,
  bodyEmbedding?: Float32Array,
): void {
  const safeReason = sanitizeMemoryTombstoneReason(tombstone.reason);
  const reason = safeReason === undefined ? null : cipher.sealString(safeReason);
  // The forgotten body's embedding is memory CONTENT (ADR-0035), so it is sealed like the memory
  // vector column before it touches the BLOB — never the raw phrase, only a lossy vector (AUDIT-
  // MEMSEC-001/-002: no plaintext body ever lands in a tombstone row).
  const sealedEmbedding =
    bodyEmbedding === undefined ? null : cipher.sealBytes(encodeVectorLE(bodyEmbedding));
  cachedPrepare(db, INSERT_SQL).run(
    tombstone.id,
    tombstone.memoryId,
    tombstone.scopeKind,
    tombstone.scopeCoordinate,
    tombstone.type,
    tombstone.forgottenAt,
    tombstone.forgetterSurface,
    tombstone.bodyHash ?? null,
    tombstone.reviewerId ?? null,
    tombstone.originalStatus ?? null,
    reason,
    sealedEmbedding,
  );
}

// Decodes one sealed tombstone embedding BLOB back to a Float32Array. Dimensions are derived from
// the decrypted byte length (not stored separately) since the tombstone table has no companion
// vector_dimensions column — the vault's only forget-tombstone consumer is the cosine sweep, which
// needs no other embedding identity metadata.
function decodeSealedTombstoneVector(
  sealed: Uint8Array,
  cipher: MemoryContentCipher,
): Float32Array {
  const plain = cipher.openBytes(Buffer.from(sealed));
  return decodeVectorLE(plain, plain.byteLength / BYTES_PER_FLOAT32);
}

// Forget-tombstone embeddings for a scope (GEN-AI-MEMORY-003, RB-4). Used to suppress a semantic
// paraphrase of a forgotten memory at capture time, even though its body_hash differs from the
// exact-match fingerprint. Tombstones written before v10 (or written without an embedder configured)
// have a NULL body_embedding and are skipped rather than failing the scan.
export function listForgetTombstoneVectors(
  db: DatabaseSync,
  scope: MemoryScope,
  cipher: MemoryContentCipher,
): readonly Float32Array[] {
  const rows = cachedPrepare(db, LIST_FORGET_VECTORS_BY_SCOPE_SQL).all(
    scopeKindOf(scope),
    scopeCoordinateOf(scope),
  ) as unknown as readonly { readonly body_embedding: Uint8Array | null }[];
  const vectors: Float32Array[] = [];
  for (const row of rows) {
    if (row.body_embedding === null) continue;
    vectors.push(decodeSealedTombstoneVector(row.body_embedding, cipher));
  }
  return vectors;
}

export function listTombstonesByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  cipher: MemoryContentCipher,
): readonly MemoryTombstone[] {
  const rows = cachedPrepare(db, LIST_BY_SCOPE_SQL).all(
    scopeKindOf(scope),
    scopeCoordinateOf(scope),
  ) as unknown as readonly TombstoneRow[];
  return rows.map((row) => rowToTombstone(row, cipher));
}

/**
 * Forget-suppression body-hash presence check (GEN-PERF-PERSISTENCE-014). Returns whether a
 * tombstone with the CURRENT and/or the LEGACY suppression hash exists in the scope, WITHOUT
 * decrypting any tombstone reason. This is the fast path for `hasForgetTombstoneForBody`: the exact
 * bodyHash comparison result is identical to scanning every tombstone, but no sealed column is
 * opened, which both removes the per-candidate decrypt cost and strengthens confidentiality (the
 * reason never leaves the sealed store on the suppression path).
 */
export function selectForgetSuppressionBodyHashPresence(
  db: DatabaseSync,
  scope: MemoryScope,
  currentBodyHash: string,
  legacyBodyHash: string,
): { readonly current: boolean; readonly legacy: boolean } {
  const rows = cachedPrepare(db, SELECT_SUPPRESSION_BODY_HASHES_BY_SCOPE_SQL).all(
    scopeKindOf(scope),
    scopeCoordinateOf(scope),
    currentBodyHash,
    legacyBodyHash,
  ) as unknown as readonly { readonly body_hash: string | null }[];
  let current = false;
  let legacy = false;
  for (const row of rows) {
    if (row.body_hash === currentBodyHash) current = true;
    if (row.body_hash === legacyBodyHash) legacy = true;
  }
  return { current, legacy };
}

export function deleteTombstonesByScopeBeforeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  forgottenBeforeMs: number,
): number {
  const info = cachedPrepare(db, DELETE_BY_SCOPE_BEFORE_SQL).run(
    scopeKindOf(scope),
    scopeCoordinateOf(scope),
    forgottenBeforeMs,
  );
  return Number(info.changes);
}

export function updateTombstoneBodyHashByScopeRows(
  db: DatabaseSync,
  scope: MemoryScope,
  previousBodyHash: string,
  nextBodyHash: string,
): number {
  const info = cachedPrepare(db, UPDATE_BODY_HASH_BY_SCOPE_SQL).run(
    nextBodyHash,
    scopeKindOf(scope),
    scopeCoordinateOf(scope),
    previousBodyHash,
  );
  return Number(info.changes);
}
