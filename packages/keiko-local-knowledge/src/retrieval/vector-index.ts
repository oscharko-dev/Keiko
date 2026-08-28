import { createHash, randomUUID } from "node:crypto";

import type {
  EmbeddingModelIdentity,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { embeddingIdentityKey } from "@oscharko-dev/keiko-contracts/runtime/vector-index-port";

import {
  readVectorIndexState,
  writeVectorIndexState,
  type VectorIndexStateRecord,
} from "../indexing/vector-index-state.js";
import type { KnowledgeLogSink } from "../knowledge-log.js";
import type { KnowledgeStore } from "../store.js";

import type { RetrievalVectorIndexDiagnostics } from "./types.js";
import {
  clearUsearchAnnCacheForGroup,
  searchUsearchAnnIndex,
  type UsearchAnnSearchResult,
  type UsearchVectorEntry,
} from "./usearch-ann-index.js";

export type VectorIndexMode = "disabled" | "auto" | "usearch";

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
  readonly chunkFilter?: readonly string[];
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
  readonly searchCapsule: (request: VectorIndexSearchRequest) => Promise<VectorIndexSearchResult>;
}

export interface VectorIndexUnexpectedFailureDiagnostic {
  readonly correlationId: string;
  readonly operation: "vector-index.search";
  readonly source: "keiko-local-knowledge.vector-index";
  // The sink owns redaction/classification. This value must never be persisted or logged directly.
  readonly error: unknown;
}

export interface VectorIndexOptions {
  readonly mode?: VectorIndexMode;
  readonly adapter?: VectorIndexAdapter;
  readonly usearchBinaryPath?: string;
  readonly maxIndexedVectorBytes?: number;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly onUnexpectedFailure?: (diagnostic: VectorIndexUnexpectedFailureDiagnostic) => void;
  // Content-free activity log (ADR-0019 seam, `knowledge-log.ts`). Absent → nothing is written.
  // Threaded down to the USearch ANN layer so a fresh native-runtime resolution is visible in
  // `server.log` beside the search that triggered it (Wave 4a, epic #3233 §8).
  readonly logSink?: KnowledgeLogSink;
}

export interface VectorIndexEnvironment {
  readonly KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX?: string;
  readonly KEIKO_USEARCH_BINARY_PATH?: string;
}

interface ResolvedVectorIndexOptions {
  readonly mode: VectorIndexMode;
  readonly adapter?: VectorIndexAdapter;
  readonly usearchBinaryPath?: string;
  readonly maxIndexedVectorBytes: number;
  readonly now: () => number;
  readonly newCorrelationId: () => string;
  readonly onUnexpectedFailure?: (diagnostic: VectorIndexUnexpectedFailureDiagnostic) => void;
  readonly logSink?: KnowledgeLogSink;
}

interface VectorIndexStampRow {
  readonly n: number;
  readonly max_created_at: number | null;
}

interface StoredVectorIdentityRow {
  readonly embedding_model_provider: string;
  readonly embedding_model_id: string;
  readonly embedding_model_revision: string | null;
  readonly embedding_normalization: string | null;
  readonly embedding_instruction_version: string | null;
  readonly embedding_space_fingerprint: string | null;
  readonly embedding_dimensions_param: number | null;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
}

interface StoredVectorRow extends StoredVectorIdentityRow {
  readonly chunk_id: string;
  readonly embedding: Uint8Array;
}

interface CandidateMetadataRow {
  readonly chunk_id: string;
  readonly source_id: string;
}

const USEARCH_PROVIDER = "usearch";
const VECTOR_METRICS = new Set(["cosine", "dot", "euclidean"]);
const VECTOR_NORMALIZATIONS = new Set(["l2", "none", "unknown"]);
const DEFAULT_MAX_INDEX_BYTES = 256 * 1024 * 1024;
const STORE_TAGS = new WeakMap<KnowledgeStore, string>();
let storeTagCounter = 0;

function codeUnitCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sourceFilterClause(sourceFilter: readonly KnowledgeSourceId[] | undefined): string {
  if (sourceFilter === undefined) return "";
  if (sourceFilter.length === 0) return " AND 0";
  return " AND source_id IN (SELECT CAST(value AS TEXT) FROM json_each(:source_filter_json))";
}

function sourceFilterParams(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
): Record<string, string> {
  if (sourceFilter === undefined || sourceFilter.length === 0) return {};
  return { source_filter_json: JSON.stringify(sourceFilter.map(String)) };
}

