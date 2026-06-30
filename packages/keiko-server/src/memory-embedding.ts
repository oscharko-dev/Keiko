// Memory embeddings — the model/IO boundary for semantic memory (#204).
//
// Mirrors the proven Local Knowledge embedding pipeline (selectEmbeddingModelId +
// createEmbeddingAdapter + requestOpenAIEmbedding) but for governed memory records. Two public
// surfaces:
//   embedMemoryText(deps, text, kind)  — embed an arbitrary query/document string, returning a
//                                        vault-ready MemoryEmbeddingInput or null. NEVER throws.
//   embedAndStoreMemory(deps, vault,…) — best-effort embed-on-capture: store the embedding if it
//                                        and the vault accept it; swallow every failure so the
//                                        capture path is never broken.
//   cosineSimilarity(a, b)             — pure cosine in [0,1] over two Float32Array vectors.
//
// Graceful degradation is the contract: when no embedding-capable model is configured, every
// function is inert (embedMemoryText -> null, embedAndStoreMemory -> no-op) and the caller keeps
// its pre-semantic behaviour byte-for-byte.

import {
  assertCompatibleEmbeddingIdentity,
  requestOpenAIEmbedding,
  type GatewayConfig,
  type ModelProviderConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { createHash, randomUUID } from "node:crypto";
import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";
import type {
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";
import type {
  MemoryEmbeddingInput,
  MemoryEmbeddingRow,
  MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import {
  configuredEmbeddingProviders,
  selectEmbeddingModelId,
} from "./local-knowledge-handlers.js";

const MEMORY_VECTOR_METRIC = "cosine" as const;
export type MemoryEmbeddingKind = "query" | "document";

const QWEN3_MEMORY_QUERY_INSTRUCTION =
  "Given a user conversation query, retrieve the most relevant durable memories for assisting the user.";

export function selectMemoryEmbeddingModelId(
  config: GatewayConfig | undefined,
): string | undefined {
  return selectEmbeddingModelId(config);
}

function requestEmbeddingImpl(
  deps: UiHandlerDeps,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  // Reuses the same gateway seam as Local Knowledge so a single injected adapter drives both.
  return deps.localKnowledgeEmbeddingRequest ?? requestOpenAIEmbedding;
}

function buildAdapter(
  provider: ModelProviderConfig,
  requestImpl: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>,
): OpenAIEmbeddingAdapter {
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
    request: (request) =>
      requestImpl({
        ...request,
        endpoint: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.apiKeyHeaderName !== undefined
          ? { apiKeyHeaderName: provider.apiKeyHeaderName }
          : {}),
        ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
      }),
  };
}

function normalizedEndpointFingerprint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function memoryEmbeddingProviderIdentity(provider: ModelProviderConfig): string {
  return `openai-compatible:${normalizedEndpointFingerprint(provider.baseUrl)}`;
}

function isQwen3EmbeddingModel(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase("en-US");
  return normalized.includes("qwen3") && normalized.includes("embedding");
}

function formatEmbeddingInput(modelId: string, text: string, kind: MemoryEmbeddingKind): string {
  if (kind !== "query" || !isQwen3EmbeddingModel(modelId)) {
    return text;
  }
  return `Instruct: ${QWEN3_MEMORY_QUERY_INSTRUCTION}\nQuery: ${text}`;
}

function toEmbeddingInput(
  provider: string,
  outcome: Extract<OpenAIEmbeddingOutcome, { ok: true }>,
): MemoryEmbeddingInput {
  return {
    provider,
    modelId: outcome.value.modelId,
    ...(outcome.value.modelRevision !== undefined
      ? { modelRevision: outcome.value.modelRevision }
      : {}),
    metric: MEMORY_VECTOR_METRIC,
    vector: outcome.value.vector,
  };
}

// A bound embedder: embeds an arbitrary string against a fixed model/provider, returning a
// vault-ready input or null on any failure. Never throws.
export type MemoryEmbedder = (
  text: string,
  kind?: MemoryEmbeddingKind,
) => Promise<MemoryEmbeddingInput | null>;

// Builds an embedder from a gateway config, or returns null when no embedding-capable model is
// configured (or its provider is absent). The CLI backfill and the conversation paths both compose
// through this single factory so capability-aware model selection lives in one place.
export function createMemoryEmbedder(
  config: GatewayConfig | undefined,
  requestImpl: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>,
): MemoryEmbedder | null {
  const providers = configuredEmbeddingProviders(config);
  if (providers.length === 0) return null;
  const candidates = providers.map((provider) => ({
    provider,
    adapter: buildAdapter(provider, requestImpl),
  }));
  return async (
    text: string,
    kind: MemoryEmbeddingKind = "document",
  ): Promise<MemoryEmbeddingInput | null> => {
    if (text.length === 0) return null;
    for (const { provider, adapter } of candidates) {
      try {
        const outcome = await adapter.request({
          endpoint: provider.baseUrl,
          apiKey: provider.apiKey,
          modelId: provider.modelId,
          input: formatEmbeddingInput(provider.modelId, text, kind),
          ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
        });
        if (outcome.ok) return toEmbeddingInput(memoryEmbeddingProviderIdentity(provider), outcome);
      } catch {
        // Model/transport boundary: a thrown adapter degrades to the next embedding provider.
      }
    }
    return null;
  };
}

// Embeds `text` against the configured embedding model. Returns null when no embedding-capable
// model is configured, when the matching provider is absent, or on any request failure. The whole
// IO body is guarded so this NEVER throws into the capture/retrieval path.
export async function embedMemoryText(
  deps: UiHandlerDeps,
  text: string,
  kind: MemoryEmbeddingKind = "document",
): Promise<MemoryEmbeddingInput | null> {
  const embedder = createMemoryEmbedder(currentGatewayConfig(deps), requestEmbeddingImpl(deps));
  if (embedder === null) return null;
  return embedder(text, kind);
}

// Best-effort embed-on-capture. Embeds the memory body and upserts the vector. A null embedding
// (no model / failure) is a no-op; a vault rejection (e.g. gateEmbeddingInput dimension/contract
// guard) is swallowed so a malformed vector can never break the capture that already succeeded.
export async function embedAndStoreMemory(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  memoryId: MemoryId,
  text: string,
): Promise<void> {
  const input = await embedMemoryText(deps, text, "document");
  if (input === null) return;
  try {
    vault.upsertEmbedding(memoryId, input);
  } catch {
    // gateEmbeddingInput / storage rejection — capture already succeeded; drop the embedding.
  }
}

export async function refreshMemoryEmbeddingAfterBodyEdit(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  memoryId: MemoryId,
  text: string,
): Promise<void> {
  const input = await embedMemoryText(deps, text, "document");
  if (input === null) {
    try {
      vault.deleteEmbedding(memoryId);
    } catch {
      // Missing memory / no existing row / storage rejection: the edit already succeeded, and the
      // important invariant is that we never keep using a known stale vector when refresh fails.
    }
    return;
  }
  try {
    vault.upsertEmbedding(memoryId, input);
  } catch {
    try {
      vault.deleteEmbedding(memoryId);
    } catch {
      // Same best-effort invalidation boundary as above.
    }
  }
}

// Pure cosine similarity in [0,1]. Returns 0 when the vectors differ in length or either has zero
// magnitude, and clamps a negative cosine to 0 so the ranker only ever sees a non-negative signal
// (mirrors Local Knowledge's cosine metric semantics).
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (cosine <= 0) return 0;
  return cosine > 1 ? 1 : cosine;
}

