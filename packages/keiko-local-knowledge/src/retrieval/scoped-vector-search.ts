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
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";

import { getCapsule } from "../capsule-lifecycle.js";
import type { ComposedRetrievalScope } from "../composition.js";
import type { KnowledgeStore } from "../store.js";

import { RetrievalError } from "./types.js";

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
  readonly vector_dimensions: number;
  readonly vector_metric: string;
}

const SELECT_VECTORS_FOR_CAPSULE_SQL = [
  "SELECT chunk_id, capsule_id, source_id, document_id, embedding,",
  "  vector_dimensions, vector_metric",
  "FROM vectors",
  "WHERE capsule_id = :c",
].join(" ");

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
  const rows = store._internal.db
    .prepare(`${SELECT_VECTORS_FOR_CAPSULE_SQL}${sourceClause}`)
    .all(params);
  return rows as unknown as readonly VectorRow[];
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
    "  pu.page_number, pu.page_label, pu.section_path_json,",
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
function decodeEmbedding(row: VectorRow): Float32Array {
  if (row.embedding.byteLength !== row.vector_dimensions * 4) {
    throw new RetrievalError(
      "STORE_READ_FAILED",
      "vector blob length does not match vector_dimensions",
    );
  }
  const copy = new Uint8Array(row.embedding); // detach from sqlite row buffer
  return new Float32Array(copy.buffer, copy.byteOffset, row.vector_dimensions);
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
  return [
    identity.provider,
    identity.modelId,
    String(identity.vectorDimensions),
    identity.vectorMetric,
  ].join("|");
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
    input: text,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!outcome.ok) {
    return new RetrievalError(
      "EMBEDDING_ADAPTER_FAILED",
      `embedding adapter returned ${outcome.kind}`,
    );
  }
  return { vector: outcome.value.vector, dimensions: outcome.value.vector.length };
}

// ─── Citation builder ────────────────────────────────────────────────────────
function parseSectionPath(json: string | null): readonly string[] | undefined {
  if (json === null) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
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

function rowToCitation(row: CitationRow): CitationReference {
  const sectionPath = parseSectionPath(row.section_path_json);
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
    ...(row.character_start !== null ? { characterStart: row.character_start } : {}),
    ...(row.character_end !== null ? { characterEnd: row.character_end } : {}),
  };
}

// ─── Per-capsule candidate selection ─────────────────────────────────────────
// Scores every vector row for one capsule, then truncates to the per-capsule top-K. We
// do not merge across capsules until all per-capsule top-Ks are collected so a single
// dense capsule cannot starve the merge of evidence from a smaller capsule.
interface ScoredCandidate {
  readonly chunkId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly score: number;
}

function scoreCapsuleVectors(
  rows: readonly VectorRow[],
  capsule: KnowledgeCapsule,
  queryVector: Float32Array,
  topK: number,
  minScore: number | undefined,
): readonly ScoredCandidate[] {
  const metric = capsule.embeddingModelIdentity.vectorMetric;
  const scored: ScoredCandidate[] = [];
  for (const row of rows) {
    // Belt-and-braces: the SQL filter already restricts to `capsule_id = capsule.id`, but
    // we re-assert at decode time so an arbitrary store-bypass cannot leak a row.
    if (row.capsule_id !== String(capsule.id)) continue;
    if (row.vector_dimensions !== queryVector.length) continue;
    const vector = decodeEmbedding(row);
    const score = scoreFor(metric, queryVector, vector);
    if (minScore !== undefined && score < minScore) continue;
    scored.push({ chunkId: row.chunk_id, capsuleId: capsule.id, score });
  }
  scored.sort(scoreDesc);
  return scored.slice(0, oversampleTopK(topK));
}

function oversampleTopK(topK: number): number {
  return Math.max(topK, Math.min(topK * 3, topK + 12));
}

function scoreDesc(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  // Stable tiebreak by chunkId so reordering of equal-score rows is deterministic across
  // platforms — important for the snapshot tests in #200.
  return a.chunkId.localeCompare(b.chunkId);
}

// ─── Main entry point ────────────────────────────────────────────────────────
// `searchVectorsForScope` is intentionally a single linear pass:
//   1. Resolve every in-scope capsule (skip ids that no longer exist).
//   2. Embed the query once per distinct identity tuple.
//   3. Per capsule: read its vectors, score, take per-capsule top-K.
//   4. Merge candidates, sort by score desc, take global top-K.
//   5. Read citation metadata for the surviving candidates.
//   6. Compose `RetrievalReference[]`.
//
// Returns either the ranked references or a structured failure reason — never throws on
// expected paths (embedding failure, dim mismatch). Throws `RetrievalError` only on
// store-corruption invariants (e.g. blob length mismatch).
export interface SearchOutcome {
  readonly references: readonly RetrievalReference[];
  // Set when the search produced no references for a reason the runner needs to
  // discriminate. `noEvidence` mirrors `RetrievalResult` (same vocabulary).
  readonly noEvidenceReason?:
    | "no-vectors"
    | "incompatible-embedding-identity"
    | "below-min-score"
    | "embedding-failed";
}

// Tracks the accumulated state of a single search pass. Hoisted out of the entry function
// so the orchestrator stays under the cyclomatic-complexity budget (the per-capsule loop
// has 4 distinct branches; bundling them into one function pushes it past the lint cap).
interface SearchState {
  readonly candidates: ScoredCandidate[];
  anyVectorSeen: boolean;
  anyDimensionCompatible: boolean;
  embeddingFailed: boolean;
}