function chunkFilterClause(chunkFilter: readonly string[] | undefined): string {
  if (chunkFilter === undefined) return "";
  if (chunkFilter.length === 0) return " AND 0";
  return " AND chunk_id IN (SELECT CAST(value AS TEXT) FROM json_each(:chunk_filter_json))";
}

function chunkFilterParams(chunkFilter: readonly string[] | undefined): Record<string, string> {
  if (chunkFilter === undefined || chunkFilter.length === 0) return {};
  return { chunk_filter_json: JSON.stringify(chunkFilter) };
}

function requestParams(request: VectorIndexSearchRequest): Record<string, string> {
  return {
    capsule_id: String(request.capsule.id),
    ...sourceFilterParams(request.sourceFilter),
    ...chunkFilterParams(request.chunkFilter),
  };
}

function requestWhere(request: VectorIndexSearchRequest): string {
  return [
    "capsule_id = :capsule_id",
    sourceFilterClause(request.sourceFilter),
    chunkFilterClause(request.chunkFilter),
  ].join("");
}

function vectorStamp(request: VectorIndexSearchRequest, filtered: boolean): VectorIndexStampRow {
  const where = filtered ? requestWhere(request) : "capsule_id = :capsule_id";
  const row = request.store._internal.db
    .prepare(
      [
        "SELECT COUNT(DISTINCT chunk_id) AS n, MAX(created_at) AS max_created_at",
        "FROM vectors",
        `WHERE ${where}`,
      ].join(" "),
    )
    .get(filtered ? requestParams(request) : { capsule_id: String(request.capsule.id) }) as
    VectorIndexStampRow | undefined;
  return row ?? { n: 0, max_created_at: null };
}

function validStoredIdentityRow(row: StoredVectorIdentityRow): boolean {
  const normalization = row.embedding_normalization;
  return (
    Number.isSafeInteger(row.vector_dimensions) &&
    row.vector_dimensions > 0 &&
    VECTOR_METRICS.has(row.vector_metric) &&
    (normalization === null || VECTOR_NORMALIZATIONS.has(normalization))
  );
}

