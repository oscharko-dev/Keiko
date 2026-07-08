// Scoped vector search (Epic #189, Issue #199). Given a list of capsule ids and a
// pre-embedded query vector per capsule, returns the ranked top-K `RetrievalReference`
// across the scope. The "no global pool" invariant lives in the SQL: every SELECT
// filters by `capsule_id` and we never join across capsules — so a bug in caller
// composition can never silently leak rows from a capsule outside scope.
//
// Vector blob layout: each row's `embedding` is `vectorDimensions * 4` bytes encoded as
// a little-endian Float32 array (see `floatToBytes` in `../indexing/embedding-batcher.ts`).
// Exact in-process vector scans are capped. When a capsule is larger than that cap, the
// lexical index first supplies a bounded chunk-id pool for dense reranking. Dense-only
// oversized capsules fall back to a scoped ANN sidecar and exact-rerank only those ANN
// candidates, avoiding an unbounded O(N*D) query scan without widening retrieval outside
// the requested scope.

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
import { resolveCapsuleModelUsePolicy } from "../model-use-policy.js";
import type { KnowledgeStore } from "../store.js";
import type { StoreContentCipher } from "../store-content-cipher.js";

import { shapeEmbeddingQuery } from "./embedding-query-shaping.js";
import {
  isExactTerm,
  lexicalQueryTermGroups,
  type LexicalQueryTermGroup,
} from "./lexical-normalization.js";
import { decomposeChainedQuery } from "./query-decomposition.js";
import {
  RetrievalError,
  type RetrievalEmbeddingLaneDiagnostics,
  type RetrievalEmbeddingLaneStatus,
  type QueryTransformer,
  type ResolvedRetrievalStrategy,
  type RetrievalDiagnostics,
  type RetrievalNoEvidenceReason,
  type RetrievalStrategy,
  type RetrievalVectorIndexDiagnostics,
} from "./types.js";
import {
  searchVectorIndex,
  type VectorIndexCandidate,
  type VectorIndexOptions,
} from "./vector-index.js";

const LEXICAL_RECALL_MAX_TERMS = 12;
const LEXICAL_RECALL_MIN_TOKEN_LENGTH = 3;
const MAX_DECODED_VECTOR_CACHE_ENTRIES = 16;
const DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = 20_000;
const GUIDED_DENSE_RERANK_MAX_ROWS = 1_000;
const ANN_HASH_BITS = 18;
const ANN_PROJECTION_WIDTH = 32;
const ANN_RERANK_MAX_ROWS = 1_000;
const DEFAULT_MAX_ANN_INDEX_ROWS = 250_000;
const EXACT_TERM_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}._:/#-]{2,}/gu;
const EXACT_QUOTED_PHRASE_PATTERN = /"([^"\r\n]{3,})"/gu;
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
  // Pre-loaded capsule metadata for exactly `capsuleIds` (existing members only,
  // same order), threaded from scope resolution so the search never re-fetches it
  // (GEN-PERF-LK-001). Optional: callers without the objects in hand omit it and
  // the search falls back to loading by id — behaviour is identical either way.
  readonly capsules?: readonly KnowledgeCapsule[];
}

export interface SearchOptions {
  readonly topK: number;
  readonly minScore?: number;
  readonly signal?: AbortSignal;
  readonly strategy?: RetrievalStrategy;
  readonly queryTransformer?: QueryTransformer;
  readonly queryTransformTimeoutMs?: number;
  readonly maxExactVectorScanRows?: number;
  readonly vectorIndex?: VectorIndexOptions;
}

interface QueryProfile {
  readonly strategy: ResolvedRetrievalStrategy;
  readonly tokens: readonly string[];
  readonly exactTerms: readonly string[];
  readonly exactPhrases: readonly string[];
  readonly lexicalRecallTerms: readonly LexicalQueryTermGroup[];
  readonly documentDiversityPenalty: number;
  readonly sectionDiversityPenalty: number;
}

interface CandidateBudgets {
  readonly denseCandidateBudget: number;
  readonly lexicalCandidateBudget: number;
  readonly fusedCandidateBudget: number;
}

