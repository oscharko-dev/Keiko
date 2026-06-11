// Prepared-statement helpers for the `vectors` table (Epic #189, Issue #196). Every helper
// wraps a single statement so the orchestrator can compose them at the boundaries of its
// per-document work. The orchestrator is the only module that writes `vectors` rows.
//
// Vector ids are deterministic on `chunkId` (`vec:<chunkId>`): the chunks table already
// owns a UNIQUE (capsule_id, id) constraint, so the same chunk being re-embedded twice in
// a force run produces a byte-identical row id — the audit ledger's row-equality assertions
// (#10) hold across re-indexes.
//
// The composite FK `vectors(capsule_id, chunk_id) → chunks(capsule_id, id)` is enforced by
// SQLite — the orchestrator never bypasses it. If an upstream bug projects a chunk to a
// wrong capsule, the INSERT raises rather than silently splitting tenants.

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorId,
  VectorRecord,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import { KnowledgeStoreError } from "../errors.js";

const INSERT_VECTOR_SQL = [
  "INSERT INTO vectors (",
  "  id, capsule_id, source_id, document_id, chunk_id,",
  "  embedding, embedding_model_provider, embedding_model_id, embedding_model_revision,",
  "  vector_dimensions, vector_metric, storage_reference, created_at",
  ") VALUES (",
  "  :id, :capsule_id, :source_id, :document_id, :chunk_id,",
  "  :embedding, :provider, :model_id, :revision,",
  "  :dimensions, :metric, :storage_reference, :created_at",
  ")",
  "ON CONFLICT(id) DO UPDATE SET",
  "  embedding = excluded.embedding,",
  "  embedding_model_provider = excluded.embedding_model_provider,",
  "  embedding_model_id = excluded.embedding_model_id,",
  "  embedding_model_revision = excluded.embedding_model_revision,",
  "  vector_dimensions = excluded.vector_dimensions,",
  "  vector_metric = excluded.vector_metric,",
  "  storage_reference = excluded.storage_reference,",
  "  created_at = excluded.created_at",
].join(" ");

const DELETE_VECTORS_FOR_DOCUMENT_SQL =
  "DELETE FROM vectors WHERE capsule_id = :c AND document_id = :d";

const DELETE_VECTORS_FOR_CAPSULE_SQL = "DELETE FROM vectors WHERE capsule_id = :c";

const COUNT_VECTORS_FOR_DOCUMENT_SQL =
  "SELECT COUNT(*) AS n FROM vectors WHERE capsule_id = :c AND document_id = :d";

const COUNT_VECTORS_FOR_CAPSULE_SQL = "SELECT COUNT(*) AS n FROM vectors WHERE capsule_id = :c";

const SELECT_CHUNKS_FOR_DOCUMENT_SQL = [
  "SELECT id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count,",
  "  safe_excerpt_hash",
  "FROM chunks",
  "WHERE capsule_id = :c AND document_id = :d",
  "ORDER BY order_index ASC",
].join(" ");

export interface ChunkRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly parsed_unit_id: string;
  readonly order_index: number;
  readonly token_count: number;
  readonly safe_excerpt_hash: string;
}

export interface VectorInsertRow {
  readonly id: VectorId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
  readonly embedding: Uint8Array;
  readonly identity: EmbeddingModelIdentity;
  readonly storageReference: string;
  readonly createdAt: number;
}

function assertEmbeddingShape(row: VectorInsertRow): void {
  const expectedByteLength = row.identity.vectorDimensions * Float32Array.BYTES_PER_ELEMENT;
  if (row.embedding.byteLength !== expectedByteLength) {
    throw new KnowledgeStoreError(
      `vector ${String(row.id)} for capsule=${String(row.capsuleId)} ` +
        `chunk=${String(row.chunkId)} has blob length ${String(row.embedding.byteLength)} ` +
        `but identity.vectorDimensions=${String(row.identity.vectorDimensions)}`,
    );
  }
}

export function insertVectorRow(db: DatabaseSync, row: VectorInsertRow): void {
  assertEmbeddingShape(row);
  db.prepare(INSERT_VECTOR_SQL).run({
    id: String(row.id),
    capsule_id: String(row.capsuleId),
    source_id: String(row.sourceId),
    document_id: String(row.documentId),
    chunk_id: String(row.chunkId),
    embedding: row.embedding,
    provider: row.identity.provider,
    model_id: row.identity.modelId,
    revision: row.identity.modelRevision ?? null,
    dimensions: row.identity.vectorDimensions,
    metric: row.identity.vectorMetric,
    storage_reference: row.storageReference,
    created_at: row.createdAt,
  });
}

export function deleteVectorsForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  db.prepare(DELETE_VECTORS_FOR_DOCUMENT_SQL).run({ c: capsuleId, d: documentId });
}

export function deleteVectorsForCapsule(db: DatabaseSync, capsuleId: KnowledgeCapsuleId): void {
  db.prepare(DELETE_VECTORS_FOR_CAPSULE_SQL).run({ c: capsuleId });
}

interface CountRow {
  readonly n: number;
}

export function countVectorsForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): number {
  const row = db.prepare(COUNT_VECTORS_FOR_DOCUMENT_SQL).get({ c: capsuleId, d: documentId }) as
    | CountRow
    | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

export function countVectorsForCapsule(db: DatabaseSync, capsuleId: KnowledgeCapsuleId): number {
  const row = db.prepare(COUNT_VECTORS_FOR_CAPSULE_SQL).get({ c: capsuleId }) as
    | CountRow
    | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

export function selectChunksForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): readonly ChunkRow[] {
  const rows = db.prepare(SELECT_CHUNKS_FOR_DOCUMENT_SQL).all({ c: capsuleId, d: documentId });
  return rows as unknown as readonly ChunkRow[];
}

// VectorRecord composition is consolidated here so the batcher and any future replay tool
// share the exact shape that gets persisted into `vectors`.
export function composeVectorRecord(row: VectorInsertRow): VectorRecord {
  return {
    id: row.id,
    chunkId: row.chunkId,
    capsuleId: row.capsuleId,
    sourceId: row.sourceId,
    documentId: row.documentId,
    embeddingIdentity: row.identity,
    vectorDimensions: row.identity.vectorDimensions,
    storageReference: row.storageReference,
    createdAt: row.createdAt,
  };
}
