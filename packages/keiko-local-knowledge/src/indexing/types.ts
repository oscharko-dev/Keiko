// Type contracts for the indexing orchestrator (Epic #189, Issue #196). The orchestrator
// composes #194 discovery, #195 chunking, and #192 embedding capability into a single
// streaming pipeline that produces `vectors` rows for a capsule. Every state change emits
// one `IndexingEvent`; consumers (UI surfaces, evidence ledger, CLI) read the event stream
// rather than polling the database.
//
// The progress channel is an event union (not a number) so a consumer can branch on the
// `kind` discriminant and surface domain-specific UI per state — matching the pattern the
// discovery layer (#194) and the verification orchestrator (#7) already use elsewhere in
// the codebase.

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  IndexingJobError,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorRecord,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import type { ChunkingOptions } from "../chunking/index.js";
import type { DiscoveryOptions } from "../discovery/index.js";
import { KnowledgeStoreError } from "../errors.js";
import type { ParserRegistry } from "../parsers/index.js";
import type { AuditEventSink } from "../privacy/index.js";
import type { KnowledgeStore } from "../store.js";

// ─── Defaults (declared up-front so callers can reason about behaviour) ──────
// Hard caps tracked in the orchestrator. The contract scope (#196) requires:
//   * batch size cap = 64 chunks per embedding flush
//   * concurrent in-flight batches ≤ 4
// Lower defaults are not exposed because they bias toward "more requests, smaller batches"
// which costs more roundtrips without saving memory in our pipeline.
export const DEFAULT_INDEXING_BATCH_SIZE = 64;
export const DEFAULT_INDEXING_CONCURRENCY = 4;

// Closed enumeration of failure reasons surfaced via `IndexingJobError.code`. Downstream
// surfaces branch on this code rather than free-form messages. The strings line up with the
// scope's BLOCKER taxonomy (`INCOMPATIBLE_EMBEDDING_IDENTITY` is the identity-drift gate).
export type IndexingErrorCode =
  | "INCOMPATIBLE_EMBEDDING_IDENTITY"
  | "EMBEDDING_ADAPTER_FAILED"
  | "DISCOVERY_FAILED"
  | "CHUNKING_FAILED"
  | "CANCELLED"
  | "CAPSULE_NOT_FOUND"
  | "INVALID_OPTIONS"
  | "PERSISTENCE_FAILED";