// ─── Compose a scope object from either `ComposedRetrievalScope` or a single capsule ────
export function toScopeInput(
  scope: ComposedRetrievalScope | { readonly capsuleId: KnowledgeCapsuleId },
): RetrievalScopeInput {
  if ("capsuleId" in scope) {
    return { capsuleIds: [scope.capsuleId] };
  }
  return { capsuleIds: scope.capsuleIds, sourceFilter: scope.sourceIds, capsules: scope.capsules };
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
  // Euclidean norm of `vector`, precomputed at decode time with the same ascending-index
  // summation as `cosineSimilarity` so the cosine fast path divides by bit-identical factors.
  readonly norm: number;
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

// GEN-PERF-CHAT-004: the grounded-ask path opens a FRESH KnowledgeStore per request and
// closes it in a `finally`, so a WeakMap keyed by store IDENTITY never hit across requests
// — every ask re-SELECTed and re-decrypted (AES-GCM) every capsule vector from scratch.
// We re-key by the store's on-disk dbPath (`db.location()`), a stable identity that
// survives the fresh-store-per-request boundary. Correctness is preserved because the
// INNER cache key already embeds the capsule content stamp (`decodeCacheKey` folds in
// `stamp.n` + `stamp.max_created_at`): any indexing write bumps the stamp and yields a new
// inner key, so a stale decoded set can never be served after content changes. Key
// rotation / store reopen changes the on-disk file's decoded content only via the stamp,
// and an in-memory (never persisted) decrypted vector for a rotated key would still be
// re-derived because rotation re-writes rows (new stamp). The outer map is bounded by an
// LRU over dbPaths so distinct runtimes cannot grow it without bound.
const MAX_DECODED_VECTOR_STORE_ENTRIES = 8;

function storeCacheIdentity(store: KnowledgeStore): string {
  // `location()` returns the resolved absolute dbPath for the connection. In-memory stores
  // (":memory:") share the literal string, but each such store is a distinct connection —
  // fall back to a per-store unique tag so two independent in-memory fixtures never alias.
  const location = store._internal.db.location();
  if (location === null || location.length === 0 || location === ":memory:") {
    return inMemoryStoreTag(store);
  }
  return location;
}

const IN_MEMORY_STORE_TAGS = new WeakMap<KnowledgeStore, string>();
let inMemoryStoreCounter = 0;
function inMemoryStoreTag(store: KnowledgeStore): string {
  const existing = IN_MEMORY_STORE_TAGS.get(store);
  if (existing !== undefined) return existing;
  inMemoryStoreCounter += 1;
  const tag = `:memory:#${String(inMemoryStoreCounter)}`;
  IN_MEMORY_STORE_TAGS.set(store, tag);
  return tag;
}

function touchStoreCache<V>(cache: Map<string, V>, identity: string, created: V): V {
  const existing = cache.get(identity);
  if (existing !== undefined) {
    // LRU: re-insert to move to the newest position.
    cache.delete(identity);
    cache.set(identity, existing);
    return existing;
  }
  cache.set(identity, created);
  while (cache.size > MAX_DECODED_VECTOR_STORE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return created;
}

const DECODED_VECTOR_CACHE = new Map<string, Map<string, readonly DecodedVectorRow[]>>();
const ANN_INDEX_CACHE = new Map<string, Map<string, AnnIndex>>();
const ANN_PROJECTION_CACHE = new Map<string, readonly AnnProjection[]>();

function readVectorsForCapsule(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter?: readonly KnowledgeSourceId[],
  chunkFilter?: readonly string[],
): readonly VectorRow[] {
  if (sourceFilter?.length === 0) return [];
  if (chunkFilter?.length === 0) return [];
  return store._internal.db
    .prepare(
      `${SELECT_VECTORS_FOR_CAPSULE_SQL}${sourceFilterClause(
        sourceFilter,
        "",
      )}${chunkFilterClause(chunkFilter, "")}`,
    )
    .all({
      c: String(capsuleId),
      ...sourceParams(sourceFilter),
      ...chunkParams(chunkFilter),
    }) as unknown as readonly VectorRow[];
}

function vectorCacheStamp(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): VectorCacheStampRow {
  return store._internal.db
    .prepare(SELECT_VECTOR_CACHE_STAMP_SQL)
    .get({ c: String(capsuleId) }) as unknown as VectorCacheStampRow;
}

function vectorCacheStampForScope(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  chunkFilter?: readonly string[],
): VectorCacheStampRow {
  if (sourceFilter === undefined && chunkFilter === undefined) {
    return vectorCacheStamp(store, capsuleId);
  }
  if (sourceFilter?.length === 0) return { n: 0, max_created_at: null };
  if (chunkFilter?.length === 0) return { n: 0, max_created_at: null };
  return store._internal.db
    .prepare(
      [
        "SELECT COUNT(*) AS n, MAX(created_at) AS max_created_at",
        "FROM vectors",
        `WHERE capsule_id = :c${sourceFilterClause(sourceFilter, "")}${chunkFilterClause(
          chunkFilter,
          "",
        )}`,
      ].join(" "),
    )
    .get({
      c: String(capsuleId),
      ...sourceParams(sourceFilter),
      ...chunkParams(chunkFilter),
    }) as unknown as VectorCacheStampRow;
}

function decodeCacheForStore(store: KnowledgeStore): Map<string, readonly DecodedVectorRow[]> {
  const identity = storeCacheIdentity(store);
  const cached = DECODED_VECTOR_CACHE.get(identity);
  if (cached !== undefined) {
    return touchStoreCache(DECODED_VECTOR_CACHE, identity, cached);
  }
  const created = new Map<string, readonly DecodedVectorRow[]>();
  return touchStoreCache(DECODED_VECTOR_CACHE, identity, created);
}

interface AnnProjection {
  readonly indices: Uint32Array;
  readonly signs: Int8Array;
}

interface AnnIndex {
  readonly rows: readonly DecodedVectorRow[];
  readonly buckets: ReadonlyMap<number, readonly number[]>;
  readonly projections: readonly AnnProjection[];
  readonly rowCount: number;
}

type AnnIndexReadResult =
  | { readonly kind: "ready"; readonly index: AnnIndex }
  | { readonly kind: "empty"; readonly rowCount: number }
  | { readonly kind: "skipped-too-large"; readonly rowCount: number; readonly limit: number };

function annCacheForStore(store: KnowledgeStore): Map<string, AnnIndex> {
  const identity = storeCacheIdentity(store);
  const cached = ANN_INDEX_CACHE.get(identity);
  if (cached !== undefined) {
    return touchStoreCache(ANN_INDEX_CACHE, identity, cached);
  }
  const created = new Map<string, AnnIndex>();
  return touchStoreCache(ANN_INDEX_CACHE, identity, created);
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function annProjectionCacheKey(identity: EmbeddingModelIdentity): string {
  return `${identityKey(identity)}|ann:${String(ANN_HASH_BITS)}:${String(ANN_PROJECTION_WIDTH)}`;
}

function annProjectionsFor(identity: EmbeddingModelIdentity): readonly AnnProjection[] {
  const key = annProjectionCacheKey(identity);
  const cached = ANN_PROJECTION_CACHE.get(key);
  if (cached !== undefined) return cached;
  const seed = fnv1a32(key);
  const projections: AnnProjection[] = [];
  for (let bit = 0; bit < ANN_HASH_BITS; bit += 1) {
    const indices = new Uint32Array(ANN_PROJECTION_WIDTH);
    const signs = new Int8Array(ANN_PROJECTION_WIDTH);
    for (let lane = 0; lane < ANN_PROJECTION_WIDTH; lane += 1) {
      const mixed = mix32(seed ^ Math.imul(bit + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b));
      indices[lane] = mixed % identity.vectorDimensions;
      signs[lane] = (mixed & 0x80000000) === 0 ? 1 : -1;
    }
    projections.push({ indices, signs });
  }
  ANN_PROJECTION_CACHE.set(key, projections);
  return projections;
}

function annHash(vector: Float32Array, projections: readonly AnnProjection[]): number {
  let hash = 0;
  for (let bit = 0; bit < projections.length; bit += 1) {
    const projection = projections[bit];
    if (projection === undefined) continue;
    let sum = 0;
    for (let lane = 0; lane < projection.indices.length; lane += 1) {
      const idx = projection.indices[lane] ?? 0;
      sum += (vector[idx] ?? 0) * (projection.signs[lane] ?? 1);
    }
    if (sum >= 0) hash |= 1 << bit;
  }
  return hash;
}

function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x !== 0) {
    x &= x - 1;
    count += 1;
  }
  return count;
}

function collectAnnBucket(
  buckets: ReadonlyMap<number, readonly number[]>,
  bucket: number,
  seenBuckets: Set<number>,
  seenRows: Set<number>,
  out: number[],
  limit: number,
): void {
  if (out.length >= limit || seenBuckets.has(bucket)) return;
  seenBuckets.add(bucket);
  const rows = buckets.get(bucket);
  if (rows === undefined) return;
  for (const row of rows) {
    if (seenRows.has(row)) continue;
    seenRows.add(row);
    out.push(row);
    if (out.length >= limit) return;
  }
}

// eslint-disable-next-line max-lines-per-function, complexity
function annCandidateRowsForQuery(
  index: AnnIndex,
  queryVector: Float32Array,
  limit: number,
): readonly DecodedVectorRow[] {
  const target = annHash(queryVector, index.projections);
  const seenBuckets = new Set<number>();
  const seenRows = new Set<number>();
  const rowIndexes: number[] = [];
  collectAnnBucket(index.buckets, target, seenBuckets, seenRows, rowIndexes, limit);
  for (let bit = 0; bit < ANN_HASH_BITS && rowIndexes.length < limit; bit += 1) {
    collectAnnBucket(index.buckets, target ^ (1 << bit), seenBuckets, seenRows, rowIndexes, limit);
  }
  for (let a = 0; a < ANN_HASH_BITS && rowIndexes.length < limit; a += 1) {
    for (let b = a + 1; b < ANN_HASH_BITS && rowIndexes.length < limit; b += 1) {
      collectAnnBucket(
        index.buckets,
        target ^ (1 << a) ^ (1 << b),
        seenBuckets,
        seenRows,
        rowIndexes,
        limit,
      );
    }
  }
  for (let a = 0; a < ANN_HASH_BITS && rowIndexes.length < limit; a += 1) {
    for (let b = a + 1; b < ANN_HASH_BITS && rowIndexes.length < limit; b += 1) {
      for (let c = b + 1; c < ANN_HASH_BITS && rowIndexes.length < limit; c += 1) {
        collectAnnBucket(
          index.buckets,
          target ^ (1 << a) ^ (1 << b) ^ (1 << c),
          seenBuckets,
          seenRows,
          rowIndexes,
          limit,
        );
      }
    }
  }
  if (rowIndexes.length === 0) {
    const nearestBuckets = [...index.buckets.keys()].sort((a, b) => {
      const dist = hammingDistance(a, target) - hammingDistance(b, target);
      return dist !== 0 ? dist : a - b;
    });
    for (const bucket of nearestBuckets) {
      collectAnnBucket(index.buckets, bucket, seenBuckets, seenRows, rowIndexes, limit);
      if (rowIndexes.length >= limit) break;
    }
  }
  return rowIndexes
    .map((rowIndex) => index.rows[rowIndex])
    .filter((row): row is DecodedVectorRow => row !== undefined);
}

// eslint-disable-next-line complexity
function readAnnIndexForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  maxRows: number = DEFAULT_MAX_ANN_INDEX_ROWS,
): AnnIndexReadResult {
  if (sourceFilter?.length === 0) return { kind: "empty", rowCount: 0 };
  const stamp = vectorCacheStampForScope(store, capsule.id, sourceFilter);
  if (stamp.n === 0) return { kind: "empty", rowCount: 0 };
  if (stamp.n > maxRows) return { kind: "skipped-too-large", rowCount: stamp.n, limit: maxRows };
  const cache = annCacheForStore(store);
  const key = ["ann", decodeCacheKey(capsule, stamp, sourceFilter, undefined)].join("|");
  const cached = cache.get(key);
  if (cached !== undefined) return { kind: "ready", index: cached };
  const projections = annProjectionsFor(capsule.embeddingModelIdentity);
  const rows = readVectorsForCapsule(store, capsule.id, sourceFilter, undefined).map((row) =>
    decodeVectorRowForIdentity(row, store._internal.contentCipher, capsule.embeddingModelIdentity),
  );
  const mutableBuckets = new Map<number, number[]>();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    const bucket = annHash(row.vector, projections);
    const bucketRows = mutableBuckets.get(bucket);
    if (bucketRows === undefined) {
      mutableBuckets.set(bucket, [rowIndex]);
    } else {
      bucketRows.push(rowIndex);
    }
  }
  const index: AnnIndex = { rows, buckets: mutableBuckets, projections, rowCount: stamp.n };
  cache.set(key, index);
  while (cache.size > MAX_DECODED_VECTOR_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { kind: "ready", index };
}

function decodeCacheKey(
  capsule: KnowledgeCapsule,
  stamp: VectorCacheStampRow,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  chunkFilter: readonly string[] | undefined,
): string {
  return [
    String(capsule.id),
    identityKey(capsule.embeddingModelIdentity),
    sourceFilterKey(sourceFilter),
    chunkFilterKey(chunkFilter),
    String(stamp.n),
    String(stamp.max_created_at ?? 0),
  ].join("|");
}

function sourceFilterKey(sourceFilter: readonly KnowledgeSourceId[] | undefined): string {
  if (sourceFilter === undefined) return "*";
  return [...new Set(sourceFilter.map(String))].sort().join("\u0000");
}

