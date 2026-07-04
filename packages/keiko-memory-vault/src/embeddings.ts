// Embedding I/O. Vectors are encoded as a packed Float32 little-endian byte buffer so a vault
// written on one host opens byte-identical on another, regardless of platform endianness.
// Reading a host-endian `Float32Array` directly off the buffer would be silently wrong on a
// big-endian host (rare in practice, but the round-trip test catches the regression class).
//
// Storage is upsert by primary key (memory_id). The vault keeps one comparable embedding space at a
// time; callers must clear/re-embed the corpus before switching model identity, metric, or shape.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryEmbeddingInput, MemoryEmbeddingMetric, MemoryEmbeddingRow } from "./types.js";
import type { MemoryContentCipher } from "./cipher.js";
import { MemoryStorageError } from "./errors.js";
import { cachedPrepare } from "./statements.js";

// Hard upper bound on vector dimensions. The largest production embedding model in scope today
// (OpenAI text-embedding-3-large) is 3072 dims; 4096 gives one binary-doubling of headroom while
// capping the per-row BLOB at 16 KiB. Without this bound a caller could request a 2^31 element
// Float32 allocation (8 GiB) via the in-process API and crash the process — CWE-400.
export const MAX_EMBEDDING_DIMENSIONS = 4096;

export const ALLOWED_EMBEDDING_METRICS: readonly MemoryEmbeddingMetric[] = [
  "cosine",
  "euclidean",
  "dot",
];

interface EmbeddingDbRow {
  readonly memory_id: string;
  readonly provider: string;
  readonly model_id: string;
  readonly model_revision: string | null;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
  readonly vector: Uint8Array;
  readonly created_at: number;
}

interface ActiveVectorSpaceRow {
  readonly provider: string;
  readonly model_id: string;
  readonly model_revision: string | null;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
}

const UPSERT_SQL = `
INSERT INTO memory_embeddings (
  memory_id, provider, model_id, model_revision, vector_dimensions,
  vector_metric, vector, created_at
) VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(memory_id) DO UPDATE SET
  provider = excluded.provider,
  model_id = excluded.model_id,
  model_revision = excluded.model_revision,
  vector_dimensions = excluded.vector_dimensions,
  vector_metric = excluded.vector_metric,
  vector = excluded.vector,
  created_at = excluded.created_at
`;

const SELECT_SQL = "SELECT * FROM memory_embeddings WHERE memory_id = ?";
const DELETE_SQL = "DELETE FROM memory_embeddings WHERE memory_id = ?";
const ACTIVE_VECTOR_SPACES_SQL = `
SELECT provider, model_id, model_revision, vector_dimensions, vector_metric
FROM memory_embeddings
WHERE memory_id <> ?
GROUP BY provider, model_id, model_revision, vector_dimensions, vector_metric
LIMIT 2
`;
const BULK_SELECT_CHUNK_SIZE = 500;

export const BYTES_PER_FLOAT32 = 4;

export function encodeVectorLE(vector: Float32Array): Buffer {
  const buf = Buffer.alloc(vector.length * BYTES_PER_FLOAT32);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < vector.length; i += 1) {
    // setFloat32(..., true) writes little-endian regardless of host endianness so the on-disk
    // byte layout is identical across Linux/macOS/Windows on x86/arm and theoretical big-endian
    // hosts.
    view.setFloat32(i * BYTES_PER_FLOAT32, vector[i] ?? 0, true);
  }
  return buf;
}

export function decodeVectorLE(bytes: Uint8Array, dimensions: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) {
    out[i] = view.getFloat32(i * BYTES_PER_FLOAT32, true);
  }
  return out;
}

function activeVectorSpaceMatches(
  row: ActiveVectorSpaceRow | undefined,
  embedding: MemoryEmbeddingInput,
  revision: string | null,
): boolean {
  if (row === undefined) return false;
  return (
    row.provider === embedding.provider &&
    row.model_id === embedding.modelId &&
    row.model_revision === revision &&
    row.vector_dimensions === embedding.vector.length &&
    row.vector_metric === embedding.metric
  );
}

function assertCompatibleActiveVectorSpace(
  db: DatabaseSync,
  memoryId: MemoryId,
  embedding: MemoryEmbeddingInput,
): void {
  const revision = embedding.modelRevision ?? null;
  const rows = cachedPrepare(db, ACTIVE_VECTOR_SPACES_SQL).all(
    memoryId,
  ) as unknown as readonly ActiveVectorSpaceRow[];
  if (rows.length === 0) {
    return;
  }
  const row = rows[0];
  if (rows.length === 1 && activeVectorSpaceMatches(row, embedding, revision)) {
    return;
  }
  throw new MemoryStorageError(
    "schema-mismatch",
    "Embedding vector space differs from existing rows; clear or re-embed the vault before switching embedding models.",
  );
}