function emptyState(): SearchState {
  return {
    candidates: [],
    anyVectorSeen: false,
    anyDimensionCompatible: false,
    embeddingFailed: false,
  };
}

async function processCapsule(
  store: KnowledgeStore,
  embeddingAdapter: OpenAIEmbeddingAdapter,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  query: string,
  options: SearchOptions,
  cache: Map<string, EmbeddedQuery>,
  state: SearchState,
): Promise<void> {
  const rows = readVectorsForCapsule(store, capsule.id, sourceFilter);
  if (rows.length === 0) return;
  state.anyVectorSeen = true;

  const embedded = await ensureQueryEmbedded(
    embeddingAdapter,
    capsule.embeddingModelIdentity,
    query,
    options.signal,
    cache,
  );
  if (embedded === undefined) {
    state.embeddingFailed = true;
    return;
  }
  if (embedded.dimensions !== capsule.embeddingModelIdentity.vectorDimensions) {
    // Adapter returned a dim that doesn't match the capsule's pinned identity — same
    // failure surface as #192's `INCOMPATIBLE_EMBEDDING_IDENTITY`. Skip this capsule.
    return;
  }
  state.anyDimensionCompatible = true;
  const candidates = scoreCapsuleVectors(
    rows,
    capsule,
    embedded.vector,
    options.topK,
    options.minScore,
  );
  state.candidates.push(...candidates);
}

async function ensureQueryEmbedded(
  adapter: OpenAIEmbeddingAdapter,
  identity: EmbeddingModelIdentity,
  query: string,
  signal: AbortSignal | undefined,
  cache: Map<string, EmbeddedQuery>,
): Promise<EmbeddedQuery | undefined> {
  const key = identityKey(identity);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await embedQueryFor(adapter, identity, query, signal);
  if (result instanceof RetrievalError) return undefined;
  cache.set(key, result);
  return result;
}

// Closed enumeration of the failure surfaces produced by the search. Lifted to a type
// alias so `selectTopCandidates` can return either the surviving list or one of these
// reasons without the loose RetrievalReference shape leaking.
type EmptyReason =
  | "no-vectors"
  | "incompatible-embedding-identity"
  | "below-min-score"
  | "embedding-failed";

type CandidateSelection =
  | { readonly ok: true; readonly top: readonly ScoredCandidate[] }
  | { readonly ok: false; readonly reason: EmptyReason };

function selectTopCandidates(state: SearchState, options: SearchOptions): CandidateSelection {
  if (!state.anyVectorSeen) return { ok: false, reason: "no-vectors" };
  if (state.embeddingFailed && state.candidates.length === 0) {
    return { ok: false, reason: "embedding-failed" };
  }
  if (!state.anyDimensionCompatible) {
    return { ok: false, reason: "incompatible-embedding-identity" };
  }
  state.candidates.sort(scoreDesc);
  const top = state.candidates.slice(0, oversampleTopK(options.topK));
  if (top.length === 0) return { ok: false, reason: "below-min-score" };
  return { ok: true, top };
}

export async function searchVectorsForScope(
  store: KnowledgeStore,
  embeddingAdapter: OpenAIEmbeddingAdapter,
  scope: RetrievalScopeInput,
  query: string,
  options: SearchOptions,
): Promise<SearchOutcome> {
  const capsules = loadCapsules(store, scope.capsuleIds);
  if (capsules.length === 0) return { references: [], noEvidenceReason: "no-vectors" };

  const cache = new Map<string, EmbeddedQuery>();
  const state = emptyState();
  for (const capsule of capsules) {
    await processCapsule(
      store,
      embeddingAdapter,
      capsule,
      scope.sourceFilter,
      query,
      options,
      cache,
      state,
    );
  }
  const selection = selectTopCandidates(state, options);
  if (!selection.ok) return { references: [], noEvidenceReason: selection.reason };
  return { references: buildReferences(store, selection.top, query, options.topK) };
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
  candidates: readonly ScoredCandidate[],
  query: string,
  limit: number,
): readonly RetrievalReference[] {
  // Group surviving candidates by capsule so we can issue one citation-read per capsule.
  const byCapsule = new Map<string, ScoredCandidate[]>();
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
      citationByChunk.set(`${row.capsule_id}|${row.chunk_id}`, rowToCitation(row));
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
      score: candidate.score + lexicalMetadataBonus(query, citation),
      citation,
    });
  }
  refs.sort(referenceScoreDesc);
  return refs.slice(0, limit);
}

function referenceScoreDesc(a: RetrievalReference, b: RetrievalReference): number {
  if (b.score !== a.score) return b.score - a.score;
  return String(a.chunkId).localeCompare(String(b.chunkId));
}

function lexicalMetadataBonus(query: string, citation: CitationReference): number {
  const queryTokens = tokenise(query);
  if (queryTokens.length === 0) return 0;
  const haystack = tokenise(
    [
      citation.safeDisplayName,
      citation.pageLabel,
      ...(citation.sectionPath ?? []),
      String(citation.pageNumber ?? ""),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
  if (haystack.length === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }
  if (hits === 0) return 0;
  return hits / (queryTokens.length * 10);
}

function tokenise(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 2);
}
