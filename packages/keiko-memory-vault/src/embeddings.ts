// Embedding I/O. Vectors are encoded as a packed Float32 little-endian byte buffer so a vault
// written on one host opens byte-identical on another, regardless of platform endianness.
// Reading a host-endian `Float32Array` directly off the buffer would be silently wrong on a
// big-endian host (rare in practice, but the round-trip test catches the regression class).
//
// Storage is upsert by primary key (memory_id). Replacing an embedding is the common path: the
// retrieval layer (#210) reschedules a re-embedding when the model identity drifts.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryEmbeddingInput, MemoryEmbeddingMetric, MemoryEmbeddingRow } from "./types.js";
import { MemoryStorageError } from "./errors.js";

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

const BYTES_PER_FLOAT32 = 4;

function encodeVectorLE(vector: Float32Array): Buffer {
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

function decodeVectorLE(bytes: Uint8Array, dimensions: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) {
    out[i] = view.getFloat32(i * BYTES_PER_FLOAT32, true);
  }
  return out;
}

export function upsertEmbeddingRow(
  db: DatabaseSync,
  memoryId: MemoryId,
  embedding: MemoryEmbeddingInput,
  nowMs: number,
): void {
  const bytes = encodeVectorLE(embedding.vector);
  db.prepare(UPSERT_SQL).run(
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

export function getEmbeddingRow(
  db: DatabaseSync,
  memoryId: MemoryId,
): MemoryEmbeddingRow | undefined {
  const row = db.prepare(SELECT_SQL).get(memoryId) as unknown as EmbeddingDbRow | undefined;
  if (row === undefined) return undefined;
  // Read-side soundness: a tampered DB row (or a future schema drift) must not silently land a
  // bad metric string in the typed return shape, and the BLOB length must match the declared
  // dimension count so callers can rely on `vector.length === dimensions`.
  const expectedBytes = row.vector_dimensions * BYTES_PER_FLOAT32;
  if (row.vector.byteLength !== expectedBytes) {
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
    vector: decodeVectorLE(row.vector, row.vector_dimensions),
    createdAt: row.created_at,
  };
  return row.model_revision === null ? base : { ...base, modelRevision: row.model_revision };
}
