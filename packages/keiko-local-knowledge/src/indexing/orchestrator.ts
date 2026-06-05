// Indexing orchestrator (Epic #189, Issue #196). Composes #194 discovery, #195 chunking,
// and #192 embedding into a single streaming pipeline that produces `vectors` rows for a
// capsule. Every state change emits one `IndexingEvent`; consumers drive the AsyncIterable
// to back-pressure the pipeline.
//
// Pipeline shape per source:
//
//   discoverAndExtract() ── (per file) ──┐
//                                        ├─ document-discovered
//                                        ├─ extraction skipped (unchanged): document-skipped
//                                        ├─ extraction persisted: document-extracted →
//                                        │      chunkDocument → document-chunked →
//                                        │      embedChunkBatch* → document-embedded
//                                        └─ extraction failed: document-failed
//
// Cancellation: a single `AbortSignal` flows into discovery, chunking, AND the embedding
// batcher. Aborting mid-document terminates the run with a `job-cancelled` event; rows
// already persisted for completed documents are kept (the source-of-truth for resume is
// the chunks/vectors tables, not the in-flight buffer).
//
// Force mode: deletes the capsule's pre-existing vector rows up front, then passes
// `force=true` into the chunker so chunks are also re-emitted. Discovery's incremental
// fast-path is bypassed by re-reading the bytes (the discovery layer already does the
// content-hash compare for us — when force=true the orchestrator deletes the vectors but
// the documents row stays valid, so chunk-and-embed still re-runs).

import { randomUUID } from "node:crypto";

import type {
  ChunkId,
  DocumentId,
  IndexingJobError,
  KnowledgeCapsule,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { verifyEmbeddingCapability } from "@oscharko-dev/keiko-model-gateway";

import { chunkDocument } from "../chunking/chunker-runner.js";
import { hasStaleChunksForDocument } from "../chunking/chunker-persist.js";
import { getCapsule, updateCapsuleState } from "../capsule-lifecycle.js";
import { discoverAndExtract } from "../discovery/discovery-runner.js";
import { readDocumentTextRow } from "../discovery/persist.js";
import type { ExtractionEvent, ExtractionResult } from "../discovery/types.js";
import { listCapsuleSources } from "../source-lifecycle.js";

import {
  finalizeJobRow,
  insertJobRow,
  updateJobCounters,
  type JobCounters,
} from "./job-persist.js";
import { embedChunkBatch } from "./embedding-batcher.js";
import {
  countVectorsForDocument,
  deleteVectorsForCapsule,
  deleteVectorsForDocument,
  selectChunksForDocument,
} from "./vector-persist.js";
import {
  DEFAULT_INDEXING_BATCH_SIZE,
  DEFAULT_INDEXING_CONCURRENCY,
  IndexingError,
  type ChunkToEmbed,
  type IndexingEvent,
  type IndexingOptions,
  type IndexingResult,
} from "./types.js";

// ─── Abort helper ─────────────────────────────────────────────────────────────
// Reads `signal?.aborted` through a function call so TypeScript's control-flow analysis
// does NOT narrow the optional chain after the first false branch. Mirrors the pattern in
// `discovery/discovery-runner.ts` and `discovery/walk.ts`.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// ─── Bounded options ──────────────────────────────────────────────────────────
function clampBatchSize(raw: number | undefined): number {
  const v = raw ?? DEFAULT_INDEXING_BATCH_SIZE;
  return Math.max(1, Math.min(DEFAULT_INDEXING_BATCH_SIZE, Math.floor(v)));
}

function clampConcurrency(raw: number | undefined): number {
  const v = raw ?? DEFAULT_INDEXING_CONCURRENCY;
  return Math.max(1, Math.min(DEFAULT_INDEXING_CONCURRENCY, Math.floor(v)));
}

// ─── Source resolution ────────────────────────────────────────────────────────
function resolveSources(
  options: IndexingOptions,
  capsule: KnowledgeCapsule,
): readonly KnowledgeSource[] {
  const all = listCapsuleSources(options.store, capsule.id);
  if (options.sourceIds === undefined) return all;
  const allow = new Set(options.sourceIds.map((s) => String(s)));
  return all.filter((s) => allow.has(String(s.id)));
}

// ─── Mutable run state ────────────────────────────────────────────────────────
interface RunState {
  readonly jobId: string;
  readonly capsule: KnowledgeCapsule;
  readonly options: IndexingOptions;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly now: () => number;
  readonly idSource: () => string;
  readonly startedAt: number;
  totalDocuments: number;
  processedDocuments: number;
  failedDocuments: number;
  skippedDocuments: number;
  vectorsPersisted: number;
  lastResumeToken: ChunkId | null;
  lastError?: IndexingJobError;
}

function buildCounters(state: RunState): JobCounters {
  return {
    total: state.totalDocuments,
    processed: state.processedDocuments,
    failed: state.failedDocuments,
    skipped: state.skippedDocuments,
    resumeToken: state.lastResumeToken === null ? null : String(state.lastResumeToken),
  };
}

function emitProgress(options: IndexingOptions, event: IndexingEvent): void {
  if (options.progress === undefined) return;
  // Caller-provided callback; isolate so a throwing consumer cannot crash the orchestrator
  // mid-document. Errors are surfaced as a document-failed event would be — but we never
  // mutate state on a progress-callback throw because that would couple the caller's bug
  // to our run accounting.
  try {
    options.progress(event);
  } catch {
    // intentionally swallowed — progress sinks must not affect run correctness
  }
}

// ─── Per-chunk text projection ────────────────────────────────────────────────
// Slices the document source text by the chunk's parsed_unit (character_start,
// character_end). We re-query parsed_units here rather than join in SQL because the joined
// row is wider than what we need and keeps the chunking and indexing layers decoupled at
// the SQL boundary.
interface ChunkProjectionRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly parsed_unit_id: string;
  readonly order_index: number;
  readonly char_start: number | null;
  readonly char_end: number | null;
}

