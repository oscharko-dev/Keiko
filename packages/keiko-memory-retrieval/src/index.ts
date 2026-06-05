// Public surface of @oscharko-dev/keiko-memory-retrieval (Epic #204 child #210).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). Internal modules are package-private.
//
// Every function in this barrel is pure: same input + same MemoryQueryPort responses =>
// byte-identical output. The package never reads a clock, never invokes randomness, never
// touches the filesystem. The caller supplies nowMs through MemoryRetrievalRequest and
// owns the vault behind the MemoryQueryPort seam.

export { KEIKO_MEMORY_RETRIEVAL_VERSION } from "./version.js";

// ─── Errors ──────────────────────────────────────────────────────────────────
export { RetrievalError, type RetrievalErrorCode } from "./errors.js";

// ─── Public type surface ─────────────────────────────────────────────────────
export {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  DEFAULT_MAX_INCLUDED,
  DEFAULT_RANKING_WEIGHTS,
  DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  type AssembledContext,
  type IncludedMemory,
  type IncludedSubscores,
  type ListByScopeOptions,
  type MemoryBudget,
  type MemoryContextBlock,
  type MemoryContextBlockEntry,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type OmittedMemory,
  type OmittedReason,
  type RankingWeights,
} from "./types.js";

// ─── Suppression (duplicated from governance — see suppression.ts header) ────
export {
  isMemorySuppressed,
  type SuppressionReason,
  type SuppressionResult,
} from "./suppression.js";

// ─── Ranking primitives + orchestration ──────────────────────────────────────
export { tokenize, lexicalRelevance } from "./relevance.js";
export { recencyScore, RECENCY_HALF_LIFE_MS } from "./recency.js";
export { graphProximityScore } from "./graph.js";
export { rankMemories, type RankMemoriesOptions, type RankMemoriesQuery } from "./ranking.js";

// ─── Context assembly ────────────────────────────────────────────────────────
export {
  assembleContextBlock,
  estimateTokens,
  TOKEN_PER_WORD_RATIO,
  type AssembleContextOptions,
} from "./context.js";

// ─── Top-level retrieval ─────────────────────────────────────────────────────
export { retrieveMemoryContext } from "./retrieve.js";
