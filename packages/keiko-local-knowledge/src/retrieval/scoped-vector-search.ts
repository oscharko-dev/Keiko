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
import type { StoreContentCipher } from "../store-content-cipher.js";

import { RetrievalError } from "./types.js";

const SEARCH_EXCERPT_MAX_CHARS = 1_600;
const SEARCH_CONTEXT_BEFORE_CHARS = 420;
const LEXICAL_RECALL_EXCERPT_CHARS = 900;
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
}

interface QueryProfile {
  readonly strategy: "balanced" | "exact" | "broad";
  readonly tokens: readonly string[];
  readonly exactTerms: readonly string[];
  readonly lexicalRecallTerms: readonly string[];
  readonly lexicalWeight: number;
  readonly phraseWeight: number;
  readonly metadataWeight: number;
  readonly contextBeforeChars: number;
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
  return store._internal.db
    .prepare(`${SELECT_VECTORS_FOR_CAPSULE_SQL}${sourceClause}`)
    .all(params) as unknown as readonly VectorRow[];
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
    "      AND p.character_start <= COALESCE(c.character_start, pu.character_start)",
    "      AND p.character_end >= COALESCE(c.character_end, pu.character_end)",
    "    ORDER BY p.page_number ASC LIMIT 1",
    "  )) AS page_number,",
    "  COALESCE(pu.page_label, (",
    "    SELECT p.page_label FROM pages p",
    "    WHERE p.capsule_id = c.capsule_id AND p.document_id = c.document_id",
    "      AND p.character_start <= COALESCE(c.character_start, pu.character_start)",
    "      AND p.character_end >= COALESCE(c.character_end, pu.character_end)",
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
  candidateLimit: number,
  minScore: number | undefined,
  cipher: StoreContentCipher,
): readonly ScoredCandidate[] {
  const metric = capsule.embeddingModelIdentity.vectorMetric;
  const scored: ScoredCandidate[] = [];
  for (const row of rows) {
    // Belt-and-braces: the SQL filter already restricts to `capsule_id = capsule.id`, but
    // we re-assert at decode time so an arbitrary store-bypass cannot leak a row.
    if (row.capsule_id !== String(capsule.id)) continue;
    if (row.vector_dimensions !== queryVector.length) continue;
    const vector = decodeEmbedding(row, cipher);
    const score = scoreFor(metric, queryVector, vector);
    if (minScore !== undefined && score < minScore) continue;
    scored.push({ chunkId: row.chunk_id, capsuleId: capsule.id, score });
  }
  scored.sort(scoreDesc);
  return scored.slice(0, candidateLimit);
}

interface LexicalDocumentRow {
  readonly document_id: string;
  readonly source_id: string;
  readonly safe_display_name: string | null;
  readonly normalized_text: string;
}

interface LexicalChunkRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
}

interface LexicalHit {
  readonly position: number;
  readonly searchText: string;
}

function lexicalRecallLimit(topK: number, profile: QueryProfile): number {
  if (profile.exactTerms.some(isStrongLexicalRecallTerm)) return 1;
  const multiplier = profile.strategy === "exact" ? 16 : profile.strategy === "broad" ? 8 : 10;
  const cap = profile.strategy === "exact" ? topK + 144 : topK + 96;
  return Math.max(topK, Math.min(topK * multiplier, cap));
}

function lexicalBaseScore(profile: QueryProfile): number {
  if (profile.strategy === "exact") return 0.88;
  if (profile.strategy === "broad") return 0.68;
  return 0.78;
}