const SELECT_CHUNKS_WITH_OFFSETS_SQL = [
  "SELECT c.id, c.capsule_id, c.source_id, c.document_id, c.parsed_unit_id, c.order_index,",
  "  pu.character_start AS char_start, pu.character_end AS char_end",
  "FROM chunks AS c",
  "JOIN parsed_units AS pu ON pu.capsule_id = c.capsule_id AND pu.id = c.parsed_unit_id",
  "WHERE c.capsule_id = :c AND c.document_id = :d",
  "ORDER BY c.order_index ASC",
].join(" ");

function selectChunkProjections(
  state: RunState,
  documentId: DocumentId,
): readonly ChunkProjectionRow[] {
  const rows = state.options.store._internal.db
    .prepare(SELECT_CHUNKS_WITH_OFFSETS_SQL)
    .all({ c: state.capsule.id, d: documentId });
  return rows as unknown as readonly ChunkProjectionRow[];
}

function projectChunksToEmbed(
  state: RunState,
  documentId: DocumentId,
  sourceText: string,
): readonly ChunkToEmbed[] {
  const projections = selectChunkProjections(state, documentId);
  const out: ChunkToEmbed[] = [];
  for (const row of projections) {
    const start = row.char_start ?? 0;
    const end = row.char_end ?? sourceText.length;
    const text = sourceText.slice(start, end);
    out.push({
      id: row.id as ChunkId,
      capsuleId: row.capsule_id as ChunkToEmbed["capsuleId"],
      sourceId: row.source_id as KnowledgeSourceId,
      documentId,
      text,
    });
  }
  return out;
}

// ─── Source-text reload (the orchestrator owns this; discovery does not expose it) ─
interface ScopeRootResolution {
  readonly absoluteRoot: string;
}

