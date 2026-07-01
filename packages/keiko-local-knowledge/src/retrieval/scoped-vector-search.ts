// Scoped vector search (Epic #189, Issue #199). Given a list of capsule ids and a
// pre-embedded query vector per capsule, returns the ranked top-K `RetrievalReference`
// across the scope. The "no global pool" invariant lives in the SQL: every SELECT
// filters by `capsule_id` and we never join across capsules — so a bug in caller
// composition can never silently leak rows from a capsule outside scope.
//
// Vector blob layout: each row's `embedding` is `vectorDimensions * 4` bytes encoded as
// a little-endian Float32 array (see `floatToBytes` in `../indexing/embedding-batcher.ts`).
// We decode to a `Float32Array` view and compute similarity in-process. This is a
// brute-force O(N·D) scan — that is intentional for the first cut, since capsules are
// expected to be small (≤ a few thousand vectors) and adding an ANN index pulls in a
// native dependency we have explicitly avoided in `@oscharko-dev/keiko-local-knowledge`.

import type {
  CitationReference,
  EmbeddingModelIdentity,
  EmbeddingVectorMetric,
  EmbeddingVectorNormalization,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  assertCompatibleEmbeddingIdentity,
  l2NormalizeVector,
  verifyEmbeddingCapability,
  type OpenAIEmbeddingAdapter,
} from "@oscharko-dev/keiko-model-gateway";

import { getCapsule } from "../capsule-lifecycle.js";
import type { ComposedRetrievalScope } from "../composition.js";
import type { KnowledgeStore } from "../store.js";
import type { StoreContentCipher } from "../store-content-cipher.js";

import { shapeEmbeddingQuery } from "./embedding-query-shaping.js";
import { lexicalQueryTerms } from "./lexical-normalization.js";
import { RetrievalError, type QueryTransformer, type RetrievalDiagnostics } from "./types.js";

const LEXICAL_RECALL_MAX_TERMS = 12;
const LEXICAL_RECALL_MIN_TOKEN_LENGTH = 3;
const EXACT_TERM_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}._:/#-]{2,}/gu;
const BROAD_QUERY_PATTERN =
  /\b(compare|comparez|summari[sz]e|overview|explain|describe|analyse|analyze|erkl[aä]re|ueberblick|überblick|vergleiche|zusammenfassung)\b/iu;
const SEARCH_STOPWORDS = new Set([
  "a",
  "about",
  "and",
  "are",
  "auf",
  "aus",
  "bei",
  "das",
  "der",
  "die",
  "ein",
  "eine",
  "einen",
  "einer",
  "eines",
  "for",
  "from",
  "how",
  "in",
  "ist",
  "mit",
  "of",
  "on",
  "oder",
  "sagen",
  "steht",
  "the",
  "to",
  "und",
  "uber",
  "ueber",
  "über",
  "von",
  "was",
  "what",
  "wie",
  "zu",
  "zum",
  "zur",
]);

// ─── Public input shape ──────────────────────────────────────────────────────
// A pre-built scope (single capsule or composed set) reshaped into the union the search
// needs. `capsuleIds` is non-empty and already contains every capsule the caller wants
// searched — the search NEVER widens this list. `sourceFilter` is an optional restriction
// (used by #200 when the conversation pins the user to a sub-set of the capsule's
// sources).
export interface RetrievalScopeInput {
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly sourceFilter?: readonly KnowledgeSourceId[];
}

export interface SearchOptions {
  readonly topK: number;
  readonly minScore?: number;
  readonly signal?: AbortSignal;
  readonly strategy?: "auto" | "balanced" | "exact" | "broad";
  readonly queryTransformer?: QueryTransformer;
  readonly queryTransformTimeoutMs?: number;
}

interface QueryProfile {
  readonly strategy: "balanced" | "exact" | "broad";
  readonly tokens: readonly string[];
  readonly exactTerms: readonly string[];
  readonly lexicalRecallTerms: readonly string[];
  readonly documentDiversityPenalty: number;
  readonly sectionDiversityPenalty: number;
}

// ─── Compose a scope object from either `ComposedRetrievalScope` or a single capsule ────
export function toScopeInput(
  scope: ComposedRetrievalScope | { readonly capsuleId: KnowledgeCapsuleId },
): RetrievalScopeInput {
  if ("capsuleId" in scope) {
    return { capsuleIds: [scope.capsuleId] };
  }
  return { capsuleIds: scope.capsuleIds, sourceFilter: scope.sourceIds };
}

// ─── Vector row reader ───────────────────────────────────────────────────────
interface VectorRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly document_id: string;
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

interface DecodedVectorRow extends Omit<VectorRow, "embedding"> {
  readonly vector: Float32Array;
}

interface VectorCacheStampRow {
  readonly n: number;
  readonly max_created_at: number | null;
}

const SELECT_VECTORS_FOR_CAPSULE_SQL = [
  "SELECT chunk_id, capsule_id, source_id, document_id, embedding,",
  "  embedding_model_provider, embedding_model_id, embedding_model_revision,",
  "  embedding_normalization, embedding_instruction_version, embedding_space_fingerprint,",
  "  embedding_dimensions_param, vector_dimensions, vector_metric, created_at",
  "FROM vectors",
  "WHERE capsule_id = :c",
].join(" ");

const SELECT_VECTOR_CACHE_STAMP_SQL = [
  "SELECT COUNT(*) AS n, MAX(created_at) AS max_created_at",
  "FROM vectors",
  "WHERE capsule_id = :c",
].join(" ");

const DECODED_VECTOR_CACHE = new WeakMap<KnowledgeStore, Map<string, readonly DecodedVectorRow[]>>();

function readVectorsForCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter?: readonly KnowledgeSourceId[],
): readonly VectorRow[] {
  if (sourceFilter?.length === 0) return [];
  const params: Record<string, string> = { c: String(capsuleId) };
  const sourceClause =
    sourceFilter === undefined
      ? ""
      : ` AND source_id IN (${sourceFilter.map((_, i) => `:s${String(i)}`).join(", ")})`;
  if (sourceFilter !== undefined) {
    for (let i = 0; i < sourceFilter.length; i += 1) {
      params[`s${String(i)}`] = String(sourceFilter[i]);
    }
  }
  return store._internal.db
    .prepare(`${SELECT_VECTORS_FOR_CAPSULE_SQL}${sourceClause}`)
    .all(params) as unknown as readonly VectorRow[];
}

function vectorCacheStamp(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): VectorCacheStampRow {
  return store._internal.db
    .prepare(SELECT_VECTOR_CACHE_STAMP_SQL)
    .get({ c: String(capsuleId) }) as unknown as VectorCacheStampRow;
}