function chunkFilterKey(chunkFilter: readonly string[] | undefined): string {
  if (chunkFilter === undefined) return "*";
  return [...new Set(chunkFilter)].sort().join("\u0000");
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

type DecodedVectorReadResult =
  | {
      readonly kind: "ready";
      readonly rows: readonly DecodedVectorRow[];
      readonly rowCount: number;
      readonly readMode: "exact" | "guided";
    }
  | {
      readonly kind: "skipped-too-large";
      readonly rowCount: number;
      readonly limit: number;
    };

// eslint-disable-next-line max-lines-per-function, complexity
function readDecodedVectorsForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  maxRows: number,
  guidedChunkIds: readonly string[] | undefined,
): DecodedVectorReadResult {
  if (sourceFilter?.length === 0) {
    return { kind: "ready", rows: [], rowCount: 0, readMode: "exact" };
  }
  const fullStamp = vectorCacheStampForScope(store, capsule.id, sourceFilter);
  if (fullStamp.n === 0) return { kind: "ready", rows: [], rowCount: 0, readMode: "exact" };

  let stamp = fullStamp;
  let chunkFilter: readonly string[] | undefined;
  let readMode: "exact" | "guided" = "exact";
  let rowLimit = maxRows;
  if (fullStamp.n > maxRows) {
    if (guidedChunkIds === undefined || guidedChunkIds.length === 0) {
      return { kind: "skipped-too-large", rowCount: fullStamp.n, limit: maxRows };
    }
    chunkFilter = uniqueStrings(guidedChunkIds);
    stamp = vectorCacheStampForScope(store, capsule.id, sourceFilter, chunkFilter);
    readMode = "guided";
    rowLimit = GUIDED_DENSE_RERANK_MAX_ROWS;
    if (stamp.n === 0) {
      return { kind: "ready", rows: [], rowCount: fullStamp.n, readMode };
    }
  }
  if (stamp.n > rowLimit) {
    return { kind: "skipped-too-large", rowCount: stamp.n, limit: rowLimit };
  }
  const cache = decodeCacheForStore(store);
  const key = decodeCacheKey(capsule, stamp, sourceFilter, chunkFilter);
  let rows = cache.get(key);
  if (rows === undefined) {
    rows = readVectorsForCapsule(store, capsule.id, sourceFilter, chunkFilter).map((row) =>
      decodeVectorRowForIdentity(
        row,
        store._internal.contentCipher,
        capsule.embeddingModelIdentity,
      ),
    );
    cache.set(key, rows);
    while (cache.size > MAX_DECODED_VECTOR_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  } else {
    cache.delete(key);
    cache.set(key, rows);
  }
  return { kind: "ready", rows, rowCount: fullStamp.n, readMode };
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
  readonly parsed_unit_id: string | null;
  readonly safe_display_name: string | null;
  readonly page_number: number | null;
  readonly page_label: string | null;
  readonly section_path_json: string | null;
  readonly json_pointer: string | null;
  readonly table_name: string | null;
  readonly row_index: number | null;
  readonly anchor_id: string | null;
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
    "SELECT c.id AS chunk_id, c.capsule_id, c.source_id, c.document_id, c.parsed_unit_id,",
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
    "  pu.json_pointer, pu.table_name, pu.row_index, pu.anchor_id,",
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

// Same ascending-index accumulation as the `na`/`nb` sums inside `cosineSimilarity`, so a
// cosine computed as dot / (norm(a) * norm(b)) from precomputed norms is bit-identical to the
// single-pass form (IEEE-754 float ops are deterministic for a fixed operation order).
function vectorNorm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function decodeVectorRowForIdentity(
  row: VectorRow,
  cipher: StoreContentCipher,
  identity: EmbeddingModelIdentity,
): DecodedVectorRow {
  const vector = normalizeVectorForIdentity(decodeEmbedding(row, cipher), identity);
  return { ...row, vector, norm: vectorNorm(vector) };
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

function embeddingLaneId(identity: EmbeddingModelIdentity): string {
  return `embedding-lane-${fnv1a32(identityKey(identity)).toString(16).padStart(8, "0")}`;
}

function queryEmbeddingCacheKey(identity: EmbeddingModelIdentity, query: string): string {
  return `${identityKey(identity)}\u0000${query}`;
}

// ─── Cross-request embedding caches ─────────────────────────────────────────
// GEN-PERF-LK-002: the grounded-ask path opens a fresh KnowledgeStore per request, and the
// query-embedding + identity-preflight caches used to be request-local Maps — every ask paid
// one preflight probe per identity plus one embedding call per (identity × query variant),
// serially. These caches carry the network results across requests. In-memory only: nothing
// here is persisted or emitted into evidence/diagnostics.
//
// Both caches are scoped PER ADAPTER INSTANCE via WeakMap. Correctness depends on it: two
// adapters can answer the same (identity, query) differently (scripted eval adapters, or a
// reconfigured gateway endpoint), so cache entries must never travel between adapters. Callers
// that construct a fresh adapter per request simply get no cross-request reuse; the BFF holds
// one adapter per live gateway config, so a config change rotates the adapter and drops every
// cache scoped to it. `embedQueryFor` re-validates the response identity on every MISS, and the
// preflight cache stores only STRUCTURAL outcomes ("ok" / "incompatible") under a TTL —
// transient failures ("failed") are never cached, so a flaky adapter cannot poison later
// requests.
const QUERY_EMBEDDING_CACHES = new WeakMap<OpenAIEmbeddingAdapter, Map<string, EmbeddedQuery>>();
const QUERY_EMBEDDING_LRU_MAX = 256;

interface PreflightTtlEntry {
  readonly result: "ok" | "incompatible";
  readonly expiresAt: number;
}

const IDENTITY_PREFLIGHT_CACHES = new WeakMap<
  OpenAIEmbeddingAdapter,
  Map<string, PreflightTtlEntry>
>();
const IDENTITY_PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const IDENTITY_PREFLIGHT_TTL_CACHE_MAX = 64;

function queryEmbeddingCacheFor(adapter: OpenAIEmbeddingAdapter): Map<string, EmbeddedQuery> {
  const existing = QUERY_EMBEDDING_CACHES.get(adapter);
  if (existing !== undefined) return existing;
  const created = new Map<string, EmbeddedQuery>();
  QUERY_EMBEDDING_CACHES.set(adapter, created);
  return created;
}

function preflightTtlCacheFor(adapter: OpenAIEmbeddingAdapter): Map<string, PreflightTtlEntry> {
  const existing = IDENTITY_PREFLIGHT_CACHES.get(adapter);
  if (existing !== undefined) return existing;
  const created = new Map<string, PreflightTtlEntry>();
  IDENTITY_PREFLIGHT_CACHES.set(adapter, created);
  return created;
}

function lruTouchQueryEmbedding(
  cache: Map<string, EmbeddedQuery>,
  key: string,
  value: EmbeddedQuery,
): void {
  cache.delete(key);
  if (cache.size >= QUERY_EMBEDDING_LRU_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
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
    ...(adapter.egress !== undefined ? { egress: adapter.egress } : {}),
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

function openOptionalText(value: string | null, cipher: StoreContentCipher): string | undefined {
  if (value === null) return undefined;
  const opened = cipher.openText(value);
  return opened.trim().length === 0 ? undefined : opened;
}

function rowCitationPageMetadata(row: CitationRow): Partial<CitationReference> {
  return {
    ...(row.parsed_unit_id !== null ? { parsedUnitId: row.parsed_unit_id } : {}),
    ...(row.page_number !== null ? { pageNumber: row.page_number } : {}),
    ...(row.page_label !== null ? { pageLabel: row.page_label } : {}),
    ...(row.json_pointer !== null ? { jsonPointer: row.json_pointer } : {}),
  };
}

function rowCitationStructuredMetadata(
  row: CitationRow,
  sectionPath: readonly string[] | undefined,
  anchorId: string | undefined,
): Partial<CitationReference> {
  return {
    ...(sectionPath !== undefined ? { sectionPath } : {}),
    ...(anchorId !== undefined ? { anchorId } : {}),
    ...(row.table_name !== null ? { tableName: row.table_name } : {}),
    ...(row.row_index !== null ? { rowIndex: row.row_index } : {}),
    ...(row.character_start !== null ? { characterStart: row.character_start } : {}),
    ...(row.character_end !== null ? { characterEnd: row.character_end } : {}),
  };
}

function rowToCitation(row: CitationRow, cipher: StoreContentCipher): CitationReference {
  const sectionPath = parseSectionPath(row.section_path_json, cipher);
  const anchorId = openOptionalText(row.anchor_id, cipher);
  // Build the citation without `undefined` literals to keep `exactOptionalPropertyTypes`
  // happy. The contract permits omission of each optional field but rejects the explicit
  // `undefined` value.
  return {
    documentId: row.document_id as CitationReference["documentId"],
    capsuleId: row.capsule_id as CitationReference["capsuleId"],
    sourceId: row.source_id as CitationReference["sourceId"],
    chunkId: row.chunk_id as CitationReference["chunkId"],
    safeDisplayName: row.safe_display_name ?? row.document_id,
    ...rowCitationPageMetadata(row),
    ...rowCitationStructuredMetadata(row, sectionPath, anchorId),
  };
}

// ─── Candidate selection + fusion ────────────────────────────────────────────
// Dense and lexical rankings stay separate until reciprocal-rank fusion. Dense scores remain
// vector-space scores; BM25 scores remain SQLite FTS scores where lower is better. The final
// `score` exposed on references is the RRF score, not an additive cosine/BM25 blend.
interface DenseCandidate {
  readonly chunkId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly laneId: string;
  readonly laneKey: string;
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
  readonly lexicalPriority: number;
  // True when THIS candidate came from the OR recall fallback rather than a strict AND/exact
  // match. Set once per collection pass (see `collectLexicalCandidates`) and carried on the
  // candidate itself — NOT derived from the merged multi-leg `LexicalCollection.usedOrFallback`
  // flag — so a genuine strict match from one chained-question leg is never discounted just
  // because a different leg needed the fallback.
  readonly viaOrFallback: boolean;
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
// OR-fallback lexical candidates fuse at half weight: a fallback hit may match only ONE query
// term, and at full weight such a hit ties with (and can displace via tiebreak) a top dense
// candidate. At any weight < 1 a candidate that ranks higher in the dense lane strictly beats
// the mirrored fallback-favoured candidate: (1/(K+1) + w/(K+2)) > (w/(K+1) + 1/(K+2)) for w < 1.
const LEXICAL_OR_FALLBACK_RRF_WEIGHT = 0.5;
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

function denseRowScore(
  metric: EmbeddingVectorMetric,
  queryVector: Float32Array,
  queryNorm: number,
  row: DecodedVectorRow,
): number {
  if (metric !== "cosine") return scoreFor(metric, queryVector, row.vector);
  if (queryNorm === 0 || row.norm === 0) return 0;
  return dotProduct(queryVector, row.vector) / (queryNorm * row.norm);
}

function scoreCapsuleVectors(
  rows: readonly DecodedVectorRow[],
  capsule: KnowledgeCapsule,
  laneId: string,
  laneKey: string,
  queryVector: Float32Array,
  candidateLimit: number,
  minScore: number | undefined,
): CapsuleScoreResult {
  const metric = capsule.embeddingModelIdentity.vectorMetric;
  // Cosine fast path: with the row norm precomputed at decode time and the query norm computed
  // once per scan, cosine = dot / (queryNorm * rowNorm) skips two of the three per-lane
  // accumulations inside the O(rows × dims) hot loop. Both norms use the same summation order
  // as `cosineSimilarity`, so the resulting scores are bit-identical to the single-pass form.
  const queryNorm = metric === "cosine" ? vectorNorm(queryVector) : 0;
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
    const score = denseRowScore(metric, queryVector, queryNorm, row);
    if (minScore !== undefined && score < minScore) continue;
    scored.push({ chunkId: row.chunk_id, capsuleId: capsule.id, laneId, laneKey, score });
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

interface ExactLexicalIndexCandidateRow extends LexicalIndexCandidateRow {
  readonly exact_text: string;
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

function chunkFilterClause(chunkFilter: readonly string[] | undefined, qualifier: string): string {
  if (chunkFilter === undefined) return "";
  if (chunkFilter.length === 0) return " AND 0";
  return ` AND ${qualifier}chunk_id IN (${chunkFilter
    .map((_, i) => `:chunk${String(i)}`)
    .join(", ")})`;
}

function chunkParams(chunkFilter: readonly string[] | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  if (chunkFilter !== undefined) {
    for (let i = 0; i < chunkFilter.length; i += 1) {
      params[`chunk${String(i)}`] = chunkFilter[i] ?? "";
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

function ftsGroupQuery(group: LexicalQueryTermGroup): string {
  const terms = group.terms.map(escapeFtsPhrase);
  if (terms.length === 1) return terms[0] ?? "";
  return `(${terms.join(" OR ")})`;
}

function buildFtsMatchQuery(profile: QueryProfile): string | undefined {
  const groups = profile.lexicalRecallTerms.slice(0, LEXICAL_RECALL_MAX_TERMS);
  if (groups.length === 0) return undefined;
  const operator = profile.strategy === "broad" ? " OR " : " AND ";
  return groups
    .map(ftsGroupQuery)
    .filter((term) => term.length > 0)
    .join(operator);
}

// Recall fallback for the AND-joined strategies: one query term that appears nowhere in the
// index (a typo, a synonym, chit-chat wrapped around the real subject) zeroes out the entire
// lexical lane even though the other terms match well. When the strict query returns no rows
// and there are at least two term groups, one bounded OR retry recovers those candidates; BM25
// ranking still rewards chunks matching more of the terms, and RRF fusion keeps the dense
// lane's view unchanged. Never used for "broad" (already OR) or single-group queries
// (AND === OR there).
function buildFtsOrFallbackQuery(profile: QueryProfile): string | undefined {
  if (profile.strategy === "broad") return undefined;
  const groups = profile.lexicalRecallTerms.slice(0, LEXICAL_RECALL_MAX_TERMS);
  if (groups.length < 2) return undefined;
  return groups
    .map(ftsGroupQuery)
    .filter((term) => term.length > 0)
    .join(" OR ");
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
    lexicalPriority: 0,
    // Overwritten by `collectLexicalCandidatesPass` with the actual per-pass fallback status.
    viaOrFallback: false,
  }));
}

function exactLexicalSql(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  exactMatches: readonly string[],
): string {
  const matchExpressions = exactMatches.map(
    (_, i) => `instr(lower(li.exact_text), :exact${String(i)}) > 0`,
  );
  const exactClause = matchExpressions.length === 0 ? "0" : matchExpressions.join(" OR ");
  return [
    "SELECT li.chunk_id AS chunk_id, li.capsule_id AS capsule_id, 0 AS bm25_score,",
    "  li.exact_text AS exact_text",
    "FROM chunk_lexical_index AS li",
    `WHERE li.capsule_id = :capsule_id${sourceFilterClause(
      sourceFilter,
      "li.",
    )} AND (${exactClause})`,
    "ORDER BY li.chunk_id ASC",
    "LIMIT :limit",
  ].join(" ");
}

function exactCandidateScanLimit(limit: number): number {
  return Math.min(500, Math.max(LEXICAL_CANDIDATE_LIMIT, limit * 4));
}

function isAlphanumeric(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}]$/u.test(value);
}

function isExactContinuation(value: string, index: number, neighborIndex: number): boolean {
  const char = value[index];
  if (char === undefined) return false;
  if (/^[\p{L}\p{N}_]$/u.test(char)) return true;
  if (char === "." || char === "-" || char === "/" || char === "#" || char === ":") {
    return isAlphanumeric(value[neighborIndex]);
  }
  return false;
}

function hasExactBoundaries(value: string, start: number, term: string): boolean {
  const end = start + term.length;
  const before = start - 1;
  const after = end;
  return (
    !isExactContinuation(value, before, before - 1) && !isExactContinuation(value, after, after + 1)
  );
}

function boundaryExactMatchCount(exactText: string, exactTerms: readonly string[]): number {
  const haystack = normaliseForSearch(exactText);
  let count = 0;
  for (const term of exactTerms) {
    let offset = haystack.indexOf(term);
    while (offset >= 0) {
      if (hasExactBoundaries(haystack, offset, term)) {
        count += 1;
        break;
      }
      offset = haystack.indexOf(term, offset + 1);
    }
  }
  return count;
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
    limit: exactCandidateScanLimit(limit),
    ...sourceParams(sourceFilter),
    ...exactParams,
  }) as unknown as readonly ExactLexicalIndexCandidateRow[];
  return rows
    .map((row): LexicalCandidate | undefined => {
      const matchCount = boundaryExactMatchCount(row.exact_text, exactTerms);
      if (matchCount === 0) return undefined;
      return {
        chunkId: row.chunk_id,
        capsuleId: row.capsule_id as KnowledgeCapsuleId,
        bm25Score: row.exact_text.length / 1_000_000,
        lexicalPriority: matchCount,
        // Overwritten by `collectLexicalCandidatesPass` with the actual per-pass fallback status.
        viaOrFallback: false,
      };
    })
    .filter((candidate): candidate is LexicalCandidate => candidate !== undefined)
    .sort(lexicalCandidateAsc)
    .slice(0, limit);
}

interface LexicalCollection {
  readonly candidates: readonly LexicalCandidate[];
  readonly indexedRowCount: number;
  readonly queryError: boolean;
  // True when at least one in-scope capsule's `rawContentRelease` policy denied the
  // lexical lane (see `isRawContentReleaseAllowed`). Threaded through to `SearchState` so
  // `selectTopCandidates` reports `policy-denied` instead of a generic empty result.
  readonly policyDenied: boolean;
  // True when the candidates came from the OR recall fallback rather than the strict
  // strategy query. Fallback matches are weaker evidence (they can match a single term), so
  // fusion discounts their reciprocal-rank contribution — see LEXICAL_OR_FALLBACK_RRF_WEIGHT.
  readonly usedOrFallback: boolean;
}

function boundedCandidateBudget(topK: number, multiplier: number, extraCap: number): number {
  const base = Math.max(1, topK);
  return Math.max(base, Math.min(base * multiplier, base + extraCap));
}

function candidateBudgets(topK: number, profile: QueryProfile): CandidateBudgets {
  if (profile.strategy === "exact") {
    const dense = boundedCandidateBudget(topK, 12, 96);
    const lexical = Math.min(LEXICAL_CANDIDATE_LIMIT, boundedCandidateBudget(topK, 14, 128));
    return {
      denseCandidateBudget: dense,
      lexicalCandidateBudget: lexical,
      fusedCandidateBudget: lexical,
    };
  }
  if (profile.strategy === "broad") {
    const dense = boundedCandidateBudget(topK, 10, 64);
    const lexical = Math.min(LEXICAL_CANDIDATE_LIMIT, boundedCandidateBudget(topK, 8, 64));
    return {
      denseCandidateBudget: dense,
      lexicalCandidateBudget: lexical,
      fusedCandidateBudget: dense,
    };
  }
  const dense = boundedCandidateBudget(topK, 8, 64);
  const lexical = Math.min(LEXICAL_CANDIDATE_LIMIT, boundedCandidateBudget(topK, 10, 80));
  return {
    denseCandidateBudget: dense,
    lexicalCandidateBudget: lexical,
    fusedCandidateBudget: Math.max(dense, lexical),
  };
}

function lexicalCandidateLimit(topK: number, profile: QueryProfile): number {
  return candidateBudgets(topK, profile).lexicalCandidateBudget;
}

interface LexicalCapsuleCollection {
  readonly candidates: readonly LexicalCandidate[];
  readonly indexedRowCount: number;
  readonly policyDenied: boolean;
}

function mergeExactLexicalCandidates(
  byKey: Map<string, LexicalCandidate>,
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  profile: QueryProfile,
  limit: number,
): void {
  for (const candidate of readExactLexicalCandidatesForCapsule(
    store,
    capsule.id,
    sourceFilter,
    uniqueStrings([...profile.exactTerms, ...profile.exactPhrases]),
    limit,
  )) {
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    const existing = byKey.get(key);
    const promoted =
      existing === undefined ? candidate : { ...candidate, bm25Score: existing.bm25Score };
    if (existing === undefined || lexicalCandidateAsc(promoted, existing) < 0) {
      byKey.set(key, promoted);
    }
  }
}

function collectLexicalCandidatesForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  profile: QueryProfile,
  limit: number,
  matchQuery: string | undefined,
): LexicalCapsuleCollection {
  const indexedRowCount = countLexicalRowsForCapsuleScope(store, capsule.id, sourceFilter);
  if (indexedRowCount === 0) return { candidates: [], indexedRowCount, policyDenied: false };
  if (!isRawContentReleaseAllowed(capsule)) {
    // The capsule's governance was tightened after its lexical rows were persisted
    // (capsule-lifecycle.ts marks it `stale` but does not purge the FTS index). Refuse to
    // surface those rows rather than trusting stale on-disk state.
    return { candidates: [], indexedRowCount, policyDenied: true };
  }
  const byKey = new Map<string, LexicalCandidate>();
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
  mergeExactLexicalCandidates(byKey, store, capsule, sourceFilter, profile, limit);
  return {
    candidates: [...byKey.values()].sort(lexicalCandidateAsc).slice(0, limit),
    indexedRowCount,
    policyDenied: false,
  };
}

function collectLexicalCandidates(
  store: KnowledgeStore,
  capsules: readonly KnowledgeCapsule[],
  scope: RetrievalScopeInput,
  profile: QueryProfile,
  topK: number,
): LexicalCollection {
  const strict = collectLexicalCandidatesPass(
    store,
    capsules,
    scope,
    profile,
    topK,
    buildFtsMatchQuery(profile),
  );
  // Whole-lane OR fallback: only when the strict AND pass found NOTHING across every in-scope
  // capsule (and the pass didn't hard-fail) do we retry once with OR. Running the fallback per
  // capsule instead would dilute ranking whenever a sibling capsule matches the strict query
  // well. `strict.policyDenied` is deliberately NOT part of this short-circuit (regression for
  // AUDIT-E1819-001): a denied capsule already contributes zero rows to `strict.candidates` (see
  // `collectLexicalCandidatesForCapsule`), so retrying the fallback here only ever surfaces
  // candidates from the scope's non-denied members — it must not be suppressed scope-wide just
  // because a co-selected sealed/denied sibling is also present.
  if (strict.candidates.length > 0 || strict.queryError) return strict;
  const fallbackQuery = buildFtsOrFallbackQuery(profile);
  if (fallbackQuery === undefined) return strict;
  const fallback = collectLexicalCandidatesPass(
    store,
    capsules,
    scope,
    profile,
    topK,
    fallbackQuery,
  );
  return {
    ...fallback,
    // Tag every candidate from THIS pass as fallback-sourced. Fusion applies the discount
    // per-candidate (see `fuseCandidates`), so this only ever affects this query variant's own
    // lexical evidence — never a different chained-question leg's strict match merged in later.
    candidates: fallback.candidates.map((candidate) => ({ ...candidate, viaOrFallback: true })),
    usedOrFallback: fallback.candidates.length > 0,
  };
}

function collectLexicalCandidatesPass(
  store: KnowledgeStore,
  capsules: readonly KnowledgeCapsule[],
  scope: RetrievalScopeInput,
  profile: QueryProfile,
  topK: number,
  matchQuery: string | undefined,
): LexicalCollection {
  const limit = lexicalCandidateLimit(topK, profile);
  const out: LexicalCandidate[] = [];
  let indexedRowCount = 0;
  let policyDenied = false;
  try {
    for (const capsule of capsules) {
      const collected = collectLexicalCandidatesForCapsule(
        store,
        capsule,
        sourceFilterForCapsule(scope.sourceFilter, capsule),
        profile,
        limit,
        matchQuery,
      );
      indexedRowCount += collected.indexedRowCount;
      policyDenied ||= collected.policyDenied;
      out.push(...collected.candidates);
      if (out.length >= limit) break;
    }
  } catch {
    return {
      candidates: [],
      indexedRowCount,
      queryError: true,
      policyDenied,
      usedOrFallback: false,
    };
  }
  return {
    candidates: out.sort(lexicalCandidateAsc).slice(0, limit),
    indexedRowCount,
    policyDenied,
    queryError: false,
    usedOrFallback: false,
  };
}

function oversampleTopK(topK: number, profile: QueryProfile): number {
  return candidateBudgets(topK, profile).denseCandidateBudget;
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

function lexicalCandidateAsc(a: LexicalCandidate, b: LexicalCandidate): number {
  const priority = b.lexicalPriority - a.lexicalPriority;
  if (priority !== 0) return priority;
  // A strict-match candidate always outranks a same-priority fallback candidate for the same
  // chunk — this only ever activates when merging multiple chained-question legs (a single
  // query variant's candidates all share one `viaOrFallback` value), and it's what keeps
  // `dedupeLexicalCandidates` picking the non-fallback copy when one leg strict-matched a chunk
  // that another leg only recovered via the OR fallback.
  if (a.viaOrFallback !== b.viaOrFallback) return a.viaOrFallback ? 1 : -1;
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
      ...(patch.lexicalBm25Score !== undefined ? { lexicalBm25Score: patch.lexicalBm25Score } : {}),
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

function lexicalFusionWeight(candidate: LexicalCandidate): number {
  return candidate.viaOrFallback ? LEXICAL_OR_FALLBACK_RRF_WEIGHT : 1;
}

function fuseCandidates(
  denseCandidates: readonly DenseCandidate[],
  lexicalCandidates: readonly LexicalCandidate[],
  limit: number,
): readonly FusedCandidate[] {
  const byKey = new Map<string, FusedCandidate>();
  for (const rankedDense of denseCandidateLanes(denseCandidates)) {
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
  }
  const rankedLexical = [...dedupeLexicalCandidates(lexicalCandidates)].sort(lexicalCandidateAsc);
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
      lexicalFusionWeight(candidate) * rrf(rank),
    );
  });
  return [...byKey.values()].sort(fusedScoreDesc).slice(0, limit);
}

function denseCandidateLanes(candidates: readonly DenseCandidate[]): readonly DenseCandidate[][] {
  const byLane = new Map<string, DenseCandidate[]>();
  for (const candidate of dedupeDenseCandidates(candidates)) {
    const bucket = byLane.get(candidate.laneKey);
    if (bucket === undefined) {
      byLane.set(candidate.laneKey, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }
  return [...byLane.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, laneCandidates]) => laneCandidates.sort(scoreDesc));
}

function dedupeDenseCandidates(candidates: readonly DenseCandidate[]): readonly DenseCandidate[] {
  const byKey = new Map<string, DenseCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.laneKey}|${String(candidate.capsuleId)}|${candidate.chunkId}`;
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
    if (existing === undefined || lexicalCandidateAsc(candidate, existing) < 0) {
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
  // Chained multi-part questions are decomposed deterministically for EVERY strategy: each
  // part retrieves its own evidence and RRF merges the legs. Single-part queries decompose to
  // [] and behave exactly as before.
  const baseQueries = uniqueQueries([query, ...decomposeChainedQuery(query)]);
  if (profile.strategy !== "broad" || options.queryTransformer === undefined) {
    return baseQueries.slice(0, QUERY_TRANSFORM_MAX_VARIANTS);
  }
  const variants = await withQueryTransformTimeout(
    options.queryTransformer.rewrite({
      query,
      strategy: "broad",
      maxVariants: QUERY_TRANSFORM_MAX_VARIANTS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }),
    options.queryTransformTimeoutMs ?? QUERY_TRANSFORM_TIMEOUT_MS,
  );
  if (variants === undefined) return baseQueries.slice(0, QUERY_TRANSFORM_MAX_VARIANTS);
  return uniqueQueries([...baseQueries, ...variants]).slice(0, QUERY_TRANSFORM_MAX_VARIANTS);
}

function mergeLexicalCollections(collections: readonly LexicalCollection[]): LexicalCollection {
  let indexedRowCount = 0;
  let queryError = false;
  let policyDenied = false;
  let usedOrFallback = false;
  const candidates: LexicalCandidate[] = [];
  for (const collection of collections) {
    indexedRowCount = Math.max(indexedRowCount, collection.indexedRowCount);
    queryError ||= collection.queryError;
    policyDenied ||= collection.policyDenied;
    usedOrFallback ||= collection.usedOrFallback;
    candidates.push(...collection.candidates);
  }
  return {
    candidates: dedupeLexicalCandidates(candidates),
    indexedRowCount,
    queryError,
    policyDenied,
    usedOrFallback,
  };
}

function guidedChunkIdsForCapsule(
  candidates: readonly LexicalCandidate[],
  capsuleId: KnowledgeCapsuleId,
): readonly string[] | undefined {
  const chunkIds: string[] = [];
  for (const candidate of candidates) {
    if (String(candidate.capsuleId) !== String(capsuleId)) continue;
    chunkIds.push(candidate.chunkId);
  }
  if (chunkIds.length === 0) return undefined;
  return uniqueStrings(chunkIds);
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
  readonly noEvidenceReason?: RetrievalNoEvidenceReason;
  // True when a dense embedding lane degraded but lexical candidates kept the
  // result non-empty. Observability signal only — does not change which references
  // are returned.
  readonly embeddingDegraded?: true;
  readonly diagnostics: RetrievalDiagnostics;
}

// Tracks the accumulated state of a single search pass. Hoisted out of the entry function
// so the orchestrator stays under the cyclomatic-complexity budget (the per-capsule loop
// has 4 distinct branches; bundling them into one function pushes it past the lint cap).
interface SearchState {
  readonly candidates: DenseCandidate[];
  readonly lanes: Map<string, EmbeddingLaneState>;
  readonly vectorIndexDiagnostics: RetrievalVectorIndexDiagnostics[];
  anyVectorSeen: boolean;
  anyDimensionCompatible: boolean;
  anyIdentityIncompatible: boolean;
  embeddingFailed: boolean;
  embeddingPolicyDenied: boolean;
  denseSkippedTooLarge: boolean;
  denseGuided: boolean;
  denseAnn: boolean;
}

interface EmbeddingLaneState {
  readonly laneId: string;
  readonly laneKey: string;
  readonly capsuleIds: Set<string>;
  status: RetrievalEmbeddingLaneStatus;
  queryEmbeddingRequested: boolean;
  vectorCount: number;
  denseCandidateCount: number;
}

function emptyState(): SearchState {
  return {
    candidates: [],
    lanes: new Map(),
    vectorIndexDiagnostics: [],
    anyVectorSeen: false,
    anyDimensionCompatible: false,
    anyIdentityIncompatible: false,
    embeddingFailed: false,
    embeddingPolicyDenied: false,
    denseSkippedTooLarge: false,
    denseGuided: false,
    denseAnn: false,
  };
}

function laneStateFor(state: SearchState, capsule: KnowledgeCapsule): EmbeddingLaneState {
  const laneKey = identityKey(capsule.embeddingModelIdentity);
  const laneId = embeddingLaneId(capsule.embeddingModelIdentity);
  const existing = state.lanes.get(laneKey);
  if (existing !== undefined) {
    existing.capsuleIds.add(String(capsule.id));
    return existing;
  }
  const created: EmbeddingLaneState = {
    laneId,
    laneKey,
    capsuleIds: new Set([String(capsule.id)]),
    status: "no-vectors",
    queryEmbeddingRequested: false,
    vectorCount: 0,
    denseCandidateCount: 0,
  };
  state.lanes.set(laneKey, created);
  return created;
}

function markLaneStatus(lane: EmbeddingLaneState, status: RetrievalEmbeddingLaneStatus): void {
  if (lane.status === "policy-denied") return;
  if (lane.status === "identity-incompatible" || lane.status === "embedding-failed") return;
  if (lane.status === "degraded" && status === "searched") return;
  lane.status = status;
}

type IdentityPreflightResult = "ok" | "incompatible" | "failed";

function hasHardenedEmbeddingSpace(identity: EmbeddingModelIdentity): boolean {
  return (
    identity.normalization === "l2" &&
    identity.instructionVersion !== undefined &&
    identity.embeddingSpaceFingerprint !== undefined
  );
}

// Request-local `inFlight` dedupes concurrent probes (the prefetch fires per variant); the
// module-level TTL cache carries STRUCTURAL outcomes across requests. "failed" is transient and
// is only held for the current request via the shared in-flight promise.
function ensureIdentityPreflight(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  signal: AbortSignal | undefined,
  inFlight: Map<string, Promise<IdentityPreflightResult>>,
): Promise<IdentityPreflightResult> {
  if (!hasHardenedEmbeddingSpace(identity)) return Promise.resolve("incompatible");
  const key = identityKey(identity);
  const ttlCache = preflightTtlCacheFor(adapter);
  const ttlCached = ttlCache.get(key);
  if (ttlCached !== undefined && ttlCached.expiresAt > Date.now()) {
    return Promise.resolve(ttlCached.result);
  }
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const started = runIdentityPreflight(adapter, identity, signal).then((result) => {
    if (result !== "failed") {
      if (ttlCache.size >= IDENTITY_PREFLIGHT_TTL_CACHE_MAX) {
        ttlCache.clear();
      }
      ttlCache.set(key, {
        result,
        expiresAt: Date.now() + IDENTITY_PREFLIGHT_TTL_MS,
      });
    }
    return result;
  });
  inFlight.set(key, started);
  return started;
}

async function runIdentityPreflight(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  signal: AbortSignal | undefined,
): Promise<IdentityPreflightResult> {
  const checked = await verifyEmbeddingCapability(adapter, {
    modelId: identity.modelId,
    provider: identity.provider,
    vectorMetric: identity.vectorMetric,
    expectedDimensions: identity.vectorDimensions,
    ...(identity.dimensionsParam !== undefined
      ? { dimensionsParam: identity.dimensionsParam }
      : {}),
    ...(identity.normalization !== undefined ? { normalization: identity.normalization } : {}),
    ...(identity.instructionVersion !== undefined
      ? { instructionVersion: identity.instructionVersion }
      : {}),
    includeSpaceFingerprint: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!checked.ok) {
    return checked.reason === "dimension-mismatch" ? "incompatible" : "failed";
  }
  return assertCompatibleEmbeddingIdentity(identity, checked.identity).ok ? "ok" : "incompatible";
}

type CapsuleQueryEmbeddingResult =
  | { readonly kind: "ready"; readonly embedded: EmbeddedQuery }
  | { readonly kind: "identity-incompatible" }
  | { readonly kind: "embedding-failed" };

async function ensureCapsuleQueryEmbedding(
  embeddingAdapter: OpenAIEmbeddingAdapter,
  capsule: KnowledgeCapsule,
  query: string,
  options: SearchOptions,
  cache: Map<string, Promise<EmbeddedQuery | RetrievalError>>,
  preflightCache: Map<string, Promise<IdentityPreflightResult>>,
): Promise<CapsuleQueryEmbeddingResult> {
  const preflight = await ensureIdentityPreflight(
    embeddingAdapter,
    capsule.embeddingModelIdentity,
    options.signal,
    preflightCache,
  );
  if (preflight === "incompatible") return { kind: "identity-incompatible" };
  if (preflight === "failed") return { kind: "embedding-failed" };

  const embedded = await ensureQueryEmbedded(
    embeddingAdapter,
    capsule.embeddingModelIdentity,
    query,
    options.signal,
    cache,
  );
  if (embedded instanceof RetrievalError) {
    return {
      kind:
        embedded.code === "INCOMPATIBLE_EMBEDDING_IDENTITY"
          ? "identity-incompatible"
          : "embedding-failed",
    };
  }
  if (embedded.dimensions !== capsule.embeddingModelIdentity.vectorDimensions) {
    return { kind: "identity-incompatible" };
  }
  return { kind: "ready", embedded };
}

function recordEmbeddingFailure(
  state: SearchState,
  lane: EmbeddingLaneState,
  result: Exclude<CapsuleQueryEmbeddingResult, { readonly kind: "ready" }>,
): void {
  if (result.kind === "identity-incompatible") {
    state.anyIdentityIncompatible = true;
    markLaneStatus(lane, "identity-incompatible");
  } else {
    state.embeddingFailed = true;
    markLaneStatus(lane, "embedding-failed");
  }
}

function pushScoredCandidates(
  state: SearchState,
  lane: EmbeddingLaneState,
  scored: CapsuleScoreResult,
): void {
  if (scored.sawIdentityIncompatible) {
    state.anyIdentityIncompatible = true;
    markLaneStatus(lane, "identity-incompatible");
  }
  if (scored.sawDimensionCompatible) {
    state.anyDimensionCompatible = true;
    markLaneStatus(lane, "searched");
  } else if (!scored.sawIdentityIncompatible) {
    markLaneStatus(lane, "identity-incompatible");
  }
  lane.denseCandidateCount += scored.candidates.length;
  state.candidates.push(...scored.candidates);
}

function isExternalEmbeddingAllowed(capsule: KnowledgeCapsule): boolean {
  return resolveCapsuleModelUsePolicy(capsule).operations.externalEmbeddings === "allow";
}

// The lexical/BM25 lane never calls an embedding model, so `externalEmbeddings` does not
// govern it — but it DOES return raw chunk text as a citation body, which is exactly what
// `rawContentRelease` governs (see ADR-backed sealed-local defaults in
// `local-knowledge-model-use-policy.ts`). Without this gate a capsule whose policy was
// tightened to sealed-local after indexing (capsule-lifecycle.ts only flips the lifecycle
// hint to `stale`; it does not purge already-persisted lexical rows) would still leak its
// content through any lexically-matching query.
function isRawContentReleaseAllowed(capsule: KnowledgeCapsule): boolean {
  return resolveCapsuleModelUsePolicy(capsule).operations.rawContentRelease === "allow";
}

function denseCandidatesFromVectorIndex(
  candidates: readonly VectorIndexCandidate[],
  capsule: KnowledgeCapsule,
  laneId: string,
  laneKey: string,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
): readonly DenseCandidate[] {
  const allowedSources =
    sourceFilter === undefined
      ? undefined
      : new Set(sourceFilter.map((sourceId) => String(sourceId)));
  const out: DenseCandidate[] = [];
  for (const candidate of candidates) {
    if (String(candidate.capsuleId) !== String(capsule.id)) continue;
    if (
      allowedSources !== undefined &&
      (candidate.sourceId === undefined || !allowedSources.has(String(candidate.sourceId)))
    ) {
      continue;
    }
    out.push({
      chunkId: candidate.chunkId,
      capsuleId: capsule.id,
      laneId,
      laneKey,
      score: candidate.score,
    });
  }
  return out;
}

function tryVectorIndexForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  lane: EmbeddingLaneState,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  embedded: EmbeddedQuery,
  options: SearchOptions,
  profile: QueryProfile,
  state: SearchState,
): boolean {
  const indexed = searchVectorIndex(
    {
      store,
      capsule,
      ...(sourceFilter !== undefined ? { sourceFilter } : {}),
      queryVector: embedded.vector,
      candidateLimit: oversampleTopK(options.topK, profile),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    },
    options.vectorIndex,
  );
  state.vectorIndexDiagnostics.push(indexed.diagnostics);
  if (indexed.sawIdentityIncompatible) {
    state.anyIdentityIncompatible = true;
    markLaneStatus(lane, "identity-incompatible");
  }
  if (indexed.sawDimensionCompatible) {
    state.anyDimensionCompatible = true;
    markLaneStatus(lane, "searched");
  }
  if (!indexed.ok) return false;
  state.anyVectorSeen = true;
  const candidates = denseCandidatesFromVectorIndex(
    indexed.candidates,
    capsule,
    lane.laneId,
    lane.laneKey,
    sourceFilter,
  );
  lane.denseCandidateCount += candidates.length;
  state.candidates.push(...candidates);
  return true;
}

// eslint-disable-next-line max-lines-per-function, complexity
async function processCapsule(
  store: KnowledgeStore,
  embeddingAdapter: OpenAIEmbeddingAdapter,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  guidedChunkIds: readonly string[] | undefined,
  query: string,
  options: SearchOptions,
  profile: QueryProfile,
  cache: Map<string, Promise<EmbeddedQuery | RetrievalError>>,
  preflightCache: Map<string, Promise<IdentityPreflightResult>>,
  state: SearchState,
): Promise<void> {
  const lane = laneStateFor(state, capsule);
  const vectorStamp = vectorCacheStampForScope(store, capsule.id, sourceFilter);
  if (vectorStamp.n === 0) return;
  lane.vectorCount += vectorStamp.n;
  state.anyVectorSeen = true;
  if (!isExternalEmbeddingAllowed(capsule)) {
    state.embeddingPolicyDenied = true;
    markLaneStatus(lane, "policy-denied");
    return;
  }
  lane.queryEmbeddingRequested = true;

  const queryEmbedding = await ensureCapsuleQueryEmbedding(
    embeddingAdapter,
    capsule,
    query,
    options,
    cache,
    preflightCache,
  );
  if (queryEmbedding.kind !== "ready") {
    recordEmbeddingFailure(state, lane, queryEmbedding);
    return;
  }
  if (
    tryVectorIndexForCapsule(
      store,
      capsule,
      lane,
      sourceFilter,
      queryEmbedding.embedded,
      options,
      profile,
      state,
    )
  ) {
    return;
  }

  const vectorRead = readDecodedVectorsForCapsule(
    store,
    capsule,
    sourceFilter,
    options.maxExactVectorScanRows ?? DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS,
    guidedChunkIds,
  );
  if (vectorRead.kind === "skipped-too-large") {
    const annRead = readAnnIndexForCapsule(store, capsule, sourceFilter);
    if (annRead.kind === "skipped-too-large") {
      state.denseSkippedTooLarge = true;
      markLaneStatus(lane, "degraded");
      return;
    }
    if (annRead.kind === "empty") return;
    const annRows = annCandidateRowsForQuery(
      annRead.index,
      queryEmbedding.embedded.vector,
      ANN_RERANK_MAX_ROWS,
    );
    if (annRows.length === 0) {
      state.denseSkippedTooLarge = true;
      markLaneStatus(lane, "degraded");
      return;
    }
    const scored = scoreCapsuleVectors(
      annRows,
      capsule,
      lane.laneId,
      lane.laneKey,
      queryEmbedding.embedded.vector,
      oversampleTopK(options.topK, profile),
      options.minScore,
    );
    state.denseAnn = true;
    pushScoredCandidates(state, lane, scored);
    return;
  }
  if (vectorRead.rowCount > 0) state.anyVectorSeen = true;
  if (vectorRead.readMode === "guided") state.denseGuided = true;
  const rows = vectorRead.rows;
  if (rows.length === 0) return;

  const scored = scoreCapsuleVectors(
    rows,
    capsule,
    lane.laneId,
    lane.laneKey,
    queryEmbedding.embedded.vector,
    oversampleTopK(options.topK, profile),
    options.minScore,
  );
  pushScoredCandidates(state, lane, scored);
}

// Request-local `inFlight` dedupes concurrent embeds of the same (identity × query); resolved
// successes are promoted into the module-level LRU so later requests skip the network call.
// RetrievalError outcomes stay request-local (shared via the in-flight promise) and are never
// promoted, so a transient adapter failure cannot poison future requests.
function ensureQueryEmbedded(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  query: string,
  signal: AbortSignal | undefined,
  inFlight: Map<string, Promise<EmbeddedQuery | RetrievalError>>,
): Promise<EmbeddedQuery | RetrievalError> {
  const key = queryEmbeddingCacheKey(identity, query);
  const lru = queryEmbeddingCacheFor(adapter);
  const cached = lru.get(key);
  if (cached !== undefined) {
    lruTouchQueryEmbedding(lru, key, cached);
    return Promise.resolve(cached);
  }
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const started = embedQueryFor(adapter, identity, query, signal).then((result) => {
    if (!(result instanceof RetrievalError)) {
      lruTouchQueryEmbedding(lru, key, result);
    }
    return result;
  });
  inFlight.set(key, started);
  return started;
}

// Fires the (query variant × distinct in-scope embedding identity) preflight + embedding
// network calls concurrently WITHOUT awaiting them, so the synchronous SQLite work of the
// per-capsule loop overlaps with network latency instead of paying each call serially. The
// loop re-awaits the SAME in-flight promises and applies the existing failure taxonomy; the
// detached continuations here only suppress unhandled-rejection noise, never outcomes.
function prefetchQueryEmbeddings(inputs: {
  readonly store: KnowledgeStore;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  readonly capsules: readonly KnowledgeCapsule[];
  readonly scope: RetrievalScopeInput;
  readonly searchQueries: readonly string[];
  readonly options: SearchOptions;
  readonly cache: Map<string, Promise<EmbeddedQuery | RetrievalError>>;
  readonly preflightCache: Map<string, Promise<IdentityPreflightResult>>;
}): void {
  const identities = new Map<string, EmbeddingModelIdentity>();
  for (const capsule of inputs.capsules) {
    if (!isExternalEmbeddingAllowed(capsule)) continue;
    const sourceFilter = sourceFilterForCapsule(inputs.scope.sourceFilter, capsule);
    if (vectorCacheStampForScope(inputs.store, capsule.id, sourceFilter).n === 0) continue;
    identities.set(identityKey(capsule.embeddingModelIdentity), capsule.embeddingModelIdentity);
  }
  for (const identity of identities.values()) {
    for (const query of inputs.searchQueries) {
      const warmed = ensureIdentityPreflight(
        inputs.embeddingAdapter,
        identity,
        inputs.options.signal,
        inputs.preflightCache,
      ).then((preflight) =>
        preflight === "ok"
          ? ensureQueryEmbedded(
              inputs.embeddingAdapter,
              identity,
              query,
              inputs.options.signal,
              inputs.cache,
            )
          : undefined,
      );
      void warmed.catch(() => undefined);
    }
  }
}

// Closed enumeration of the failure surfaces produced by the search. Lifted to a type
// alias so `selectTopCandidates` can return either the surviving list or one of these
// reasons without the loose RetrievalReference shape leaking.
type EmptyReason =
  | "no-vectors"
  | "incompatible-embedding-identity"
  | "dense-scan-too-large"
  | "below-min-score"
  | "embedding-failed"
  | "policy-denied";

type CandidateSelection =
  | { readonly ok: true; readonly top: readonly FusedCandidate[] }
  | { readonly ok: false; readonly reason: EmptyReason };

// eslint-disable-next-line complexity
function selectTopCandidates(
  state: SearchState,
  candidates: readonly FusedCandidate[],
  lexicalPolicyDenied: boolean,
): CandidateSelection {
  if (!state.anyVectorSeen && candidates.length === 0) {
    return { ok: false, reason: "no-vectors" };
  }
  if (state.denseSkippedTooLarge && candidates.length === 0) {
    return { ok: false, reason: "dense-scan-too-large" };
  }
  if (state.embeddingFailed && candidates.length === 0) {
    return { ok: false, reason: "embedding-failed" };
  }
  if ((state.embeddingPolicyDenied || lexicalPolicyDenied) && candidates.length === 0) {
    return { ok: false, reason: "policy-denied" };
  }
  if (
    state.anyVectorSeen &&
    candidates.length === 0 &&
    !state.denseSkippedTooLarge &&
    !state.anyDimensionCompatible &&
    !state.embeddingFailed
  ) {
    return { ok: false, reason: "incompatible-embedding-identity" };
  }
  if (candidates.length === 0) return { ok: false, reason: "below-min-score" };
  return { ok: true, top: candidates };
}

function hasEmbeddingDegradation(state: SearchState, lexicalPolicyDenied: boolean): boolean {
  return (
    state.embeddingFailed ||
    state.embeddingPolicyDenied ||
    state.anyIdentityIncompatible ||
    state.denseSkippedTooLarge ||
    lexicalPolicyDenied
  );
}

function vectorIndexDiagnostics(
  diagnostics: readonly RetrievalVectorIndexDiagnostics[],
): RetrievalVectorIndexDiagnostics {
  const available = diagnostics.find((diagnostic) => diagnostic.status === "available");
  if (available !== undefined) return available;
  const fallback = diagnostics.find((diagnostic) => diagnostic.provider === "sqlite-vec");
  if (fallback !== undefined) return fallback;
  return {
    provider: "brute-force",
    status: "disabled",
    reason: "vector-index-disabled",
  };
}

function finalLaneStatus(lane: EmbeddingLaneState): RetrievalEmbeddingLaneStatus {
  const degradedStatuses = new Set<RetrievalEmbeddingLaneStatus>([
    "identity-incompatible",
    "embedding-failed",
    "policy-denied",
  ]);
  if (lane.denseCandidateCount > 0 && degradedStatuses.has(lane.status)) {
    return "degraded";
  }
  if (lane.status === "policy-denied") return "policy-denied";
  if (lane.status === "no-vectors" && lane.vectorCount > 0 && lane.queryEmbeddingRequested) {
    return "identity-incompatible";
  }
  if (lane.status === "degraded") return "degraded";
  return lane.denseCandidateCount > 0 ? "searched" : lane.status;
}

function embeddingLaneDiagnostics(
  state: SearchState,
): readonly RetrievalEmbeddingLaneDiagnostics[] {
  return [...state.lanes.values()]
    .sort((left, right) => left.laneId.localeCompare(right.laneId))
    .map((lane) => ({
      laneId: lane.laneId,
      capsuleIds: [...lane.capsuleIds].sort().map((id) => id as KnowledgeCapsuleId),
      status: finalLaneStatus(lane),
      queryEmbeddingRequested: lane.queryEmbeddingRequested,
      vectorCount: lane.vectorCount,
      denseCandidateCount: lane.denseCandidateCount,
    }));
}

function lexicalIndexState(lexical: LexicalCollection): RetrievalDiagnostics["lexicalIndex"] {
  if (lexical.queryError) return "query-error";
  return lexical.indexedRowCount === 0 ? "missing" : "available";
}

function denseIndexState(state: SearchState): RetrievalDiagnostics["denseIndex"] {
  if (state.denseSkippedTooLarge) return "skipped-too-large";
  if (state.denseAnn) return "ann";
  if (state.denseGuided) return "guided";
  return state.anyVectorSeen ? "available" : "missing";
}

function retrievalMode(
  state: SearchState,
  lexical: LexicalCollection,
): RetrievalDiagnostics["mode"] {
  const hasDense = state.candidates.length > 0;
  const hasLexical = lexical.candidates.length > 0;
  const denseDegraded = hasEmbeddingDegradation(state, lexical.policyDenied);
  if (denseDegraded && hasLexical && !hasDense) return "lexical-degraded";
  if (hasDense && hasLexical) return "hybrid";
  if (hasLexical) return "lexical-only";
  return "dense-only";
}

function retrievalDiagnostics(
  state: SearchState,
  lexical: LexicalCollection,
  fused: readonly FusedCandidate[],
  strategy: ResolvedRetrievalStrategy,
  budgets: CandidateBudgets,
  queryVariantCount: number,
): RetrievalDiagnostics {
  const lanes = embeddingLaneDiagnostics(state);
  return {
    mode: retrievalMode(state, lexical),
    strategy,
    denseCandidateCount: state.candidates.length,
    lexicalCandidateCount: lexical.candidates.length,
    fusedCandidateCount: fused.length,
    denseCandidateBudget: budgets.denseCandidateBudget,
    lexicalCandidateBudget: budgets.lexicalCandidateBudget,
    fusedCandidateBudget: budgets.fusedCandidateBudget,
    queryVariantCount,
    lexicalOrFallbackUsed: lexical.usedOrFallback,
    denseIndex: denseIndexState(state),
    lexicalIndex: lexicalIndexState(lexical),
    vectorIndex: vectorIndexDiagnostics(state.vectorIndexDiagnostics),
    embeddingLaneCount: lanes.length,
    embeddingLanes: lanes,
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
  const capsules = scope.capsules ?? loadCapsules(store, scope.capsuleIds);
  if (capsules.length === 0) {
    const profile = profileQuery(query, options.strategy);
    const budgets = candidateBudgets(options.topK, profile);
    return {
      references: [],
      noEvidenceReason: "no-vectors",
      diagnostics: {
        mode: "dense-only",
        strategy: profile.strategy,
        denseCandidateCount: 0,
        lexicalCandidateCount: 0,
        fusedCandidateCount: 0,
        denseCandidateBudget: budgets.denseCandidateBudget,
        lexicalCandidateBudget: budgets.lexicalCandidateBudget,
        fusedCandidateBudget: budgets.fusedCandidateBudget,
        queryVariantCount: 0,
        lexicalOrFallbackUsed: false,
        denseIndex: "missing",
        lexicalIndex: "missing",
        vectorIndex: {
          provider: "brute-force",
          status: "disabled",
          reason: "vector-index-disabled",
        },
        embeddingLaneCount: 0,
        embeddingLanes: [],
      },
    };
  }

  const profile = profileQuery(query, options.strategy);
  const searchQueries = await searchQueriesFor(query, profile, options);
  const budgets = candidateBudgets(options.topK, profile);
  const cache = new Map<string, Promise<EmbeddedQuery | RetrievalError>>();
  const preflightCache = new Map<string, Promise<IdentityPreflightResult>>();
  prefetchQueryEmbeddings({
    store,
    embeddingAdapter,
    capsules,
    scope,
    searchQueries,
    options,
    cache,
    preflightCache,
  });
  const state = emptyState();
  const lexicalCollections: LexicalCollection[] = [];
  for (const searchQuery of searchQueries) {
    const variantProfile = profileQuery(searchQuery, profile.strategy);
    const lexicalForQuery = collectLexicalCandidates(
      store,
      capsules,
      scope,
      variantProfile,
      options.topK,
    );
    lexicalCollections.push(lexicalForQuery);
    for (const capsule of capsules) {
      await processCapsule(
        store,
        embeddingAdapter,
        capsule,
        sourceFilterForCapsule(scope.sourceFilter, capsule),
        guidedChunkIdsForCapsule(lexicalForQuery.candidates, capsule.id),
        searchQuery,
        options,
        variantProfile,
        cache,
        preflightCache,
        state,
      );
    }
  }
  const lexical = mergeLexicalCollections(lexicalCollections);
  const fused = fuseCandidates(state.candidates, lexical.candidates, budgets.fusedCandidateBudget);
  const diagnostics = retrievalDiagnostics(
    state,
    lexical,
    fused,
    profile.strategy,
    budgets,
    searchQueries.length,
  );
  const selection = selectTopCandidates(state, fused, lexical.policyDenied);
  if (!selection.ok) {
    return { references: [], noEvidenceReason: selection.reason, diagnostics };
  }
  const refs = buildReferences(store, selection.top, options.topK, profile);
  return hasEmbeddingDegradation(state, lexical.policyDenied)
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
  const exactPhrases = extractExactPhrases(query);
  const strategy = resolveQueryStrategy(query, tokens, exactTerms, exactPhrases, requested);
  if (strategy === "exact") return exactQueryProfile(tokens, exactTerms, exactPhrases);
  if (strategy === "broad") return broadQueryProfile(tokens, exactTerms, exactPhrases);
  return balancedQueryProfile(tokens, exactTerms, exactPhrases);
}

function resolveQueryStrategy(
  query: string,
  tokens: readonly string[],
  exactTerms: readonly string[],
  exactPhrases: readonly string[],
  requested: SearchOptions["strategy"] | undefined,
): QueryProfile["strategy"] {
  if (requested !== undefined && requested !== "auto") return requested;
  if (exactPhrases.length > 0) return "exact";
  if (exactTerms.some(isStrongLexicalRecallTerm)) return "exact";
  if (tokens.length >= 8 || BROAD_QUERY_PATTERN.test(query)) return "broad";
  return "balanced";
}

function exactQueryProfile(
  tokens: readonly string[],
  exactTerms: readonly string[],
  exactPhrases: readonly string[],
): QueryProfile {
  return {
    strategy: "exact",
    tokens,
    exactTerms,
    exactPhrases,
    lexicalRecallTerms: buildLexicalRecallTerms(tokens, exactTerms),
    documentDiversityPenalty: 0.0018,
    sectionDiversityPenalty: 0.001,
  };
}

function broadQueryProfile(
  tokens: readonly string[],
  exactTerms: readonly string[],
  exactPhrases: readonly string[],
): QueryProfile {
  return {
    strategy: "broad",
    tokens,
    exactTerms,
    exactPhrases,
    lexicalRecallTerms: buildLexicalRecallTerms(tokens, exactTerms),
    documentDiversityPenalty: 0.003,
    sectionDiversityPenalty: 0.0015,
  };
}

function balancedQueryProfile(
  tokens: readonly string[],
  exactTerms: readonly string[],
  exactPhrases: readonly string[],
): QueryProfile {
  return {
    strategy: "balanced",
    tokens,
    exactTerms,
    exactPhrases,
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

function extractExactPhrases(value: string): readonly string[] {
  const out: string[] = [];
  for (const match of value.matchAll(EXACT_QUOTED_PHRASE_PATTERN)) {
    const phrase = normaliseForSearch(match[1] ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    const tokens = phrase.split(/\s+/u).filter((token) => token.length >= 2);
    if (tokens.length >= 2 || (tokens.length === 1 && phrase.length >= 3)) out.push(phrase);
  }
  return uniqueTokens(out);
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
): readonly LexicalQueryTermGroup[] {
  const tokenTerms = tokens.filter((token) => token.length >= LEXICAL_RECALL_MIN_TOKEN_LENGTH);
  return lexicalQueryTermGroups(uniqueTokens([...exactTerms, ...tokenTerms])).slice(
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