function scopeRootOf(source: KnowledgeSource): ScopeRootResolution {
  const scope = source.scope;
  if (scope.kind === "folder") return { absoluteRoot: scope.rootPath };
  if (scope.kind === "repository") return { absoluteRoot: scope.repositoryRoot };
  return { absoluteRoot: scope.rootPath };
}

function joinAbs(root: string, rel: string): string {
  if (root.endsWith("/")) return `${root}${rel}`;
  return `${root}/${rel}`;
}

function normaliseSep(p: string): string {
  return p.replace(/\\/g, "/");
}

function isContained(absoluteRoot: string, absolutePath: string): boolean {
  const normRoot = normaliseSep(absoluteRoot);
  const normPath = normaliseSep(absolutePath);
  if (normPath === normRoot) return true;
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normPath.startsWith(prefix);
}

function readSourceText(state: RunState, source: KnowledgeSource, relativePath: string): string {
  const { absoluteRoot } = scopeRootOf(source);
  const abs = joinAbs(absoluteRoot, relativePath);
  let real: string;
  try {
    real = state.options.workspaceFs.realPath(abs);
  } catch (cause) {
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      `source realPath failed before embedding: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  if (!isContained(absoluteRoot, real)) {
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      `source realpath escapes scope root before embedding: ${relativePath}`,
    );
  }
  return state.options.workspaceFs.readFileUtf8(normaliseSep(real));
}

function resolveChunkSourceText(
  state: RunState,
  documentId: DocumentId,
  source: KnowledgeSource,
  relativePath: string,
): string {
  const persistedText = readDocumentTextRow(
    state.options.store._internal.db,
    state.capsule.id,
    documentId,
  );
  if (persistedText !== undefined) {
    return persistedText;
  }
  return readSourceText(state, source, relativePath);
}

// ─── Batch boundaries ─────────────────────────────────────────────────────────
function sliceIntoBatches<T>(items: readonly T[], batchSize: number): readonly (readonly T[])[] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

// ─── Per-document embedding step ──────────────────────────────────────────────
interface EmbedDocumentResult {
  readonly vectorCount: number;
  readonly errors: readonly IndexingJobError[];
  readonly lastChunkId: ChunkId | null;
}

async function embedDocumentChunks(
  state: RunState,
  documentId: DocumentId,
  source: KnowledgeSource,
  relativePath: string,
): Promise<EmbedDocumentResult> {
  // Text-like documents are re-read from disk; binary parsers persist a normalized text
  // projection so chunk slicing stays aligned with extracted content.
  const sourceText = resolveChunkSourceText(state, documentId, source, relativePath);
  const chunks = projectChunksToEmbed(state, documentId, sourceText);
  if (chunks.length === 0) {
    return { vectorCount: 0, errors: [], lastChunkId: null };
  }
  const batches = sliceIntoBatches(chunks, state.batchSize);
  const errors: IndexingJobError[] = [];
  let vectorCount = 0;
  let lastChunkId: ChunkId | null = null;
  for (const batch of batches) {
    const result = await embedChunkBatch(batch, {
      adapter: state.options.embeddingAdapter,
      store: state.options.store,
      pinnedIdentity: state.capsule.embeddingModelIdentity,
      concurrency: state.concurrency,
      ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
      now: state.now,
      idSource: state.idSource,
    });
    vectorCount += result.vectors.length;
    errors.push(...result.errors);
    if (result.vectors.length > 0) {
      const last = result.vectors[result.vectors.length - 1];
      if (last !== undefined) lastChunkId = last.chunkId;
    }
    // Identity-incompatibility is detected by the batcher — stop emitting further batches
    // for this document so the orchestrator can mark the whole job failed.
    if (result.errors.some((e) => e.code === "INCOMPATIBLE_EMBEDDING_IDENTITY")) {
      break;
    }
    if (aborted(state.options.signal)) break;
  }
  return { vectorCount, errors, lastChunkId };
}

// ─── Document handlers ────────────────────────────────────────────────────────
function handleExtractionSkipped(state: RunState, result: ExtractionResult): IndexingEvent {
  state.skippedDocuments += 1;
  return {
    kind: "document-skipped",
    jobId: state.jobId,
    documentId: result.outcome.kind === "skipped" ? result.outcome.document.id : ("" as DocumentId),
    reason: "unchanged",
  };
}

function handleExtractionFailed(state: RunState, result: ExtractionResult): IndexingEvent {
  state.failedDocuments += 1;
  const errMessage =
    result.outcome.kind === "failed" ? result.outcome.error.message : "extraction failed";
  const errCode = result.outcome.kind === "failed" ? result.outcome.error.code : "READ_FAILED";
  const error: IndexingJobError = { code: `DISCOVERY_FAILED:${errCode}`, message: errMessage };
  state.lastError = error;
  return {
    kind: "document-failed",
    jobId: state.jobId,
    ...(result.outcome.kind === "failed" ? { documentId: result.outcome.document.id } : {}),
    relativePath: result.relativePath,
    error,
  };
}

interface PersistedHandling {
  readonly events: readonly IndexingEvent[];
  // True when the job-level identity gate fired — orchestrator must mark the whole job
  // failed and stop iterating further documents.
  readonly identityFailure?: IndexingJobError;
}

function resolveChunkCount(
  state: RunState,
  documentId: DocumentId,
  skippedExisting: boolean,
  freshChunkIds: readonly ChunkId[],
): number {
  if (!skippedExisting) return freshChunkIds.length;
  // When skippedExisting, the chunks table already holds the rows from a prior run; count
  // them so the chunked event still reports an accurate number.
  return selectChunksForDocument(state.options.store._internal.db, state.capsule.id, documentId)
    .length;
}

function chunkPersistedDocument(
  state: RunState,
  result: ExtractionResult,
): {
  readonly events: readonly IndexingEvent[];
  readonly documentId: DocumentId;
  readonly chunkCount: number;
} {
  if (result.outcome.kind !== "persisted") {
    throw new IndexingError(
      "INVALID_OPTIONS",
      "chunkPersistedDocument called with non-persisted result",
    );
  }
  const documentId = result.outcome.document.id;
  const sourceText = resolveChunkSourceText(
    state,
    documentId,
    sourceForResult(state, result),
    result.relativePath,
  );
  const chunkResult = chunkDocument(
    state.options.store,
    {
      capsuleId: state.capsule.id,
      sourceId: result.sourceId,
      documentId,
      sourceText,
      force: state.options.force === true,
      ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
    },
    state.options.chunkingOptions,
  );
  const chunkCount = resolveChunkCount(
    state,
    documentId,
    chunkResult.skippedExisting,
    chunkResult.chunkIds,
  );
  return {
    events: chunkedDocumentEvents(state.jobId, documentId, result.relativePath, chunkCount),
    documentId,
    chunkCount,
  };
}

function chunkedDocumentEvents(
  jobId: string,
  documentId: DocumentId,
  relativePath: string,
  chunkCount: number,
): readonly IndexingEvent[] {
  return [
    { kind: "document-extracted", jobId, documentId, relativePath },
    { kind: "document-chunked", jobId, documentId, chunkCount },
  ];
}

function sourceForResult(state: RunState, result: ExtractionResult): KnowledgeSource {
  // Resolved once per source by the outer loop; this lookup uses the capsule-scoped list
  // so we never read across capsule boundaries.
  const sources = listCapsuleSources(state.options.store, state.capsule.id);
  const match = sources.find((s) => String(s.id) === String(result.sourceId));
  if (match === undefined) {
    throw new IndexingError(
      "INVALID_OPTIONS",
      `result references unknown source ${String(result.sourceId)}`,
    );
  }
  return match;
}

// Incremental fast-path: skips embedding when vectors already exist (non-force run), or
// deletes prior vectors to prepare for a forced re-embed.
// Returns a PersistedHandling to short-circuit when already-embedded, undefined to continue.
function applyIncrementalFastPath(
  state: RunState,
  documentId: DocumentId,
): PersistedHandling | undefined {
  const staleChunks = hasStaleChunksForDocument(
    state.options.store._internal.db,
    state.capsule.id,
    documentId,
  );
  if (state.options.force !== true) {
    // Incremental fast-path #2: if vectors already exist for this document AND not in force
    // mode, skip the embedding step entirely. The chunker is also a no-op in this case.
    const existing = countVectorsForDocument(
      state.options.store._internal.db,
      state.capsule.id,
      documentId,
    );
    if (existing > 0 && !staleChunks) {
      state.skippedDocuments += 1;
      return {
        events: [
          { kind: "document-skipped", jobId: state.jobId, documentId, reason: "already-embedded" },
        ],
      };
    }
    if (existing > 0 && staleChunks) {
      deleteVectorsForDocument(state.options.store._internal.db, state.capsule.id, documentId);
    }
    return undefined;
  }
  // Force mode: tear down prior vectors so the re-embed is the only surviving set.
  deleteVectorsForDocument(state.options.store._internal.db, state.capsule.id, documentId);
  return undefined;
}

// Runs the chunker and returns its result, or a PersistedHandling failure event on throw.
function tryChunkDocument(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
): { readonly chunked: ReturnType<typeof chunkPersistedDocument> } | PersistedHandling {
  try {
    return { chunked: chunkPersistedDocument(state, result) };
  } catch (cause) {
    state.failedDocuments += 1;
    const error: IndexingJobError = {
      code: "CHUNKING_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
    };
    state.lastError = error;
    return {
      events: [
        {
          kind: "document-failed",
          jobId: state.jobId,
          documentId,
          relativePath: result.relativePath,
          error,
        },
      ],
    };
  }
}

// Maps an EmbedDocumentResult into PersistedHandling events, mutating run-state counters.
function applyEmbedResult(
  state: RunState,
  documentId: DocumentId,
  relativePath: string,
  priorEvents: readonly IndexingEvent[],
  embedResult: EmbedDocumentResult,
): PersistedHandling {
  const events: IndexingEvent[] = [...priorEvents];
  const identityErr = embedResult.errors.find((e) => e.code === "INCOMPATIBLE_EMBEDDING_IDENTITY");
  if (identityErr !== undefined) {
    state.failedDocuments += 1;
    state.lastError = identityErr;
    events.push({
      kind: "document-failed",
      jobId: state.jobId,
      documentId,
      relativePath,
      error: identityErr,
    });
    return { events, identityFailure: identityErr };
  }
  if (embedResult.errors.length > 0) {
    state.failedDocuments += 1;
    const firstErr = embedResult.errors[0] ?? {
      code: "EMBEDDING_ADAPTER_FAILED",
      message: "embedding adapter failed",
    };
    state.lastError = firstErr;
    events.push({
      kind: "document-failed",
      jobId: state.jobId,
      documentId,
      relativePath,
      error: firstErr,
    });
    return { events };
  }
  state.processedDocuments += 1;
  state.vectorsPersisted += embedResult.vectorCount;
  if (embedResult.lastChunkId !== null) state.lastResumeToken = embedResult.lastChunkId;
  events.push({
    kind: "document-embedded",
    jobId: state.jobId,
    documentId,
    vectorCount: embedResult.vectorCount,
    resumeToken: embedResult.lastChunkId ?? (`${String(documentId)}#empty` as ChunkId),
  });
  return { events };
}