function decodeCacheForStore(store: KnowledgeStore): Map<string, readonly DecodedVectorRow[]> {
  const cached = DECODED_VECTOR_CACHE.get(store);
  if (cached !== undefined) return cached;
  const created = new Map<string, readonly DecodedVectorRow[]>();
  DECODED_VECTOR_CACHE.set(store, created);
  return created;
}

function decodeCacheKey(
  capsule: KnowledgeCapsule,
  stamp: VectorCacheStampRow,
): string {
  return [
    String(capsule.id),
    identityKey(capsule.embeddingModelIdentity),
    String(stamp.n),
    String(stamp.max_created_at ?? 0),
  ].join("|");
}

function readDecodedVectorsForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
): readonly DecodedVectorRow[] {
  if (sourceFilter?.length === 0) return [];
  const stamp = vectorCacheStamp(store, capsule.id);
  if (stamp.n === 0) return [];
  const cache = decodeCacheForStore(store);
  const key = decodeCacheKey(capsule, stamp);
  let rows = cache.get(key);
  if (rows === undefined) {
    rows = readVectorsForCapsule(store, capsule.id).map((row) => ({
      ...row,
      vector: normalizeVectorForIdentity(
        decodeEmbedding(row, store._internal.contentCipher),
        capsule.embeddingModelIdentity,
      ),
    }));
    cache.set(key, rows);
  }
  if (sourceFilter === undefined) return rows;
  const allowed = new Set(sourceFilter.map(String));
  return rows.filter((row) => allowed.has(row.source_id));
}

// ─── Citation row reader ─────────────────────────────────────────────────────
// One LEFT JOIN against documents (for the safe display name) + parsed_units (for the
// page/section/character span). All filtered by `capsule_id` so an upstream FK violation
// cannot cross tenants. The `chunk_id IN (…)` list is bounded by the surviving top-K
// candidate set, so the IN clause is never larger than `topK * scope.capsuleIds.length`.
interface CitationRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly safe_display_name: string | null;
  readonly page_number: number | null;
  readonly page_label: string | null;
  readonly section_path_json: string | null;
  readonly json_pointer: string | null;
  readonly table_name: string | null;
  readonly row_index: number | null;
  readonly character_start: number | null;
  readonly character_end: number | null;
}

function readCitationRows(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkIds: readonly string[],
): readonly CitationRow[] {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map((_, i) => `:c${String(i)}`).join(", ");
  const sql = [
    "SELECT c.id AS chunk_id, c.capsule_id, c.source_id, c.document_id,",
    "  d.safe_display_name AS safe_display_name,",
    "  COALESCE(pu.page_number, (",
    "    SELECT p.page_number FROM pages p",
    "    WHERE p.capsule_id = c.capsule_id AND p.document_id = c.document_id",
    "      AND p.character_end > p.character_start",
    "      AND p.character_start <= COALESCE(c.character_end, pu.character_end)",
    "      AND p.character_end >= COALESCE(c.character_start, pu.character_start)",
    "    ORDER BY p.page_number ASC LIMIT 1",
    "  )) AS page_number,",
    "  COALESCE(pu.page_label, (",
    "    SELECT p.page_label FROM pages p",
    "    WHERE p.capsule_id = c.capsule_id AND p.document_id = c.document_id",
    "      AND p.character_end > p.character_start",
    "      AND p.character_start <= COALESCE(c.character_end, pu.character_end)",
    "      AND p.character_end >= COALESCE(c.character_start, pu.character_start)",
    "    ORDER BY p.page_number ASC LIMIT 1",
    "  )) AS page_label,",
    "  COALESCE(pu.section_path_json, pu.heading_path_json) AS section_path_json,",
    "  pu.json_pointer, pu.table_name, pu.row_index,",
    "  COALESCE(c.character_start, pu.character_start) AS character_start,",
    "  COALESCE(c.character_end, pu.character_end) AS character_end",
    "FROM chunks c",
    "LEFT JOIN documents d ON d.capsule_id = c.capsule_id AND d.id = c.document_id",
    "LEFT JOIN parsed_units pu",
    "  ON pu.capsule_id = c.capsule_id AND pu.id = c.parsed_unit_id",
    `WHERE c.capsule_id = :cap AND c.id IN (${placeholders})`,
  ].join(" ");

  const params: Record<string, string> = { cap: String(capsuleId) };
  for (let i = 0; i < chunkIds.length; i += 1) {
    params[`c${String(i)}`] = chunkIds[i] ?? "";
  }
  const rows = store._internal.db.prepare(sql).all(params);
  return rows as unknown as readonly CitationRow[];
}

// ─── Similarity primitives ───────────────────────────────────────────────────
// Float32 decode. The row blob is a fresh-copied Uint8Array; we wrap it in a Float32Array
// view backed by the same ArrayBuffer. The byteLength must be exactly `dims * 4` — a
// length mismatch indicates DB corruption and we surface a `RetrievalError`.
function decodeEmbedding(row: VectorRow, cipher: StoreContentCipher): Float32Array {
  const embedding = cipher.openVector(row.embedding, row.vector_dimensions * 4);
  if (embedding.byteLength !== row.vector_dimensions * 4) {
    throw new RetrievalError(
      "STORE_READ_FAILED",
      "vector blob length does not match vector_dimensions",
    );
  }
  const copy = new Uint8Array(embedding); // detach from sqlite row buffer / decrypted envelope
  return new Float32Array(copy.buffer, copy.byteOffset, row.vector_dimensions);
}

function shouldL2Normalize(identity: EmbeddingModelIdentity): boolean {
  return identity.normalization === undefined || identity.normalization === "l2";
}

function normalizeVectorForIdentity(
  vector: Float32Array,
  identity: EmbeddingModelIdentity,
): Float32Array {
  return shouldL2Normalize(identity) ? l2NormalizeVector(vector) : new Float32Array(vector);
}

// `noUncheckedIndexedAccess` widens `Float32Array[i]` to `number | undefined`; the loop
// stays in-bounds by construction (`i < a.length`), so we narrow with `?? 0` rather than
// a `!` assertion (forbidden by the project's lint rule) — at this index the value is
// always a real Float32 lane, never absent.
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

// Negated Euclidean distance so higher = closer (uniform "score-desc" sort with the
// other two metrics). Documented in the function name; consumers never see the raw
// distance — only the unified score.
function negativeEuclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return -Math.sqrt(sum);
}

function scoreFor(
  metric: EmbeddingVectorMetric,
  query: Float32Array,
  vector: Float32Array,
): number {
  if (metric === "cosine") return cosineSimilarity(query, vector);
  if (metric === "dot") return dotProduct(query, vector);
  return negativeEuclideanDistance(query, vector);
}

