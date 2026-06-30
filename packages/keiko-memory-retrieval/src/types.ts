// Public type surface for the memory-retrieval layer (Epic #204 / Issue #210).
//
// Pure types + a handful of `Object.freeze`d default-weight tables. No IO, no clock, no
// randomness. All durable timestamps are epoch milliseconds; the caller supplies `nowMs`.
//
// Cross-cutting invariants encoded structurally:
//  1. MemoryQueryPort.listByScope is the SINGLE seam through which records enter this
//     layer. There is no "list all" surface — the port is scope-addressed, so cross-scope
//     leakage requires an explicit second call to a second scope. The orchestrator
//     (retrieve.ts) is the one place that decides which scopes to ask for, and it ONLY
//     iterates `request.scopes`.
//  2. ListByScopeOptions.maxResults bounds the upstream fetch so a misbehaving port can
//     never flood this layer; the orchestrator passes its own bound regardless of caller.
//  3. Every IncludedMemory carries the full subscore breakdown so audit and UI can
//     reconstruct WHY a memory was chosen without re-running the ranker.
//  4. Every OmittedMemory carries one of a closed-set of reasons so audit dashboards can
//     bucket suppressions without parsing free-form strings.

import type {
  MemoryEdge,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";

// ─── Port (vault access seam) ────────────────────────────────────────────────
// The retrieval layer never imports keiko-memory-vault. Callers (server, CLI, workflows)
// construct a MemoryQueryPort backed by the vault and pass it in. The two edge-listing
// methods are OPTIONAL: a caller without an edge index can pass a port that only
// implements listByScope and the ranker will skip the graph-proximity contribution.
export interface MemoryQueryPort {
  /** Fetch memories visible at the given scope. Cross-scope queries forbidden. */
  listByScope(scope: MemoryScope, options?: ListByScopeOptions): readonly MemoryRecord[];
  /** Fetch outgoing edges for graph-proximity scoring. */
  listOutgoingEdges?(memoryId: MemoryId): readonly MemoryEdge[];
  /** Fetch incoming edges. */
  listIncomingEdges?(memoryId: MemoryId): readonly MemoryEdge[];
  /** Fetch all incident edges for the candidate set in one bounded pass. */
  listEdgesForMemories?(
    memoryIds: readonly MemoryId[],
  ): ReadonlyMap<MemoryId, readonly MemoryEdge[]>;
}

export interface ListByScopeOptions {
  readonly includeForgotten?: boolean;
  readonly includeArchived?: boolean;
  readonly includeExpired?: boolean;
  readonly maxResults?: number;
}

// ─── Ranking weights ──────────────────────────────────────────────────────────
// Carried separately so the orchestrator can fill missing fields from the request once and
// hand a fully-populated RankingWeights to rankMemories. Each weight scales a subscore in
// [0,1] before the weighted sum; final score is also clamped to [0,1] for display.
export interface RankingWeights {
  readonly relevance: number;
  readonly recency: number;
  readonly confidence: number;
  readonly pinned: number;
  readonly correction: number;
  readonly graph: number;
  // Embedding-based similarity of the query to the memory body (#204). Weighted at least as
  // high as `relevance` because cross-lingual / paraphrase recall is the stronger signal. The
  // subscore is 0 for every memory when no per-memory semantic scores are supplied, AND the
  // ranker zeroes this weight in that case so the denominator (and therefore every score) is
  // byte-identical to the pre-semantic lexical behaviour.
  readonly semantic: number;
  // Reinforcement strength derived from access frequency + recency-of-use (#204 plasticity).
  // Closes the reinforcement loop online: a frequently-recalled memory ranks above a never-touched
  // one. The subscore is 0 for every memory when no per-memory strength scores are supplied, AND the
  // ranker zeroes this weight in that case so the score is byte-identical to the pre-strength
  // behaviour. See strength.ts for the cognitive (ACT-R base-level) basis.
  readonly strength: number;
  // Frozen source-authority importance in [0,1] (#204, O-F5): an explicit user instruction outranks a
  // passively-inferred system default at equal relevance. Derived deterministically from
  // provenance.sourceKind (immutable since capture), so it needs no caller input and stays
  // reproducible. Default weight is 0 (opt-in) so it never perturbs legacy ranking until configured.
  readonly importance: number;
}

// Defaults are documented at the request-type boundary; this table is the single source of
// truth the orchestrator reads when a field is `undefined` on the request. Frozen so a
// downstream consumer cannot mutate the global default.
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = Object.freeze({
  relevance: 0.2,
  recency: 0.12,
  confidence: 0.12,
  pinned: 0.3,
  correction: 0.1,
  graph: 0.15,
  semantic: 0.4,
  // Reinforcement weight (#204). Sits between recency and semantic: reuse is a strong signal but must
  // not override an explicit pin or a fresh correction. Only participates when the caller supplies
  // per-memory strength scores; otherwise the ranker forces it to 0 (byte-identical legacy behaviour).
  strength: 0.2,
  // Source-authority importance weight (#204, O-F5): explicit user instructions and accepted
  // corrections should not tie passive inferred memories at equal relevance.
  importance: 0.1,
});

export const DEFAULT_BUDGET_TOKENS = 1500;
export const DEFAULT_MAX_INCLUDED = 12;
export const DEFAULT_STALE_CONFIDENCE_THRESHOLD = 0.3;
export const DEFAULT_SEMANTIC_MIN_SCORE = 0.3;
export const DEFAULT_LIST_BY_SCOPE_MAX_RESULTS = 500;

// Signal-fusion strategy (#204, O-F2). "weighted-sum" (default) blends normalized subscores by
// weight. "rrf" (Reciprocal Rank Fusion) fuses by RANK — score = Σ w/(k+rank) — needing no score
// normalization and rewarding candidates multiple signals agree on; the documented fix for blending
// heterogeneous-scale signals (lexical Jaccard vs cosine).
export type RankingFusionMode = "weighted-sum" | "rrf";

// ─── Request ──────────────────────────────────────────────────────────────────
export interface MemoryRetrievalRequest {
  readonly scopes: readonly MemoryScope[];
  readonly queryText?: string;
  readonly types?: readonly MemoryType[];
  readonly nowMs: number;
  readonly budgetTokens?: number;
  readonly maxIncluded?: number;
  readonly recencyWeight?: number;
  readonly confidenceWeight?: number;
  readonly pinnedBoost?: number;
  readonly correctionBoost?: number;
  readonly graphProximityBoost?: number;
  readonly relevanceWeight?: number;
  readonly semanticWeight?: number;
  // Semantic scores below this floor are treated as absent before ranking and relevance-threshold
  // filtering. Prevents tiny positive cosine values from filling the prompt when lexical/graph
  // signals are zero.
  readonly semanticMinScore?: number;
  readonly staleConfidenceThreshold?: number;
  /** Audit/debug opt-in. Active context retrieval suppresses superseded memories by default. */
  readonly includeSuperseded?: boolean;
  // Per-memory cosine similarity (in [0,1]) of the query embedding to each candidate's stored
  // embedding, keyed by memory id (#204). Computed by the caller (which owns the embedding
  // gateway and the vault's stored vectors); the retrieval layer stays pure and IO-free. When
  // undefined or empty, the ranker falls back to byte-identical lexical behaviour.
  readonly semanticById?: ReadonlyMap<MemoryId, number>;
  // Per-memory reinforcement strength (in [0,1]) derived from access frequency + recency-of-use,
  // keyed by memory id (#204 plasticity). Computed by the caller from the vault's access counters
  // via reinforcementStrength(); the retrieval layer stays pure and IO-free. When undefined, the
  // ranker zeroes the strength weight so output is byte-identical to the pre-strength behaviour.
  readonly strengthById?: ReadonlyMap<MemoryId, number>;
  readonly strengthWeight?: number;
  // Source-authority importance weight (#204, O-F5). Defaults to a small positive authority signal
  // so explicit user instructions win equal-score ties against passive inferred memories.
  readonly importanceWeight?: number;
  // Per-memory embedding vectors for MMR diversity re-ordering at selection time (#204, O-F3). When
  // absent, selection stays the pure greedy-by-rank behaviour (byte-identical). mmrLambda balances
  // relevance vs novelty (1 = pure relevance / inert, lower = more diverse); defaults to 0.7.
  readonly embeddingById?: ReadonlyMap<MemoryId, Float32Array>;
  readonly mmrLambda?: number;
  // Signal-fusion strategy (#204, O-F2). Defaults to "weighted-sum" (byte-identical legacy ranking);
  // "rrf" opts into rank-based Reciprocal Rank Fusion.
  readonly fusion?: RankingFusionMode;
}

// ─── Result + included/omitted ───────────────────────────────────────────────
export interface MemoryContextBlockEntry {
  readonly memoryId: MemoryId;
  readonly bodyExcerpt: string;
  readonly inclusionReason: string;
  readonly sourceKind: MemorySourceKind;
  readonly captureRationale?: string | undefined;
  readonly sensitivity: MemorySensitivity;
  readonly confidence: number;
  readonly status: MemoryStatus;
  readonly capturedAt: number;
}

export interface MemoryContextBlock {
  /** Compact text rendering for prompt assembly. */
  readonly text: string;
  /** Structured payload for UI/audit consumers. */
  readonly memories: readonly MemoryContextBlockEntry[];
}

export interface IncludedSubscores {
  readonly relevance: number;
  readonly recency: number;
  readonly confidence: number;
  readonly pinned: number;
  readonly correction: number;
  readonly graph: number;
  // Cosine similarity in [0,1] of the query embedding to this memory's stored embedding (#204).
  // 0 when no semantic scores were supplied for this memory.
  readonly semantic: number;
  // Reinforcement strength in [0,1] from access frequency + recency-of-use (#204 plasticity).
  // 0 when no strength scores were supplied for this memory (the never-reused default).
  readonly strength: number;
  // Source-authority importance in [0,1] derived from provenance.sourceKind (#204, O-F5). Always
  // computed; contributes to the score only when the importance weight is opted in.
  readonly importance: number;
}

export interface IncludedMemory {
  readonly memoryId: MemoryId;
  readonly score: number;
  readonly subscores: IncludedSubscores;
  readonly inclusionReason: string;
}

export type OmittedReason =
  "suppressed-by-status" | "below-threshold" | "budget-exceeded" | "out-of-scope" | "type-filtered";

export interface OmittedMemory {
  readonly memoryId: MemoryId;
  readonly reason: OmittedReason;
  readonly suppressionDetail?: string;
}

export interface MemoryBudget {
  readonly tokens: number;
  readonly used: number;
}

export interface MemoryRetrievalResult {
  readonly contextBlock: MemoryContextBlock;
  readonly included: readonly IncludedMemory[];
  readonly omitted: readonly OmittedMemory[];
  readonly budget: MemoryBudget;
  readonly request: MemoryRetrievalRequest;
}

/**
 * Internal result type used by `assembleContextBlock`. Mirrors `MemoryRetrievalResult`
 * minus the `request` field, which is attached by `retrieveMemoryContext` after assembly.
 * The brief lists `assembleContextBlock(ranked, memories, options): MemoryRetrievalResult`
 * but the assembler has no need for the request envelope to compose its output — keeping
 * the function pure on its (ranked, memories, options) inputs is cleaner than threading
 * the request through a layer that does not read it.
 */
export type AssembledContext = Omit<MemoryRetrievalResult, "request">;