function identityFromRow(row: StoredVectorIdentityRow): EmbeddingModelIdentity | undefined {
  const normalization = row.embedding_normalization;
  if (!validStoredIdentityRow(row)) return undefined;
  return {
    provider: row.embedding_model_provider,
    modelId: row.embedding_model_id,
    ...(row.embedding_model_revision !== null
      ? { modelRevision: row.embedding_model_revision }
      : {}),
    vectorDimensions: row.vector_dimensions,
    vectorMetric: row.vector_metric as EmbeddingModelIdentity["vectorMetric"],
    ...(normalization !== null
      ? {
          normalization: normalization as NonNullable<EmbeddingModelIdentity["normalization"]>,
        }
      : {}),
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

function storedIdentitiesCompatible(request: VectorIndexSearchRequest): boolean {
  const rows = request.store._internal.db
    .prepare(
      [
        "SELECT DISTINCT embedding_model_provider, embedding_model_id,",
        "  embedding_model_revision, embedding_normalization, embedding_instruction_version,",
        "  embedding_space_fingerprint, embedding_dimensions_param,",
        "  vector_dimensions, vector_metric FROM (",
        "  SELECT *, ROW_NUMBER() OVER (",
        "    PARTITION BY chunk_id ORDER BY created_at DESC, id DESC",
        "  ) AS vector_rank",
        "  FROM vectors",
        "  WHERE capsule_id = :capsule_id",
        ") WHERE vector_rank = 1",
      ].join(" "),
    )
    .all({
      capsule_id: String(request.capsule.id),
    }) as unknown as readonly StoredVectorIdentityRow[];
  return rows.every((row) => {
    const identity = identityFromRow(row);
    return (
      identity !== undefined &&
      embeddingIdentityKey(request.capsule.embeddingModelIdentity) ===
        embeddingIdentityKey(identity)
    );
  });
}

function storedVectorRows(request: VectorIndexSearchRequest): readonly StoredVectorRow[] {
  return request.store._internal.db
    .prepare(
      [
        "SELECT chunk_id, embedding, embedding_model_provider, embedding_model_id,",
        "  embedding_model_revision, embedding_normalization, embedding_instruction_version,",
        "  embedding_space_fingerprint, embedding_dimensions_param,",
        "  vector_dimensions, vector_metric FROM (",
        "  SELECT *, ROW_NUMBER() OVER (",
        "    PARTITION BY chunk_id ORDER BY created_at DESC, id DESC",
        "  ) AS vector_rank",
        "  FROM vectors",
        `  WHERE ${requestWhere(request)}`,
        ") WHERE vector_rank = 1",
        "ORDER BY chunk_id ASC",
      ].join(" "),
    )
    .all(requestParams(request)) as unknown as readonly StoredVectorRow[];
}

function decodeStoredVectors(request: VectorIndexSearchRequest): readonly UsearchVectorEntry[] {
  const expectedBytes =
    request.capsule.embeddingModelIdentity.vectorDimensions * Float32Array.BYTES_PER_ELEMENT;
  return storedVectorRows(request).map((row) => {
    const opened = request.store._internal.contentCipher.openVector(row.embedding, expectedBytes);
    if (opened.byteLength !== expectedBytes) throw new RangeError("stored vector length mismatch");
    const detached = new Uint8Array(opened);
    return {
      id: row.chunk_id,
      vector: new Float32Array(
        detached.buffer,
        detached.byteOffset,
        request.capsule.embeddingModelIdentity.vectorDimensions,
      ),
    };
  });
}

function storeIdentity(store: KnowledgeStore): string {
  const location = store._internal.db.location();
  if (location !== null && location.length > 0 && location !== ":memory:") return location;
  const existing = STORE_TAGS.get(store);
  if (existing !== undefined) return existing;
  storeTagCounter += 1;
  const created = `memory-store-${String(storeTagCounter)}`;
  STORE_TAGS.set(store, created);
  return created;
}

function normalizedFilter(values: readonly string[] | undefined): string | null {
  if (values === undefined) return null;
  const normalized = [...new Set(values)].sort(codeUnitCompare);
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

function capsuleCacheGroup(request: VectorIndexSearchRequest): string {
  return `keiko-vector-cache-group-v2:${createHash("sha256")
    .update(JSON.stringify([storeIdentity(request.store), String(request.capsule.id)]), "utf8")
    .digest("hex")}`;
}

function partitionCacheKey(request: VectorIndexSearchRequest): string {
  return JSON.stringify([
    "keiko-vector-partition-v2",
    capsuleCacheGroup(request),
    normalizedFilter(request.sourceFilter?.map(String)),
    normalizedFilter(request.chunkFilter),
  ]);
}

function revisionFor(request: VectorIndexSearchRequest, stamp: VectorIndexStampRow): string {
  return `keiko-vector-revision-v2:${createHash("sha256")
    .update(
      JSON.stringify([
        embeddingIdentityKey(request.capsule.embeddingModelIdentity),
        stamp.n,
        stamp.max_created_at,
      ]),
      "utf8",
    )
    .digest("hex")}`;
}

function resolvedMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_INDEX_BYTES;
  }
  return Math.min(Math.trunc(value), DEFAULT_MAX_INDEX_BYTES);
}

function parseMode(value: string | undefined): VectorIndexMode {
  if (value === "disabled" || value === "auto" || value === "usearch") return value;
  return "auto";
}

function resolvedUsearchBinaryPath(
  supplied: VectorIndexOptions,
  environment: VectorIndexEnvironment,
): string | undefined {
  if (supplied.usearchBinaryPath !== undefined) return supplied.usearchBinaryPath;
  return environment.KEIKO_USEARCH_BINARY_PATH;
}

export function resolveVectorIndexOptions(
  options: VectorIndexOptions | undefined,
  environment: VectorIndexEnvironment = process.env,
): ResolvedVectorIndexOptions {
  const supplied = options ?? {};
  const mode = parseMode(supplied.mode ?? environment.KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX);
  const usearchBinaryPath = resolvedUsearchBinaryPath(supplied, environment);
  return {
    mode,
    ...(supplied.adapter !== undefined ? { adapter: supplied.adapter } : {}),
    ...(usearchBinaryPath !== undefined ? { usearchBinaryPath } : {}),
    maxIndexedVectorBytes: resolvedMaxBytes(supplied.maxIndexedVectorBytes),
    now: supplied.now ?? Date.now,
    newCorrelationId: supplied.newCorrelationId ?? randomUUID,
    ...(supplied.onUnexpectedFailure !== undefined
      ? { onUnexpectedFailure: supplied.onUnexpectedFailure }
      : {}),
    ...(supplied.logSink !== undefined ? { logSink: supplied.logSink } : {}),
  };
}

function unavailable(
  status: RetrievalVectorIndexDiagnostics["status"],
  reason: string,
  vectorCount?: number,
  correlationId?: string,
): VectorIndexSearchResult {
  return {
    ok: false,
    candidates: [],
    sawDimensionCompatible: false,
    sawIdentityIncompatible: status === "fallback-incompatible-identity",
    diagnostics: {
      provider: USEARCH_PROVIDER,
      status,
      reason,
      ...(vectorCount !== undefined ? { vectorCount } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    },
  };
}

function disabled(): VectorIndexSearchResult {
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

function statusForFailure(
  result: Extract<UsearchAnnSearchResult, { readonly ok: false }>,
): RetrievalVectorIndexDiagnostics["status"] {
  if (result.reason === "index-bytes-over-bound") return "fallback-index-too-large";
  if (result.reason === "unsupported-metric") return "fallback-unsupported-metric";
  if (result.reason === "runtime-unavailable") return "fallback-unavailable";
  if (result.reason === "query-dimension-mismatch") return "fallback-incompatible-identity";
  return "fallback-query-error";
}

function candidateMetadata(
  request: VectorIndexSearchRequest,
  chunkIds: readonly string[],
): ReadonlyMap<string, KnowledgeSourceId> {
  if (chunkIds.length === 0) return new Map();
  const rows = request.store._internal.db
    .prepare(
      [
        "SELECT chunk_id, source_id FROM vectors",
        "WHERE capsule_id = :capsule_id",
        "  AND chunk_id IN (SELECT CAST(value AS TEXT) FROM json_each(:candidate_ids_json))",
      ].join(" "),
    )
    .all({
      capsule_id: String(request.capsule.id),
      candidate_ids_json: JSON.stringify(chunkIds),
    }) as unknown as readonly CandidateMetadataRow[];
  return new Map(rows.map((row) => [row.chunk_id, row.source_id as KnowledgeSourceId]));
}

function successfulResult(
  request: VectorIndexSearchRequest,
  result: Extract<UsearchAnnSearchResult, { readonly ok: true }>,
  vectorCount: number,
): VectorIndexSearchResult {
  const filtered = result.candidates.filter(
    (candidate) => request.minScore === undefined || candidate.score >= request.minScore,
  );
  const metadata = candidateMetadata(
    request,
    filtered.map((candidate) => candidate.id),
  );
  return {
    ok: true,
    candidates: filtered.map((candidate) => {
      const sourceId = metadata.get(candidate.id);
      return {
        chunkId: candidate.id,
        capsuleId: request.capsule.id,
        ...(sourceId !== undefined ? { sourceId } : {}),
        score: candidate.score,
      };
    }),
    sawDimensionCompatible: true,
    sawIdentityIncompatible: false,
    diagnostics: {
      provider: USEARCH_PROVIDER,
      status: "available",
      indexName: usearchIndexName(request.capsule.embeddingModelIdentity),
      vectorCount,
      searchMode: result.mode,
      examinedCandidateCount: result.examinedCandidates,
      estimatedIndexBytes: result.estimatedIndexBytes,
    },
  };
}

function writeIndexState(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  stamp: VectorIndexStampRow,
  status: "ready" | "unavailable",
  reason?: string,
): void {
  const identity = request.capsule.embeddingModelIdentity;
  writeVectorIndexState(request.store._internal.db, {
    capsuleId: request.capsule.id,
    provider: USEARCH_PROVIDER,
    indexName: usearchIndexName(identity),
    vectorDimensions: identity.vectorDimensions,
    vectorMetric: identity.vectorMetric,
    embeddingIdentityKey: embeddingIdentityKey(identity),
    vectorCount: stamp.n,
    vectorMaxCreatedAt: stamp.max_created_at,
    status,
    ...(reason !== undefined ? { reason } : {}),
    updatedAt: options.now(),
  });
}

function vectorIndexState(request: VectorIndexSearchRequest): VectorIndexStateRecord | undefined {
  const identity = request.capsule.embeddingModelIdentity;
  return readVectorIndexState(request.store._internal.db, {
    capsuleId: request.capsule.id,
    provider: USEARCH_PROVIDER,
    indexName: usearchIndexName(identity),
    vectorDimensions: identity.vectorDimensions,
    vectorMetric: identity.vectorMetric,
    embeddingIdentityKey: embeddingIdentityKey(identity),
  });
}

function fullVectorStamp(
  request: VectorIndexSearchRequest,
  state: VectorIndexStateRecord | undefined,
): VectorIndexStampRow {
  // The schema-owned vectors mutation triggers make `ready` a trustworthy constant-time content
  // revision. Missing, dirty, and unavailable states still derive their stamp from stored rows.
  if (state?.status !== "ready") return vectorStamp(request, false);
  return { n: state.vectorCount, max_created_at: state.vectorMaxCreatedAt };
}

function prepareCacheState(
  request: VectorIndexSearchRequest,
  state: VectorIndexStateRecord | undefined,
): void {
  if (state?.status !== "ready") {
    clearUsearchAnnCacheForGroup(capsuleCacheGroup(request));
  }
}

function earlyBuiltInResult(
  request: VectorIndexSearchRequest,
): VectorIndexSearchResult | undefined {
  if (request.chunkFilter?.length === 0 || request.sourceFilter?.length === 0) {
    return successfulResult(
      request,
      {
        ok: true,
        mode: "exact",
        candidates: [],
        examinedCandidates: 0,
        estimatedIndexBytes: 0,
      },
      0,
    );
  }
  if (request.queryVector.length !== request.capsule.embeddingModelIdentity.vectorDimensions) {
    return unavailable("fallback-incompatible-identity", "query-dimension-mismatch");
  }
  return undefined;
}

async function runBuiltInSearch(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  stamp: VectorIndexStampRow,
): Promise<UsearchAnnSearchResult> {
  return await searchUsearchAnnIndex({
    partition: {
      cacheKey: partitionCacheKey(request),
      cacheGroupKey: capsuleCacheGroup(request),
      revision: revisionFor(request, stamp),
      identity: request.capsule.embeddingModelIdentity,
      rowCount: stamp.n,
      loadEntries: () => decodeStoredVectors(request),
    },
    queryVector: request.queryVector,
    candidateLimit: request.candidateLimit,
    ...(options.usearchBinaryPath !== undefined ? { binaryPath: options.usearchBinaryPath } : {}),
    maxIndexBytes: options.maxIndexedVectorBytes,
    ...(options.logSink !== undefined ? { logSink: options.logSink } : {}),
  });
}

function failedBuiltInResult(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
  fullStamp: VectorIndexStampRow,
  filteredStamp: VectorIndexStampRow,
  result: Extract<UsearchAnnSearchResult, { readonly ok: false }>,
): VectorIndexSearchResult {
  const reason =
    result.reason === "partition-load-failed" ? "stored-vector-decrypt-failed" : result.reason;
  writeIndexState(request, options, fullStamp, "unavailable", reason);
  return unavailable(statusForFailure(result), reason, filteredStamp.n);
}

async function searchBuiltIn(
  request: VectorIndexSearchRequest,
  options: ResolvedVectorIndexOptions,
): Promise<VectorIndexSearchResult> {
  const earlyResult = earlyBuiltInResult(request);
  if (earlyResult !== undefined) return earlyResult;
  const state = vectorIndexState(request);
  const fullStamp = fullVectorStamp(request, state);
  prepareCacheState(request, state);
  const filtered = request.sourceFilter !== undefined || request.chunkFilter !== undefined;
  const stamp = filtered ? vectorStamp(request, true) : fullStamp;
  if (state?.status !== "ready" && !storedIdentitiesCompatible(request)) {
    return unavailable("fallback-incompatible-identity", "stored-vector-identity-mismatch");
  }
  const result = await runBuiltInSearch(request, options, stamp);
  if (!result.ok) {
    return failedBuiltInResult(request, options, fullStamp, stamp, result);
  }
  writeIndexState(request, options, fullStamp, "ready");
  return successfulResult(request, result, stamp.n);
}

function reportUnexpectedFailure(options: ResolvedVectorIndexOptions, error: unknown): string {
  const correlationId = options.newCorrelationId();
  try {
    options.onUnexpectedFailure?.({
      correlationId,
      operation: "vector-index.search",
      source: "keiko-local-knowledge.vector-index",
      error,
    });
  } catch {
    // A diagnostic sink failure must not turn a safe brute-force fallback into an unhandled error.
  }
  return correlationId;
}

export async function searchVectorIndex(
  request: VectorIndexSearchRequest,
  options: VectorIndexOptions | undefined,
): Promise<VectorIndexSearchResult> {
  const resolved = resolveVectorIndexOptions(options);
  try {
    if (resolved.adapter !== undefined) return await resolved.adapter.searchCapsule(request);
    if (resolved.mode === "disabled") return disabled();
    return await searchBuiltIn(request, resolved);
  } catch (error) {
    const correlationId = reportUnexpectedFailure(resolved, error);
    return unavailable(
      "fallback-query-error",
      "vector-index-query-failed",
      undefined,
      correlationId,
    );
  }
}

export function usearchIndexName(identity: EmbeddingModelIdentity): string {
  return [
    "keiko-hnsw",
    String(identity.vectorDimensions),
    identity.vectorMetric,
    embeddingIdentityKey(identity),
  ].join(":");
}

export const DEFAULT_MAX_INDEXED_VECTOR_BYTES = DEFAULT_MAX_INDEX_BYTES;