// Wraps the chunk-then-embed pipeline for a single persisted document.
async function handlePersistedDocument(
  state: RunState,
  result: ExtractionResult,
): Promise<PersistedHandling> {
  const documentId = result.outcome.kind === "persisted" ? result.outcome.document.id : null;
  if (documentId === null) return { events: [] };

  const fastPath = applyIncrementalFastPath(state, documentId);
  if (fastPath !== undefined) return fastPath;

  const chunkStep = tryChunkDocument(state, result, documentId);
  if (!("chunked" in chunkStep)) return chunkStep;

  const embedResult = await embedDocumentChunks(
    state,
    documentId,
    sourceForResult(state, result),
    result.relativePath,
  );
  return applyEmbedResult(
    state,
    documentId,
    result.relativePath,
    chunkStep.chunked.events,
    embedResult,
  );
}

// ─── Per-source pipeline ──────────────────────────────────────────────────────
async function* runOneSource(
  state: RunState,
  source: KnowledgeSource,
): AsyncGenerator<IndexingEvent> {
  const stream = discoverAndExtract(
    {
      fs: state.options.workspaceFs,
      store: state.options.store,
      parserRegistry: state.options.parserRegistry,
    },
    {
      capsuleId: state.capsule.id,
      source,
      ...(state.options.discoveryOptions !== undefined
        ? { discovery: state.options.discoveryOptions }
        : state.options.signal !== undefined
          ? { discovery: { maxDepth: 12, maxFiles: 5_000, signal: state.options.signal } }
          : {}),
    },
  );

  let cancelled = false;
  for await (const evt of stream) {
    if (aborted(state.options.signal)) {
      cancelled = true;
      break;
    }
    const events = await handleDiscoveryEvent(state, evt);
    for (const e of events) {
      yield e;
      if (e.kind === "document-failed" && e.error.code === "INCOMPATIBLE_EMBEDDING_IDENTITY") {
        return;
      }
    }
    // After yielding a batch we re-check the signal — the consumer's awaiting iterator
    // may have aborted between events.
    if (aborted(state.options.signal)) {
      cancelled = true;
      break;
    }
  }
  if (cancelled) return;
}

