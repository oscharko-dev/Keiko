import type {
  EmbeddingModelIdentity,
  EmbeddingVectorMetric,
  EmbeddingVectorNormalization,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { assertCompatibleEmbeddingIdentity } from "@oscharko-dev/keiko-model-gateway";
import type { DatabaseSync } from "node:sqlite";

import {
  readVectorIndexState,
  writeVectorIndexState,
  type VectorIndexProvider,
} from "../indexing/vector-index-state.js";
import type { KnowledgeStore } from "../store.js";

import type { RetrievalVectorIndexDiagnostics } from "./types.js";

export type VectorIndexMode = "disabled" | "auto" | "sqlite-vec";

export interface VectorIndexCandidate {
  readonly chunkId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId?: KnowledgeSourceId;
  readonly score: number;
}

export interface VectorIndexSearchRequest {
  readonly store: KnowledgeStore;
  readonly capsule: KnowledgeCapsule;
  readonly sourceFilter?: readonly KnowledgeSourceId[];
  readonly queryVector: Float32Array;
  readonly candidateLimit: number;
  readonly minScore?: number;
}

export interface VectorIndexSearchResult {
  readonly ok: boolean;
  readonly candidates: readonly VectorIndexCandidate[];
  readonly sawDimensionCompatible: boolean;
  readonly sawIdentityIncompatible: boolean;
  readonly diagnostics: RetrievalVectorIndexDiagnostics;
}

export interface VectorIndexAdapter {
  readonly searchCapsule: (request: VectorIndexSearchRequest) => VectorIndexSearchResult;
}

export interface SqliteVecModule {
  readonly load: (db: DatabaseSync) => void;
}

export interface VectorIndexOptions {
  readonly mode?: VectorIndexMode;
  readonly adapter?: VectorIndexAdapter;
  readonly sqliteVec?: SqliteVecModule;
  readonly sqliteVecExtensionPath?: string;
  readonly now?: () => number;
}

interface ResolvedVectorIndexOptions {
  readonly mode: VectorIndexMode;
  readonly adapter?: VectorIndexAdapter;
  readonly sqliteVec?: SqliteVecModule;
  readonly sqliteVecExtensionPath?: string;
  readonly now: () => number;
}

interface VectorIndexStampRow {
  readonly n: number;
  readonly max_created_at: number | null;
}

interface SqliteVecIndexRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly embedding: Uint8Array;
  readonly embedding_model_provider: string;
  readonly embedding_model_id: string;
  readonly embedding_model_revision: string | null;
  readonly embedding_normalization: string | null;
  readonly embedding_instruction_version: string | null;
  readonly embedding_space_fingerprint: string | null;
  readonly embedding_dimensions_param: number | null;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
  readonly created_at: number;
}

interface SqliteVecCandidateRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly distance: number;
}

interface SqliteTempTableRow {
  readonly n: number;
}

type SqliteVecLoadResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const SQLITE_VEC_PROVIDER: VectorIndexProvider = "sqlite-vec";
const SQLITE_VEC_TABLE_PREFIX = "keiko_lk_vec";
const SQLITE_VEC_LOADS = new WeakMap<KnowledgeStore, Map<string, SqliteVecLoadResult>>();

const SELECT_VECTOR_INDEX_STAMP_SQL = [
  "SELECT COUNT(*) AS n, MAX(created_at) AS max_created_at",
  "FROM vectors",
  "WHERE capsule_id = :capsule_id",
  "  AND vector_dimensions = :vector_dimensions",
  "  AND vector_metric = :vector_metric",
].join(" ");

const SELECT_SQLITE_VEC_INDEX_ROWS_SQL = [
  "SELECT chunk_id, capsule_id, source_id, embedding,",
  "  embedding_model_provider, embedding_model_id, embedding_model_revision,",
  "  embedding_normalization, embedding_instruction_version, embedding_space_fingerprint,",
  "  embedding_dimensions_param, vector_dimensions, vector_metric, created_at",
  "FROM vectors",
  "WHERE capsule_id = :capsule_id",
  "  AND vector_dimensions = :vector_dimensions",
  "  AND vector_metric = :vector_metric",
  "ORDER BY chunk_id ASC",
].join(" ");

