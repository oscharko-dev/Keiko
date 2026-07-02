// Barrel for the chunking layer (Epic #189, Issue #195). Composed by the package barrel
// in ../index.ts; consumers outside the package never import from this subdirectory
// directly (ADR-0019 direction rule 3e + the trust-8 test-support naming convention).

export {
  chunkDedupeKey,
  chunkParsedUnit,
  chunkingStrategyKey,
  resolveChunkingOptions,
} from "./chunker.js";
export { chunkDocument } from "./chunker-runner.js";
export { mapChunkToCitation } from "./citation-mapper.js";
export {
  conservativeTokenEstimatorTokenizer,
  createQwen3SentencePieceTokenizerFromModule,
  defaultTokenEstimator,
  charsForTokenBudget,
  loadOptionalQwen3SentencePieceTokenizer,
  TokenizerLoadError,
  type OptionalTokenizerLoadDiagnostic,
  type OptionalTokenizerLoadResult,
  type Qwen3TokenizerFactoryOptions,
  type Qwen3TokenizerModule,
} from "./token-estimator.js";
export {
  CHUNKING_STRATEGY_VERSION,
  CONSERVATIVE_TOKENIZER_ID,
  CUSTOM_TOKEN_ESTIMATOR_ID,
  ChunkingError,
  DEFAULT_CHUNKING_STRATEGY_KEY,
  DEFAULT_INDEXING_TEXT_STRATEGY_KEY,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  MAX_CHUNK_TOKENS,
  MAX_OVERLAP_TOKENS,
  QWEN3_SENTENCEPIECE_TOKENIZER_ID,
  type ChunkDocumentParams,
  type ChunkDocumentResult,
  type ChunkingOptions,
  type ChunkingResult,
  type LocalKnowledgeTokenizer,
  type LocalKnowledgeTokenizerKind,
  type ResolvedChunkingOptions,
  type TokenEstimator,
} from "./types.js";