function lexicalCandidateScore(searchText: string, profile: QueryProfile): number {
  if (profile.lexicalRecallTerms.length === 0) return 0;
  let termHits = 0;
  for (const term of profile.lexicalRecallTerms) {
    if (searchText.includes(term)) termHits += 1;
  }
  let exactHits = 0;
  for (const term of profile.exactTerms) {
    if (searchText.includes(term)) exactHits += 1;
  }
  const coverage = termHits / profile.lexicalRecallTerms.length;
  return (
    lexicalBaseScore(profile) + Math.min(0.24, coverage * 0.24) + Math.min(0.16, exactHits * 0.04)
  );
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

function lexicalDocumentSql(sourceFilter: readonly KnowledgeSourceId[] | undefined): string {
  return [
    "SELECT d.id AS document_id, d.source_id, d.safe_display_name, dt.normalized_text",
    "FROM documents AS d",
    "JOIN document_texts AS dt ON dt.capsule_id = d.capsule_id AND dt.document_id = d.id",
    `WHERE d.capsule_id = :capsule_id${sourceFilterClause(sourceFilter, "d.")}`,
    "ORDER BY d.safe_display_name ASC, d.id ASC",
  ].join(" ");
}

function readLexicalDocuments(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
): readonly LexicalDocumentRow[] {
  const rows = store._internal.db.prepare(lexicalDocumentSql(sourceFilter)).all({
    capsule_id: String(capsuleId),
    ...sourceParams(sourceFilter),
  }) as unknown as readonly LexicalDocumentRow[];
  // Decrypt the joined document_texts text at the store boundary before the lexical scan runs over it.
  // This join only matches small documents (large documents store text in document_text_windows, not
  // document_texts), so the per-row decrypt stays within the small-document memory bound.
  const cipher = store._internal.contentCipher;
  if (!cipher.isEncrypted) return rows;
  return rows.map((row) => ({ ...row, normalized_text: cipher.openText(row.normalized_text) }));
}

function lexicalChunkSql(
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  mode: "contains" | "nearest",
): string {
  const positionStart = "COALESCE(c.character_start, pu.character_start, 0)";
  const positionEnd =
    "COALESCE(c.character_end, pu.character_end, COALESCE(c.character_start, pu.character_start, 0) + 1)";
  const predicate =
    mode === "contains" ? `AND ${positionStart} <= :position AND ${positionEnd} >= :position` : "";
  const order =
    mode === "contains"
      ? "ORDER BY c.order_index ASC, c.id ASC"
      : `ORDER BY ABS(${positionStart} - :position) ASC, c.order_index ASC, c.id ASC`;
  return [
    "SELECT c.id AS chunk_id, c.capsule_id AS capsule_id",
    "FROM chunks AS c",
    "JOIN vectors AS v ON v.capsule_id = c.capsule_id AND v.chunk_id = c.id",
    "LEFT JOIN parsed_units AS pu ON pu.capsule_id = c.capsule_id AND pu.id = c.parsed_unit_id",
    `WHERE c.capsule_id = :capsule_id AND c.document_id = :document_id${sourceFilterClause(
      sourceFilter,
      "c.",
    )}`,
    predicate,
    order,
    "LIMIT 3",
  ].join(" ");
}

function chunkRowsForHit(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  documentId: string,
  position: number,
): readonly LexicalChunkRow[] {
  const params = {
    capsule_id: String(capsuleId),
    document_id: documentId,
    position,
    ...sourceParams(sourceFilter),
  };
  const contained = store._internal.db
    .prepare(lexicalChunkSql(sourceFilter, "contains"))
    .all(params) as unknown as readonly LexicalChunkRow[];
  if (contained.length > 0) return contained;
  return store._internal.db
    .prepare(lexicalChunkSql(sourceFilter, "nearest"))
    .all(params) as unknown as readonly LexicalChunkRow[];
}

function lexicalSearchExcerpt(text: string, position: number, profile: QueryProfile): string {
  const start = Math.max(0, position - profile.contextBeforeChars);
  const end = Math.min(text.length, position + LEXICAL_RECALL_EXCERPT_CHARS);
  return text.slice(start, end).toLowerCase();
}

function lexicalHitsForDocument(
  doc: LexicalDocumentRow,
  profile: QueryProfile,
  limit: number,
): readonly LexicalHit[] {
  const hits: LexicalHit[] = [];
  const seenBuckets = new Set<number>();
  const text = doc.normalized_text.toLowerCase();
  const metadata = normaliseForSearch(doc.safe_display_name ?? "");
  for (const term of profile.lexicalRecallTerms) {
    let position = text.indexOf(term);
    if (position < 0 && metadata.includes(term)) position = 0;
    if (position < 0) continue;
    const bucket = Math.floor(position / Math.max(1, LEXICAL_RECALL_EXCERPT_CHARS));
    if (seenBuckets.has(bucket)) continue;
    seenBuckets.add(bucket);
    hits.push({ position, searchText: lexicalSearchExcerpt(text, position, profile) });
    if (hits.length >= limit) break;
  }
  return hits;
}

function lexicalRecallCandidatesForCapsule(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  sourceFilter: readonly KnowledgeSourceId[] | undefined,
  profile: QueryProfile,
  topK: number,
): readonly ScoredCandidate[] {
  if (profile.lexicalRecallTerms.length === 0) return [];
  const limit = lexicalRecallLimit(topK, profile);
  const out: ScoredCandidate[] = [];
  for (const doc of readLexicalDocuments(store, capsule.id, sourceFilter)) {
    const remaining = Math.max(0, limit - out.length);
    if (remaining === 0) break;
    const hits = lexicalHitsForDocument(doc, profile, remaining);
    for (const hit of hits) {
      for (const row of chunkRowsForHit(
        store,
        capsule.id,
        sourceFilter,
        doc.document_id,
        hit.position,
      )) {
        out.push({
          chunkId: row.chunk_id,
          capsuleId: capsule.id,
          score: lexicalCandidateScore(hit.searchText, profile),
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }
  return out.filter((candidate) => candidate.score > 0).sort(scoreDesc);
}

function mergeCandidates(
  candidates: readonly ScoredCandidate[],
  lexicalCandidates: readonly ScoredCandidate[],
): readonly ScoredCandidate[] {
  if (lexicalCandidates.length === 0) return candidates;
  const byKey = new Map<string, ScoredCandidate>();
  for (const candidate of candidates) {
    byKey.set(`${String(candidate.capsuleId)}|${candidate.chunkId}`, candidate);
  }
  for (const candidate of lexicalCandidates) {
    const key = `${String(candidate.capsuleId)}|${candidate.chunkId}`;
    const existing = byKey.get(key);
    if (existing === undefined || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function collectLexicalRecallCandidates(
  store: KnowledgeStore,
  capsules: readonly KnowledgeCapsule[],
  scope: RetrievalScopeInput,
  profile: QueryProfile,
  topK: number,
): readonly ScoredCandidate[] {
  if (profile.lexicalRecallTerms.length === 0) return [];
  const out: ScoredCandidate[] = [];
  for (const capsule of capsules) {
    out.push(
      ...lexicalRecallCandidatesForCapsule(
        store,
        capsule,
        sourceFilterForCapsule(scope.sourceFilter, capsule),
        profile,
        topK,
      ),
    );
  }
  return out;
}

function oversampleTopK(topK: number, profile: QueryProfile): number {
  const multiplier = profile.strategy === "exact" ? 12 : profile.strategy === "broad" ? 10 : 8;
  const cap = profile.strategy === "exact" ? topK + 96 : topK + 64;
  return Math.max(topK, Math.min(topK * multiplier, cap));
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
  // True when the embedding adapter failed for at least one capsule but lexical
  // candidates kept the result non-empty. Observability signal only — does not
  // change which references are returned.
  readonly embeddingDegraded?: true;
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
  profile: QueryProfile,
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
    oversampleTopK(options.topK, profile),
    options.minScore,
    store._internal.contentCipher,
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

function selectTopCandidates(
  state: SearchState,
  options: SearchOptions,
  profile: QueryProfile,
  candidates: readonly ScoredCandidate[] = state.candidates,
): CandidateSelection {
  if (!state.anyVectorSeen) return { ok: false, reason: "no-vectors" };
  if (state.embeddingFailed && candidates.length === 0) {
    return { ok: false, reason: "embedding-failed" };
  }
  if (!state.anyDimensionCompatible) {
    return { ok: false, reason: "incompatible-embedding-identity" };
  }
  const sorted = [...candidates].sort(scoreDesc);
  const top = sorted.slice(0, oversampleTopK(options.topK, profile));
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

  const profile = profileQuery(query, options.strategy);
  const cache = new Map<string, EmbeddedQuery>();
  const state = emptyState();
  for (const capsule of capsules) {
    await processCapsule(
      store,
      embeddingAdapter,
      capsule,
      sourceFilterForCapsule(scope.sourceFilter, capsule),
      query,
      options,
      profile,
      cache,
      state,
    );
  }
  // GRD-002 / GRD-024: `minScore` is a DENSE relevance floor. Lexical recall is a recall booster
  // whose candidates carry a lexical base score (0.68–0.88) unrelated to vector similarity, so
  // they would bypass the floor (a ~0-cosine chunk that merely shares a query token could surface
  // above a 0.9 floor). When a caller sets `minScore`, suppress lexical recall so only
  // vector candidates that already passed the cosine floor (scoreCapsuleVectors) survive — and so
  // the `below-min-score` no-evidence reason becomes reachable when none do. The default path
  // (no `minScore`) keeps hybrid lexical recall unchanged.
  const lexicalCandidates =
    state.anyDimensionCompatible && options.minScore === undefined
      ? collectLexicalRecallCandidates(store, capsules, scope, profile, options.topK)
      : [];
  const candidates = mergeCandidates(state.candidates, lexicalCandidates);
  const selection = selectTopCandidates(state, options, profile, candidates);
  if (!selection.ok) return { references: [], noEvidenceReason: selection.reason };
  const refs = buildReferences(store, selection.top, options.topK, profile);
  return state.embeddingFailed
    ? { references: refs, embeddingDegraded: true }
    : { references: refs };
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
  candidates: readonly ScoredCandidate[],
  limit: number,
  profile: QueryProfile,
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
      score:
        candidate.score +
        lexicalMetadataBonus(citation, profile) +
        lexicalContentBonus(store, candidate.capsuleId, citation, profile),
      citation,
    });
  }
  refs.sort(referenceScoreDesc);
  return diversifyReferences(refs, limit, profile);
}

function referenceScoreDesc(a: RetrievalReference, b: RetrievalReference): number {
  if (b.score !== a.score) return b.score - a.score;
  return String(a.chunkId).localeCompare(String(b.chunkId));
}

function diversifyReferences(
  references: readonly RetrievalReference[],
  limit: number,
  profile: QueryProfile,
): readonly RetrievalReference[] {
  if (references.length <= limit) return references;
  const remaining = [...references];
  const selected: RetrievalReference[] = [];
  while (remaining.length > 0 && selected.length < limit) {
    const pick = pickNextReference(remaining, selected, profile);
    selected.push(pick.reference);
    remaining.splice(pick.index, 1);
  }
  selected.sort(referenceScoreDesc);
  return selected;
}

function pickNextReference(
  remaining: readonly RetrievalReference[],
  selected: readonly RetrievalReference[],
  profile: QueryProfile,
): { readonly reference: RetrievalReference; readonly index: number } {
  let bestIndex = 0;
  let best = withDiversityScore(remaining[0], selected, profile);
  for (let i = 1; i < remaining.length; i += 1) {
    const candidate = withDiversityScore(remaining[i], selected, profile);
    if (referenceScoreDesc(candidate, best) < 0) {
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

function lexicalMetadataBonus(citation: CitationReference, profile: QueryProfile): number {
  if (profile.tokens.length === 0) return 0;
  const haystack = tokenise(
    [
      citation.safeDisplayName,
      citation.pageLabel,
      ...(citation.sectionPath ?? []),
      citation.jsonPointer,
      citation.tableName,
      citation.rowIndex === undefined ? undefined : String(citation.rowIndex),
      String(citation.pageNumber ?? ""),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
  if (haystack.length === 0) return 0;

  const haystackSet = new Set(haystack);
  const hits = countTokenHits(profile.tokens, haystackSet);
  if (hits === 0) return 0;
  return (hits / profile.tokens.length) * profile.metadataWeight;
}

function lexicalContentBonus(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  citation: CitationReference,
  profile: QueryProfile,
): number {
  if (profile.tokens.length === 0) return 0;
  const excerpt = readCitationSearchExcerpt(
    store,
    capsuleId,
    citation,
    SEARCH_EXCERPT_MAX_CHARS,
    profile.contextBeforeChars,
  );
  if (excerpt.length === 0) return 0;
  const excerptTokens = tokenise(excerpt);
  if (excerptTokens.length === 0) return 0;

  const normalisedExcerpt = normaliseForSearch(excerpt);
  const tokenCoverage =
    countTokenHits(profile.tokens, new Set(excerptTokens)) / profile.tokens.length;
  const phraseHits = countAdjacentPhraseHits(profile.tokens, normalisedExcerpt);
  const exactHits = countExactTermHits(profile.exactTerms, normalisedExcerpt);
  return (
    Math.min(0.24, tokenCoverage * profile.lexicalWeight) +
    Math.min(0.16, phraseHits * profile.phraseWeight) +
    Math.min(0.18, exactHits * 0.06)
  );
}

interface DocumentTextRow {
  readonly normalized_text?: string;
}

function readCitationSearchExcerpt(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  citation: CitationReference,
  maxChars: number,
  beforeChars: number,
): string {
  const row = store._internal.db
    .prepare(
      "SELECT normalized_text FROM document_texts WHERE capsule_id = :capsule_id AND document_id = :document_id",
    )
    .get({
      capsule_id: String(capsuleId),
      document_id: String(citation.documentId),
    }) as DocumentTextRow | undefined;
  const stored = row?.normalized_text;
  const text =
    typeof stored === "string" ? store._internal.contentCipher.openText(stored) : undefined;
  if (typeof text !== "string" || text.length === 0) return "";
  const focusStart = Math.max(0, Math.min(text.length, citation.characterStart ?? 0));
  const focusEnd = Math.max(
    focusStart,
    Math.min(text.length, citation.characterEnd ?? focusStart + maxChars),
  );
  const start = Math.max(0, focusStart - beforeChars);
  const afterBudget = Math.max(0, maxChars - (focusStart - start));
  const end = Math.min(text.length, focusEnd + afterBudget);
  return text.slice(start, end).trim();
}

function countTokenHits(tokens: readonly string[], haystack: ReadonlySet<string>): number {
  let hits = 0;
  for (const token of tokens) {
    if (haystack.has(token)) hits += 1;
  }
  return hits;
}

function countAdjacentPhraseHits(tokens: readonly string[], normalisedHaystack: string): number {
  let hits = 0;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const first = tokens[i];
    const second = tokens[i + 1];
    if (first === undefined || second === undefined) continue;
    if (normalisedHaystack.includes(`${first} ${second}`)) hits += 1;
  }
  return hits;
}

function countExactTermHits(terms: readonly string[], normalisedHaystack: string): number {
  let hits = 0;
  for (const term of terms) {
    if (normalisedHaystack.includes(term)) hits += 1;
  }
  return hits;
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
    lexicalWeight: 0.22,
    phraseWeight: 0.06,
    metadataWeight: 0.16,
    contextBeforeChars: SEARCH_CONTEXT_BEFORE_CHARS * 2,
    documentDiversityPenalty: 0.018,
    sectionDiversityPenalty: 0.01,
  };
}

function broadQueryProfile(tokens: readonly string[], exactTerms: readonly string[]): QueryProfile {
  return {
    strategy: "broad",
    tokens,
    exactTerms,
    lexicalRecallTerms: buildLexicalRecallTerms(tokens, exactTerms),
    lexicalWeight: 0.16,
    phraseWeight: 0.04,
    metadataWeight: 0.1,
    contextBeforeChars: SEARCH_CONTEXT_BEFORE_CHARS,
    documentDiversityPenalty: 0.085,
    sectionDiversityPenalty: 0.035,
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
    lexicalWeight: 0.18,
    phraseWeight: 0.045,
    metadataWeight: 0.12,
    contextBeforeChars: SEARCH_CONTEXT_BEFORE_CHARS,
    documentDiversityPenalty: 0.045,
    sectionDiversityPenalty: 0.02,
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
  return uniqueTokens([...exactTerms, ...tokenTerms]).slice(0, LEXICAL_RECALL_MAX_TERMS);
}

function tokenise(value: string): readonly string[] {
  return normaliseForSearch(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));
}

function normaliseForSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLowerCase()
    .replace(/ß/gu, "ss");
}
