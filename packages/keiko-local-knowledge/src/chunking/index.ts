// Barrel for the chunking layer (Epic #189, Issue #195). Composed by the package barrel
// in ../index.ts; consumers outside the package never import from this subdirectory
// directly (ADR-0019 direction rule 3e + the trust-8 test-support naming convention).

export { chunkParsedUnit } from "./chunker.js";
export { chunkDocument } from "./chunker-runner.js";
export { mapChunkToCitation } from "./citation-mapper.js";
export { defaultTokenEstimator, charsForTokenBudget } from "./token-estimator.js";
export {
  ChunkingError,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  type ChunkDocumentParams,
  type ChunkDocumentResult,
  type ChunkingOptions,
  type ChunkingResult,
  type ResolvedChunkingOptions,
  type TokenEstimator,
} from "./types.js";