// ─── Semantic novelty gate at capture (#204, O-F1) ──────────────────────────────
// Lexical Jaccard dedup at capture misses semantic restatements ("I use Postgres" vs "my database is
// PostgreSQL"). This catches them BEFORE a second copy is stored: embed the candidate once, compare
// to the in-scope stored vectors, and if it is NEAR-IDENTICAL to an existing memory, reinforce that
// canonical memory instead of duplicating it.
//
// SAFETY: the default threshold is deliberately HIGH and the gate is applied ONLY to the low-stakes
// salience firehose — NOT to explicit user instructions. A pure cosine signal cannot tell a
// paraphrase ("uses PostgreSQL") from a value-change ("region is eu-central-1" vs "us-east-1"), so a
// lower threshold could merge a contradicting update. Model-specific cosine geometry can be
// calibrated through KEIKO_MEMORY_EMBEDDING_CALIBRATION; without calibration only near-verbatim
// restatements merge. Merging reinforces the canonical rather than deleting, so even a false merge
// loses no stored fact. Graceful: with no embedder the candidate embedding is null and the gate is
// inert (prior lexical-only behaviour, byte-for-byte).

export const SEMANTIC_DEDUP_COSINE_THRESHOLD = 0.95;
export const RELATED_LINK_COSINE_THRESHOLD = 0.82;

export interface MemoryEmbeddingCalibration {
  readonly semanticDedupThreshold?: number;
  readonly relatedLinkThreshold?: number;
  readonly mmrLambda?: number;
}

interface EmbeddingCalibrationIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly modelRevision?: string;
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseCalibrationEntry(value: unknown): MemoryEmbeddingCalibration | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: {
    semanticDedupThreshold?: number;
    relatedLinkThreshold?: number;
    mmrLambda?: number;
  } = {};
  if (isUnit(raw.semanticDedupThreshold)) out.semanticDedupThreshold = raw.semanticDedupThreshold;
  if (isUnit(raw.relatedLinkThreshold)) out.relatedLinkThreshold = raw.relatedLinkThreshold;
  if (isUnit(raw.mmrLambda)) out.mmrLambda = raw.mmrLambda;
  return Object.keys(out).length === 0 ? undefined : out;
}