function resolvedVectorIndexOptions(
  options: VectorIndexOptions | undefined,
): ResolvedVectorIndexOptions {
  const mode = parseVectorIndexMode(
    options?.mode ?? process.env.KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX,
  );
  const resolved: {
    mode: VectorIndexMode;
    adapter?: VectorIndexAdapter;
    sqliteVec?: SqliteVecModule;
    sqliteVecExtensionPath?: string;
    now: () => number;
  } = { mode, now: options?.now ?? Date.now };
  if (options?.adapter !== undefined) resolved.adapter = options.adapter;
  if (options?.sqliteVec !== undefined) resolved.sqliteVec = options.sqliteVec;
  const extensionPath = vectorIndexExtensionPath(options);
  if (extensionPath !== undefined) resolved.sqliteVecExtensionPath = extensionPath;
  return resolved;
}

function parseVectorIndexMode(value: string | undefined): VectorIndexMode {
  if (value === "auto" || value === "sqlite-vec" || value === "disabled") return value;
  return "disabled";
}

function vectorIndexExtensionPath(options: VectorIndexOptions | undefined): string | undefined {
  const value =
    options?.sqliteVecExtensionPath ?? process.env.KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH;
  return value === undefined || value.length === 0 ? undefined : value;
}

function disabledResult(): VectorIndexSearchResult {
  return {
    ok: false,
    candidates: [],
    sawDimensionCompatible: false,
    sawIdentityIncompatible: false,
    diagnostics: {
      provider: "brute-force",
      status: "disabled",
      reason: "vector-index-disabled",
    },
  };
}

function unavailableResult(
  status: RetrievalVectorIndexDiagnostics["status"],
  reason: string,
  indexName?: string,
): VectorIndexSearchResult {
  return {
    ok: false,
    candidates: [],
    sawDimensionCompatible: false,
    sawIdentityIncompatible: false,
    diagnostics: {
      provider: SQLITE_VEC_PROVIDER,
      status,
      reason,
      ...(indexName !== undefined ? { indexName } : {}),
    },
  };
}

export function searchVectorIndex(
  request: VectorIndexSearchRequest,
  options: VectorIndexOptions | undefined,
): VectorIndexSearchResult {
  const resolved = resolvedVectorIndexOptions(options);
  if (resolved.adapter !== undefined) return resolved.adapter.searchCapsule(request);
  if (resolved.mode === "disabled") return disabledResult();
  return searchSqliteVecIndex(request, resolved);
}

function searchSqliteVecIndex(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
): VectorIndexSearchResult {
  const identity = request.capsule.embeddingModelIdentity;
  const indexName = sqliteVecIndexName(identity);
  if (request.store._internal.contentCipher.isEncrypted) {
    writeUnavailable(request, options, indexName, "encrypted-store");
    return unavailableResult("fallback-encrypted-store", "encrypted-store", indexName);
  }
  if (identity.vectorMetric !== "cosine") {
    writeUnavailable(request, options, indexName, "unsupported-metric");
    return unavailableResult("fallback-unsupported-metric", "unsupported-metric", indexName);
  }
  if (request.queryVector.length !== identity.vectorDimensions) {
    return {
      ok: false,
      candidates: [],
      sawDimensionCompatible: false,
      sawIdentityIncompatible: true,
      diagnostics: {
        provider: SQLITE_VEC_PROVIDER,
        status: "fallback-incompatible-identity",
        reason: "query-dimension-mismatch",
        indexName,
      },
    };
  }

  const load = loadSqliteVec(request.store, options);
  if (!load.ok) {
    writeUnavailable(request, options, indexName, load.reason);
    return unavailableResult("fallback-unavailable", load.reason, indexName);
  }

  try {
    const build = ensureSqliteVecIndex(request, options, indexName);
    if (!build.ok) return build.result;
    return querySqliteVecIndex(request, indexName);
  } catch {
    writeUnavailable(request, options, indexName, "sqlite-vec-query-error");
    return unavailableResult("fallback-query-error", "sqlite-vec-query-error", indexName);
  }
}

function writeUnavailable(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  indexName: string,
  reason: string,
): void {
  const stamp = vectorIndexStamp(request.store, request.capsule);
  writeVectorIndexState(request.store._internal.db, {
    capsuleId: request.capsule.id,
    provider: SQLITE_VEC_PROVIDER,
    indexName,
    vectorDimensions: request.capsule.embeddingModelIdentity.vectorDimensions,
    vectorMetric: request.capsule.embeddingModelIdentity.vectorMetric,
    embeddingIdentityKey: embeddingIdentityKey(request.capsule.embeddingModelIdentity),
    vectorCount: stamp.n,
    vectorMaxCreatedAt: stamp.max_created_at,
    status: "unavailable",
    reason,
    updatedAt: options.now(),
  });
}