// Distinct from KnowledgeStoreError so a test asserting "indexing failed" cannot
// accidentally accept any other store error. Extends KnowledgeStoreError so callers that
// catch the parent class still see the failure.
export class IndexingError extends KnowledgeStoreError {
  public override readonly name: string = "IndexingError";
  public readonly code: IndexingErrorCode;
  public constructor(code: IndexingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ─── Orchestrator inputs ─────────────────────────────────────────────────────
export interface IndexingOptions {
  readonly capsuleId: KnowledgeCapsuleId;
  // Optional restriction to a subset of the capsule's sources. Undefined → all sources
  // attached to the capsule are indexed in lexicographic order of `KnowledgeSource.id`.
  readonly sourceIds?: readonly KnowledgeSourceId[];
  readonly parserRegistry: ParserRegistry;
  readonly workspaceFs: WorkspaceFs;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  readonly store: KnowledgeStore;
  readonly signal?: AbortSignal;
  // Optional progress sink. The orchestrator emits AsyncIterable<IndexingEvent>; this
  // callback fires for the SAME events. Consumers that only need a side-channel (e.g. a
  // file logger) use this rather than driving the async iterator manually.
  readonly progress?: (event: IndexingEvent) => void;
  readonly auditSink?: AuditEventSink;
  // When true: re-extract, re-chunk, and re-embed every document — does NOT honour the
  // chunking-layer incremental skip. Existing chunk and vector rows for in-scope documents
  // are deleted at the start of each document's work.
  readonly force?: boolean;
  // Hard caps are clamped to the scope's contract maxima (64 / 4). Smaller values are
  // accepted so tests can exercise batching boundaries without manufacturing 64 chunks.
  readonly batchSize?: number;
  readonly concurrency?: number;
  // Pass-through to the chunking layer's pure options (token estimator, min/max/overlap).
  readonly chunkingOptions?: ChunkingOptions;
  // Pass-through to the discovery layer's walker options (maxDepth, maxFiles).
  readonly discoveryOptions?: DiscoveryOptions;
  // Clock injection — defaults to the store's internal clock.
  readonly now?: () => number;
  // Optional id source so tests can pin the job id. Defaults to `crypto.randomUUID`.
  readonly idSource?: () => string;
}

// ─── Event stream ────────────────────────────────────────────────────────────
// `jobId` is stamped on every event so a consumer multiplexing multiple jobs can route by
// id without holding the orchestrator's local state. The discriminant is `kind`.
export interface IndexingJobStartedEvent {
  readonly kind: "job-started";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly startedAt: number;
}

export interface IndexingDocumentDiscoveredEvent {
  readonly kind: "document-discovered";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface IndexingDocumentExtractedEvent {
  readonly kind: "document-extracted";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly relativePath: string;
}

export interface IndexingDocumentChunkedEvent {
  readonly kind: "document-chunked";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkCount: number;
}

export interface IndexingDocumentEmbeddedEvent {
  readonly kind: "document-embedded";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly vectorCount: number;
  // Lexicographically-greatest chunk id embedded so far for this document. Persisted to
  // `indexing_jobs.resume_token` so a resumed run can continue past it.
  readonly resumeToken: ChunkId;
}

export interface IndexingDocumentSkippedEvent {
  readonly kind: "document-skipped";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly reason: "unchanged" | "already-embedded" | "unsupported";
}

export interface IndexingDocumentFailedEvent {
  readonly kind: "document-failed";
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId?: DocumentId;
  readonly relativePath?: string;
  readonly error: IndexingJobError;
}

export interface IndexingJobCompletedEvent {
  readonly kind: "job-completed";
  readonly jobId: string;
  readonly result: IndexingResult;
}

export interface IndexingJobCancelledEvent {
  readonly kind: "job-cancelled";
  readonly jobId: string;
  readonly result: IndexingResult;
}

export interface IndexingJobFailedEvent {
  readonly kind: "job-failed";
  readonly jobId: string;
  readonly error: IndexingJobError;
  readonly result: IndexingResult;
}

export type IndexingEvent =
  | IndexingJobStartedEvent
  | IndexingDocumentDiscoveredEvent
  | IndexingDocumentExtractedEvent
  | IndexingDocumentChunkedEvent
  | IndexingDocumentEmbeddedEvent
  | IndexingDocumentSkippedEvent
  | IndexingDocumentFailedEvent
  | IndexingJobCompletedEvent
  | IndexingJobCancelledEvent
  | IndexingJobFailedEvent;

// ─── Result aggregates ───────────────────────────────────────────────────────
export interface IndexingResult {
  readonly jobId: string;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly totalDocuments: number;
  readonly processedDocuments: number;
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly vectorsPersisted: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly lastError?: IndexingJobError;
  readonly embeddingIdentity?: EmbeddingModelIdentity;
}

// ─── Embedding batch primitive (used by orchestrator.ts and embedding-batcher.ts) ────────
// A chunk projected into the shape the batcher needs to slice the document's source text
// for the embedding payload and to compose the persisted VectorRecord.
export interface ChunkToEmbed {
  readonly id: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly text: string;
}

// Bounded retry over TRANSIENT embedding failures (rate-limit, timeout, transport). A
// single flaky response should not fail an entire document on a large index; permanent
// failures (auth, unsupported-model, malformed body) and caller cancellation are never
// retried. The `sleep` seam keeps backoff deterministic and instant in tests.
export interface EmbedRetryOptions {
  // Additional attempts AFTER the first try. 0 disables retry.
  readonly maxRetries: number;
  // First backoff in ms; doubled each subsequent attempt (capped by the batcher).
  readonly baseDelayMs: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface EmbedBatchOptions {
  readonly adapter: OpenAIEmbeddingAdapter;
  readonly store: KnowledgeStore;
  readonly pinnedIdentity: EmbeddingModelIdentity;
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly idSource: () => string;
  // Optional; defaults to 2 retries with a 200 ms exponential backoff.
  readonly retry?: EmbedRetryOptions;
}

export interface EmbedBatchResult {
  readonly vectors: readonly VectorRecord[];
  // Non-empty when at least one chunk in the batch failed (adapter outcome ok=false, or
  // the identity-compatibility gate refused the result). The orchestrator marks the owning
  // document as failed; best-effort partial-failure recovery is out of scope.
  readonly errors: readonly IndexingJobError[];
}