// Routes a file-extracted event: force-skipped docs are re-shaped to persisted so the
// standard chunk-and-embed pipeline runs on them.
async function handleFileExtracted(
  state: RunState,
  result: ExtractionResult,
): Promise<readonly IndexingEvent[]> {
  if (result.outcome.kind === "skipped") {
    // In force mode, an "unchanged" document still needs chunk-and-embed because the
    // orchestrator deleted the vector rows at job-started. Re-shape the skipped outcome
    // as a persisted outcome (the document row exists and is valid) so the standard
    // pipeline runs. Outside force mode, surface the skip as-is.
    const staleChunks = hasStaleChunksForDocument(
      state.options.store._internal.db,
      state.capsule.id,
      result.outcome.document.id,
    );
    if (state.options.force === true || staleChunks) {
      const synthetic: ExtractionResult = {
        capsuleId: result.capsuleId,
        sourceId: result.sourceId,
        relativePath: result.relativePath,
        outcome: { kind: "persisted", document: result.outcome.document },
        diagnostics: result.diagnostics,
      };
      const handled = await handlePersistedDocument(state, synthetic);
      return handled.events;
    }
    return [handleExtractionSkipped(state, result)];
  }
  if (result.outcome.kind === "failed") {
    return [handleExtractionFailed(state, result)];
  }
  const handled = await handlePersistedDocument(state, result);
  return handled.events;
}

