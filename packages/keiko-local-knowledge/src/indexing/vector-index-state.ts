import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import { KnowledgeStoreError } from "../errors.js";
import { capsuleIdColumn } from "../knowledge-ids.js";
import {
  nullableNumberColumn,
  nullableTextColumn,
  numberColumn,
  textColumn,
  type KnowledgeSqlRow,
} from "../sql-row.js";

export type VectorIndexProvider = "usearch";
export type VectorIndexStateStatus = "dirty" | "ready" | "unavailable";

export interface VectorIndexStateKey {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly provider: VectorIndexProvider;
  readonly indexName: string;
  readonly vectorDimensions: number;
  readonly vectorMetric: string;
  readonly embeddingIdentityKey: string;
}

export interface VectorIndexStateRecord extends VectorIndexStateKey {
  readonly vectorCount: number;
  readonly vectorMaxCreatedAt: number | null;
  readonly status: VectorIndexStateStatus;
  readonly reason?: string;
  readonly updatedAt: number;
}

interface VectorIndexStateRow {
  readonly capsule_id: KnowledgeCapsuleId;
  readonly provider: VectorIndexProvider;
  readonly index_name: string;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
  readonly embedding_identity_key: string;
  readonly vector_count: number;
  readonly vector_max_created_at: number | null;
  readonly status: VectorIndexStateStatus;
  readonly reason: string | null;
  readonly updated_at: number;
}

// The SELECT binds provider to the requested key, and the only provider is "usearch".
function storedProvider(row: KnowledgeSqlRow): VectorIndexProvider {
  const provider = textColumn(row, "provider");
  if (provider === "usearch") return provider;
  throw new KnowledgeStoreError("A stored vector index state has an unknown provider.");
}

// The vector_index_state CHECK constraint admits exactly these three states.
function storedStatus(row: KnowledgeSqlRow): VectorIndexStateStatus {
  const status = textColumn(row, "status");
  if (status === "dirty" || status === "ready" || status === "unavailable") return status;
  throw new KnowledgeStoreError("A stored vector index state has an unknown status.");
}

function readVectorIndexStateRow(row: KnowledgeSqlRow): VectorIndexStateRow {
  return {
    capsule_id: capsuleIdColumn(row, "capsule_id"),
    provider: storedProvider(row),
    index_name: textColumn(row, "index_name"),
    vector_dimensions: numberColumn(row, "vector_dimensions"),
    vector_metric: textColumn(row, "vector_metric"),
    embedding_identity_key: textColumn(row, "embedding_identity_key"),
    vector_count: numberColumn(row, "vector_count"),
    vector_max_created_at: nullableNumberColumn(row, "vector_max_created_at"),
    status: storedStatus(row),
    reason: nullableTextColumn(row, "reason"),
    updated_at: numberColumn(row, "updated_at"),
  };
}

const DIRTY_VECTOR_INDEX_STATE_FOR_CAPSULE_SQL = [
  "UPDATE vector_index_state",
  "SET status = 'dirty', reason = NULL",
  "WHERE capsule_id = :capsule_id",
].join(" ");

const SELECT_VECTOR_INDEX_STATE_SQL = [
  "SELECT capsule_id, provider, index_name, vector_dimensions, vector_metric,",
  "  embedding_identity_key, vector_count, vector_max_created_at, status, reason, updated_at",
  "FROM vector_index_state",
  "WHERE capsule_id = :capsule_id",
  "  AND provider = :provider",
  "  AND index_name = :index_name",
  "  AND vector_dimensions = :vector_dimensions",
  "  AND vector_metric = :vector_metric",
  "  AND embedding_identity_key = :embedding_identity_key",
].join(" ");

const UPSERT_VECTOR_INDEX_STATE_SQL = [
  "INSERT INTO vector_index_state (",
  "  capsule_id, provider, index_name, vector_dimensions, vector_metric,",
  "  embedding_identity_key, vector_count, vector_max_created_at, status, reason, updated_at",
  ") VALUES (",
  "  :capsule_id, :provider, :index_name, :vector_dimensions, :vector_metric,",
  "  :embedding_identity_key, :vector_count, :vector_max_created_at, :status, :reason, :updated_at",
  ")",
  "ON CONFLICT(",
  "  capsule_id, provider, index_name, vector_dimensions, vector_metric, embedding_identity_key",
  ") DO UPDATE SET",
  "  vector_count = excluded.vector_count,",
  "  vector_max_created_at = excluded.vector_max_created_at,",
  "  status = excluded.status,",
  "  reason = excluded.reason,",
  "  updated_at = excluded.updated_at",
].join(" ");

const DELETE_OBSOLETE_VECTOR_INDEX_STATE_SQL = [
  "DELETE FROM vector_index_state",
  "WHERE capsule_id = :capsule_id",
  "  AND provider = :provider",
  "  AND embedding_identity_key <> :embedding_identity_key",
].join(" ");

export function invalidateVectorIndexStateForCapsule(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
): void {
  db.prepare(DIRTY_VECTOR_INDEX_STATE_FOR_CAPSULE_SQL).run({
    capsule_id: String(capsuleId),
  });
}

export function readVectorIndexState(
  db: DatabaseSync,
  key: VectorIndexStateKey,
): VectorIndexStateRecord | undefined {
  const stored = db.prepare(SELECT_VECTOR_INDEX_STATE_SQL).get({
    capsule_id: String(key.capsuleId),
    provider: key.provider,
    index_name: key.indexName,
    vector_dimensions: key.vectorDimensions,
    vector_metric: key.vectorMetric,
    embedding_identity_key: key.embeddingIdentityKey,
  });
  if (stored === undefined) return undefined;
  const row = readVectorIndexStateRow(stored);
  return {
    capsuleId: row.capsule_id,
    provider: row.provider,
    indexName: row.index_name,
    vectorDimensions: row.vector_dimensions,
    vectorMetric: row.vector_metric,
    embeddingIdentityKey: row.embedding_identity_key,
    vectorCount: row.vector_count,
    vectorMaxCreatedAt: row.vector_max_created_at,
    status: row.status,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    updatedAt: row.updated_at,
  };
}

export function writeVectorIndexState(db: DatabaseSync, record: VectorIndexStateRecord): void {
  const parameters = {
    capsule_id: String(record.capsuleId),
    provider: record.provider,
    index_name: record.indexName,
    vector_dimensions: record.vectorDimensions,
    vector_metric: record.vectorMetric,
    embedding_identity_key: record.embeddingIdentityKey,
    vector_count: record.vectorCount,
    vector_max_created_at: record.vectorMaxCreatedAt,
    status: record.status,
    reason: record.reason ?? null,
    updated_at: record.updatedAt,
  };
  // A missing state row only causes a fail-closed runtime index rebuild, so deletion-before-upsert
  // is crash-safe. Keeping one row per logical index also bounds metadata after identity changes.
  db.prepare(DELETE_OBSOLETE_VECTOR_INDEX_STATE_SQL).run({
    capsule_id: parameters.capsule_id,
    provider: parameters.provider,
    embedding_identity_key: parameters.embedding_identity_key,
  });
  db.prepare(UPSERT_VECTOR_INDEX_STATE_SQL).run(parameters);
}