function loadSqliteVec(
  store: KnowledgeStore,
  options: ResolvedVectorIndexOptions,
): SqliteVecLoadResult {
  const key = options.sqliteVec !== undefined ? "module" : (options.sqliteVecExtensionPath ?? "");
  const cachedByKey = SQLITE_VEC_LOADS.get(store);
  const cached = cachedByKey?.get(key);
  if (cached !== undefined) return cached;

  const result = loadSqliteVecUncached(store._internal.db, options);
  const nextByKey = cachedByKey ?? new Map<string, SqliteVecLoadResult>();
  nextByKey.set(key, result);
  SQLITE_VEC_LOADS.set(store, nextByKey);
  return result;
}

function loadSqliteVecUncached(
  db: DatabaseSync,
  options: ResolvedVectorIndexOptions,
): SqliteVecLoadResult {
  if (options.sqliteVec !== undefined) {
    try {
      options.sqliteVec.load(db);
      return { ok: true };
    } catch {
      return { ok: false, reason: "sqlite-vec-module-load-failed" };
    }
  }
  if (options.sqliteVecExtensionPath === undefined) {
    return { ok: false, reason: "sqlite-vec-runtime-not-configured" };
  }
  if (typeof db.enableLoadExtension !== "function" || typeof db.loadExtension !== "function") {
    return { ok: false, reason: "sqlite-load-extension-unavailable" };
  }
  try {
    db.enableLoadExtension(true);
    db.loadExtension(options.sqliteVecExtensionPath);
    return { ok: true };
  } catch {
    return { ok: false, reason: "sqlite-vec-extension-load-failed" };
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      // Best-effort hardening; a failing disable should not mask the real load result.
    }
  }
}

function ensureSqliteVecIndex(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  indexName: string,
): { readonly ok: true } | { readonly ok: false; readonly result: VectorIndexSearchResult } {
  createSqliteVecTempTable(request.store._internal.db, indexName, request.capsule);
  const stamp = vectorIndexStamp(request.store, request.capsule);
  const state = readVectorIndexState(request.store._internal.db, {
    capsuleId: request.capsule.id,
    provider: SQLITE_VEC_PROVIDER,
    indexName,
    vectorDimensions: request.capsule.embeddingModelIdentity.vectorDimensions,
    vectorMetric: request.capsule.embeddingModelIdentity.vectorMetric,
    embeddingIdentityKey: embeddingIdentityKey(request.capsule.embeddingModelIdentity),
  });
  if (
    state?.status === "ready" &&
    state.vectorCount === stamp.n &&
    state.vectorMaxCreatedAt === stamp.max_created_at &&
    sqliteVecTempTableHasRows(request.store._internal.db, indexName, request.capsule.id)
  ) {
    return { ok: true };
  }

  const build = rebuildSqliteVecIndex(request, options, indexName, stamp);
  if (!build.ok) return build;
  return { ok: true };
}

function createSqliteVecTempTable(
  db: DatabaseSync,
  indexName: string,
  capsule: KnowledgeCapsule,
): void {
  db.exec(
    [
      `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${indexName} USING vec0(`,
      "  capsule_id TEXT partition key,",
      "  source_id TEXT,",
      "  identity_key TEXT,",
      "  chunk_id TEXT,",
      `  embedding float[${String(capsule.embeddingModelIdentity.vectorDimensions)}] distance_metric=cosine`,
      ");",
    ].join("\n"),
  );
}