async function handleDiscoveryEvent(
  state: RunState,
  evt: ExtractionEvent,
): Promise<readonly IndexingEvent[]> {
  if (evt.kind === "file-discovered") {
    state.totalDocuments += 1;
    return [
      {
        kind: "document-discovered",
        jobId: state.jobId,
        relativePath: evt.relativePath,
        sizeBytes: evt.sizeBytes,
      },
    ];
  }
  if (evt.kind === "scope-error") {
    state.failedDocuments += 1;
    const err: IndexingJobError = {
      code: `DISCOVERY_FAILED:${evt.error.code}`,
      message: evt.error.message,
    };
    state.lastError = err;
    const failed: IndexingEvent = {
      kind: "document-failed",
      jobId: state.jobId,
      ...(evt.error.relativePath !== undefined ? { relativePath: evt.error.relativePath } : {}),
      error: err,
    };
    return [failed];
  }
  if (evt.kind === "cancelled" || evt.kind === "completed") {
    // No-op at this level: the outer loop drives terminal events.
    return [];
  }
  // evt.kind === "file-extracted"
  return handleFileExtracted(state, evt.result);
}

// ─── Capsule resolution + job lifecycle ───────────────────────────────────────
function resolveCapsule(options: IndexingOptions): KnowledgeCapsule {
  const capsule = getCapsule(options.store, options.capsuleId);
  if (capsule === undefined) {
    throw new IndexingError("CAPSULE_NOT_FOUND", `capsule not found: ${String(options.capsuleId)}`);
  }
  return capsule;
}

