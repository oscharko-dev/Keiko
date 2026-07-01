// Public surface of the indexing layer (Epic #189, Issue #196). Composed by the package
// barrel in ../index.ts; consumers outside this package never import from this
// subdirectory directly (ADR-0019 direction rule 3e + the trust-8 test-support naming
// convention).

export { runIndexingJob } from "./orchestrator.js";

export { embedChunkBatch } from "./embedding-batcher.js";

export {
  CONTEXTUAL_RETRIEVAL_DISABLED_KEY,
  CONTEXTUAL_RETRIEVAL_PROMPT_VERSION,
  buildContextualRetrievalMessages,
  contextualRetrievalStrategyKey,
  type ContextualRetrievalChatGateway,
  type ContextualRetrievalOptions,
  type ContextualRetrievalStatus,
} from "./contextual-retrieval.js";

export { findResumableJob } from "./job-resume.js";

// Bounded large-document ingestion checkpoints + resume (Epic #1160, Issue #1286).
export {
  upsertExtractionCheckpoint,
  selectExtractionCheckpoint,
  listExtractionCheckpoints,
  deleteExtractionCheckpoint,
} from "./checkpoint-persist.js";
export {
  resolveExtractionResume,
  isResumableCheckpoint,
  checkpointToProgress,
  listResumableDocuments,
  type CheckpointResumeDecision,
} from "./checkpoint-resume.js";

export {
  DEFAULT_INDEXING_BATCH_SIZE,
  DEFAULT_INDEXING_CONCURRENCY,
  IndexingError,
  type ChunkToEmbed,
  type EmbedBatchOptions,
  type EmbedBatchResult,
  type EmbedRetryOptions,
  type IndexingDocumentChunkedEvent,
  type IndexingDocumentDiscoveredEvent,
  type IndexingDocumentEmbeddedEvent,
  type IndexingDocumentExtractedEvent,
  type IndexingDocumentFailedEvent,
  type IndexingDocumentSkippedEvent,
  type IndexingErrorCode,
  type IndexingEvent,
  type IndexingJobCancelledEvent,
  type IndexingJobCompletedEvent,
  type IndexingJobFailedEvent,
  type IndexingJobStartedEvent,
  type IndexingOptions,
  type IndexingResult,
} from "./types.js";