function calibrationKeys(identity: EmbeddingCalibrationIdentity): readonly string[] {
  const revision = identity.modelRevision;
  return [
    ...(revision !== undefined ? [`${identity.provider}/${identity.modelId}@${revision}`] : []),
    `${identity.provider}/${identity.modelId}`,
    ...(revision !== undefined ? [`${identity.modelId}@${revision}`] : []),
    identity.modelId,
  ];
}

export function memoryEmbeddingCalibrationFor(
  env: Readonly<Record<string, string | undefined>>,
  identity: EmbeddingCalibrationIdentity,
): MemoryEmbeddingCalibration {
  const raw = env.KEIKO_MEMORY_EMBEDDING_CALIBRATION;
  if (raw === undefined || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const table = parsed as Record<string, unknown>;
  for (const key of calibrationKeys(identity)) {
    const entry = parseCalibrationEntry(table[key]);
    if (entry !== undefined) return entry;
  }
  return {};
}

// Pure: the id of the nearest in-scope memory whose cosine to the candidate is at/above the
// threshold, or null (no candidate embedding, no neighbours, or none similar enough). First-max wins
// on ties so the result is deterministic for a fixed neighbour iteration order.
export function findSemanticDuplicate(
  candidate: MemoryEmbeddingInput | null,
  neighbors: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  threshold: number = SEMANTIC_DEDUP_COSINE_THRESHOLD,
): MemoryId | null {
  if (candidate === null) return null;
  let bestId: MemoryId | null = null;
  let bestSim = -1;
  for (const [id, row] of neighbors) {
    if (!embeddingIdentitiesCompatible(candidate, row)) continue;
    const sim = cosineSimilarity(candidate.vector, row.vector);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = id;
    }
  }
  return bestSim >= threshold ? bestId : null;
}

// ─── Semantic auto-linking at capture (#204, O-P4) ──────────────────────────────
// A-MEM (2502.12110) self-organises memory by LINKING a new note to its semantic neighbours at
// write time, so associative recall has structure to traverse immediately. Memoria Viva already
// runs graph-proximity recall live (the ranker's `graph` subscore), but until now the only edges
// were supersedes/correction links and the batch consolidation pass — a fresh capture had no
// associations. This forms them deterministically from the SAME embedding used for the novelty
// gate: a novel capture is linked to its nearest in-scope neighbours that fall in a "related" band
// (similar enough to associate, below the dedup threshold so they are not the same fact). No model
// call, no non-determinism — a pure cosine band over vectors already in hand.

// Lower bound of the related band. Above this two memory bodies are topically associated; below it
// the link would be noise. Conservative default; model/provider-specific cosine bands can be
// configured through KEIKO_MEMORY_EMBEDDING_CALIBRATION before auto-linking is enabled.

// At most this many associations per capture, so the graph stays sparse and traversal stays cheap.
export const MAX_AUTO_LINKS = 3;

// Pure: the in-scope neighbours whose cosine to the candidate falls in the band [lower, upper) —
// associated but not a duplicate — ranked by similarity desc (id asc tiebreak) and capped at
// maxLinks. Empty for a null candidate or when nothing lands in the band. Deterministic for a fixed
// neighbour set.
export function findRelatedNeighbors(
  candidate: MemoryEmbeddingInput | null,
  neighbors: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  lower: number = RELATED_LINK_COSINE_THRESHOLD,
  upper: number = SEMANTIC_DEDUP_COSINE_THRESHOLD,
  maxLinks: number = MAX_AUTO_LINKS,
): readonly MemoryId[] {
  if (candidate === null) return [];
  const scored: { readonly id: MemoryId; readonly similarity: number }[] = [];
  for (const [id, row] of neighbors) {
    if (!embeddingIdentitiesCompatible(candidate, row)) continue;
    const similarity = cosineSimilarity(candidate.vector, row.vector);
    if (similarity >= lower && similarity < upper) scored.push({ id, similarity });
  }
  scored.sort((a, b) =>
    a.similarity !== b.similarity ? b.similarity - a.similarity : a.id.localeCompare(b.id),
  );
  return scored.slice(0, maxLinks).map((n) => n.id);
}

function inputIdentity(input: MemoryEmbeddingInput): EmbeddingModelIdentity {
  return {
    provider: input.provider,
    modelId: input.modelId,
    ...(input.modelRevision !== undefined ? { modelRevision: input.modelRevision } : {}),
    vectorDimensions: input.vector.length,
    vectorMetric: input.metric,
  };
}