// ─── Query embedding ─────────────────────────────────────────────────────────
// Embeds the query once per distinct embedding identity in scope. Different capsules can
// pin different embedding models (#192 invariant), so we cache by the identity tuple to
// avoid duplicate adapter calls when two capsules share the same identity. Returns the
// vector and the dimension the adapter actually produced — the dim is compared to each
// capsule's `vectorDimensions` before any similarity is computed.
interface EmbeddedQuery {
  readonly vector: Float32Array;
  readonly dimensions: number;
}

function identityKey(identity: EmbeddingModelIdentity): string {
  // modelRevision intentionally excluded — two capsules sharing structural identity
  // tuple share an embedding even if one has been re-validated with a new revision.
  // Hardening fields are included because normalization, instruction shaping, and
  // embedding-space fingerprint define whether vectors can be compared safely.
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

function queryEmbeddingCacheKey(identity: EmbeddingModelIdentity, query: string): string {
  return `${identityKey(identity)}\u0000${query}`;
}

function queryOutcomeIdentity(
  stored: EmbeddingModelIdentity,
  dimensions: number,
  modelId: string,
  modelRevision: string | undefined,
): EmbeddingModelIdentity {
  const revision = modelRevision ?? (modelId === stored.modelId ? undefined : modelId);
  return {
    provider: stored.provider,
    modelId: stored.modelId,
    vectorDimensions: dimensions,
    vectorMetric: stored.vectorMetric,
    ...(revision !== undefined ? { modelRevision: revision } : {}),
    ...(stored.normalization !== undefined ? { normalization: stored.normalization } : {}),
    ...(stored.instructionVersion !== undefined
      ? { instructionVersion: stored.instructionVersion }
      : {}),
    ...(stored.embeddingSpaceFingerprint !== undefined
      ? { embeddingSpaceFingerprint: stored.embeddingSpaceFingerprint }
      : {}),
    ...(stored.dimensionsParam !== undefined ? { dimensionsParam: stored.dimensionsParam } : {}),
  };
}

async function embedQueryFor(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  text: string,
  signal: AbortSignal | undefined,
): Promise<EmbeddedQuery | RetrievalError> {
  const outcome = await adapter.request({
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    ...(adapter.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: adapter.apiKeyHeaderName }
      : {}),
    modelId: identity.modelId,
    input: shapeEmbeddingQuery(identity, text),
    ...(identity.dimensionsParam !== undefined ? { dimensions: identity.dimensionsParam } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!outcome.ok) {
    return new RetrievalError(
      "EMBEDDING_ADAPTER_FAILED",
      `embedding adapter returned ${outcome.kind}`,
    );
  }
  const current = queryOutcomeIdentity(
    identity,
    outcome.value.vector.length,
    outcome.value.modelId,
    outcome.value.modelRevision,
  );
  const compatibility = assertCompatibleEmbeddingIdentity(identity, current);
  if (!compatibility.ok) {
    return new RetrievalError(
      "INCOMPATIBLE_EMBEDDING_IDENTITY",
      "embedding model identity changed — existing capsule vectors require re-indexing",
    );
  }
  return {
    vector: normalizeVectorForIdentity(outcome.value.vector, identity),
    dimensions: outcome.value.vector.length,
  };
}

// ─── Citation builder ────────────────────────────────────────────────────────
function parseSectionPath(
  json: string | null,
  cipher: StoreContentCipher,
): readonly string[] | undefined {
  if (json === null) return undefined;
  const opened = cipher.openText(json);
  try {
    const parsed = JSON.parse(opened) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") return undefined;
      out.push(item);
    }
    return out;
  } catch {
    return undefined;
  }
}

function rowToCitation(row: CitationRow, cipher: StoreContentCipher): CitationReference {
  const sectionPath = parseSectionPath(row.section_path_json, cipher);
  // Build the citation without `undefined` literals to keep `exactOptionalPropertyTypes`
  // happy. The contract permits omission of each optional field but rejects the explicit
  // `undefined` value.
  return {
    documentId: row.document_id as CitationReference["documentId"],
    capsuleId: row.capsule_id as CitationReference["capsuleId"],
    sourceId: row.source_id as CitationReference["sourceId"],
    chunkId: row.chunk_id as CitationReference["chunkId"],
    safeDisplayName: row.safe_display_name ?? row.document_id,
    ...(row.page_number !== null ? { pageNumber: row.page_number } : {}),
    ...(row.page_label !== null ? { pageLabel: row.page_label } : {}),
    ...(sectionPath !== undefined ? { sectionPath } : {}),
    ...(row.json_pointer !== null ? { jsonPointer: row.json_pointer } : {}),
    ...(row.table_name !== null ? { tableName: row.table_name } : {}),
    ...(row.row_index !== null ? { rowIndex: row.row_index } : {}),
    ...(row.character_start !== null ? { characterStart: row.character_start } : {}),
    ...(row.character_end !== null ? { characterEnd: row.character_end } : {}),
  };
}

// ─── Candidate selection + fusion ────────────────────────────────────────────
// Dense and lexical rankings stay separate until reciprocal-rank fusion. Dense scores remain
// vector-space scores; BM25 scores remain SQLite FTS scores where lower is better. The final
// `score` exposed on references is the RRF score, not an additive cosine/BM25 blend.
interface DenseCandidate {
  readonly chunkId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly score: number;
}

interface CapsuleScoreResult {
  readonly candidates: readonly DenseCandidate[];
  readonly sawDimensionCompatible: boolean;
  readonly sawIdentityIncompatible: boolean;
}

interface LexicalCandidate {
  readonly chunkId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly bm25Score: number;
}

interface FusedCandidate {
  readonly chunkId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly score: number;
  readonly provenance: "dense" | "lexical" | "both";
  readonly denseRank?: number;
  readonly denseScore?: number;
  readonly lexicalRank?: number;
  readonly lexicalBm25Score?: number;
}

const RRF_K = 60;
const LEXICAL_CANDIDATE_LIMIT = 100;
const QUERY_TRANSFORM_MAX_VARIANTS = 4;
const QUERY_TRANSFORM_TIMEOUT_MS = 750;

function vectorMetricFromRow(value: string): EmbeddingVectorMetric | undefined {
  if (value === "cosine" || value === "dot" || value === "euclidean") return value;
  return undefined;
}

function normalizationFromRow(value: string | null): EmbeddingVectorNormalization | undefined {
  if (value === "l2" || value === "none" || value === "unknown") return value;
  return undefined;
}

function identityFromVectorRow(row: DecodedVectorRow): EmbeddingModelIdentity | undefined {
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

function scoreCapsuleVectors(
  rows: readonly DecodedVectorRow[],
  capsule: KnowledgeCapsule,
  queryVector: Float32Array,
  candidateLimit: number,
  minScore: number | undefined,
): CapsuleScoreResult {
  const metric = capsule.embeddingModelIdentity.vectorMetric;
  const scored: DenseCandidate[] = [];
  let sawDimensionCompatible = false;
  let sawIdentityIncompatible = false;
  for (const row of rows) {
    // Belt-and-braces: the SQL filter already restricts to `capsule_id = capsule.id`, but
    // we re-assert at decode time so an arbitrary store-bypass cannot leak a row.
    if (row.capsule_id !== String(capsule.id)) continue;
    const rowIdentity = identityFromVectorRow(row);
    if (
      rowIdentity === undefined ||
      !assertCompatibleEmbeddingIdentity(capsule.embeddingModelIdentity, rowIdentity).ok
    ) {
      sawIdentityIncompatible = true;
      continue;
    }
    if (row.vector_dimensions !== queryVector.length) continue;
    sawDimensionCompatible = true;
    const score = scoreFor(metric, queryVector, row.vector);
    if (minScore !== undefined && score < minScore) continue;
    scored.push({ chunkId: row.chunk_id, capsuleId: capsule.id, score });
  }
  scored.sort(scoreDesc);
  return {
    candidates: scored.slice(0, candidateLimit),
    sawDimensionCompatible,
    sawIdentityIncompatible,
  };
}

interface LexicalIndexCandidateRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly bm25_score: number;
}

interface LexicalIndexCountRow {
  readonly n: number;
}

function sourceFilterClause(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  qualifier: string,
): string {
  if (sourceFilter === undefined) return "";
  if (sourceFilter.length === 0) return " AND 0";
  return ` AND ${qualifier}source_id IN (${sourceFilter
    .map((_, i) => `:source${String(i)}`)
    .join(", ")})`;
}

function sourceParams(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (sourceFilter !== undefined) {
    for (let i = 0; i < sourceFilter.length; i += 1) {
      params[`source${String(i)}`] = String(sourceFilter[i]);
    }
  }
  return params;
}

function countLexicalRowsForCapsuleScope(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
): number {
  const row = store._internal.db
    .prepare(
      [
        "SELECT COUNT(*) AS n",
        "FROM chunk_lexical_index AS li",
        `WHERE li.capsule_id = :capsule_id${sourceFilterClause(sourceFilter, "li.")}`,
      ].join(" "),
    )
    .get({ capsule_id: String(capsuleId), ...sourceParams(sourceFilter) }) as
    LexicalIndexCountRow | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

function lexicalFtsSql(sourceFilter: readonly KnowledgeSourceId[] | undefined): string {
  return [
    "SELECT li.chunk_id AS chunk_id, li.capsule_id AS capsule_id,",
    "  bm25(chunk_lexical_fts) AS bm25_score",
    "FROM chunk_lexical_fts",
    "JOIN chunk_lexical_index AS li ON li.rowid = chunk_lexical_fts.rowid",
    `WHERE chunk_lexical_fts MATCH :match AND li.capsule_id = :capsule_id${sourceFilterClause(
      sourceFilter,
      "li.",
    )}`,
    "ORDER BY bm25_score ASC, li.chunk_id ASC",
    "LIMIT :limit",
  ].join(" ");
}

function escapeFtsPhrase(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function buildFtsMatchQuery(profile: QueryProfile): string | undefined {
  const terms = profile.lexicalRecallTerms.slice(0, LEXICAL_RECALL_MAX_TERMS);
  if (terms.length === 0) return undefined;
  const operator = profile.strategy === "broad" ? " OR " : " AND ";
  return terms.map(escapeFtsPhrase).join(operator);
}

function readFtsCandidatesForCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  matchQuery: string,
  limit: number,
): readonly LexicalCandidate[] {
  const rows = store._internal.db.prepare(lexicalFtsSql(sourceFilter)).all({
    capsule_id: String(capsuleId),
    match: matchQuery,
    limit,
    ...sourceParams(sourceFilter),
  }) as unknown as readonly LexicalIndexCandidateRow[];
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    bm25Score: row.bm25_score,
  }));
}