export function upsertEmbeddingRow(
  db: DatabaseSync,
  memoryId: MemoryId,
  embedding: MemoryEmbeddingInput,
  nowMs: number,
  cipher: MemoryContentCipher,
): void {
  assertCompatibleActiveVectorSpace(db, memoryId, embedding);
  // The vector is memory CONTENT (ADR-0035), so the packed LE bytes are sealed before they touch
  // the BLOB column. vector_dimensions / vector_metric stay cleartext for retrieval-side dispatch.
  const bytes = cipher.sealBytes(encodeVectorLE(embedding.vector));
  cachedPrepare(db, UPSERT_SQL).run(
    memoryId,
    embedding.provider,
    embedding.modelId,
    embedding.modelRevision ?? null,
    embedding.vector.length,
    embedding.metric,
    bytes,
    nowMs,
  );
}

function narrowMetric(raw: string): MemoryEmbeddingMetric {
  if (!ALLOWED_EMBEDDING_METRICS.includes(raw as MemoryEmbeddingMetric)) {
    throw new MemoryStorageError(
      "schema-mismatch",
      "Stored embedding metric is not in the allowed set.",
    );
  }
  return raw as MemoryEmbeddingMetric;
}

function openVectorBytes(stored: Uint8Array, cipher: MemoryContentCipher): Buffer {
  // The BLOB is ALWAYS a sealed binary envelope here: the v1->v2 migration (run before any read in
  // openMemoryDatabase) seals every embedding row, and there is no unambiguous plaintext-vs-sealed
  // marker for raw Float32 bytes, so we never guess. openBytes throws loudly on a wrong key or a
  // tampered/corrupt envelope rather than silently returning plaintext.
  return cipher.openBytes(Buffer.from(stored));
}

export function getEmbeddingRow(
  db: DatabaseSync,
  memoryId: MemoryId,
  cipher: MemoryContentCipher,
): MemoryEmbeddingRow | undefined {
  const row = cachedPrepare(db, SELECT_SQL).get(memoryId) as unknown as EmbeddingDbRow | undefined;
  if (row === undefined) return undefined;
  return rowToEmbedding(row, cipher);
}

function rowToEmbedding(row: EmbeddingDbRow, cipher: MemoryContentCipher): MemoryEmbeddingRow {
  const plainVector = openVectorBytes(row.vector, cipher);
  // Read-side soundness: a tampered DB row (or a future schema drift) must not silently land a
  // bad metric string in the typed return shape, and the DECRYPTED BLOB length must match the
  // declared dimension count so callers can rely on `vector.length === dimensions`.
  const expectedBytes = row.vector_dimensions * BYTES_PER_FLOAT32;
  if (plainVector.byteLength !== expectedBytes) {
    throw new MemoryStorageError(
      "schema-mismatch",
      "Stored embedding vector byte length does not match declared dimensions.",
    );
  }
  const base = {
    memoryId: row.memory_id as MemoryId,
    provider: row.provider,
    modelId: row.model_id,
    dimensions: row.vector_dimensions,
    metric: narrowMetric(row.vector_metric),
    vector: decodeVectorLE(plainVector, row.vector_dimensions),
    createdAt: row.created_at,
  };
  return row.model_revision === null ? base : { ...base, modelRevision: row.model_revision };
}

export function getEmbeddingRows(
  db: DatabaseSync,
  memoryIds: readonly MemoryId[],
  cipher: MemoryContentCipher,
): ReadonlyMap<MemoryId, MemoryEmbeddingRow> {
  const out = new Map<MemoryId, MemoryEmbeddingRow>();
  if (memoryIds.length === 0) return out;
  const uniqueIds = [...new Set(memoryIds)];
  for (let i = 0; i < uniqueIds.length; i += BULK_SELECT_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + BULK_SELECT_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = cachedPrepare(
      db,
      `SELECT * FROM memory_embeddings WHERE memory_id IN (${placeholders})`,
    ).all(...chunk) as unknown as readonly EmbeddingDbRow[];
    for (const row of rows) {
      out.set(row.memory_id as MemoryId, rowToEmbedding(row, cipher));
    }
  }
  return out;
}

export function deleteEmbeddingRow(db: DatabaseSync, memoryId: MemoryId): boolean {
  const result = cachedPrepare(db, DELETE_SQL).run(memoryId);
  return result.changes > 0;
}