function buildInitialState(
  options: IndexingOptions,
  capsule: KnowledgeCapsule,
  jobId: string,
  startedAt: number,
): RunState {
  return {
    jobId,
    capsule,
    options,
    batchSize: clampBatchSize(options.batchSize),
    concurrency: clampConcurrency(options.concurrency),
    now: options.now ?? options.store._internal.now,
    idSource: options.idSource ?? ((): string => randomUUID()),
    startedAt,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
    skippedDocuments: 0,
    vectorsPersisted: 0,
    lastResumeToken: null,
  };
}

function buildResult(
  state: RunState,
  status: "succeeded" | "failed" | "cancelled",
  finishedAt: number,
): IndexingResult {
  return {
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    status,
    totalDocuments: state.totalDocuments,
    processedDocuments: state.processedDocuments,
    failedDocuments: state.failedDocuments,
    skippedDocuments: state.skippedDocuments,
    vectorsPersisted: state.vectorsPersisted,
    startedAt: state.startedAt,
    finishedAt,
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
    embeddingIdentity: state.capsule.embeddingModelIdentity,
  };
}

async function verifyEmbeddingPreflight(
  state: RunState,
): Promise<IndexingJobError | undefined> {
  const result = await verifyEmbeddingCapability(state.options.embeddingAdapter, {
    modelId: state.capsule.embeddingModelIdentity.modelId,
    provider: state.capsule.embeddingModelIdentity.provider,
    vectorMetric: state.capsule.embeddingModelIdentity.vectorMetric,
    expectedDimensions: state.capsule.embeddingModelIdentity.vectorDimensions,
    ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
  });
  if (result.ok) return undefined;
  return {
    code:
      result.reason === "dimension-mismatch"
        ? "INCOMPATIBLE_EMBEDDING_IDENTITY"
        : "EMBEDDING_ADAPTER_FAILED",
    message: result.safeMessage,
  };
}