function exactLexicalSql(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  exactTerms: readonly string[],
): string {
  const exactClause =
    exactTerms.length === 0
      ? "0"
      : exactTerms.map((_, i) => `instr(lower(li.exact_text), :exact${String(i)}) > 0`).join(" OR ");
  return [
    "SELECT li.chunk_id AS chunk_id, li.capsule_id AS capsule_id, 0 AS bm25_score",
    "FROM chunk_lexical_index AS li",
    `WHERE li.capsule_id = :capsule_id${sourceFilterClause(
      sourceFilter,
      "li.",
    )} AND (${exactClause})`,
    "ORDER BY li.chunk_id ASC",
    "LIMIT :limit",
  ].join(" ");
}

function readExactLexicalCandidatesForCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  exactTerms: readonly string[],
  limit: number,
): readonly LexicalCandidate[] {
  if (exactTerms.length === 0) return [];
  const exactParams = Object.fromEntries(
    exactTerms.map((term, i) => [`exact${String(i)}`, term.toLocaleLowerCase("und")]),
  );
  const rows = store._internal.db.prepare(exactLexicalSql(sourceFilter, exactTerms)).all({
    capsule_id: String(capsuleId),
    limit,
    ...sourceParams(sourceFilter),
    ...exactParams,
  }) as unknown as readonly LexicalIndexCandidateRow[];
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    bm25Score: row.bm25_score,
  }));
}

interface LexicalCollection {
  readonly candidates: readonly LexicalCandidate[];
  readonly indexedRowCount: number;
  readonly queryError: boolean;
}

function lexicalCandidateLimit(topK: number): number {
  return Math.max(topK, Math.min(LEXICAL_CANDIDATE_LIMIT, topK * 10));
}

function collectLexicalCandidatesForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  profile: QueryProfile,
  limit: number,
): { readonly candidates: readonly LexicalCandidate[]; readonly indexedRowCount: number } {
  const indexedRowCount = countLexicalRowsForCapsuleScope(store, capsule.id, sourceFilter);
  if (indexedRowCount === 0) return { candidates: [], indexedRowCount };
  const byKey = new Map<string, LexicalCandidate>();
  const matchQuery = buildFtsMatchQuery(profile);
  if (matchQuery !== undefined) {
    for (const candidate of readFtsCandidatesForCapsule(
      store,
      capsule.id,
      sourceFilter,
      matchQuery,
      limit,
    )) {
      byKey.set(`${String(candidate.capsuleId)}|${candidate.chunkId}`, candidate);
    }
  }
  for (const candidate of readExactLexicalCandidatesForCapsule(
    store,
    capsule.id,
    sourceFilter,
    profile.exactTerms.filter(isStrongLexicalRecallTerm),
    limit,
  )) {
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  return { candidates: [...byKey.values()].slice(0, limit), indexedRowCount };
}

function collectLexicalCandidates(
  store: KnowledgeStore,
  capsules: readonly KnowledgeCapsule[],
  scope: RetrievalScopeInput,
  profile: QueryProfile,
  topK: number,
): LexicalCollection {
  const limit = lexicalCandidateLimit(topK);
  const out: LexicalCandidate[] = [];
  let indexedRowCount = 0;
  try {
    for (const capsule of capsules) {
      const collected = collectLexicalCandidatesForCapsule(
        store,
        capsule,
        sourceFilterForCapsule(scope.sourceFilter, capsule),
        profile,
        limit,
      );
      indexedRowCount += collected.indexedRowCount;
      out.push(...collected.candidates);
      if (out.length >= limit) break;
    }
  } catch {
    return { candidates: [], indexedRowCount, queryError: true };
  }
  return { candidates: out.slice(0, limit), indexedRowCount, queryError: false };
}

function oversampleTopK(topK: number, profile: QueryProfile): number {
  const multiplier = profile.strategy === "exact" ? 12 : profile.strategy === "broad" ? 10 : 8;
  const cap = profile.strategy === "exact" ? topK + 96 : topK + 64;
  return Math.max(topK, Math.min(topK * multiplier, cap));
}

function scoreDesc(
  a: { readonly score: number; readonly chunkId: string },
  b: { readonly score: number; readonly chunkId: string },
): number {
  if (b.score !== a.score) return b.score - a.score;
  // Stable tiebreak by chunkId so reordering of equal-score rows is deterministic across
  // platforms — important for the snapshot tests in #200.
  return a.chunkId.localeCompare(b.chunkId);
}

function bm25Asc(a: LexicalCandidate, b: LexicalCandidate): number {
  if (a.bm25Score !== b.bm25Score) return a.bm25Score - b.bm25Score;
  return a.chunkId.localeCompare(b.chunkId);
}

function provenanceRank(candidate: FusedCandidate): number {
  if (candidate.provenance === "both") return 0;
  if (candidate.provenance === "lexical") return 1;
  return 2;
}

function fusedScoreDesc(a: FusedCandidate, b: FusedCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const provenance = provenanceRank(a) - provenanceRank(b);
  if (provenance !== 0) return provenance;
  return a.chunkId.localeCompare(b.chunkId);
}

function rrf(rank: number): number {
  return 1 / (RRF_K + rank);
}

function upsertFusedCandidate(
  byKey: Map<string, FusedCandidate>,
  key: string,
  patch: Partial<FusedCandidate> & Pick<FusedCandidate, "chunkId" | "capsuleId">,
  increment: number,
): void {
  const existing = byKey.get(key);
  if (existing === undefined) {
    byKey.set(key, {
      chunkId: patch.chunkId,
      capsuleId: patch.capsuleId,
      score: increment,
      provenance: patch.denseRank === undefined ? "lexical" : "dense",
      ...(patch.denseRank !== undefined ? { denseRank: patch.denseRank } : {}),
      ...(patch.denseScore !== undefined ? { denseScore: patch.denseScore } : {}),
      ...(patch.lexicalRank !== undefined ? { lexicalRank: patch.lexicalRank } : {}),
      ...(patch.lexicalBm25Score !== undefined
        ? { lexicalBm25Score: patch.lexicalBm25Score }
        : {}),
    });
    return;
  }
  byKey.set(key, {
    ...existing,
    ...patch,
    score: existing.score + increment,
    provenance: "both",
  });
}

function fuseCandidates(
  denseCandidates: readonly DenseCandidate[],
  lexicalCandidates: readonly LexicalCandidate[],
  limit: number,
): readonly FusedCandidate[] {
  const byKey = new Map<string, FusedCandidate>();
  const rankedDense = [...dedupeDenseCandidates(denseCandidates)].sort(scoreDesc);
  rankedDense.forEach((candidate, index) => {
    const rank = index + 1;
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    upsertFusedCandidate(
      byKey,
      key,
      {
        chunkId: candidate.chunkId,
        capsuleId: candidate.capsuleId,
        denseRank: rank,
        denseScore: candidate.score,
      },
      rrf(rank),
    );
  });
  const rankedLexical = [...dedupeLexicalCandidates(lexicalCandidates)].sort(bm25Asc);
  rankedLexical.forEach((candidate, index) => {
    const rank = index + 1;
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    upsertFusedCandidate(
      byKey,
      key,
      {
        chunkId: candidate.chunkId,
        capsuleId: candidate.capsuleId,
        lexicalRank: rank,
        lexicalBm25Score: candidate.bm25Score,
      },
      rrf(rank),
    );
  });
  return [...byKey.values()].sort(fusedScoreDesc).slice(0, limit);
}

function dedupeDenseCandidates(candidates: readonly DenseCandidate[]): readonly DenseCandidate[] {
  const byKey = new Map<string, DenseCandidate>();
  for (const candidate of candidates) {
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    const existing = byKey.get(key);
    if (existing === undefined || candidate.score > existing.score) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

function dedupeLexicalCandidates(
  candidates: readonly LexicalCandidate[],
): readonly LexicalCandidate[] {
  const byKey = new Map<string, LexicalCandidate>();
  for (const candidate of candidates) {
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    const existing = byKey.get(key);
    if (existing === undefined || candidate.bm25Score < existing.bm25Score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function uniqueQueries(queries: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const trimmed = query.trim();
    if (trimmed.length === 0) continue;
    const key = normaliseForSearch(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function withQueryTransformTimeout(
  promise: Promise<readonly string[]>,
  timeoutMs: number,
): Promise<readonly string[] | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function searchQueriesFor(
  query: string,
  profile: QueryProfile,
  options: SearchOptions,
): Promise<readonly string[]> {
  if (profile.strategy !== "broad" || options.queryTransformer === undefined) return [query];
  const variants = await withQueryTransformTimeout(
    options.queryTransformer.rewrite({
      query,
      strategy: "broad",
      maxVariants: QUERY_TRANSFORM_MAX_VARIANTS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }),
    options.queryTransformTimeoutMs ?? QUERY_TRANSFORM_TIMEOUT_MS,
  );
  if (variants === undefined) return [query];
  return uniqueQueries([query, ...variants]).slice(0, QUERY_TRANSFORM_MAX_VARIANTS);
}

function mergeLexicalCollections(collections: readonly LexicalCollection[]): LexicalCollection {
  let indexedRowCount = 0;
  let queryError = false;
  const candidates: LexicalCandidate[] = [];
  for (const collection of collections) {
    indexedRowCount = Math.max(indexedRowCount, collection.indexedRowCount);
    queryError ||= collection.queryError;
    candidates.push(...collection.candidates);
  }
  return {
    candidates: dedupeLexicalCandidates(candidates),
    indexedRowCount,
    queryError,
  };
}

// ─── Main entry point ────────────────────────────────────────────────────────
// `searchVectorsForScope` keeps the retrieval legs separate until fusion:
//   1. Resolve every in-scope capsule (skip ids that no longer exist).
//   2. Embed the query once per distinct identity tuple.
//   3. Per capsule: read vectors, dense-score, and keep dense candidates.
//   4. Query the SQLite FTS5/BM25 lexical index independently.
//   5. Fuse dense rank + lexical BM25 rank with RRF.
//   6. Read citation metadata for the surviving fused candidates.
//
// Returns either the ranked references or a structured failure reason — never throws on
// expected paths (embedding failure, dim mismatch). Throws `RetrievalError` only on
// store-corruption invariants (e.g. blob length mismatch).
export interface SearchOutcome {
  readonly references: readonly RetrievalReference[];
  // Set when the search produced no references for a reason the runner needs to
  // discriminate. `noEvidence` mirrors `RetrievalResult` (same vocabulary).
  readonly noEvidenceReason?:
    "no-vectors" | "incompatible-embedding-identity" | "below-min-score" | "embedding-failed";
  // True when the embedding adapter failed for at least one capsule but lexical
  // candidates kept the result non-empty. Observability signal only — does not
  // change which references are returned.
  readonly embeddingDegraded?: true;
  readonly diagnostics: RetrievalDiagnostics;
}

// Tracks the accumulated state of a single search pass. Hoisted out of the entry function
// so the orchestrator stays under the cyclomatic-complexity budget (the per-capsule loop
// has 4 distinct branches; bundling them into one function pushes it past the lint cap).
interface SearchState {
  readonly candidates: DenseCandidate[];
  anyVectorSeen: boolean;
  anyDimensionCompatible: boolean;
  anyIdentityIncompatible: boolean;
  embeddingFailed: boolean;
}

function emptyState(): SearchState {
  return {
    candidates: [],
    anyVectorSeen: false,
    anyDimensionCompatible: false,
    anyIdentityIncompatible: false,
    embeddingFailed: false,
  };
}

type IdentityPreflightResult = "ok" | "incompatible" | "failed";

async function ensureIdentityPreflight(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  signal: AbortSignal | undefined,
  cache: Map<string, IdentityPreflightResult>,
): Promise<IdentityPreflightResult> {
  if (identity.embeddingSpaceFingerprint === undefined) return "ok";
  const key = identityKey(identity);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const checked = await verifyEmbeddingCapability(adapter, {
    modelId: identity.modelId,
    provider: identity.provider,
    vectorMetric: identity.vectorMetric,
    expectedDimensions: identity.vectorDimensions,
    ...(identity.dimensionsParam !== undefined ? { dimensionsParam: identity.dimensionsParam } : {}),
    ...(identity.normalization !== undefined ? { normalization: identity.normalization } : {}),
    ...(identity.instructionVersion !== undefined
      ? { instructionVersion: identity.instructionVersion }
      : {}),
    includeSpaceFingerprint: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  let result: IdentityPreflightResult;
  if (!checked.ok) {
    result = checked.reason === "dimension-mismatch" ? "incompatible" : "failed";
  } else {
    result = assertCompatibleEmbeddingIdentity(identity, checked.identity).ok
      ? "ok"
      : "incompatible";
  }
  cache.set(key, result);
  return result;
}

// eslint-disable-next-line max-lines-per-function
async function processCapsule(
  store: KnowledgeStore,
  embeddingAdapter: OpenAIEmbeddingAdapter,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  query: string,
  options: SearchOptions,
  profile: QueryProfile,
  cache: Map<string, EmbeddedQuery>,
  preflightCache: Map<string, IdentityPreflightResult>,
  state: SearchState,
): Promise<void> {
  const rows = readDecodedVectorsForCapsule(store, capsule, sourceFilter);
  if (rows.length === 0) return;
  state.anyVectorSeen = true;

  const preflight = await ensureIdentityPreflight(
    embeddingAdapter,
    capsule.embeddingModelIdentity,
    options.signal,
    preflightCache,
  );
  if (preflight === "incompatible") {
    state.anyIdentityIncompatible = true;
    return;
  }
  if (preflight === "failed") {
    state.embeddingFailed = true;
    return;
  }

  const embedded = await ensureQueryEmbedded(
    embeddingAdapter,
    capsule.embeddingModelIdentity,
    query,
    options.signal,
    cache,
  );
  if (embedded instanceof RetrievalError) {
    if (embedded.code === "INCOMPATIBLE_EMBEDDING_IDENTITY") {
      state.anyIdentityIncompatible = true;
    } else {
      state.embeddingFailed = true;
    }
    return;
  }
  if (embedded === undefined) {
    state.embeddingFailed = true;
    return;
  }
  if (embedded.dimensions !== capsule.embeddingModelIdentity.vectorDimensions) {
    // Adapter returned a dim that doesn't match the capsule's pinned identity — same
    // failure surface as #192's `INCOMPATIBLE_EMBEDDING_IDENTITY`. Skip this capsule.
    state.anyIdentityIncompatible = true;
    return;
  }
  const scored = scoreCapsuleVectors(
    rows,
    capsule,
    embedded.vector,
    oversampleTopK(options.topK, profile),
    options.minScore,
  );
  if (scored.sawIdentityIncompatible) state.anyIdentityIncompatible = true;
  if (scored.sawDimensionCompatible) state.anyDimensionCompatible = true;
  state.candidates.push(...scored.candidates);
}

async function ensureQueryEmbedded(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  query: string,
  signal: AbortSignal | undefined,
  cache: Map<string, EmbeddedQuery>,
): Promise<EmbeddedQuery | RetrievalError | undefined> {
  const key = queryEmbeddingCacheKey(identity, query);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await embedQueryFor(adapter, identity, query, signal);
  if (result instanceof RetrievalError) return result;
  cache.set(key, result);
  return result;
}

// Closed enumeration of the failure surfaces produced by the search. Lifted to a type
// alias so `selectTopCandidates` can return either the surviving list or one of these
// reasons without the loose RetrievalReference shape leaking.
type EmptyReason =
  "no-vectors" | "incompatible-embedding-identity" | "below-min-score" | "embedding-failed";

type CandidateSelection =
  | { readonly ok: true; readonly top: readonly FusedCandidate[] }
  | { readonly ok: false; readonly reason: EmptyReason };

function selectTopCandidates(
  state: SearchState,
  candidates: readonly FusedCandidate[],
): CandidateSelection {
  if (state.anyIdentityIncompatible) {
    return { ok: false, reason: "incompatible-embedding-identity" };
  }
  if (!state.anyVectorSeen && candidates.length === 0) {
    return { ok: false, reason: "no-vectors" };
  }
  if (state.embeddingFailed && candidates.length === 0) {
    return { ok: false, reason: "embedding-failed" };
  }
  if (state.anyVectorSeen && !state.anyDimensionCompatible && !state.embeddingFailed) {
    return { ok: false, reason: "incompatible-embedding-identity" };
  }
  if (candidates.length === 0) return { ok: false, reason: "below-min-score" };
  return { ok: true, top: candidates };
}

function retrievalDiagnostics(
  state: SearchState,
  lexical: LexicalCollection,
  fused: readonly FusedCandidate[],
): RetrievalDiagnostics {
  const lexicalIndex = lexical.queryError
    ? "query-error"
    : lexical.indexedRowCount === 0
      ? "missing"
      : "available";
  const hasDense = state.candidates.length > 0;
  const hasLexical = lexical.candidates.length > 0;
  const mode =
    state.embeddingFailed && hasLexical
      ? "lexical-degraded"
      : hasDense && hasLexical
        ? "hybrid"
        : hasLexical
          ? "lexical-only"
          : "dense-only";
  return {
    mode,
    denseCandidateCount: state.candidates.length,
    lexicalCandidateCount: lexical.candidates.length,
    fusedCandidateCount: fused.length,
    lexicalIndex,
  };
}

// eslint-disable-next-line max-lines-per-function
export async function searchVectorsForScope(
  store: KnowledgeStore,
  embeddingAdapter: OpenAIEmbeddingAdapter,
  scope: RetrievalScopeInput,
  query: string,
  options: SearchOptions,
): Promise<SearchOutcome> {
  const capsules = loadCapsules(store, scope.capsuleIds);
  if (capsules.length === 0) {
    return {
      references: [],
      noEvidenceReason: "no-vectors",
      diagnostics: {
        mode: "dense-only",
        denseCandidateCount: 0,
        lexicalCandidateCount: 0,
        fusedCandidateCount: 0,
        lexicalIndex: "missing",
      },
    };
  }

  const profile = profileQuery(query, options.strategy);
  const searchQueries = await searchQueriesFor(query, profile, options);
  const cache = new Map<string, EmbeddedQuery>();
  const preflightCache = new Map<string, IdentityPreflightResult>();
  const state = emptyState();
  const lexicalCollections: LexicalCollection[] = [];
  for (const searchQuery of searchQueries) {
    const variantProfile = profileQuery(searchQuery, profile.strategy);
    for (const capsule of capsules) {
      await processCapsule(
        store,
        embeddingAdapter,
        capsule,
        sourceFilterForCapsule(scope.sourceFilter, capsule),
        searchQuery,
        options,
        variantProfile,
        cache,
        preflightCache,
        state,
      );
    }
    lexicalCollections.push(
      collectLexicalCandidates(store, capsules, scope, variantProfile, options.topK),
    );
  }
  const lexical = mergeLexicalCollections(lexicalCollections);
  const fused = fuseCandidates(
    state.candidates,
    lexical.candidates,
    oversampleTopK(options.topK, profile),
  );
  const diagnostics = retrievalDiagnostics(state, lexical, fused);
  const selection = selectTopCandidates(state, fused);
  if (!selection.ok) {
    return { references: [], noEvidenceReason: selection.reason, diagnostics };
  }
  const refs = buildReferences(store, selection.top, options.topK, profile);
  return state.embeddingFailed
    ? { references: refs, embeddingDegraded: true, diagnostics }
    : { references: refs, diagnostics };
}

function sourceFilterForCapsule(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  capsule: KnowledgeCapsule,
): readonly KnowledgeSourceId[] | undefined {
  if (sourceFilter === undefined) return undefined;
  const capsuleSourceIds = new Set(capsule.sourceIds.map(String));
  return sourceFilter.filter((sourceId) => capsuleSourceIds.has(String(sourceId)));
}

function loadCapsules(
  store: KnowledgeStore,
  ids: readonly KnowledgeCapsuleId[],
): readonly KnowledgeCapsule[] {
  const out: KnowledgeCapsule[] = [];
  for (const id of ids) {
    const capsule = getCapsule(store, id);
    if (capsule !== undefined) out.push(capsule);
  }
  return out;
}

function buildReferences(
  store: KnowledgeStore,
  candidates: readonly FusedCandidate[],
  limit: number,
  profile: QueryProfile,
): readonly RetrievalReference[] {
  const orderByKey = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    orderByKey.set(`${String(candidate.capsuleId)}|${candidate.chunkId}`, index);
  });
  // Group surviving candidates by capsule so we can issue one citation-read per capsule.
  const byCapsule = new Map<string, FusedCandidate[]>();
  for (const candidate of candidates) {
    const key = String(candidate.capsuleId);
    const bucket = byCapsule.get(key);
    if (bucket === undefined) {
      byCapsule.set(key, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }

  const citationByChunk = new Map<string, CitationReference>();
  for (const [capsuleKey, bucket] of byCapsule.entries()) {
    const rows = readCitationRows(
      store,
      capsuleKey as KnowledgeCapsuleId,
      bucket.map((c) => c.chunkId),
    );
    for (const row of rows) {
      // Composite scoping key — chunk ids ARE globally unique by construction (chunks
      // table PK on `id`), but we still namespace the map by `capsule|chunk` so any
      // future schema change cannot let a citation row for one capsule become the
      // citation for another with the same chunkId by coincidence.
      citationByChunk.set(
        `${row.capsule_id}|${row.chunk_id}`,
        rowToCitation(row, store._internal.contentCipher),
      );
    }
  }

  const refs: RetrievalReference[] = [];
  for (const candidate of candidates) {
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    const citation = citationByChunk.get(key);
    if (citation === undefined) continue; // Defensive: a missing citation means the chunk
    // row was deleted between the vectors read and the citations read. Drop the
    // candidate rather than fabricate.
    refs.push({
      chunkId: citation.chunkId,
      capsuleId: candidate.capsuleId,
      score: candidate.score,
      citation,
    });
  }
  refs.sort((a, b) => referenceScoreDesc(a, b, orderByKey));
  return diversifyReferences(refs, limit, profile, orderByKey);
}

function referenceScoreDesc(
  a: RetrievalReference,
  b: RetrievalReference,
  orderByKey?: ReadonlyMap<string, number>,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (orderByKey !== undefined) {
    const aOrder = orderByKey.get(`${String(a.capsuleId)}|${String(a.chunkId)}`) ?? 0;
    const bOrder = orderByKey.get(`${String(b.capsuleId)}|${String(b.chunkId)}`) ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
  }
  return String(a.chunkId).localeCompare(String(b.chunkId));
}

function diversifyReferences(
  references: readonly RetrievalReference[],
  limit: number,
  profile: QueryProfile,
  orderByKey: ReadonlyMap<string, number>,
): readonly RetrievalReference[] {
  if (references.length <= limit) return references;
  const remaining = [...references];
  const selected: RetrievalReference[] = [];
  while (remaining.length > 0 && selected.length < limit) {
    const pick = pickNextReference(remaining, selected, profile, orderByKey);
    selected.push(pick.reference);
    remaining.splice(pick.index, 1);
  }
  selected.sort((a, b) => referenceScoreDesc(a, b, orderByKey));
  return selected;
}

function pickNextReference(
  remaining: readonly RetrievalReference[],
  selected: readonly RetrievalReference[],
  profile: QueryProfile,
  orderByKey: ReadonlyMap<string, number>,
): { readonly reference: RetrievalReference; readonly index: number } {
  let bestIndex = 0;
  let best = withDiversityScore(remaining[0], selected, profile);
  for (let i = 1; i < remaining.length; i += 1) {
    const candidate = withDiversityScore(remaining[i], selected, profile);
    if (referenceScoreDesc(candidate, best, orderByKey) < 0) {
      best = candidate;
      bestIndex = i;
    }
  }
  return { reference: best, index: bestIndex };
}

function withDiversityScore(
  reference: RetrievalReference | undefined,
  selected: readonly RetrievalReference[],
  profile: QueryProfile,
): RetrievalReference {
  if (reference === undefined) throw new RetrievalError("STORE_READ_FAILED", "missing reference");
  const penalty = diversityPenalty(reference, selected, profile);
  if (penalty === 0) return reference;
  return { ...reference, score: reference.score - penalty };
}

function diversityPenalty(
  reference: RetrievalReference,
  selected: readonly RetrievalReference[],
  profile: QueryProfile,
): number {
  let sameDocument = 0;
  let sameSection = 0;
  const sectionKey = referenceSectionKey(reference);
  for (const prior of selected) {
    if (String(prior.citation.documentId) === String(reference.citation.documentId)) {
      sameDocument += 1;
    }
    if (sectionKey !== "" && sectionKey === referenceSectionKey(prior)) {
      sameSection += 1;
    }
  }
  return (
    sameDocument * profile.documentDiversityPenalty + sameSection * profile.sectionDiversityPenalty
  );
}

function referenceSectionKey(reference: RetrievalReference): string {
  const path = reference.citation.sectionPath?.join(">");
  return path === undefined ? "" : `${String(reference.citation.documentId)}:${path}`;
}

function profileQuery(
  query: string,
  requested: SearchOptions["strategy"] | undefined,
): QueryProfile {
  const tokens = uniqueTokens(tokenise(query));
  const exactTerms = extractExactTerms(query);
  const strategy = resolveQueryStrategy(query, tokens, exactTerms, requested);
  if (strategy === "exact") return exactQueryProfile(tokens, exactTerms);
  if (strategy === "broad") return broadQueryProfile(tokens, exactTerms);
  return balancedQueryProfile(tokens, exactTerms);
}

function resolveQueryStrategy(
  query: string,
  tokens: readonly string[],
  exactTerms: readonly string[],
  requested: SearchOptions["strategy"] | undefined,
): QueryProfile["strategy"] {
  if (requested !== undefined && requested !== "auto") return requested;
  if (exactTerms.some(isStrongLexicalRecallTerm)) return "exact";
  if (tokens.length >= 8 || BROAD_QUERY_PATTERN.test(query)) return "broad";
  return "balanced";
}

function exactQueryProfile(tokens: readonly string[], exactTerms: readonly string[]): QueryProfile {
  return {
    strategy: "exact",
    tokens,
    exactTerms,
    lexicalRecallTerms: buildLexicalRecallTerms(tokens, exactTerms),
    documentDiversityPenalty: 0.0018,
    sectionDiversityPenalty: 0.001,
  };
}

function broadQueryProfile(tokens: readonly string[], exactTerms: readonly string[]): QueryProfile {
  return {
    strategy: "broad",
    tokens,
    exactTerms,
    lexicalRecallTerms: buildLexicalRecallTerms(tokens, exactTerms),
    documentDiversityPenalty: 0.003,
    sectionDiversityPenalty: 0.0015,
  };
}

function balancedQueryProfile(
  tokens: readonly string[],
  exactTerms: readonly string[],
): QueryProfile {
  return {
    strategy: "balanced",
    tokens,
    exactTerms,
    lexicalRecallTerms: buildLexicalRecallTerms(tokens, exactTerms),
    documentDiversityPenalty: 0.002,
    sectionDiversityPenalty: 0.001,
  };
}

function extractExactTerms(value: string): readonly string[] {
  const out: string[] = [];
  const matches = value.matchAll(EXACT_TERM_PATTERN);
  for (const match of matches) {
    const raw = match[0];
    if (!isExactTerm(raw)) continue;
    const term = normaliseForSearch(raw);
    if (term.length > 0) out.push(term);
  }
  return uniqueTokens(out);
}

function isExactTerm(value: string): boolean {
  if (/\d/u.test(value)) return true;
  if (/[._:/#-]/u.test(value)) return true;
  if (/[a-z][A-Z]/u.test(value)) return true;
  return value.length >= 3 && value === value.toUpperCase() && /\p{L}/u.test(value);
}

function hasDigitAndLetter(value: string): boolean {
  return /\d/u.test(value) && /\p{L}/u.test(value);
}

function isUppercaseLetterTerm(value: string): boolean {
  return value === value.toUpperCase() && /\p{L}/u.test(value);
}

function isStrongLexicalRecallTerm(value: string): boolean {
  const checks = [
    value.length >= 4 && /[._:/#-]/u.test(value),
    value.length >= 4 && hasDigitAndLetter(value),
    value.length >= 8 && /\p{L}/u.test(value),
    value.length >= 6 && isUppercaseLetterTerm(value),
  ];
  return checks.includes(true);
}

function uniqueTokens(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens)];
}

function buildLexicalRecallTerms(
  tokens: readonly string[],
  exactTerms: readonly string[],
): readonly string[] {
  const tokenTerms = tokens.filter((token) => token.length >= LEXICAL_RECALL_MIN_TOKEN_LENGTH);
  return uniqueTokens(lexicalQueryTerms([...exactTerms, ...tokenTerms])).slice(
    0,
    LEXICAL_RECALL_MAX_TERMS,
  );
}

function tokenise(value: string): readonly string[] {
  return normaliseForSearch(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));
}

function normaliseForSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}
