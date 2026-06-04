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
  type RetrievalNoEvidenceReason,
  type RetrievalQuery,
  type RetrievalResult,
} from "./types.js";