function rowIdentity(row: MemoryEmbeddingRow): EmbeddingModelIdentity {
  return {
    provider: row.provider,
    modelId: row.modelId,
    ...(row.modelRevision !== undefined ? { modelRevision: row.modelRevision } : {}),
    vectorDimensions: row.dimensions,
    vectorMetric: row.metric,
  };
}

function embeddingIdentitiesCompatible(
  candidate: MemoryEmbeddingInput,
  row: MemoryEmbeddingRow,
): boolean {
  return assertCompatibleEmbeddingIdentity(rowIdentity(row), inputIdentity(candidate)).ok;
}

// Opt-in (KEIKO_MEMORY_AUTO_LINK=1, default off => byte-identical: no edges, no behaviour change).
// Best-effort: a rejected edge insert must never break the capture that already succeeded.
function autoLinkRelatedMemories(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  fromId: MemoryId,
  embedding: MemoryEmbeddingInput,
  neighbors: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
  calibration: MemoryEmbeddingCalibration,
): void {
  if (deps.env.KEIKO_MEMORY_AUTO_LINK !== "1") return;
  const relatedIds = findRelatedNeighbors(
    embedding,
    neighbors,
    calibration.relatedLinkThreshold ?? RELATED_LINK_COSINE_THRESHOLD,
    calibration.semanticDedupThreshold ?? SEMANTIC_DEDUP_COSINE_THRESHOLD,
  );
  if (relatedIds.length === 0) return;
  const nowMs = Date.now();
  for (const toId of relatedIds) {
    try {
      vault.insertEdge({
        id: randomUUID() as MemoryEdgeId,
        schemaVersion: "1",
        fromMemoryId: fromId,
        toMemoryId: toId,
        kind: "related",
        createdAt: nowMs,
        provenanceSummary: "semantic auto-link",
      });
    } catch {
      // Validator / storage rejection — association enrichment is best-effort, never fatal.
    }
  }
}

// Bounds the neighbour set so the cosine sweep stays cheap on a large vault (mirrors the lexical
// dedup corpus bound). Scope-local list preserves cross-scope isolation.
const MAX_DEDUP_NEIGHBORS = 200;

function gatherScopeEmbeddings(
  vault: MemoryVaultStore,
  scope: MemoryScope,
): ReadonlyMap<MemoryId, MemoryEmbeddingRow> {
  const ids = vault
    .listMemoriesByScope(scope, { status: ["accepted"] })
    .slice(0, MAX_DEDUP_NEIGHBORS)
    .map((record) => record.id);
  return ids.length === 0 ? new Map() : vault.getEmbeddings(ids);
}

export interface NoveltyInsertResult {
  // The inserted record, or null when the candidate was merged into an existing near-duplicate.
  readonly inserted: MemoryRecord | null;
  // The canonical memory the candidate merged into (reinforced via recordAccess), or null.
  readonly mergedInto: MemoryId | null;
}

// Insert a freshly-built salience capture record UNLESS it is a semantic near-duplicate of an
// existing in-scope memory, in which case reinforce the canonical (recordAccess) and skip the
// duplicate. Embeds the body exactly ONCE (reused for both the novelty check and storage), so this
// replaces — not adds to — the prior best-effort embed-on-capture call. Never throws past the
// vault's own guards; a null embedding degrades to a plain insert.
export async function insertSalienceMemoryWithNoveltyGate(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  record: MemoryRecord,
): Promise<NoveltyInsertResult> {
  const embedding = await embedMemoryText(deps, record.body, "document");
  const neighbors = gatherScopeEmbeddings(vault, record.scope);
  const calibration =
    embedding === null ? {} : memoryEmbeddingCalibrationFor(deps.env, embedding);
  const duplicateOf = findSemanticDuplicate(
    embedding,
    neighbors,
    calibration.semanticDedupThreshold ?? SEMANTIC_DEDUP_COSINE_THRESHOLD,
  );
  if (duplicateOf !== null) {
    vault.recordAccess([duplicateOf], Date.now());
    return { inserted: null, mergedInto: duplicateOf };
  }
  const inserted = vault.insertMemory(record);
  if (embedding !== null) {
    try {
      vault.upsertEmbedding(inserted.id, embedding);
    } catch {
      // gateEmbeddingInput / storage rejection — capture already succeeded; drop the embedding.
    }
    // A-MEM-style associative linking (#204, O-P4). Reuses the neighbour set already fetched for the
    // novelty gate — no extra IO. Opt-in (default off => no edges, byte-identical).
    autoLinkRelatedMemories(deps, vault, inserted.id, embedding, neighbors, calibration);
  }
  return { inserted, mergedInto: null };
}
