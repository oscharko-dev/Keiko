// Public surface of the retrieval layer (Epic #189, Issue #199). Composed by the
// package barrel in ../index.ts; consumers outside this package never import from this
// subdirectory directly (ADR-0019 direction rule 3e + the trust-8 test-support naming
// convention).

export { runLocalKnowledgeRetrieval, type RetrievalDependencies } from "./retrieval-runner.js";

export {
  searchVectorsForScope,
  toScopeInput,
  type RetrievalScopeInput,
  type SearchOptions,
  type SearchOutcome,
} from "./scoped-vector-search.js";

export {
  resolveVectorIndexOptions,
  searchVectorIndex,
  usearchIndexName,
  type VectorIndexAdapter,
  type VectorIndexCandidate,
  type VectorIndexMode,
  type VectorIndexEnvironment,
  type VectorIndexOptions,
  type VectorIndexSearchRequest,
  type VectorIndexSearchResult,
  type VectorIndexUnexpectedFailureDiagnostic,
} from "./vector-index.js";

export {
  // Renamed at the boundary so the package surface says which subsystem the budgets belong to.
  BUILD_TIMEOUT_MS as ANN_INDEX_BUILD_TIMEOUT_MS,
  QUERY_TIMEOUT_MS as ANN_INDEX_QUERY_TIMEOUT_MS,
  searchUsearchAnnIndex,
  type UsearchAnnCandidate,
  type UsearchAnnPartition,
  type UsearchAnnSearchRequest,
  type UsearchAnnSearchResult,
  type UsearchVectorEntry,
} from "./usearch-ann-index.js";

// The `knowledge`/`repo` implementations of the pillar-neutral `VectorIndexPort` (ADR-0152
// D1/D3). Both are exported here; the server composes them into the LK retrieval path
// through `VectorIndexOptions.adapter`.
export {
  createLocalKnowledgeStoreVectorIndexPort,
  encodePartitionKey,
  vectorIndexPortAsKnowledgeAdapter,
  vectorIndexPortAsRepoAdapter,
  type CreateLocalKnowledgeStoreVectorIndexPortOptions,
  type LocalKnowledgeStoreNamespace,
} from "./local-vector-index-port.js";

export {
  assembleGroundedContext,
  LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION,
  type AssembleGroundedContextOptions,
  type LocalKnowledgeGroundedContextCounts,
  type LocalKnowledgeGroundedContextPack,
  type LocalKnowledgeGroundedContextScope,
} from "./context-pack-assembler.js";

export {
  validateAnswerGrounding,
  type GroundingDecision,
  type GroundingDecisionReason,
} from "./answer-grounding.js";

export {
  DEFAULT_RETRIEVAL_TOP_K,
  MAX_RETRIEVAL_TOP_K,
  RetrievalError,
  type RetrievalErrorCode,
  type RetrievalDiagnostics,
  type RetrievalEmbeddingLaneDiagnostics,
  type RetrievalEmbeddingLaneStatus,
  type RetrievalNoEvidenceReason,
  type QueryTransformer,
  type QueryTransformRequest,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievalStrategy,
  type RetrievalVectorIndexDiagnostics,
  type ResolvedRetrievalStrategy,
} from "./types.js";
