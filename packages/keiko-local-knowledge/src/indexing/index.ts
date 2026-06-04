// Public surface of the indexing layer (Epic #189, Issue #196). Composed by the package
// barrel in ../index.ts; consumers outside this package never import from this
// subdirectory directly (ADR-0019 direction rule 3e + the trust-8 test-support naming
// convention).

export { runIndexingJob } from "./orchestrator.js";

export { embedChunkBatch } from "./embedding-batcher.js";

export { findResumableJob } from "./job-resume.js";

export {
  DEFAULT_INDEXING_BATCH_SIZE,
  DEFAULT_INDEXING_CONCURRENCY,
  IndexingError,
  type ChunkToEmbed,
  type EmbedBatchOptions,
  type EmbedBatchResult,
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
