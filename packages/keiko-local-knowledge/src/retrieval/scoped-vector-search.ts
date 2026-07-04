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
import type { KnowledgeStore } from "../store.js";
import type { StoreContentCipher } from "../store-content-cipher.js";

import { shapeEmbeddingQuery } from "./embedding-query-shaping.js";
import { lexicalQueryTermGroups, type LexicalQueryTermGroup } from "./lexical-normalization.js";
import {
  RetrievalError,
  type QueryTransformer,
  type RetrievalDiagnostics,
  type RetrievalNoEvidenceReason,
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
  readonly maxExactVectorScanRows?: number;
  readonly vectorIndex?: VectorIndexOptions;
}

interface QueryProfile {
  readonly strategy: "balanced" | "exact" | "broad";
  readonly tokens: readonly string[];
  readonly exactTerms: readonly string[];
  readonly lexicalRecallTerms: readonly LexicalQueryTermGroup[];
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
  const rows = readVectorsForCapsule(store, capsule.id, sourceFilter, undefined).map((row) => ({
    ...row,
    vector: normalizeVectorForIdentity(
      decodeEmbedding(row, store._internal.contentCipher),
      capsule.embeddingModelIdentity,
    ),
  }));
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
    rows = readVectorsForCapsule(store, capsule.id, sourceFilter, chunkFilter).map((row) => ({
      ...row,
      vector: normalizeVectorForIdentity(
        decodeEmbedding(row, store._internal.contentCipher),
        capsule.embeddingModelIdentity,
      ),
    }));
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
      : exactTerms
          .map((_, i) => `instr(lower(li.exact_text), :exact${String(i)}) > 0`)
          .join(" OR ");
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
  readonly vectorIndexDiagnostics: RetrievalVectorIndexDiagnostics[];
  anyVectorSeen: boolean;
  anyDimensionCompatible: boolean;
  anyIdentityIncompatible: boolean;
  embeddingFailed: boolean;
  denseSkippedTooLarge: boolean;
  denseGuided: boolean;
  denseAnn: boolean;
}

function emptyState(): SearchState {
  return {
    candidates: [],
    vectorIndexDiagnostics: [],
    anyVectorSeen: false,
    anyDimensionCompatible: false,
    anyIdentityIncompatible: false,
    embeddingFailed: false,
    denseSkippedTooLarge: false,
    denseGuided: false,
    denseAnn: false,
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

type CapsuleQueryEmbeddingResult =
  | { readonly kind: "ready"; readonly embedded: EmbeddedQuery }
  | { readonly kind: "identity-incompatible" }
  | { readonly kind: "embedding-failed" };

async function ensureCapsuleQueryEmbedding(
  embeddingAdapter: OpenAIEmbeddingAdapter,
  capsule: KnowledgeCapsule,
  query: string,
  options: SearchOptions,
  cache: Map<string, EmbeddedQuery>,
  preflightCache: Map<string, IdentityPreflightResult>,
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
  if (embedded === undefined) return { kind: "embedding-failed" };
  if (embedded.dimensions !== capsule.embeddingModelIdentity.vectorDimensions) {
    return { kind: "identity-incompatible" };
  }
  return { kind: "ready", embedded };
}

function recordEmbeddingFailure(
  state: SearchState,
  result: Exclude<CapsuleQueryEmbeddingResult, { readonly kind: "ready" }>,
): void {
  if (result.kind === "identity-incompatible") {
    state.anyIdentityIncompatible = true;
  } else {
    state.embeddingFailed = true;
  }
}

function pushScoredCandidates(state: SearchState, scored: CapsuleScoreResult): void {
  if (scored.sawIdentityIncompatible) state.anyIdentityIncompatible = true;
  if (scored.sawDimensionCompatible) state.anyDimensionCompatible = true;
  state.candidates.push(...scored.candidates);
}

function denseCandidatesFromVectorIndex(
  candidates: readonly VectorIndexCandidate[],
  capsule: KnowledgeCapsule,
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
      score: candidate.score,
    });
  }
  return out;
}

function tryVectorIndexForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
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
  if (indexed.sawIdentityIncompatible) state.anyIdentityIncompatible = true;
  if (indexed.sawDimensionCompatible) state.anyDimensionCompatible = true;
  if (!indexed.ok) return false;
  state.anyVectorSeen = true;
  state.candidates.push(
    ...denseCandidatesFromVectorIndex(indexed.candidates, capsule, sourceFilter),
  );
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
  cache: Map<string, EmbeddedQuery>,
  preflightCache: Map<string, IdentityPreflightResult>,
  state: SearchState,
): Promise<void> {
  const vectorStamp = vectorCacheStampForScope(store, capsule.id, sourceFilter);
  if (vectorStamp.n === 0) return;
  state.anyVectorSeen = true;

  const queryEmbedding = await ensureCapsuleQueryEmbedding(
    embeddingAdapter,
    capsule,
    query,
    options,
    cache,
    preflightCache,
  );
  if (queryEmbedding.kind !== "ready") {
    recordEmbeddingFailure(state, queryEmbedding);
    return;
  }
  if (
    tryVectorIndexForCapsule(
      store,
      capsule,
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
      return;
    }
    const scored = scoreCapsuleVectors(
      annRows,
      capsule,
      queryEmbedding.embedded.vector,
      oversampleTopK(options.topK, profile),
      options.minScore,
    );
    state.denseAnn = true;
    pushScoredCandidates(state, scored);
    return;
  }
  if (vectorRead.rowCount > 0) state.anyVectorSeen = true;
  if (vectorRead.readMode === "guided") state.denseGuided = true;
  const rows = vectorRead.rows;
  if (rows.length === 0) return;

  const scored = scoreCapsuleVectors(
    rows,
    capsule,
    queryEmbedding.embedded.vector,
    oversampleTopK(options.topK, profile),
    options.minScore,
  );
  pushScoredCandidates(state, scored);
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
  | "no-vectors"
  | "incompatible-embedding-identity"
  | "dense-scan-too-large"
  | "below-min-score"
  | "embedding-failed";

type CandidateSelection =
  | { readonly ok: true; readonly top: readonly FusedCandidate[] }
  | { readonly ok: false; readonly reason: EmptyReason };

// eslint-disable-next-line complexity
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
  if (state.denseSkippedTooLarge && candidates.length === 0) {
    return { ok: false, reason: "dense-scan-too-large" };
  }
  if (state.embeddingFailed && candidates.length === 0) {
    return { ok: false, reason: "embedding-failed" };
  }
  if (
    state.anyVectorSeen &&
    !state.denseSkippedTooLarge &&
    !state.anyDimensionCompatible &&
    !state.embeddingFailed
  ) {
    return { ok: false, reason: "incompatible-embedding-identity" };
  }
  if (candidates.length === 0) return { ok: false, reason: "below-min-score" };
  return { ok: true, top: candidates };
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

// eslint-disable-next-line complexity
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
  const denseIndex = state.denseSkippedTooLarge
    ? "skipped-too-large"
    : state.denseAnn
      ? "ann"
      : state.denseGuided
        ? "guided"
        : state.anyVectorSeen
          ? "available"
          : "missing";
  const hasDense = state.candidates.length > 0;
  const hasLexical = lexical.candidates.length > 0;
  const denseDegraded = state.embeddingFailed || state.denseSkippedTooLarge;
  const mode =
    denseDegraded && hasLexical && !hasDense
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
    denseIndex,
    lexicalIndex,
    vectorIndex: vectorIndexDiagnostics(state.vectorIndexDiagnostics),
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
        denseIndex: "missing",
        lexicalIndex: "missing",
        vectorIndex: {
          provider: "brute-force",
          status: "disabled",
          reason: "vector-index-disabled",
        },
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