function sqliteVecTempTableHasRows(
  db: DatabaseSync,
  indexName: string,
  capsuleId: KnowledgeCapsuleId,
): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM temp.${indexName} WHERE capsule_id = :capsule_id LIMIT 1`)
    .get({ capsule_id: String(capsuleId) }) as unknown as SqliteTempTableRow | undefined;
  return (row?.n ?? 0) > 0;
}

function rebuildSqliteVecIndex(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  indexName: string,
  stamp: VectorIndexStampRow,
): { readonly ok: true } | { readonly ok: false; readonly result: VectorIndexSearchResult } {
  const compatible = compatibleSqliteVecRows(request);
  if (!compatible.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        candidates: [],
        sawDimensionCompatible: false,
        sawIdentityIncompatible: true,
        diagnostics: {
          provider: SQLITE_VEC_PROVIDER,
          status: "fallback-incompatible-identity",
          reason: "stored-vector-identity-mismatch",
          indexName,
        },
      },
    };
  }
  replaceSqliteVecRows(request, indexName, compatible.rows);
  writeReadySqliteVecState(request, options, indexName, stamp);
  return { ok: true };
}

function compatibleSqliteVecRows(
  request: VectorIndexSearchRequest,
): { readonly ok: true; readonly rows: readonly SqliteVecIndexRow[] } | { readonly ok: false } {
  const rows = readSqliteVecIndexRows(request.store, request.capsule);
  const compatibleRows: SqliteVecIndexRow[] = [];
  for (const row of rows) {
    const rowIdentity = identityFromSqliteVecRow(row);
    if (
      rowIdentity === undefined ||
      !assertCompatibleEmbeddingIdentity(request.capsule.embeddingModelIdentity, rowIdentity).ok
    ) {
      return { ok: false };
    }
    compatibleRows.push(row);
  }
  return { ok: true, rows: compatibleRows };
}

function replaceSqliteVecRows(
  request: VectorIndexSearchRequest,
  indexName: string,
  rows: readonly SqliteVecIndexRow[],
): void {
  const db = request.store._internal.db;
  const identityKey = embeddingIdentityKey(request.capsule.embeddingModelIdentity);
  db.prepare(
    `DELETE FROM temp.${indexName} WHERE capsule_id = :capsule_id AND identity_key = :identity_key`,
  ).run({
    capsule_id: String(request.capsule.id),
    identity_key: identityKey,
  });
  const insert = db.prepare(
    [
      `INSERT INTO temp.${indexName} (capsule_id, source_id, identity_key, chunk_id, embedding)`,
      "VALUES (:capsule_id, :source_id, :identity_key, :chunk_id, :embedding)",
    ].join(" "),
  );
  for (const row of rows) {
    insert.run({
      capsule_id: row.capsule_id,
      source_id: row.source_id,
      identity_key: identityKey,
      chunk_id: row.chunk_id,
      embedding: row.embedding,
    });
  }
}

function writeReadySqliteVecState(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  indexName: string,
  stamp: VectorIndexStampRow,
): void {
  const identityKey = embeddingIdentityKey(request.capsule.embeddingModelIdentity);
  writeVectorIndexState(request.store._internal.db, {
    capsuleId: request.capsule.id,
    provider: SQLITE_VEC_PROVIDER,
    indexName,
    vectorDimensions: request.capsule.embeddingModelIdentity.vectorDimensions,
    vectorMetric: request.capsule.embeddingModelIdentity.vectorMetric,
    embeddingIdentityKey: identityKey,
    vectorCount: stamp.n,
    vectorMaxCreatedAt: stamp.max_created_at,
    status: "ready",
    updatedAt: options.now(),
  });
}

function querySqliteVecIndex(
  request: VectorIndexSearchRequest,
  indexName: string,
): VectorIndexSearchResult {
  const identityKey = embeddingIdentityKey(request.capsule.embeddingModelIdentity);
  const rows =
    request.sourceFilter === undefined
      ? querySqliteVecIndexForSource(request, indexName, identityKey)
      : request.sourceFilter.flatMap((sourceId) =>
          querySqliteVecIndexForSource(request, indexName, identityKey, sourceId),
        );
  const candidates = rows
    .map(sqliteVecRowToCandidate)
    .filter((candidate) => request.minScore === undefined || candidate.score >= request.minScore)
    .sort(scoreDesc)
    .slice(0, request.candidateLimit);
  return {
    ok: true,
    candidates,
    sawDimensionCompatible: true,
    sawIdentityIncompatible: false,
    diagnostics: {
      provider: SQLITE_VEC_PROVIDER,
      status: "available",
      indexName,
      vectorCount: candidates.length,
    },
  };
}

function querySqliteVecIndexForSource(
  request: VectorIndexSearchRequest,
  indexName: string,
  identityKey: string,
  sourceId?: KnowledgeSourceId,
): readonly SqliteVecCandidateRow[] {
  const sourceClause = sourceId === undefined ? "" : " AND source_id = :source_id";
  const rows = request.store._internal.db
    .prepare(
      [
        "SELECT chunk_id, capsule_id, source_id, distance",
        `FROM temp.${indexName}`,
        "WHERE embedding MATCH :query",
        "  AND k = :k",
        "  AND capsule_id = :capsule_id",
        "  AND identity_key = :identity_key",
        sourceClause,
        "ORDER BY distance ASC, chunk_id ASC",
      ].join(" "),
    )
    .all({
      query: float32Bytes(request.queryVector),
      k: request.candidateLimit,
      capsule_id: String(request.capsule.id),
      identity_key: identityKey,
      ...(sourceId !== undefined ? { source_id: String(sourceId) } : {}),
    }) as unknown as readonly SqliteVecCandidateRow[];
  return rows;
}

function sqliteVecRowToCandidate(row: SqliteVecCandidateRow): VectorIndexCandidate {
  return {
    chunkId: row.chunk_id,
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    sourceId: row.source_id as KnowledgeSourceId,
    score: 1 - row.distance,
  };
}

function readSqliteVecIndexRows(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
): readonly SqliteVecIndexRow[] {
  return store._internal.db.prepare(SELECT_SQLITE_VEC_INDEX_ROWS_SQL).all({
    capsule_id: String(capsule.id),
    vector_dimensions: capsule.embeddingModelIdentity.vectorDimensions,
    vector_metric: capsule.embeddingModelIdentity.vectorMetric,
  }) as unknown as readonly SqliteVecIndexRow[];
}

function vectorIndexStamp(store: KnowledgeStore, capsule: KnowledgeCapsule): VectorIndexStampRow {
  return store._internal.db.prepare(SELECT_VECTOR_INDEX_STAMP_SQL).get({
    capsule_id: String(capsule.id),
    vector_dimensions: capsule.embeddingModelIdentity.vectorDimensions,
    vector_metric: capsule.embeddingModelIdentity.vectorMetric,
  }) as unknown as VectorIndexStampRow;
}

function sqliteVecIndexName(identity: EmbeddingModelIdentity): string {
  return `${SQLITE_VEC_TABLE_PREFIX}_${String(identity.vectorDimensions)}_${identity.vectorMetric}`;
}

function float32Bytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function scoreDesc(
  a: { readonly score: number; readonly chunkId: string },
  b: { readonly score: number; readonly chunkId: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.chunkId.localeCompare(b.chunkId);
}

function vectorMetricFromRow(value: string): EmbeddingVectorMetric | undefined {
  if (value === "cosine" || value === "dot" || value === "euclidean") return value;
  return undefined;
}

function normalizationFromRow(value: string | null): EmbeddingVectorNormalization | undefined {
  if (value === "l2" || value === "none" || value === "unknown") return value;
  return undefined;
}

function identityFromSqliteVecRow(row: SqliteVecIndexRow): EmbeddingModelIdentity | undefined {
  const vectorMetric = vectorMetricFromRow(row.vector_metric);
  if (vectorMetric === undefined) return undefined;
  const normalization = normalizationFromRow(row.embedding_normalization);
  return {
    provider: row.embedding_model_provider,
    modelId: row.embedding_model_id,
    vectorDimensions: row.vector_dimensions,
    vectorMetric,
    ...(row.embedding_model_revision !== null
      ? { modelRevision: row.embedding_model_revision }
      : {}),
    ...(normalization !== undefined ? { normalization } : {}),
    ...(row.embedding_instruction_version !== null
      ? { instructionVersion: row.embedding_instruction_version }
      : {}),
    ...(row.embedding_space_fingerprint !== null
      ? { embeddingSpaceFingerprint: row.embedding_space_fingerprint }
      : {}),
    ...(row.embedding_dimensions_param !== null
      ? { dimensionsParam: row.embedding_dimensions_param }
      : {}),
  };
}

export function embeddingIdentityKey(identity: EmbeddingModelIdentity): string {
  return [
    identity.provider,
    identity.modelId,
    String(identity.vectorDimensions),
    identity.vectorMetric,
    identity.normalization ?? "legacy",
    identity.instructionVersion ?? "legacy",
    identity.embeddingSpaceFingerprint ?? "unverified",
    String(identity.dimensionsParam ?? ""),
  ].join("|");
}