// ─── Public entrypoint ────────────────────────────────────────────────────────
export async function* runIndexingJob(options: IndexingOptions): AsyncIterable<IndexingEvent> {
  const capsule = resolveCapsule(options);
  const sources = resolveSources(options, capsule);
  const startedAt = (options.now ?? options.store._internal.now)();
  const idSource = options.idSource ?? ((): string => randomUUID());
  const jobId = idSource();
  const state = buildInitialState(options, capsule, jobId, startedAt);

  // Persist the started row up front. The `idSource` is reused for vector storage refs;
  // the jobId itself is minted from the same source so test fixtures can pin both.
  insertJobRow(state.options.store._internal.db, {
    id: jobId,
    capsuleId: capsule.id,
    sourceIds: sources.map((s) => s.id),
    startedAt,
  });

  // Lifecycle: mark the capsule as `indexing` so concurrent UI surfaces see the
  // in-progress state. Restored to `ready`/`error` at finalization.
  try {
    updateCapsuleState(state.options.store, capsule.id, "indexing");
  } catch {
    // The capsule state column is informational — failing to flip it must not abort the
    // run. The events stream remains the source of truth.
  }

  yield emit(state, {
    kind: "job-started",
    jobId,
    capsuleId: capsule.id,
    sourceIds: sources.map((s) => s.id),
    startedAt,
  });
  options.auditSink?.emit({
    kind: "indexing-job-started",
    capsuleId: capsule.id,
    jobId,
    occurredAt: startedAt,
  });

  const preflightFailure = await verifyEmbeddingPreflight(state);
  if (preflightFailure !== undefined) {
    state.lastError = preflightFailure;
    yield* finalize(state, preflightFailure);
    return;
  }

  // Force mode: tear down ALL vectors for the capsule up front. Per-document teardown
  // still runs in handlePersistedDocument as a defence-in-depth measure.
  if (options.force === true) {
    deleteVectorsForCapsule(state.options.store._internal.db, capsule.id);
  }

  let identityFailure: IndexingJobError | undefined;
  for (const source of sources) {
    if (aborted(options.signal)) break;
    if (identityFailure !== undefined) break;
    identityFailure = yield* iterateSourceEvents(state, source);
    updateJobCounters(state.options.store._internal.db, jobId, buildCounters(state));
  }

  yield* finalize(state, identityFailure);
}

// Drains one source's event stream, yielding each event to the outer generator.
// Returns the identity-failure error if encountered, undefined otherwise.
async function* iterateSourceEvents(
  state: RunState,
  source: KnowledgeSource,
): AsyncGenerator<IndexingEvent, IndexingJobError | undefined> {
  for await (const evt of runOneSource(state, source)) {
    yield emit(state, evt);
    if (evt.kind === "document-failed" && evt.error.code === "INCOMPATIBLE_EMBEDDING_IDENTITY") {
      return evt.error;
    }
  }
  return undefined;
}

function emit(state: RunState, event: IndexingEvent): IndexingEvent {
  emitProgress(state.options, event);
  return event;
}

function resolveJobStatus(
  state: RunState,
  fatalFailure: IndexingJobError | undefined,
): "succeeded" | "failed" | "cancelled" {
  if (fatalFailure !== undefined) {
    state.lastError = fatalFailure;
    return "failed";
  }
  if (aborted(state.options.signal)) return "cancelled";
  if (state.failedDocuments > 0 && state.processedDocuments === 0) return "failed";
  return "succeeded";
}

function* finalize(
  state: RunState,
  fatalFailure: IndexingJobError | undefined,
): Generator<IndexingEvent> {
  const finishedAt = state.now();
  const status = resolveJobStatus(state, fatalFailure);

  finalizeJobRow(state.options.store._internal.db, {
    id: state.jobId,
    status,
    finishedAt,
    counters: buildCounters(state),
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
  });

  try {
    updateCapsuleState(
      state.options.store,
      state.capsule.id,
      status === "succeeded" ? "ready" : "error",
    );
  } catch {
    // informational only — see the started block for the rationale
  }

  const result = buildResult(state, status, finishedAt);
  if (status === "cancelled") {
    yield emit(state, { kind: "job-cancelled", jobId: state.jobId, result });
    return;
  }
  if (status === "failed") {
    const err = state.lastError ?? { code: "EMBEDDING_ADAPTER_FAILED", message: "indexing failed" };
    state.options.auditSink?.emit({
      kind: "indexing-job-failed",
      capsuleId: state.capsule.id,
      jobId: state.jobId,
      errorCode: err.code,
      occurredAt: finishedAt,
    });
    yield emit(state, { kind: "job-failed", jobId: state.jobId, error: err, result });
    return;
  }
  state.options.auditSink?.emit({
    kind: "indexing-job-completed",
    capsuleId: state.capsule.id,
    jobId: state.jobId,
    processedDocuments: result.processedDocuments,
    failedDocuments: result.failedDocuments,
    occurredAt: finishedAt,
  });
  yield emit(state, { kind: "job-completed", jobId: state.jobId, result });
}
