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
// Force mode: passes `force=true` into the chunker per document so existing chunks are
// replaced from the current source text, then re-embeds. Discovery's incremental
// fast-path is bypassed (the skipped outcome is re-shaped to persisted in
// handleFileExtracted) so chunk-and-embed re-runs even for unchanged file hashes.
// Recovery mode (partial vector coverage, non-force): re-embeds using existing chunks
// only — the chunker runs with force=false so it reuses the already-correct chunk rows.

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  CheckpointFingerprint,
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  ExtractionCheckpointRecord,
  INDEXING_EMBEDDING_STOPPED_ERROR_CODES,
  IndexingJobError,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  checkpointCompatibility,
  DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
  LARGE_DOCUMENT_DIAGNOSTIC_CODES,
  largeDocumentPolicyFingerprint,
} from "@oscharko-dev/keiko-contracts";
import {
  assertCompatibleEmbeddingIdentity,
  verifyEmbeddingCapability,
  type EmbeddingCapabilityCheck,
  type EmbeddingProbeOptions,
  type OpenAIEmbeddingAdapter,
} from "@oscharko-dev/keiko-model-gateway";

import { chunkDocument } from "../chunking/chunker-runner.js";
import {
  countChunksForDocument,
  deleteChunksForDocument,
  hasStaleChunksForDocument,
} from "../chunking/chunker-persist.js";
import {
  chunkingStrategyKey,
  loadOptionalQwen3SentencePieceTokenizer,
  resolveChunkingOptions,
  type ChunkingOptions,
  type LocalKnowledgeTokenizer,
} from "../chunking/index.js";
import {
  getCapsule,
  updateCapsuleEmbeddingModelIdentity,
  updateCapsuleState,
} from "../capsule-lifecycle.js";
import { discoverAndExtract } from "../discovery/discovery-runner.js";
import {
  DEFAULT_DISCOVERY_OPTIONS,
  MAX_DISCOVERY_DEPTH_CEILING,
  MAX_DISCOVERY_FILES_CEILING,
  documentIdFor,
  type DiscoveryOptions,
} from "../discovery/index.js";
import {
  deleteDocumentRow,
  deleteCapsuleDiagnosticsByCode,
  insertDiagnosticRow,
  listPersistedDocumentsForSource,
  readDocumentTextRow,
  updateDocumentStatusRow,
} from "../discovery/persist.js";
import type {
  DiscoveryError,
  ExtractionEvent,
  ExtractionOutcome,
  ExtractionResult,
} from "../discovery/types.js";
import { listCapsuleSources } from "../source-lifecycle.js";
import { LEXICAL_ANALYZER_KEY } from "../retrieval/lexical-normalization.js";
import {
  BoundedIndexingCancelledError,
  BoundedIndexingPolicyError,
  chunkDocumentBounded,
  embedDocumentChunksBounded,
} from "./bounded-indexing.js";
import { resolveCapsuleModelUsePolicy } from "../model-use-policy.js";
import { selectExtractionCheckpoint, upsertExtractionCheckpoint } from "./checkpoint-persist.js";

import {
  finalizeJobRow,
  isJobCancellationRequested,
  insertJobRow,
  updateJobCounters,
  type JobCounters,
} from "./job-persist.js";
import { embedChunkBatch, embeddingEndpointHost } from "./embedding-batcher.js";
import {
  emitKnowledgeLogEvent,
  knowledgeErrorKind,
  startKnowledgeLogTimer,
  type KnowledgeLogEvent,
} from "../knowledge-log.js";
import {
  countVectorsForCapsule,
  countVectorsForDocument,
  deleteVectorsForDocument,
  invalidateVectorIndexStateForCapsules,
  selectChunksForDocument,
} from "./vector-persist.js";
import {
  countLexicalRowsForDocument,
  deleteLexicalRowsForDocument,
  replaceLexicalRowsForDocument,
} from "./lexical-index-persist.js";
import {
  DEFAULT_INDEXING_BATCH_SIZE,
  DEFAULT_INDEXING_CONCURRENCY,
  IndexingError,
  type ChunkToEmbed,
  type EmbedBatchResult,
  type IndexingEvent,
  type IndexingLogContext,
  type IndexingOptions,
  type IndexingResult,
} from "./types.js";
import {
  boundedDocumentContext,
  contextualizeChunk,
  contextualRetrievalStrategyKey,
} from "./contextual-retrieval.js";
import {
  persistChunkIndexedText,
  readStoredAugmentedText,
  type StoredChunkIndexedTextColumns,
} from "./chunk-indexed-text-persist.js";

// ─── Abort helper ─────────────────────────────────────────────────────────────
// Reads `signal?.aborted` through a function call so TypeScript's control-flow analysis
// does NOT narrow the optional chain after the first false branch. Mirrors the pattern in
// `discovery/discovery-runner.ts` and `discovery/walk.ts`.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancellationRequested(state: RunState): boolean {
  return (
    aborted(state.options.signal) ||
    isJobCancellationRequested(state.options.store._internal.db, state.jobId)
  );
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

// Relocated pin (2026-08 field review): the caller bound used to be Math.min(DEFAULT, value) —
// the default doubled as a hard ceiling, so an operator could LOWER the walk bounds but never
// raise them, and a corpus above the default was silently truncated forever. The runaway guard
// the old clamp provided lives on in the explicit CEILING: malformed or absurd caller values
// still cannot demand an unbounded walk.
function clampDiscoveryInteger(raw: number | undefined, fallback: number, ceiling: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(ceiling, Math.floor(raw)));
}

function resolvedDiscoveryOptions(state: RunState): DiscoveryOptions {
  const raw = state.options.discoveryOptions;
  const base = {
    maxDepth: clampDiscoveryInteger(
      raw?.maxDepth,
      DEFAULT_DISCOVERY_OPTIONS.maxDepth,
      MAX_DISCOVERY_DEPTH_CEILING,
    ),
    maxFiles: clampDiscoveryInteger(
      raw?.maxFiles,
      DEFAULT_DISCOVERY_OPTIONS.maxFiles,
      MAX_DISCOVERY_FILES_CEILING,
    ),
    ...(raw?.respectGitIgnore === true ? { respectGitIgnore: true } : {}),
  };
  const signal = raw?.signal ?? state.options.signal;
  return signal === undefined ? base : { ...base, signal };
}

function chunkingOptionsForState(state: RunState): ChunkingOptions {
  const indexingTextStrategyKey = [
    contextualRetrievalStrategyKey(state.options.contextualRetrieval),
    `lexical-analyzer=${LEXICAL_ANALYZER_KEY}`,
  ].join("|");
  return {
    ...state.options.chunkingOptions,
    tokenizer: state.tokenizer,
    indexingTextStrategyKey,
  };
}

// ─── Source resolution ────────────────────────────────────────────────────────
function resolveSources(
  options: IndexingOptions,
  capsule: KnowledgeCapsule,
): readonly KnowledgeSource[] {
  const all = listCapsuleSources(options.store, capsule.id);
  if (all.length === 0) {
    throw new IndexingError(
      "INVALID_OPTIONS",
      `Capsule ${String(capsule.id)} has no attached sources to index.`,
    );
  }
  if (options.sourceIds === undefined) return all;
  const allow = new Set(options.sourceIds.map(String));
  if (allow.size === 0) {
    throw new IndexingError("INVALID_OPTIONS", "sourceIds must contain at least one source id.");
  }
  const selected = all.filter((s) => allow.has(String(s.id)));
  if (selected.length !== allow.size) {
    throw new IndexingError(
      "INVALID_OPTIONS",
      "sourceIds must reference sources attached to the target capsule.",
    );
  }
  return selected;
}

// ─── Mutable run state ────────────────────────────────────────────────────────
interface RunState {
  readonly jobId: string;
  capsule: KnowledgeCapsule;
  readonly options: IndexingOptions;
  // Correlation identity stamped on every activity-log line this run writes. Built once at job
  // start — the capsule digest is computed a single time rather than per line.
  readonly logContext: IndexingLogContext;
  // Monotonic wall time since the job started, for the closing line. Deliberately NOT
  // `finishedAt - startedAt`: `now` is an injectable clock that tests pin to a counter, so that
  // subtraction reports a tick count rather than a duration.
  readonly elapsed: () => number;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly now: () => number;
  readonly idSource: () => string;
  readonly tokenizer: LocalKnowledgeTokenizer;
  readonly startedAt: number;
  readonly sourcesById: ReadonlyMap<string, KnowledgeSource>;
  totalDocuments: number;
  processedDocuments: number;
  failedDocuments: number;
  skippedDocuments: number;
  vectorsPersisted: number;
  lastResumeToken: ChunkId | null;
  lastError?: IndexingJobError;
  // Circuit breaker: transient adapter failures since the last successfully embedded document.
  // A dead or saturated gateway produces ONLY transient failures, so this climbing without an
  // intervening success is outage evidence; deterministic failures (parse errors, unsupported
  // formats) and skips say nothing about the gateway and leave the count untouched.
  consecutiveTransientEmbedFailures: number;
  // At most one capsule-level truncation warning per run (multiple LIMIT_REACHED frames can
  // surface from one truncated walk).
  discoveryLimitWarningPersisted: boolean;
  // Walk-level scope errors within failedDocuments. They are diagnostics about the WALK, not
  // attempted documents, so the honest-status ratio subtracts them from its numerator.
  discoveryFailedDocuments: number;
  // Pre-run per-document snapshots captured at "file-discovered" time (see the "Per-document
  // restore snapshot" section below), keyed by DocumentId. Restored only if that same
  // document's re-processing ends this run in failure.
  readonly restoreSnapshots: Map<string, DocumentRestoreSnapshot>;
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

function persistJobProgress(state: RunState): void {
  updateJobCounters(state.options.store._internal.db, state.jobId, buildCounters(state));
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

// ─── Activity log ─────────────────────────────────────────────────────────────
// WHY THESE LINES EXIST ON TOP OF THE EVENT STREAM
//
// `IndexingEvent` reports STATE, and only to a consumer that is actively driving the async
// iterator. The field incident this instrumentation was written for is a run that produced no
// state change at all — "0 of 1 documents, 0 of 36 vectors" for six minutes, then an operator
// cancellation. There was nothing to report, so nothing was reported, and four releases went by
// guessing. These lines are the run's SPINE: one per lifecycle transition, at `info`, so an
// operator who opens `server.log` at the default level sees which step a stuck run reached and
// never started the next one — without attaching a consumer to anything.
//
// CORRELATION. Concurrency is up to 4, so several documents and several embedding flushes are in
// flight at once and a line without an owner cannot be attributed to the work that produced it.
// Every line carries the run's `IndexingLogContext`: the job uuid verbatim in `correlationId`,
// and the capsule (always) and document (where known) as DIGESTS — see the type's own note for
// why the raw ids are not writable.
const LOG_DIGEST_LENGTH = 16;

// A truncated sha-256. 16 hex characters is 64 bits: collision-free across every capsule and
// document a single log file can hold, short enough to read at the start of a line, and — being
// a one-way digest of the whole value — carries nothing back about the name it stands for.
function logDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, LOG_DIGEST_LENGTH);
}

// `scheme://host` for the configured embedding gateway, omitted when the endpoint does not
// parse. Never the path or the query — see `embeddingEndpointHost`.
function endpointHostExtra(state: RunState): Readonly<Record<string, unknown>> {
  const host = embeddingEndpointHost(state.options.embeddingAdapter.endpoint);
  return host === undefined ? {} : { endpointHost: host };
}

function documentLogContext(state: RunState, documentId: DocumentId): IndexingLogContext {
  return { ...state.logContext, documentIdDigest: logDigest(String(documentId)) };
}

// Routed through `emitKnowledgeLogEvent` for the same reason `emitProgress` above wraps the
// progress callback: the sink is caller-supplied code, and a run's correctness may not depend on
// it. Without the guard a throwing sink would abort whichever step happened to be logging —
// mid-document, inside a retry ladder, or in the failure path that is about to report the real
// cause — and a logging defect would be indistinguishable from an indexing failure. The seam also
// keeps a broken sink from going unnoticed; see `knowledge-log.ts`.
function writeKnowledgeLog(
  state: RunState,
  context: IndexingLogContext,
  event: Omit<KnowledgeLogEvent, "correlationId">,
): void {
  emitKnowledgeLogEvent(state.options.logSink, {
    ...event,
    correlationId: context.jobId,
    extra: {
      capsuleIdDigest: context.capsuleIdDigest,
      ...(context.documentIdDigest !== undefined
        ? { documentIdDigest: context.documentIdDigest }
        : {}),
      ...event.extra,
    },
  });
}

// Job-scoped lifecycle line.
function logIndexing(
  state: RunState,
  event: Omit<KnowledgeLogEvent, "category" | "correlationId">,
): void {
  writeKnowledgeLog(state, state.logContext, { ...event, category: "indexing" });
}

// Job-scoped line about the embedding gateway rather than the corpus. The category has to match
// the op prefix: an `embedding.*` op filed under `indexing` is invisible to the grep an operator
// runs when the gateway is the suspect.
function logEmbeddingRun(
  state: RunState,
  event: Omit<KnowledgeLogEvent, "category" | "correlationId">,
): void {
  writeKnowledgeLog(state, state.logContext, { ...event, category: "embedding" });
}

// Document-scoped lifecycle line — same shape, plus the document digest.
function logDocument(
  state: RunState,
  documentId: DocumentId,
  event: Omit<KnowledgeLogEvent, "category" | "correlationId">,
): void {
  writeKnowledgeLog(state, documentLogContext(state, documentId), {
    ...event,
    category: "indexing",
  });
}

function clearDocumentArtifacts(
  state: RunState,
  documentId: DocumentId,
  options: { readonly deleteChunks: boolean },
): void {
  deleteVectorsForDocument(state.options.store._internal.db, state.capsule.id, documentId);
  if (options.deleteChunks) {
    deleteLexicalRowsForDocument(state.options.store._internal.db, state.capsule.id, documentId);
    deleteChunksForDocument(state.options.store._internal.db, state.capsule.id, documentId);
  }
}

function markDocumentFailed(state: RunState, documentId: DocumentId): void {
  updateDocumentStatusRow(state.options.store._internal.db, state.capsule.id, documentId, "failed");
}

// ─── Per-document restore snapshot ─────────────────────────────────────────────
// A changed page's previous chunks/vectors are destroyed before its re-embed is attempted
// (real re-extraction cascade-deletes parsed_units -> chunks -> vectors; a force/stale
// re-chunk deletes chunks -> vectors directly) — a per-page embed failure used to leave the
// page with zero vectors instead of its previous (good) ones. This section captures a raw,
// column-exact snapshot of a document's dependent rows synchronously at "file-discovered"
// time (before extraction or re-chunking can touch anything) and restores it only if that
// same document's standard chunk/embed processing ends this run in failure.
type SqlCellValue = string | number | bigint | Uint8Array | null;
type RawTableRow = Readonly<Record<string, SqlCellValue>>;

interface DocumentRestoreSnapshot {
  readonly document: RawTableRow;
  readonly parsedUnits: readonly RawTableRow[];
  readonly chunks: readonly RawTableRow[];
  readonly chunkLexicalRows: readonly RawTableRow[];
  readonly repositoryChunkLineRows: readonly RawTableRow[];
  readonly vectors: readonly RawTableRow[];
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :name").get({
      name: table,
    }) !== undefined
  );
}

function selectRowsForDocument(
  db: DatabaseSync,
  table: string,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): readonly RawTableRow[] {
  const rows = db
    .prepare(`SELECT * FROM ${table} WHERE capsule_id = :c AND document_id = :d`)
    .all({ c: String(capsuleId), d: String(documentId) });
  return rows;
}

function selectDocumentRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): RawTableRow | undefined {
  return db
    .prepare("SELECT * FROM documents WHERE capsule_id = :c AND id = :d")
    .get({ c: String(capsuleId), d: String(documentId) });
}

// Only a document that already has confirmed vectors from a prior run is worth protecting, and
// only outside the progressive/bounded large-document path — that path owns its own
// checkpointed resume semantics (partial progress is meant to be resumed, not reverted) and
// must not be disturbed by an unrelated restore.
function eligibleForRestoreSnapshot(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): boolean {
  const checkpoint = selectExtractionCheckpoint(db, capsuleId, documentId);
  if (checkpoint?.strategy === "progressive-pdf") return false;
  return countVectorsForDocument(db, capsuleId, documentId) > 0;
}

function captureRestoreSnapshotIfEligible(state: RunState, documentId: DocumentId): void {
  const db = state.options.store._internal.db;
  if (!eligibleForRestoreSnapshot(db, state.capsule.id, documentId)) return;
  const document = selectDocumentRow(db, state.capsule.id, documentId);
  if (document === undefined) return;
  state.restoreSnapshots.set(String(documentId), {
    document,
    parsedUnits: selectRowsForDocument(db, "parsed_units", state.capsule.id, documentId),
    chunks: selectRowsForDocument(db, "chunks", state.capsule.id, documentId),
    chunkLexicalRows: selectRowsForDocument(
      db,
      "chunk_lexical_index",
      state.capsule.id,
      documentId,
    ),
    repositoryChunkLineRows: tableExists(db, "repository_chunk_line_ranges")
      ? selectRowsForDocument(db, "repository_chunk_line_ranges", state.capsule.id, documentId)
      : [],
    vectors: selectRowsForDocument(db, "vectors", state.capsule.id, documentId),
  });
}

function discardRestoreSnapshot(state: RunState, documentId: DocumentId): void {
  state.restoreSnapshots.delete(String(documentId));
}

function requiredDocumentCell(row: RawTableRow, key: string, documentId: DocumentId): SqlCellValue {
  const value = row[key];
  if (value === undefined) {
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      `document snapshot for ${String(documentId)} is missing column ${key}`,
    );
  }
  return value;
}

const RESTORE_DOCUMENT_ROW_SQL = [
  "UPDATE documents SET",
  "  size_bytes = :size_bytes, media_type = :media_type, content_hash = :content_hash,",
  "  parser_id = :parser_id, parser_version = :parser_version,",
  "  last_extracted_at = :last_extracted_at, status = :status",
  "WHERE capsule_id = :capsule_id AND id = :id",
].join(" ");

// Reverts `documents.content_hash` (and the rest of the extraction-derived columns) back to the
// snapshot's values. This is what makes a future refresh retry the failed page instead of
// treating the just-restored (stale) content as already caught up: the next run's freshly
// computed content hash for the (still-changed) page will no longer match.
function restoreDocumentRow(db: DatabaseSync, documentId: DocumentId, row: RawTableRow): void {
  const cell = (key: string): SqlCellValue => requiredDocumentCell(row, key, documentId);
  db.prepare(RESTORE_DOCUMENT_ROW_SQL).run({
    size_bytes: cell("size_bytes"),
    media_type: cell("media_type"),
    content_hash: cell("content_hash"),
    parser_id: cell("parser_id"),
    parser_version: cell("parser_version"),
    last_extracted_at: cell("last_extracted_at"),
    status: cell("status"),
    capsule_id: cell("capsule_id"),
    id: cell("id"),
  });
}

function insertRawRow(db: DatabaseSync, table: string, row: RawTableRow): void {
  const columns = Object.keys(row);
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
    .map((column) => `:${column}`)
    .join(", ")})`;
  db.prepare(sql).run(row as Record<string, SqlCellValue>);
}

// Reverts a document to its last known-good state after this run's (re-)processing of it
// failed. The failed attempt already replaced parsed_units (real re-extraction) or chunks
// (force/stale re-chunk); deleting parsed_units cascades away whatever partial state it left
// (chunks -> chunk_lexical_index + vectors, FK ON DELETE CASCADE), freeing the original ids so
// the snapshot can be reinserted unchanged.
function restoreDocumentSnapshot(
  state: RunState,
  documentId: DocumentId,
  snapshot: DocumentRestoreSnapshot,
): void {
  const db = state.options.store._internal.db;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM parsed_units WHERE capsule_id = :c AND document_id = :d").run({
      c: String(state.capsule.id),
      d: String(documentId),
    });
    for (const row of snapshot.parsedUnits) insertRawRow(db, "parsed_units", row);
    for (const row of snapshot.chunks) insertRawRow(db, "chunks", row);
    for (const row of snapshot.chunkLexicalRows) insertRawRow(db, "chunk_lexical_index", row);
    for (const row of snapshot.repositoryChunkLineRows) {
      insertRawRow(db, "repository_chunk_line_ranges", row);
    }
    for (const row of snapshot.vectors) insertRawRow(db, "vectors", row);
    restoreDocumentRow(db, documentId, snapshot.document);
    invalidateVectorIndexStateForCapsules(db, [state.capsule.id]);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      "document snapshot restore failed mid-transaction",
      cause === undefined ? undefined : { cause },
    );
  }
}

// Checked once a document's standard chunk/embed processing reaches a terminal outcome for this
// run: if it failed AND a pre-run snapshot was captured, restore it so the document keeps
// returning its previous (still valid) hits instead of going dark until some future refresh
// happens to succeed. Always clears the snapshot afterward — a success needs no restore, and a
// failure with no snapshot (first-ever index of this document) has nothing to revert to.
function restoreSnapshotOnFailure(
  state: RunState,
  documentId: DocumentId,
  events: readonly IndexingEvent[],
): void {
  const snapshot = state.restoreSnapshots.get(String(documentId));
  discardRestoreSnapshot(state, documentId);
  if (snapshot === undefined) return;
  if (!events.some((event) => event.kind === "document-failed")) return;
  restoreDocumentSnapshot(state, documentId, snapshot);
}

function restoreSnapshotOnCancellation(state: RunState, documentId: DocumentId): boolean {
  if (!cancellationRequested(state)) return false;
  const snapshot = state.restoreSnapshots.get(String(documentId));
  discardRestoreSnapshot(state, documentId);
  if (snapshot !== undefined) restoreDocumentSnapshot(state, documentId, snapshot);
  return true;
}

// ─── Per-chunk text projection ────────────────────────────────────────────────
// Slices the document source text by the chunk's OWN (character_start, character_end) span
// so each chunk embeds a bounded sub-span. A multi-chunk parsed unit (e.g. a dense PDF page)
// would otherwise re-derive the full parsed-unit span for every chunk, emitting duplicate
// vectors and an unbounded embedding input. Chunks indexed before the v8 migration carry no
// chunk span (NULL), so COALESCE falls back to the parsed_unit span — byte-identical to the
// pre-fix behaviour until the capsule is reindexed.
interface ChunkProjectionRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly parsed_unit_id: string;
  readonly order_index: number;
  readonly safe_excerpt_hash: string;
  readonly char_start: number | null;
  readonly char_end: number | null;
  readonly contextual_retrieval_key: string | null;
  readonly context_prefix: string | null;
  readonly augmented_text: string | null;
  readonly context_status: string | null;
}

const SELECT_CHUNKS_WITH_OFFSETS_SQL = [
  "SELECT c.id, c.capsule_id, c.source_id, c.document_id, c.parsed_unit_id, c.order_index,",
  "  c.safe_excerpt_hash, c.contextual_retrieval_key, c.context_prefix,",
  "  c.augmented_text, c.context_status,",
  "  COALESCE(c.character_start, pu.character_start) AS char_start,",
  "  COALESCE(c.character_end, pu.character_end) AS char_end",
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

function storedColumns(row: ChunkProjectionRow): StoredChunkIndexedTextColumns {
  return {
    contextual_retrieval_key: row.contextual_retrieval_key,
    context_prefix: row.context_prefix,
    augmented_text: row.augmented_text,
    context_status: row.context_status,
  };
}

function expectedContextualKey(state: RunState, row: ChunkProjectionRow): string {
  return `${contextualRetrievalStrategyKey(state.options.contextualRetrieval)}|chunk=${row.safe_excerpt_hash}`;
}

function readStoredChunkToEmbed(
  state: RunState,
  documentId: DocumentId,
  row: ChunkProjectionRow,
): ChunkToEmbed | undefined {
  const text = readStoredAugmentedText(
    state.options.store._internal.contentCipher,
    storedColumns(row),
    expectedContextualKey(state, row),
  );
  if (text === undefined) return undefined;
  return {
    id: row.id as ChunkId,
    capsuleId: row.capsule_id as ChunkToEmbed["capsuleId"],
    sourceId: row.source_id as KnowledgeSourceId,
    documentId,
    text,
  };
}

function storedChunksToEmbed(
  state: RunState,
  documentId: DocumentId,
): readonly ChunkToEmbed[] | undefined {
  const projections = selectChunkProjections(state, documentId);
  const out: ChunkToEmbed[] = [];
  for (const row of projections) {
    const chunk = readStoredChunkToEmbed(state, documentId, row);
    if (chunk === undefined) return undefined;
    out.push(chunk);
  }
  return out;
}

async function contextualizedChunkToEmbed(
  state: RunState,
  documentId: DocumentId,
  row: ChunkProjectionRow,
  sourceText: string,
): Promise<ChunkToEmbed> {
  const stored = readStoredChunkToEmbed(state, documentId, row);
  if (stored !== undefined) return stored;
  const start = row.char_start ?? 0;
  const end = row.char_end ?? sourceText.length;
  const originalText = sourceText.slice(start, end);
  const result = await contextualizeChunk(
    {
      documentId,
      chunkId: row.id as ChunkId,
      originalText,
      safeExcerptHash: row.safe_excerpt_hash,
      documentText: boundedDocumentContext(
        sourceText,
        start,
        end,
        state.options.contextualRetrieval,
      ),
      ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
    },
    state.options.contextualRetrieval,
  );
  persistChunkIndexedText(
    state.options.store._internal.db,
    state.options.store._internal.contentCipher,
    {
      capsuleId: state.capsule.id,
      chunkId: row.id as ChunkId,
      contextualRetrievalKey: result.contextualRetrievalKey,
      contextPrefix: result.contextPrefix,
      augmentedText: result.augmentedText,
      contextStatus: result.status,
      updatedAt: state.now(),
    },
  );
  return {
    id: row.id as ChunkId,
    capsuleId: row.capsule_id as ChunkToEmbed["capsuleId"],
    sourceId: row.source_id as KnowledgeSourceId,
    documentId,
    text: result.augmentedText,
  };
}

function persistContextualRetrievalDiagnostic(
  state: RunState,
  documentId: DocumentId,
  degradedCount: number,
): void {
  if (degradedCount <= 0) return;
  state.options.store._internal.db
    .prepare(
      [
        "INSERT OR REPLACE INTO parser_diagnostics (",
        "  id, capsule_id, document_id, severity, code, message, created_at",
        ") VALUES (",
        "  :id, :capsule_id, :document_id, 'warning', 'CONTEXTUAL_RETRIEVAL_DEGRADED',",
        "  :message, :created_at",
        ")",
      ].join(" "),
    )
    .run({
      id: `${String(documentId)}#contextual-retrieval-degraded`,
      capsule_id: String(state.capsule.id),
      document_id: String(documentId),
      message: `${String(degradedCount)} chunk context generations degraded to raw chunk text.`,
      created_at: state.now(),
    });
}

async function prepareChunksToEmbed(
  state: RunState,
  documentId: DocumentId,
  sourceText: string,
): Promise<readonly ChunkToEmbed[]> {
  const rows = selectChunkProjections(state, documentId);
  const chunks: ChunkToEmbed[] = [];
  for (const row of rows) {
    chunks.push(await contextualizedChunkToEmbed(state, documentId, row, sourceText));
  }
  const degraded = state.options.store._internal.db
    .prepare(
      "SELECT COUNT(*) AS n FROM chunks WHERE capsule_id = :c AND document_id = :d AND context_status = 'degraded'",
    )
    .get({ c: String(state.capsule.id), d: String(documentId) }) as { readonly n: number };
  persistContextualRetrievalDiagnostic(state, documentId, degraded.n);
  return chunks;
}

function replaceLexicalRowsForChunks(
  state: RunState,
  documentId: DocumentId,
  chunks: readonly ChunkToEmbed[],
): void {
  const updatedAt = state.now();
  replaceLexicalRowsForDocument(
    state.options.store._internal.db,
    state.capsule.id,
    documentId,
    chunks.map((chunk) => ({
      capsuleId: chunk.capsuleId,
      sourceId: chunk.sourceId,
      documentId: chunk.documentId,
      chunkId: chunk.id,
      text: chunk.text,
      exactText: chunk.text,
      updatedAt,
    })),
  );
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
  return p.replaceAll("\\", "/");
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
      "source text could not be read before embedding",
      { cause },
    );
  }
  if (!isContained(absoluteRoot, real)) {
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      `source realpath escapes scope root before embedding: ${relativePath}`,
    );
  }
  try {
    return state.options.workspaceFs.readFileUtf8(normaliseSep(real));
  } catch (cause) {
    throw new IndexingError(
      "PERSISTENCE_FAILED",
      "source text could not be read before embedding",
      { cause },
    );
  }
}

function resolveChunkSourceText(
  state: RunState,
  documentId: DocumentId,
  source: KnowledgeSource,
  relativePath: string,
): string {
  const persistedText = readDocumentTextRow(
    state.options.store._internal.db,
    state.options.store._internal.contentCipher,
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

function cancellationError(): IndexingJobError {
  return { code: "CANCELLED", message: "indexing aborted via AbortSignal" };
}

function recordCancellationIfRequested(state: RunState, errors: IndexingJobError[]): void {
  if (cancellationRequested(state) && !errors.some((error) => error.code === "CANCELLED")) {
    errors.push(cancellationError());
  }
}

function contextualRetrievalFailureResult(): EmbedDocumentResult {
  return {
    vectorCount: 0,
    errors: [
      {
        code: "CONTEXTUAL_RETRIEVAL_FAILED",
        message: "contextual retrieval generation failed",
      },
    ],
    lastChunkId: null,
  };
}

async function prepareChunksToEmbedSafely(
  state: RunState,
  documentId: DocumentId,
  sourceText: string,
): Promise<readonly ChunkToEmbed[] | null> {
  try {
    return await prepareChunksToEmbed(state, documentId, sourceText);
  } catch (cause) {
    // The caller converts `null` into a CONTEXTUAL_RETRIEVAL_FAILED document error, which tells
    // an operator that a document failed but not which stage threw. The error KIND is the one
    // fact that separates a chat-gateway outage from a chunker defect, and it is lost here
    // unless this line records it. The message is never read — it can carry document text, and
    // neither is the raw document id, which IS the document's relative path (`doc:<capsule>:
    // <source>:<relativePath>`): the digest correlates it to every other line of this document's
    // work without writing a customer file name into the log.
    logDocument(state, documentId, {
      level: "warn",
      op: "indexing.chunking.failed",
      errorKind: knowledgeErrorKind(cause),
      extra: { sourceTextLength: sourceText.length, lane: "standard" },
    });
    return null;
  }
}

function lastChunkIdOfBatch(vectors: EmbedBatchResult["vectors"]): ChunkId | null {
  if (vectors.length === 0) return null;
  const last = vectors.at(-1);
  return last === undefined ? null : last.chunkId;
}

async function embedOneChunkBatch(
  state: RunState,
  documentId: DocumentId,
  batch: readonly ChunkToEmbed[],
): Promise<EmbedBatchResult> {
  return embedChunkBatch(batch, {
    adapter: state.options.embeddingAdapter,
    store: state.options.store,
    pinnedIdentity: state.capsule.embeddingModelIdentity,
    concurrency: state.concurrency,
    ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
    ...(state.options.embedRetry !== undefined ? { retry: state.options.embedRetry } : {}),
    now: state.now,
    idSource: state.idSource,
    tokenizer: state.tokenizer,
    // The batcher's lines are the ones an operator reads during a stall, and with concurrency 4
    // they interleave across documents — so they carry the same correlation context as the
    // orchestrator's own, down to the document.
    ...(state.options.logSink !== undefined
      ? { logSink: state.options.logSink, logContext: documentLogContext(state, documentId) }
      : {}),
  });
}

async function embedChunkBatches(
  state: RunState,
  documentId: DocumentId,
  batches: readonly (readonly ChunkToEmbed[])[],
): Promise<EmbedDocumentResult> {
  const errors: IndexingJobError[] = [];
  let vectorCount = 0;
  let lastChunkId: ChunkId | null = null;
  for (const batch of batches) {
    if (cancellationRequested(state)) break;
    const result = await embedOneChunkBatch(state, documentId, batch);
    vectorCount += result.vectors.length;
    errors.push(...result.errors);
    const batchLastChunkId = lastChunkIdOfBatch(result.vectors);
    if (batchLastChunkId !== null) lastChunkId = batchLastChunkId;
    // Identity-incompatibility is detected by the batcher — stop emitting further batches
    // for this document so the orchestrator can mark the whole job failed.
    if (result.errors.some((e) => e.code === "INCOMPATIBLE_EMBEDDING_IDENTITY")) {
      break;
    }
    if (cancellationRequested(state)) break;
  }
  recordCancellationIfRequested(state, errors);
  return { vectorCount, errors, lastChunkId };
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
  const chunks = await prepareChunksToEmbedSafely(state, documentId, sourceText);
  if (chunks === null) {
    return contextualRetrievalFailureResult();
  }
  replaceLexicalRowsForChunks(state, documentId, chunks);
  if (chunks.length === 0) {
    return { vectorCount: 0, errors: [], lastChunkId: null };
  }
  const batches = sliceIntoBatches(chunks, state.batchSize);
  // The flush plan for this document: how many chunks became how many batches at which cap. It
  // is the last line before the first outbound call, so a run that stalls in embedding stops
  // exactly here — with the count of work it was about to issue.
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.embedding-started",
    extra: { chunkCount: chunks.length, batchCount: batches.length, batchSize: state.batchSize },
  });
  return embedChunkBatches(state, documentId, batches);
}

// ─── Document handlers ────────────────────────────────────────────────────────
function handleExtractionSkipped(state: RunState, result: ExtractionResult): IndexingEvent {
  state.skippedDocuments += 1;
  const documentId =
    result.outcome.kind === "skipped" ? result.outcome.document.id : ("" as DocumentId);
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.skipped",
    extra: { reason: "unchanged", skippedDocuments: state.skippedDocuments },
  });
  return {
    kind: "document-skipped",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId: result.sourceId,
    documentId,
    reason: "unchanged",
  };
}

// GRD-010: transient IO failure codes that must NOT destroy a previously-good index on an
// incremental refresh. Mirrors the gate in discovery/extract.ts buildFailureResult.
const TRANSIENT_DISCOVERY_CODES: ReadonlySet<string> = new Set(["READ_FAILED", "STAT_FAILED"]);

// The extraction lane does NOT reach `appendDocumentFailure` (see the note there), so until this
// line existed a READ_FAILED, a STAT_FAILED, a PATH_ESCAPE or any parse failure produced a
// `DISCOVERY_FAILED:<code>` event for a consumer driving the iterator and nothing at all in the
// file an operator opens. `errorKind` carries the discovery code — the part that says WHY, and
// the part that decides the repair: an unreadable mount, an unstattable entry and a parser that
// rejected the bytes are three different problems. The message is never written; it quotes the
// path, or the fragment of content that failed to parse.
function logExtractionFailed(state: RunState, documentId: DocumentId, discoveryCode: string): void {
  logDocument(state, documentId, {
    level: "warn",
    op: "indexing.document.extraction-failed",
    errorKind: discoveryCode,
    extra: { failedDocuments: state.failedDocuments },
  });
}

// The GRD-010 downgrade, made visible. A transient re-read failure on a document whose previous
// chunks survived is reported to the consumer as `document-skipped` with reason "unchanged" —
// byte-identical to what a genuinely unchanged document produces. The flattening is deliberate
// (the retrievable content really did survive), but it hides that this document was NOT
// refreshed this run, which is exactly the state behind "the pod keeps answering from the old
// version of the file". At `warn`, with the discovery code that caused the downgrade.
function transientRereadSkip(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  discoveryCode: string,
  preservedChunkCount: number,
): IndexingEvent {
  state.skippedDocuments += 1;
  logDocument(state, documentId, {
    level: "warn",
    op: "indexing.document.skipped",
    errorKind: discoveryCode,
    extra: {
      reason: "transient-read-failure",
      preservedChunkCount,
      skippedDocuments: state.skippedDocuments,
    },
  });
  return {
    kind: "document-skipped",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId: result.sourceId,
    documentId,
    reason: "unchanged",
  };
}

function failExtractedDocument(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  discoveryCode: string,
  message: string,
): IndexingEvent {
  state.failedDocuments += 1;
  logExtractionFailed(state, documentId, discoveryCode);
  clearDocumentArtifacts(state, documentId, { deleteChunks: true });
  markDocumentFailed(state, documentId);
  const error: IndexingJobError = { code: `DISCOVERY_FAILED:${discoveryCode}`, message };
  state.lastError = error;
  return {
    kind: "document-failed",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId: result.sourceId,
    documentId,
    relativePath: result.relativePath,
    error,
  };
}

// The failed outcome is threaded in already narrowed, rather than re-tested here. The old shape
// re-derived it from `result.outcome` and carried an `else` branch for an outcome that the single
// call site's own guard makes unreachable — a branch no test could ever reach, and therefore a
// log line no test could ever pin.
type FailedExtractionOutcome = Extract<ExtractionOutcome, { readonly kind: "failed" }>;

function handleExtractionFailed(
  state: RunState,
  result: ExtractionResult,
  outcome: FailedExtractionOutcome,
): IndexingEvent {
  const documentId = outcome.document.id;
  const errCode = outcome.error.code;
  // GRD-010: a transient re-read failure on a document that still has a prior good index
  // (extract.ts preserved its chunks/vectors) is reported as a non-destructive skip, NOT a
  // failure — the retrievable content survives until a successful re-extraction. The chunk
  // count is only read for a transient code, exactly as before.
  const preservedChunks = TRANSIENT_DISCOVERY_CODES.has(errCode)
    ? countChunksForDocument(state.options.store._internal.db, state.capsule.id, documentId)
    : 0;
  if (preservedChunks > 0) {
    return transientRereadSkip(state, result, documentId, errCode, preservedChunks);
  }
  return failExtractedDocument(state, result, documentId, errCode, outcome.error.message);
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

interface EmbeddingCoverage {
  readonly chunkCount: number;
  readonly vectorCount: number;
}

function embeddingCoverage(state: RunState, documentId: DocumentId): EmbeddingCoverage {
  return {
    chunkCount: countChunksForDocument(
      state.options.store._internal.db,
      state.capsule.id,
      documentId,
    ),
    vectorCount: countVectorsForDocument(
      state.options.store._internal.db,
      state.capsule.id,
      documentId,
    ),
  };
}

function hasCompleteVectorCoverage(state: RunState, documentId: DocumentId): boolean {
  const coverage = embeddingCoverage(state, documentId);
  return coverage.chunkCount > 0 && coverage.vectorCount === coverage.chunkCount;
}

function persistedDocumentId(result: ExtractionResult): DocumentId {
  if (result.outcome.kind !== "persisted") {
    throw new IndexingError(
      "INVALID_OPTIONS",
      "chunkPersistedDocument called with non-persisted result",
    );
  }
  return result.outcome.document.id;
}

function chunkPersistedDocument(
  state: RunState,
  result: ExtractionResult,
): {
  readonly events: readonly IndexingEvent[];
  readonly documentId: DocumentId;
  readonly chunkCount: number;
} {
  const documentId = persistedDocumentId(result);
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
    chunkingOptionsForState(state),
  );
  const chunkCount = resolveChunkCount(
    state,
    documentId,
    chunkResult.skippedExisting,
    chunkResult.chunkIds,
  );
  return {
    events: chunkedDocumentEvents(
      state,
      result.sourceId,
      documentId,
      result.relativePath,
      chunkCount,
    ),
    documentId,
    chunkCount,
  };
}

function chunkedDocumentEvents(
  state: RunState,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  relativePath: string,
  chunkCount: number,
): readonly IndexingEvent[] {
  // The per-document half of the spine. `chunkCount` is the denominator of the "0 of 36 vectors"
  // the operator sees: with this line an operator can say the chunker produced 36 and embedding
  // never returned, which is a different bug from the chunker producing nothing. The relative
  // path is deliberately absent — it is a customer file name; the document digest identifies it.
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.extracted",
  });
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.chunked",
    extra: { chunkCount },
  });
  return [
    {
      kind: "document-extracted",
      jobId: state.jobId,
      capsuleId: state.capsule.id,
      sourceId,
      documentId,
      relativePath,
    },
    {
      kind: "document-chunked",
      jobId: state.jobId,
      capsuleId: state.capsule.id,
      sourceId,
      documentId,
      chunkCount,
    },
  ];
}

function sourceForResult(state: RunState, result: ExtractionResult): KnowledgeSource {
  // Sources are resolved once at job start (see buildInitialState) and cached on RunState.
  // The capsule lifecycleState gates concurrent mutation, so the map stays consistent for
  // the duration of the run — no per-document SELECT against capsule_sources.
  const match = state.sourcesById.get(String(result.sourceId));
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
function hasCompleteIndexedTextCoverage(state: RunState, documentId: DocumentId): boolean {
  return storedChunksToEmbed(state, documentId) !== undefined;
}

// When an already-embedded document is skipped, keep its lexical rows consistent with its chunk
// count. Extracted from applyIncrementalFastPath to keep it under the LOC bound.
function reconcileLexicalRowsForEmbeddedDocument(
  state: RunState,
  documentId: DocumentId,
  chunkCount: number,
): void {
  if (
    countLexicalRowsForDocument(state.options.store._internal.db, state.capsule.id, documentId) !==
    chunkCount
  ) {
    const stored = storedChunksToEmbed(state, documentId);
    if (stored !== undefined) {
      replaceLexicalRowsForChunks(state, documentId, stored);
    }
  }
}

function applyIncrementalFastPath(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
): PersistedHandling | undefined {
  const staleChunks = hasStaleChunksForDocument(
    state.options.store._internal.db,
    state.capsule.id,
    documentId,
    chunkingStrategyKey(chunkingOptionsForState(state)),
  );
  if (state.options.force !== true) {
    const coverage = embeddingCoverage(state, documentId);
    const indexedTextComplete = hasCompleteIndexedTextCoverage(state, documentId);
    if (
      coverage.chunkCount > 0 &&
      coverage.vectorCount === coverage.chunkCount &&
      !staleChunks &&
      indexedTextComplete
    ) {
      reconcileLexicalRowsForEmbeddedDocument(state, documentId, coverage.chunkCount);
      state.skippedDocuments += 1;
      return {
        events: [
          {
            kind: "document-skipped",
            jobId: state.jobId,
            capsuleId: state.capsule.id,
            sourceId: result.sourceId,
            documentId,
            reason: "already-embedded",
          },
        ],
      };
    }
    if (coverage.vectorCount > 0) {
      deleteVectorsForDocument(state.options.store._internal.db, state.capsule.id, documentId);
    }
    return undefined;
  }
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
    if (cancellationRequested(state)) {
      clearDocumentArtifacts(state, documentId, { deleteChunks: true });
      return { events: [] };
    }
    // Same class as the contextual lane above and the bounded lane below: the document error is
    // flattened to CHUNKING_FAILED, so the real cause exists nowhere else. One shared op name
    // across all three lanes, distinguished by `lane`, so an operator greps once.
    logDocument(state, documentId, {
      level: "warn",
      op: "indexing.chunking.failed",
      errorKind: knowledgeErrorKind(cause),
      extra: { lane: "standard-chunker" },
    });
    // Routed through the shared failure sink rather than a hand-built copy of it: this branch
    // used to duplicate the counter bump, the artifact cleanup, the status write and the event,
    // which is how it ended up as the one document failure with no `indexing.document.failed`
    // line. One owner, one shape, every lane.
    return appendDocumentFailure(
      state,
      [],
      result.sourceId,
      documentId,
      result.relativePath,
      { code: "CHUNKING_FAILED", message: "document chunking failed" },
      { deleteChunks: true },
    );
  }
}

function appendDocumentFailure(
  state: RunState,
  events: IndexingEvent[],
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  relativePath: string,
  error: IndexingJobError,
  options: { readonly deleteChunks: boolean },
): PersistedHandling {
  state.failedDocuments += 1;
  clearDocumentArtifacts(state, documentId, options);
  markDocumentFailed(state, documentId);
  state.lastError = error;
  // Every POST-EXTRACTION lane funnels through here — standard, bounded, identity gate and
  // chunker alike — so this is the single site that records their failures. It is NOT every
  // failing lane: a document that never got past discovery/extraction fails inside
  // `handleExtractionFailed`, which owns its own `indexing.document.extraction-failed` line for
  // exactly that reason. Claiming otherwise here is what left that lane silent through four
  // releases of field guesswork. The error CODE is written, never the message: a document
  // error's message can quote the content that failed to parse.
  logDocument(state, documentId, {
    level: "warn",
    op: "indexing.document.failed",
    errorKind: error.code,
    extra: {
      transient: error.transient === true,
      consecutiveTransientEmbedFailures: state.consecutiveTransientEmbedFailures,
    },
  });
  events.push({
    kind: "document-failed",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId,
    documentId,
    relativePath,
    error,
  });
  return { events };
}

function completeEmbeddedDocument(
  state: RunState,
  events: IndexingEvent[],
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  embedResult: EmbedDocumentResult,
): PersistedHandling {
  state.processedDocuments += 1;
  state.vectorsPersisted += embedResult.vectorCount;
  if (embedResult.lastChunkId !== null) state.lastResumeToken = embedResult.lastChunkId;
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.embedded",
    extra: {
      vectorCount: embedResult.vectorCount,
      vectorsPersistedSoFar: state.vectorsPersisted,
      processedDocuments: state.processedDocuments,
    },
  });
  events.push({
    kind: "document-embedded",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId,
    documentId,
    vectorCount: embedResult.vectorCount,
    resumeToken: embedResult.lastChunkId ?? (`${String(documentId)}#empty` as ChunkId),
  });
  return { events };
}

function isCancellationOnlyEmbedResult(state: RunState, embedResult: EmbedDocumentResult): boolean {
  return (
    cancellationRequested(state) &&
    embedResult.errors.length > 0 &&
    embedResult.errors.every((error) => error.code === "CANCELLED")
  );
}

// Gateway-outage evidence for the circuit breaker (2026-08 field review, adversarially
// re-verified): only a document that proves NOTHING answered may lengthen the streak. Any
// persisted vector and any DETERMINISTIC (answered) rejection prove the gateway is alive and
// reset it — a live-but-flaky gateway whose documents fail on one chunk out of dozens must
// never trip the outage abort. Zero-chunk documents contact no gateway and are no evidence
// either way; cancellations are the caller's own doing and are ignored. Both embed paths
// (standard flushes and bounded large documents) route through applyEmbedResult, so this is
// the single owning site.
function trackGatewayEvidence(state: RunState, embedResult: EmbedDocumentResult): void {
  const evidential = embedResult.errors.filter((error) => error.code !== "CANCELLED");
  if (evidential.length === 0) {
    if (embedResult.vectorCount > 0) state.consecutiveTransientEmbedFailures = 0;
    return;
  }
  const answered =
    embedResult.vectorCount > 0 || evidential.some((error) => error.transient !== true);
  if (answered) {
    state.consecutiveTransientEmbedFailures = 0;
    return;
  }
  state.consecutiveTransientEmbedFailures += 1;
}

// Maps an EmbedDocumentResult into PersistedHandling events, mutating run-state counters.
function applyEmbedResult(
  state: RunState,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  relativePath: string,
  priorEvents: readonly IndexingEvent[],
  embedResult: EmbedDocumentResult,
): PersistedHandling {
  const events: IndexingEvent[] = [...priorEvents];
  if (isCancellationOnlyEmbedResult(state, embedResult)) {
    return { events };
  }
  trackGatewayEvidence(state, embedResult);
  const identityErr = embedResult.errors.find((e) => e.code === "INCOMPATIBLE_EMBEDDING_IDENTITY");
  if (identityErr !== undefined) {
    return {
      ...appendDocumentFailure(state, events, sourceId, documentId, relativePath, identityErr, {
        deleteChunks: false,
      }),
      identityFailure: identityErr,
    };
  }
  if (embedResult.errors.length > 0) {
    const firstErr = embedResult.errors[0] ?? {
      code: "EMBEDDING_ADAPTER_FAILED",
      message: "embedding adapter failed",
    };
    return appendDocumentFailure(state, events, sourceId, documentId, relativePath, firstErr, {
      deleteChunks: false,
    });
  }
  return completeEmbeddedDocument(state, events, sourceId, documentId, embedResult);
}

function* persistedEvents(handling: PersistedHandling): Generator<IndexingEvent> {
  for (const event of handling.events) {
    yield event;
  }
}

// ─── Bounded large-document chunk + embed + resume (Epic #1160, Issue #1286) ─────
function boundedCurrentFingerprint(
  state: RunState,
  checkpoint: ExtractionCheckpointRecord,
): CheckpointFingerprint {
  const policy = boundedPolicy(state);
  return {
    ...checkpoint.fingerprint,
    policyFingerprint: largeDocumentPolicyFingerprint(policy),
    chunkingStrategyVersion: chunkingStrategyKey(chunkingOptionsForState(state)),
    embeddingIdentity: state.capsule.embeddingModelIdentity,
  };
}

function boundedPolicy(state: RunState): typeof DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY {
  return state.options.largeDocumentPolicy ?? DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY;
}

interface WriteBoundedCheckpointInput {
  readonly state: RunState;
  readonly checkpoint: ExtractionCheckpointRecord;
  readonly fingerprint: CheckpointFingerprint;
  readonly phase: ExtractionCheckpointRecord["phase"];
  readonly chunkCursor: number;
  readonly embeddedChunkCursor: number;
  readonly lastEmbeddedChunkId: ChunkId | null;
  readonly terminalDiagnostics?: ExtractionCheckpointRecord["terminalDiagnostics"];
}

function writeBoundedCheckpoint(input: WriteBoundedCheckpointInput): void {
  const {
    state,
    checkpoint,
    fingerprint,
    phase,
    chunkCursor,
    embeddedChunkCursor,
    lastEmbeddedChunkId,
    terminalDiagnostics = checkpoint.terminalDiagnostics,
  } = input;
  upsertExtractionCheckpoint(state.options.store._internal.db, {
    capsuleId: checkpoint.capsuleId,
    documentId: checkpoint.documentId,
    jobId: state.jobId,
    strategy: checkpoint.strategy,
    phase,
    pageCursor: checkpoint.pageCursor,
    sectionCursor: checkpoint.sectionCursor,
    objectCursor: checkpoint.objectCursor,
    extractedTextBytes: checkpoint.extractedTextBytes,
    chunkCursor,
    embeddedChunkCursor,
    ...(lastEmbeddedChunkId !== null ? { lastEmbeddedChunkId } : {}),
    retryCount: checkpoint.retryCount,
    coverage: checkpoint.coverage,
    fingerprint,
    terminalDiagnostics,
    createdAt: checkpoint.createdAt,
    updatedAt: state.now(),
  });
}

function persistCheckpointIncompatibleDiagnostic(
  state: RunState,
  documentId: DocumentId,
  reasons: readonly string[],
): void {
  insertDiagnosticRow(state.options.store._internal.db, {
    id: `${String(documentId)}#checkpoint-incompatible`,
    capsuleId: state.capsule.id,
    diagnostic: {
      severity: "warning",
      code: LARGE_DOCUMENT_DIAGNOSTIC_CODES.CHECKPOINT_INCOMPATIBLE,
      message: `resume refused and restarted; changed: ${reasons.join(", ")}`,
      documentId,
    },
    createdAt: state.now(),
  });
}

function boundedNeedsRechunk(
  state: RunState,
  documentId: DocumentId,
  fingerprint: CheckpointFingerprint,
  incompatible: boolean,
): boolean {
  const db = state.options.store._internal.db;
  return (
    incompatible ||
    state.options.force === true ||
    countChunksForDocument(db, state.capsule.id, documentId) === 0 ||
    hasStaleChunksForDocument(db, state.capsule.id, documentId, fingerprint.chunkingStrategyVersion)
  );
}

function boundedEmbedDeps(
  state: RunState,
  documentId: DocumentId,
  fingerprint: CheckpointFingerprint,
  checkpoint: ExtractionCheckpointRecord,
  chunkCount: number,
): Parameters<typeof embedDocumentChunksBounded>[0] {
  return {
    store: state.options.store,
    capsuleId: state.capsule.id,
    documentId,
    adapter: state.options.embeddingAdapter,
    identity: state.capsule.embeddingModelIdentity,
    batchSize: state.batchSize,
    concurrency: state.concurrency,
    now: state.now,
    idSource: state.idSource,
    tokenizer: state.tokenizer,
    policy: boundedPolicy(state),
    ...(state.options.contextualRetrieval !== undefined
      ? { contextualRetrieval: state.options.contextualRetrieval }
      : {}),
    ...(state.options.embedRetry !== undefined ? { retry: state.options.embedRetry } : {}),
    ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
    onBatch: (cursor, lastId): void => {
      writeBoundedCheckpoint({
        state,
        checkpoint,
        fingerprint,
        phase: "embedding",
        chunkCursor: chunkCount,
        embeddedChunkCursor: cursor,
        lastEmbeddedChunkId: lastId,
      });
    },
  };
}

// Bounded path for a progressively-extracted document: resumes a compatible checkpoint, restarts an
// incompatible one with a CHECKPOINT_INCOMPATIBLE diagnostic, chunks + embeds through SUBSTR-backed
// readers, and advances the durable checkpoint between batches.
// Reconciles existing chunks/vectors against the current fingerprint: refuses an incompatible
// checkpoint (diagnostic + delete vectors) and re-chunks when stale/forced/missing. Returns the
// chunk count.
function prepareBoundedChunks(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  checkpoint: ExtractionCheckpointRecord,
  fingerprint: CheckpointFingerprint,
): number {
  const db = state.options.store._internal.db;
  const compat = checkpointCompatibility(checkpoint.fingerprint, fingerprint);
  if (!compat.compatible) {
    persistCheckpointIncompatibleDiagnostic(state, documentId, compat.reasons);
    deleteVectorsForDocument(db, state.capsule.id, documentId);
  }
  if (boundedNeedsRechunk(state, documentId, fingerprint, !compat.compatible)) {
    chunkDocumentBounded(
      state.options.store,
      { capsuleId: state.capsule.id, sourceId: result.sourceId, documentId },
      chunkingOptionsForState(state),
      state.options.signal,
      boundedPolicy(state),
    );
    deleteVectorsForDocument(db, state.capsule.id, documentId);
  }
  return countChunksForDocument(db, state.capsule.id, documentId);
}

// The bounded large-document lane had the same hole the standard lane did: every non-policy cause
// is relabelled `CHUNKING_FAILED` with a fixed message, so an out-of-memory page window, a corrupt
// checkpoint and a real chunker defect are indistinguishable downstream. It gets the identical
// line, under the identical op name, tagged with its lane — including the cancellation branch,
// which otherwise returns zero events and leaves an operator with a document that simply stopped
// existing in the run.
function logBoundedChunkFailure(state: RunState, documentId: DocumentId, cause: unknown): void {
  logDocument(state, documentId, {
    level: "warn",
    op: "indexing.chunking.failed",
    errorKind: knowledgeErrorKind(cause),
    extra: {
      lane: "bounded",
      cancelled: cause instanceof BoundedIndexingCancelledError || cancellationRequested(state),
      policyRejection: cause instanceof BoundedIndexingPolicyError,
    },
  });
}

function boundedChunkPreparationFailure(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  checkpoint: ExtractionCheckpointRecord,
  fingerprint: CheckpointFingerprint,
  cause: unknown,
): PersistedHandling {
  const db = state.options.store._internal.db;
  logBoundedChunkFailure(state, documentId, cause);
  if (cause instanceof BoundedIndexingCancelledError || cancellationRequested(state)) {
    updateDocumentStatusRow(db, state.capsule.id, documentId, "pending");
    writeBoundedCheckpoint({
      state,
      checkpoint,
      fingerprint,
      phase: "cancelled",
      chunkCursor: countChunksForDocument(db, state.capsule.id, documentId),
      embeddedChunkCursor: countVectorsForDocument(db, state.capsule.id, documentId),
      lastEmbeddedChunkId: null,
    });
    return { events: [] };
  }
  const error =
    cause instanceof BoundedIndexingPolicyError
      ? cause.toIndexingError()
      : ({ code: "CHUNKING_FAILED", message: "document chunking failed" } as IndexingJobError);
  writeBoundedCheckpoint({
    state,
    checkpoint,
    fingerprint,
    phase: "failed",
    chunkCursor: countChunksForDocument(db, state.capsule.id, documentId),
    embeddedChunkCursor: countVectorsForDocument(db, state.capsule.id, documentId),
    lastEmbeddedChunkId: null,
    terminalDiagnostics: [
      { severity: "error", code: error.code, message: error.message, documentId },
    ],
  });
  return appendDocumentFailure(state, [], result.sourceId, documentId, result.relativePath, error, {
    deleteChunks: true,
  });
}

function prepareBoundedChunksSafely(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  checkpoint: ExtractionCheckpointRecord,
  fingerprint: CheckpointFingerprint,
): { readonly chunkCount: number } | PersistedHandling {
  try {
    return { chunkCount: prepareBoundedChunks(state, result, documentId, checkpoint, fingerprint) };
  } catch (cause) {
    return boundedChunkPreparationFailure(
      state,
      result,
      documentId,
      checkpoint,
      fingerprint,
      cause,
    );
  }
}

function persistBoundedEmbedCheckpoint(
  state: RunState,
  checkpoint: ExtractionCheckpointRecord,
  fingerprint: CheckpointFingerprint,
  documentId: DocumentId,
  chunkCount: number,
  embedResult: Awaited<ReturnType<typeof embedDocumentChunksBounded>>,
): void {
  writeBoundedCheckpoint({
    state,
    checkpoint,
    fingerprint,
    phase: embedResult.errors.length === 0 ? "complete" : "failed",
    chunkCursor: chunkCount,
    embeddedChunkCursor: embedResult.embeddedCursor,
    lastEmbeddedChunkId: embedResult.lastChunkId,
    terminalDiagnostics: embedResult.errors.map((error) => ({
      severity: "error",
      code: error.code,
      message: error.message,
      documentId,
    })),
  });
}

function persistBoundedEmbedCancellation(
  state: RunState,
  checkpoint: ExtractionCheckpointRecord,
  fingerprint: CheckpointFingerprint,
  documentId: DocumentId,
  chunkCount: number,
  embedResult: Awaited<ReturnType<typeof embedDocumentChunksBounded>>,
): void {
  updateDocumentStatusRow(
    state.options.store._internal.db,
    state.capsule.id,
    documentId,
    "pending",
  );
  writeBoundedCheckpoint({
    state,
    checkpoint,
    fingerprint,
    phase: "cancelled",
    chunkCursor: chunkCount,
    embeddedChunkCursor: embedResult.embeddedCursor,
    lastEmbeddedChunkId: embedResult.lastChunkId,
    terminalDiagnostics: embedResult.errors.map((error) => ({
      severity: "info",
      code: error.code,
      message: error.message,
      documentId,
    })),
  });
}

async function persistBoundedEmbeddingResult(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  checkpoint: ExtractionCheckpointRecord,
  fingerprint: CheckpointFingerprint,
  chunkCount: number,
): Promise<PersistedHandling | undefined> {
  // The bounded embed self-resumes from chunks that have no vector yet.
  const embedResult = await embedDocumentChunksBounded(
    boundedEmbedDeps(state, documentId, fingerprint, checkpoint, chunkCount),
  );
  if (embedResult.cancelled) {
    persistBoundedEmbedCancellation(
      state,
      checkpoint,
      fingerprint,
      documentId,
      chunkCount,
      embedResult,
    );
    return undefined;
  }
  persistBoundedEmbedCheckpoint(
    state,
    checkpoint,
    fingerprint,
    documentId,
    chunkCount,
    embedResult,
  );
  return applyEmbedResult(state, result.sourceId, documentId, result.relativePath, [], {
    vectorCount: embedResult.vectorCount,
    errors: embedResult.errors,
    lastChunkId: embedResult.lastChunkId,
  });
}

async function* handleBoundedDocument(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
  checkpoint: ExtractionCheckpointRecord,
): AsyncGenerator<IndexingEvent> {
  const db = state.options.store._internal.db;
  const sourceId = result.sourceId;
  const fingerprint = boundedCurrentFingerprint(state, checkpoint);
  const prepared = prepareBoundedChunksSafely(state, result, documentId, checkpoint, fingerprint);
  if (!("chunkCount" in prepared)) {
    yield* persistedEvents(prepared);
    return;
  }
  const { chunkCount } = prepared;
  yield* chunkedDocumentEvents(state, sourceId, documentId, result.relativePath, chunkCount);
  persistJobProgress(state);
  const alreadyEmbedded = countVectorsForDocument(db, state.capsule.id, documentId);
  writeBoundedCheckpoint({
    state,
    checkpoint,
    fingerprint,
    phase: "embedding",
    chunkCursor: chunkCount,
    embeddedChunkCursor: alreadyEmbedded,
    lastEmbeddedChunkId: null,
  });
  const embedded = await persistBoundedEmbeddingResult(
    state,
    result,
    documentId,
    checkpoint,
    fingerprint,
    chunkCount,
  );
  if (embedded !== undefined) yield* persistedEvents(embedded);
}

// Wraps the chunk-then-embed pipeline for a single persisted document. Extraction/chunking
// events are yielded before awaiting embeddings, so progress consumers see pre-model work
// immediately instead of only after all embedding batches finish.
function* handleUnsupportedDocument(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
): Generator<IndexingEvent> {
  clearDocumentArtifacts(state, documentId, { deleteChunks: true });
  state.skippedDocuments += 1;
  // This pair — extracted, then immediately skipped — is a whole document that will never
  // produce a vector, and it wrote nothing. An operator reading "0 of 1 documents" against a
  // scanned PDF or an image saw a run that looked identical to one wedged in the gateway. The
  // `extracted` line keeps this lane countable next to the chunked lane's own; `documentStatus`
  // is the closed enum the extractor assigned, never a file name.
  logDocument(state, documentId, { level: "info", op: "indexing.document.extracted" });
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.skipped",
    extra: {
      reason: "unsupported",
      documentStatus: result.outcome.document.status,
      skippedDocuments: state.skippedDocuments,
    },
  });
  yield {
    kind: "document-extracted",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId: result.sourceId,
    documentId,
    relativePath: result.relativePath,
  };
  yield {
    kind: "document-skipped",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId: result.sourceId,
    documentId,
    reason: "unsupported",
  };
}

// Extracted from handlePersistedDocument to stay under the per-function line limit: runs the
// embed step for a freshly-chunked document and finalizes it (embed-then-swap failure handling +
// event emission).
async function* embedAndFinalizeChunkedDocument(
  state: RunState,
  result: ExtractionResult,
  documentId: DocumentId,
): AsyncGenerator<IndexingEvent> {
  const embedResult = await embedDocumentChunks(
    state,
    documentId,
    sourceForResult(state, result),
    result.relativePath,
  );
  const handling = applyEmbedResult(
    state,
    result.sourceId,
    documentId,
    result.relativePath,
    [],
    embedResult,
  );
  restoreSnapshotOnFailure(state, documentId, handling.events);
  yield* persistedEvents(handling);
}

async function* handlePersistedDocument(
  state: RunState,
  result: ExtractionResult,
): AsyncGenerator<IndexingEvent> {
  const documentId = result.outcome.kind === "persisted" ? result.outcome.document.id : null;
  if (documentId === null) return;
  if (
    result.outcome.document.status === "unsupported" ||
    result.outcome.document.status === "extracted-image"
  ) {
    yield* handleUnsupportedDocument(state, result, documentId);
    return;
  }

  // Progressive checkpoints take the page-windowed bounded chunk/embed pass. Standard checkpoints
  // are content-free extraction metadata only; ordinary documents still use the normal chunker.
  const checkpoint = selectExtractionCheckpoint(
    state.options.store._internal.db,
    state.capsule.id,
    documentId,
  );
  if (checkpoint?.strategy === "progressive-pdf") {
    yield* handleBoundedDocument(state, result, documentId, checkpoint);
    return;
  }

  const fastPath = applyIncrementalFastPath(state, result, documentId);
  if (fastPath !== undefined) {
    yield* persistedEvents(fastPath);
    return;
  }

  const chunkStep = tryChunkDocument(state, result, documentId);
  if (!("chunked" in chunkStep)) {
    restoreSnapshotOnFailure(state, documentId, chunkStep.events);
    yield* persistedEvents(chunkStep);
    return;
  }

  yield* chunkStep.chunked.events;
  persistJobProgress(state);
  if (restoreSnapshotOnCancellation(state, documentId)) return;
  yield* embedAndFinalizeChunkedDocument(state, result, documentId);
}

function* handleExtractionSkippedEvents(
  state: RunState,
  result: ExtractionResult,
): Generator<IndexingEvent> {
  yield handleExtractionSkipped(state, result);
}

function* handleExtractionFailedEvents(
  state: RunState,
  result: ExtractionResult,
  outcome: FailedExtractionOutcome,
): Generator<IndexingEvent> {
  yield handleExtractionFailed(state, result, outcome);
}

// Routes a file-extracted event: force-skipped docs are re-shaped to persisted so the
// standard chunk-and-embed pipeline runs on them.
async function* handleFileExtracted(
  state: RunState,
  result: ExtractionResult,
): AsyncGenerator<IndexingEvent> {
  if (result.outcome.kind === "skipped") {
    // In force mode, an "unchanged" document still needs chunk-and-embed because the
    // caller explicitly requested a fresh embedding pass. Re-shape the skipped outcome as
    // a persisted outcome (the document row exists and is valid) so the standard pipeline
    // runs. Outside force/recovery mode, surface the skip as-is.
    const staleChunks = hasStaleChunksForDocument(
      state.options.store._internal.db,
      state.capsule.id,
      result.outcome.document.id,
      chunkingStrategyKey(chunkingOptionsForState(state)),
    );
    const missingVectors =
      result.outcome.document.status === "extracted" &&
      !hasCompleteVectorCoverage(state, result.outcome.document.id);
    if (state.options.force === true || staleChunks || missingVectors) {
      const synthetic: ExtractionResult = {
        capsuleId: result.capsuleId,
        sourceId: result.sourceId,
        relativePath: result.relativePath,
        outcome: { kind: "persisted", document: result.outcome.document },
        diagnostics: result.diagnostics,
      };
      yield* handlePersistedDocument(state, synthetic);
      return;
    }
    yield* handleExtractionSkippedEvents(state, result);
    return;
  }
  if (result.outcome.kind === "failed") {
    yield* handleExtractionFailedEvents(state, result, result.outcome);
    return;
  }
  yield* handlePersistedDocument(state, result);
}

async function* handleDiscoveryEvent(
  state: RunState,
  source: KnowledgeSource,
  evt: ExtractionEvent,
): AsyncGenerator<IndexingEvent> {
  if (evt.kind === "file-discovered") {
    state.totalDocuments += 1;
    const documentId = documentIdFor({
      capsuleId: state.capsule.id,
      sourceId: source.id,
      relativePath: evt.relativePath,
    });
    captureRestoreSnapshotIfEligible(state, documentId);
    logDocumentExtractionStarted(state, documentId, evt.sizeBytes);
    yield {
      kind: "document-discovered",
      jobId: state.jobId,
      capsuleId: state.capsule.id,
      sourceId: source.id,
      relativePath: evt.relativePath,
      sizeBytes: evt.sizeBytes,
    };
    return;
  }
  if (evt.kind === "scope-error") {
    yield scopeErrorEvent(state, source, evt.error);
    return;
  }
  if (evt.kind === "cancelled" || evt.kind === "completed") {
    // No-op at this level: the outer loop drives terminal events.
    return;
  }
  // evt.kind === "file-extracted"
  yield* handleFileExtracted(state, evt.result);
  // Safety-net cleanup: `handlePersistedDocument`'s own success/failure branches already clear
  // the snapshot it owns, but the "genuinely unchanged" and "extraction failed" outcomes never
  // reach that function — discard is a no-op if it already ran.
  discardRestoreSnapshot(state, evt.result.outcome.document.id);
}

// The discovery lane's progress tick AND the extraction-start marker, deliberately one line.
// `discoverAndExtract` yields `file-discovered` and only THEN awaits that file's extraction, so
// the instant this runs is both "the walk found another file" and "extraction of that file is
// about to begin" — two lines here would carry the same timestamp and the same facts.
//
// It closes both halves of the field incident's silent middle. Between
// `indexing.source.started` and `indexing.source.completed` a slow walk now advances a visible
// counter instead of showing nothing, and a document that hangs mid-extraction leaves this line
// with no `indexing.document.extracted` partner — which is what separates "the walk never
// reached it" from "extraction started and never returned".
//
// `discoveredCount` is the running job-wide total: the "1" in "0 of 1 documents". The relative
// path is a customer file name and is never written — the document digest carries identity, and
// it is the same digest every later line for this document uses, so one grep follows the
// document from here to its terminal line.
function logDocumentExtractionStarted(
  state: RunState,
  documentId: DocumentId,
  sizeBytes: number,
): void {
  logDocument(state, documentId, {
    level: "info",
    op: "indexing.document.extraction-started",
    extra: { discoveredCount: state.totalDocuments, sizeBytes },
  });
}

// Every walk-level rejection an operator can act on: a PATH_ESCAPE containment refusal, an
// unreadable or unstattable directory, an invalid scope, and the LIMIT_REACHED truncation
// frames. Each of them bumped two counters and produced a `document-failed` event that only a
// consumer driving the iterator ever saw. `errorKind` is the discovery code; the message is
// never written because a walk error's message quotes the path that produced it. Note that a
// deny-list match is dropped inside the walk without an error at all and cannot reach here.
function logDiscoveryScopeError(state: RunState, error: DiscoveryError): void {
  logIndexing(state, {
    level: "warn",
    op: "indexing.discovery.scope-error",
    errorKind: error.code,
    extra: {
      scopedToFile: error.relativePath !== undefined,
      discoveryFailedDocuments: state.discoveryFailedDocuments,
    },
  });
}

// Returns the event rather than yielding it, so the caller keeps its `yield` direct. Delegating
// with `yield*` from an async generator to a sync one routes every value through
// AsyncFromSyncIterator and inserts extra microtask ticks between producing this event and the
// cancellation re-check that follows it — a timing change this instrumentation must not make.
function scopeErrorEvent(
  state: RunState,
  source: KnowledgeSource,
  error: DiscoveryError,
): IndexingEvent {
  state.failedDocuments += 1;
  state.discoveryFailedDocuments += 1;
  logDiscoveryScopeError(state, error);
  if (error.code === "LIMIT_REACHED") {
    persistDiscoveryLimitWarning(state);
  }
  const err: IndexingJobError = {
    code: `DISCOVERY_FAILED:${error.code}`,
    message: error.message,
  };
  state.lastError = err;
  return {
    kind: "document-failed",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceId: source.id,
    ...(error.relativePath !== undefined ? { relativePath: error.relativePath } : {}),
    error: err,
  };
}

function shouldStopAfterEvent(event: IndexingEvent): boolean {
  return event.kind === "document-failed" && event.error.code === "INCOMPATIBLE_EMBEDDING_IDENTITY";
}

async function* streamDiscoveryEvent(
  state: RunState,
  source: KnowledgeSource,
  evt: ExtractionEvent,
): AsyncGenerator<IndexingEvent, boolean> {
  for await (const event of handleDiscoveryEvent(state, source, evt)) {
    persistJobProgress(state);
    yield event;
    if (shouldStopAfterEvent(event)) {
      return true;
    }
  }
  return false;
}

// ─── Per-source pipeline ──────────────────────────────────────────────────────
function discoveryStreamFor(
  state: RunState,
  source: KnowledgeSource,
): ReturnType<typeof discoverAndExtract> {
  return discoverAndExtract(
    {
      fs: state.options.workspaceFs,
      store: state.options.store,
      parserRegistry: state.options.parserRegistry,
      ...(state.options.largeDocumentPolicy !== undefined
        ? { largeDocumentPolicy: state.options.largeDocumentPolicy }
        : {}),
      ...(state.options.progressiveExtractors !== undefined
        ? { progressiveExtractors: state.options.progressiveExtractors }
        : {}),
      ...(state.options.extractionCapabilities !== undefined
        ? { extractionCapabilities: state.options.extractionCapabilities }
        : {}),
      largeDocumentJobId: state.jobId,
      chunkingStrategyVersion: chunkingStrategyKey(chunkingOptionsForState(state)),
    },
    sourceDiscoveryParams(state, source),
  );
}

// Paired with `indexing.source.completed`. A walk that never returns — an unreachable network
// mount, a directory tree that does not terminate — leaves this line with no partner, which is
// the ONLY evidence that a run stalled in discovery rather than in embedding. The source id is
// digested for the same reason the capsule id is: it is caller-supplied.
function logSourceStarted(state: RunState, source: KnowledgeSource, sourceDigest: string): void {
  logIndexing(state, {
    level: "info",
    op: "indexing.source.started",
    extra: { sourceIdDigest: sourceDigest, scopeKind: source.scope.kind },
  });
}

// The discovered count is the number the field incident's operator was staring at ("0 of 1
// documents"): it is what the walk actually found, as opposed to what got indexed.
function logSourceCompleted(
  state: RunState,
  progress: SourceRunProgress,
  counts: {
    readonly sourceDigest: string;
    readonly failedCount: number;
    readonly durationMs: number;
  },
): void {
  logIndexing(state, {
    level: "info",
    op: "indexing.source.completed",
    durationMs: counts.durationMs,
    extra: {
      sourceIdDigest: counts.sourceDigest,
      discoveredCount: progress.discoveredPaths.size,
      failedCount: counts.failedCount,
      walkCompleted: progress.completed,
      cancelled: progress.cancelled,
      sawScopeError: progress.sawScopeError,
    },
  });
}

async function* runOneSource(
  state: RunState,
  source: KnowledgeSource,
): AsyncGenerator<IndexingEvent> {
  const stream = discoveryStreamFor(state, source);
  const progress: SourceRunProgress = {
    cancelled: false,
    sawScopeError: false,
    completed: false,
    discoveredPaths: new Set<string>(),
  };
  const sourceDigest = logDigest(String(source.id));
  const sourceElapsed = startKnowledgeLogTimer();
  logSourceStarted(state, source, sourceDigest);
  // Snapshot the job-wide failure counter before this source's documents are processed so
  // finalizeSourceRun can tell whether ANY document belonging to THIS source failed during this
  // run, without conflating it with failures from other sources in the same multi-source job.
  const failedDocumentsBefore = state.failedDocuments;
  for await (const evt of stream) {
    observeSourceEvent(progress, evt);
    if (cancellationRequested(state)) {
      progress.cancelled = true;
      break;
    }
    const shouldStop = yield* streamDiscoveryEvent(state, source, evt);
    if (shouldStop) {
      return;
    }
    // After yielding a batch we re-check the signal — the consumer's awaiting iterator
    // may have aborted between events.
    if (cancellationRequested(state)) {
      progress.cancelled = true;
      break;
    }
  }
  const failedCount = state.failedDocuments - failedDocumentsBefore;
  logSourceCompleted(state, progress, {
    sourceDigest,
    failedCount,
    durationMs: sourceElapsed(),
  });
  finalizeSourceRun(state, source, progress, failedCount);
}

interface SourceRunProgress {
  cancelled: boolean;
  sawScopeError: boolean;
  completed: boolean;
  readonly discoveredPaths: Set<string>;
}

function sourceDiscoveryParams(
  state: RunState,
  source: KnowledgeSource,
): Parameters<typeof discoverAndExtract>[1] {
  return {
    capsuleId: state.capsule.id,
    source,
    discovery: resolvedDiscoveryOptions(state),
  };
}

function observeSourceEvent(progress: SourceRunProgress, evt: ExtractionEvent): void {
  if (evt.kind === "file-discovered") {
    progress.discoveredPaths.add(evt.relativePath);
    return;
  }
  if (evt.kind === "scope-error") {
    progress.sawScopeError = true;
    return;
  }
  if (evt.kind === "cancelled") {
    progress.cancelled = true;
    return;
  }
  if (evt.kind === "completed") {
    progress.completed = true;
  }
}

function pruneDeletedSourceDocuments(
  state: RunState,
  source: KnowledgeSource,
  discoveredPaths: ReadonlySet<string>,
): void {
  const persisted = listPersistedDocumentsForSource(
    state.options.store._internal.db,
    state.capsule.id,
    source.id,
  );
  for (const document of persisted) {
    if (discoveredPaths.has(document.document_path)) continue;
    deleteDocumentRow(state.options.store._internal.db, state.capsule.id, document.id);
  }
}

function finalizeSourceRun(
  state: RunState,
  source: KnowledgeSource,
  progress: SourceRunProgress,
  failedDocumentsThisSource: number,
): void {
  // An incremental connector re-sync (#2243) mounts only re-fetched items: undiscovered
  // documents are deliberately alive and removal is owned by the caller's enumeration diff.
  if (state.options.retainUndiscoveredDocuments === true) return;
  if (progress.cancelled) return;
  if (!progress.completed || progress.sawScopeError) return;
  if (progress.discoveredPaths.size >= resolvedDiscoveryOptions(state).maxFiles) return;
  // A document belonging to this source failed to (re-)extract/chunk/embed during this run: the
  // discovered-path set this run observed is not a trustworthy full picture of the source's current
  // pages, so pruning "not discovered this run" documents here could delete a document whose page
  // is still live but simply failed to process — mirrors the maxFiles guard above, which already
  // refuses to prune on an incomplete/uncertain discovered-path set for the same reason.
  if (failedDocumentsThisSource > 0) return;
  pruneDeletedSourceDocuments(state, source, progress.discoveredPaths);
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
  sources: readonly KnowledgeSource[],
  jobId: string,
  startedAt: number,
  tokenizer: LocalKnowledgeTokenizer,
): RunState {
  const sourcesById = new Map<string, KnowledgeSource>();
  for (const source of sources) sourcesById.set(String(source.id), source);
  return {
    jobId,
    capsule,
    options,
    logContext: { jobId, capsuleIdDigest: logDigest(String(capsule.id)) },
    elapsed: startKnowledgeLogTimer(),
    batchSize: clampBatchSize(options.batchSize),
    concurrency: clampConcurrency(options.concurrency),
    now: options.now ?? options.store._internal.now,
    idSource: options.idSource ?? ((): string => randomUUID()),
    tokenizer,
    startedAt,
    sourcesById,
    totalDocuments: 0,
    processedDocuments: 0,
    failedDocuments: 0,
    skippedDocuments: 0,
    vectorsPersisted: 0,
    lastResumeToken: null,
    restoreSnapshots: new Map(),
    consecutiveTransientEmbedFailures: 0,
    discoveryLimitWarningPersisted: false,
    discoveryFailedDocuments: 0,
  };
}

function buildResult(
  state: RunState,
  status: IndexingResult["status"],
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

function embeddingPreflightOptions(state: RunState): EmbeddingProbeOptions {
  const identity = state.capsule.embeddingModelIdentity;
  const provisional = hasProvisionalIdentity(state);
  return {
    modelId: identity.modelId,
    provider: identity.provider,
    vectorMetric: identity.vectorMetric,
    ...(!provisional ? { expectedDimensions: identity.vectorDimensions } : {}),
    ...(identity.dimensionsParam !== undefined
      ? { dimensionsParam: identity.dimensionsParam }
      : {}),
    ...(identity.normalization !== undefined ? { normalization: identity.normalization } : {}),
    ...(identity.instructionVersion !== undefined
      ? { instructionVersion: identity.instructionVersion }
      : {}),
    includeSpaceFingerprint: provisional || identity.embeddingSpaceFingerprint !== undefined,
    ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
  };
}

// An identity is provisional while it has never been verified against the live gateway (no
// embedding-space fingerprint) AND the capsule owns no vectors an adopted identity could
// invalidate. Lifecycle state is deliberately not consulted: `"draft"` alone was not enough
// (a failed FIRST run moves the capsule to "error" while the identity still holds the
// creation-time dimension guess, wedging it on INCOMPATIBLE_EMBEDDING_IDENTITY forever), and
// conversely a draft shortcut must never bypass the vector guard — the moment vectors exist,
// adopting a changed identity would silently mix embedding spaces, whatever the lifecycle says.
function hasProvisionalIdentity(state: RunState): boolean {
  const identity = state.capsule.embeddingModelIdentity;
  if (identity.embeddingSpaceFingerprint !== undefined) return false;
  return countVectorsForCapsule(state.options.store._internal.db, state.capsule.id) === 0;
}

interface EmbeddingPreflightCacheEntry {
  readonly result: Extract<EmbeddingCapabilityCheck, { readonly ok: true }>;
  readonly expiresAt: number;
}

const EMBEDDING_PREFLIGHT_CACHES = new WeakMap<object, Map<string, EmbeddingPreflightCacheEntry>>();
const EMBEDDING_PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const EMBEDDING_PREFLIGHT_CACHE_MAX = 64;

function embeddingPreflightCacheKey(options: EmbeddingProbeOptions): string {
  return [
    options.provider,
    options.modelId,
    options.vectorMetric,
    options.expectedDimensions ?? "any",
    options.dimensionsParam ?? "",
    options.normalization ?? "",
    options.instructionVersion ?? "",
    options.includeSpaceFingerprint === true ? "fingerprinted" : "structural",
  ].join("\u0000");
}

function embeddingPreflightCacheFor(cacheScope: object): Map<string, EmbeddingPreflightCacheEntry> {
  const existing = EMBEDDING_PREFLIGHT_CACHES.get(cacheScope);
  if (existing !== undefined) return existing;
  const created = new Map<string, EmbeddingPreflightCacheEntry>();
  EMBEDDING_PREFLIGHT_CACHES.set(cacheScope, created);
  return created;
}

function cacheSuccessfulEmbeddingPreflight(
  cache: Map<string, EmbeddingPreflightCacheEntry>,
  options: EmbeddingProbeOptions,
  result: Extract<EmbeddingCapabilityCheck, { readonly ok: true }>,
  expiresAt: number,
): void {
  const keys = new Set([embeddingPreflightCacheKey(options)]);
  if (options.expectedDimensions === undefined) {
    keys.add(
      embeddingPreflightCacheKey({
        ...options,
        expectedDimensions: result.identity.vectorDimensions,
      }),
    );
  }
  if (cache.size + keys.size > EMBEDDING_PREFLIGHT_CACHE_MAX) cache.clear();
  for (const key of keys) cache.set(key, { result, expiresAt });
}

// ─── Preflight instrumentation ────────────────────────────────────────────────
// The capability preflight is the FIRST outbound call of every run and, until now, the only
// step of it that could take six minutes while emitting nothing at all: it runs before the first
// `document-discovered` event, so a run wedged here shows an operator a started job and no
// progress whatsoever — precisely the field incident's shape. Three facts have to be on the
// record: that a probe was attempted, whether it was answered from the cache instead (a cached
// preflight makes NO outbound call, so its absence from the file is not evidence of a hang), and
// how it ended with how long it took.
//
// The log arrives as a callback rather than the RunState because the preflight cache is
// deliberately shared across runs and must not gain a dependency on any one of them.
type PreflightLog = (event: Omit<KnowledgeLogEvent, "category" | "correlationId">) => void;

// Provider and model id are gateway configuration, not customer data, and they are the pair that
// makes a preflight failure actionable. The endpoint is reduced to `scheme://host`.
function preflightProbeExtra(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
): Readonly<Record<string, unknown>> {
  const host = embeddingEndpointHost(adapter.endpoint);
  return {
    provider: options.provider,
    modelId: options.modelId,
    ...(options.expectedDimensions !== undefined
      ? { expectedDimensions: options.expectedDimensions }
      : {}),
    fingerprinted: options.includeSpaceFingerprint === true,
    ...(host === undefined ? {} : { endpointHost: host }),
  };
}

async function probeEmbeddingCapability(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
  log: PreflightLog,
): Promise<EmbeddingCapabilityCheck> {
  const probe = preflightProbeExtra(adapter, options);
  log({ level: "info", op: "embedding.preflight.started", extra: { ...probe, cached: false } });
  const elapsed = startKnowledgeLogTimer();
  const result = await verifyEmbeddingCapability(adapter, options);
  const durationMs = elapsed();
  if (!result.ok) {
    log({
      level: "error",
      op: "embedding.preflight.failed",
      errorKind: result.reason,
      durationMs,
      extra: probe,
    });
    return result;
  }
  log({
    level: "info",
    op: "embedding.preflight.completed",
    durationMs,
    extra: { ...probe, observedDimensions: result.identity.vectorDimensions },
  });
  return result;
}

async function verifyEmbeddingPreflightCapability(
  adapter: OpenAIEmbeddingAdapter,
  options: EmbeddingProbeOptions,
  cacheScope: object | undefined,
  now: () => number,
  log: PreflightLog,
): Promise<EmbeddingCapabilityCheck> {
  const cache = cacheScope === undefined ? undefined : embeddingPreflightCacheFor(cacheScope);
  const cached = cache?.get(embeddingPreflightCacheKey(options));
  if (cached !== undefined && cached.expiresAt > now()) {
    log({
      level: "info",
      op: "embedding.preflight.cache-hit",
      extra: { ...preflightProbeExtra(adapter, options), cached: true },
    });
    return cached.result;
  }
  const result = await probeEmbeddingCapability(adapter, options, log);
  if (cache === undefined || !result.ok) return result;
  cacheSuccessfulEmbeddingPreflight(cache, options, result, now() + EMBEDDING_PREFLIGHT_TTL_MS);
  return result;
}

// The preflight ANSWERED and the gateway's identity was still refused. This is the one outcome
// an operator most often mistakes for an outage, so it gets its own line carrying both
// dimensions — the whole diagnosis, and none of the safe message's prose.
function logPreflightIdentityRejected(state: RunState, observed: EmbeddingModelIdentity): void {
  logEmbeddingRun(state, {
    level: "error",
    op: "embedding.preflight.identity-rejected",
    errorKind: "INCOMPATIBLE_EMBEDDING_IDENTITY",
    extra: {
      pinnedDimensions: state.capsule.embeddingModelIdentity.vectorDimensions,
      observedDimensions: observed.vectorDimensions,
    },
  });
}

function adoptPreflightIdentity(
  state: RunState,
  identity: EmbeddingModelIdentity,
  op: string,
): void {
  state.capsule = updateCapsuleEmbeddingModelIdentity(
    state.options.store,
    state.capsule.id,
    identity,
  );
  logEmbeddingRun(state, {
    level: "info",
    op,
    extra: { observedDimensions: identity.vectorDimensions, provider: identity.provider },
  });
}

function embeddingPreflightSuccess(
  state: RunState,
  result: Extract<EmbeddingCapabilityCheck, { readonly ok: true }>,
): IndexingJobError | undefined {
  if (hasProvisionalIdentity(state)) {
    adoptPreflightIdentity(state, result.identity, "embedding.preflight.identity-adopted");
    return undefined;
  }
  const compatibility = assertCompatibleEmbeddingIdentity(
    state.capsule.embeddingModelIdentity,
    result.identity,
  );
  if (!compatibility.ok) {
    logPreflightIdentityRejected(state, result.identity);
    return { code: "INCOMPATIBLE_EMBEDDING_IDENTITY", message: compatibility.safeMessage };
  }
  if (embeddingIdentityChanged(state.capsule.embeddingModelIdentity, compatibility.identity)) {
    adoptPreflightIdentity(state, compatibility.identity, "embedding.preflight.identity-refreshed");
  }
  return undefined;
}

function embeddingPreflightFailure(
  state: RunState,
  result: EmbeddingCapabilityCheck,
): IndexingJobError | undefined {
  if (result.ok) {
    return embeddingPreflightSuccess(state, result);
  }
  return {
    code:
      result.reason === "dimension-mismatch"
        ? "INCOMPATIBLE_EMBEDDING_IDENTITY"
        : "EMBEDDING_ADAPTER_FAILED",
    message: result.safeMessage,
  };
}

function embeddingIdentityChanged(
  stored: EmbeddingModelIdentity,
  current: EmbeddingModelIdentity,
): boolean {
  return (
    stored.provider !== current.provider ||
    stored.modelId !== current.modelId ||
    stored.modelRevision !== current.modelRevision ||
    stored.vectorDimensions !== current.vectorDimensions ||
    stored.vectorMetric !== current.vectorMetric ||
    stored.normalization !== current.normalization ||
    stored.instructionVersion !== current.instructionVersion ||
    stored.embeddingSpaceFingerprint !== current.embeddingSpaceFingerprint ||
    stored.dimensionsParam !== current.dimensionsParam
  );
}

// A THROWN preflight is the worst case for an operator: the adapter did not answer with a
// classified failure, it blew up, and the run ends with a generic EMBEDDING_ADAPTER_FAILED whose
// message says nothing about the cause. The kind — never the message, which carries the endpoint
// and often the response body — is the whole difference between a DNS failure and a TLS refusal.
function preflightThrowFailure(
  state: RunState,
  log: PreflightLog,
  cause: unknown,
): IndexingJobError {
  const cancelled =
    cancellationRequested(state) || (cause instanceof DOMException && cause.name === "AbortError");
  log({
    level: cancelled ? "warn" : "error",
    op: "embedding.preflight.failed",
    errorKind: cancelled ? "CANCELLED" : knowledgeErrorKind(cause),
    extra: { threw: true, ...endpointHostExtra(state) },
  });
  if (cancelled) {
    return { code: "CANCELLED", message: "indexing aborted via AbortSignal" };
  }
  return {
    code: "EMBEDDING_ADAPTER_FAILED",
    message: "embedding capability preflight failed before indexing started",
  };
}

async function verifyEmbeddingPreflight(state: RunState): Promise<IndexingJobError | undefined> {
  const log: PreflightLog = (event): void => {
    logEmbeddingRun(state, event);
  };
  try {
    const result = await verifyEmbeddingPreflightCapability(
      state.options.embeddingAdapter,
      embeddingPreflightOptions(state),
      state.options.embeddingPreflightCacheScope,
      state.now,
      log,
    );
    return embeddingPreflightFailure(state, result);
  } catch (cause) {
    return preflightThrowFailure(state, log, cause);
  }
}

function modelUsePolicyPreflightFailure(
  capsule: KnowledgeCapsule,
  options: IndexingOptions,
): IndexingJobError | undefined {
  const policy = resolveCapsuleModelUsePolicy(capsule);
  if (policy.operations.externalEmbeddings === "deny") {
    return {
      code: "POLICY_DENIED",
      message: "Knowledge Pod policy denies external embeddings for indexing.",
    };
  }
  if (options.contextualRetrieval?.enabled !== true) return undefined;
  if (policy.operations.rawContentRelease === "deny") {
    return {
      code: "POLICY_DENIED",
      message: "Knowledge Pod policy denies raw content release for contextual indexing.",
    };
  }
  if (policy.operations.answerSynthesis === "deny") {
    return {
      code: "POLICY_DENIED",
      message: "Knowledge Pod policy denies answer synthesis for contextual indexing.",
    };
  }
  return undefined;
}

// Loud truncation surfacing (2026-08 field review): LIMIT_REACHED used to be one buried
// document-failed entry in job history while the capsule finished "ready" — a corpus silently
// missing part of its files. A capsule-level quality warning (document_id NULL, so it survives
// per-document cleanup and flows into the health surface's qualityWarnings) says so instead.
// Content-free: no paths, no counts derived from file names.
const DISCOVERY_LIMIT_WARNING =
  "File discovery stopped at the configured limit before the whole connected folder was " +
  "covered — part of the corpus is not indexed. Raise KEIKO_LOCAL_KNOWLEDGE_MAX_DISCOVERY_FILES " +
  "(or _MAX_DISCOVERY_DEPTH) and re-index to cover the full corpus.";

export const DISCOVERY_LIMIT_WARNING_CODE = "DISCOVERY_LIMIT_REACHED";

function persistDiscoveryLimitWarning(state: RunState): void {
  if (state.discoveryLimitWarningPersisted) return;
  state.discoveryLimitWarningPersisted = true;
  // Truncation is the one discovery outcome where the run SUCCEEDS and the corpus is still
  // incomplete, so the operator has no failing signal to chase — they only notice later, when a
  // grounded answer is missing a document nobody knows was never indexed. The capsule diagnostic
  // below reaches the health surface; this line puts the same fact, plus the two caps that
  // produced it, in the file. Written once per run behind the guard above, because LIMIT_REACHED
  // surfaces once per ancestor frame.
  const discovery = resolvedDiscoveryOptions(state);
  logIndexing(state, {
    level: "warn",
    op: "indexing.discovery.limit-reached",
    extra: {
      discoveredCount: state.totalDocuments,
      maxFiles: discovery.maxFiles,
      maxDepth: discovery.maxDepth,
    },
  });
  try {
    insertDiagnosticRow(state.options.store._internal.db, {
      id: state.idSource(),
      capsuleId: state.capsule.id,
      diagnostic: {
        severity: "warning",
        code: DISCOVERY_LIMIT_WARNING_CODE,
        message: DISCOVERY_LIMIT_WARNING,
      },
      createdAt: state.now(),
    });
  } catch {
    // Informational surface — a diagnostics write must never fail the run.
  }
}

// A truncation warning describes the LAST completed walk. Each new run clears it up front and
// re-asserts it only if this walk truncates again, so raising the limit (or shrinking the
// folder) makes the warning disappear with the next index instead of shouting forever.
function clearDiscoveryLimitWarning(state: RunState): void {
  try {
    deleteCapsuleDiagnosticsByCode(
      state.options.store._internal.db,
      state.capsule.id,
      DISCOVERY_LIMIT_WARNING_CODE,
    );
  } catch {
    // Informational surface — see persistDiscoveryLimitWarning.
  }
}

function persistStartedJob(state: RunState, sources: readonly KnowledgeSource[]): void {
  insertJobRow(state.options.store._internal.db, {
    id: state.jobId,
    capsuleId: state.capsule.id,
    sourceIds: sources.map((source) => source.id),
    startedAt: state.startedAt,
  });
  clearDiscoveryLimitWarning(state);
  try {
    updateCapsuleState(state.options.store, state.capsule.id, "indexing");
  } catch {
    // The capsule state column is informational — failing to flip it must not abort the
    // run. The events stream remains the source of truth.
  }
}

function sourceIdsForState(state: RunState): readonly KnowledgeSourceId[] {
  return [...state.sourcesById.values()].map((source) => source.id);
}

function emitJobStarted(state: RunState, sources: readonly KnowledgeSource[]): IndexingEvent {
  const event: IndexingEvent = {
    kind: "job-started",
    jobId: state.jobId,
    capsuleId: state.capsule.id,
    sourceIds: sources.map((source) => source.id),
    startedAt: state.startedAt,
  };
  state.options.auditSink?.emit({
    kind: "indexing-job-started",
    capsuleId: state.capsule.id,
    sourceIds: sources.map((source) => source.id),
    jobId: state.jobId,
    occurredAt: state.startedAt,
  });
  // The first line of the run's spine, and the only place the run's shape is stated: how many
  // sources it will walk, and the two caps that decide the whole request profile. Everything
  // downstream is read against these numbers.
  logIndexing(state, {
    level: "info",
    op: "indexing.job.started",
    extra: {
      sourceCount: sources.length,
      batchSize: state.batchSize,
      concurrency: state.concurrency,
      force: state.options.force === true,
      resume: state.options.resume === true,
      contextualRetrieval: state.options.contextualRetrieval?.enabled === true,
      ...endpointHostExtra(state),
    },
  });
  return emit(state, event);
}

async function resolveIndexingTokenizer(
  options: IndexingOptions,
): Promise<LocalKnowledgeTokenizer> {
  if (
    options.chunkingOptions?.tokenizer !== undefined ||
    options.chunkingOptions?.tokenEstimator !== undefined
  ) {
    return resolveChunkingOptions(options.chunkingOptions).tokenizer;
  }
  const loaded = await loadOptionalQwen3SentencePieceTokenizer();
  return loaded.tokenizer;
}

function resolvePolicyFailureTokenizer(options: IndexingOptions): LocalKnowledgeTokenizer {
  return resolveChunkingOptions(options.chunkingOptions).tokenizer;
}

async function* runSourcesWithProgress(
  state: RunState,
  sources: readonly KnowledgeSource[],
): AsyncGenerator<IndexingEvent, IndexingJobError | undefined> {
  let identityFailure: IndexingJobError | undefined;
  for (const source of sources) {
    if (cancellationRequested(state) || identityFailure !== undefined) {
      break;
    }
    identityFailure = yield* iterateSourceEvents(state, source);
    persistJobProgress(state);
  }
  return identityFailure;
}

// The run's prologue — capsule resolution, source resolution, the tokenizer load and the
// started-job write — all happens BEFORE `indexing.job.started` can be emitted, and every one of
// those steps can throw or hang: a missing capsule, a source filter matching nothing, a
// tokenizer read off disk, a locked database. Until this line existed, a job that died or wedged
// in its prologue produced exactly what a job that was never launched produces — nothing — and
// no operator could tell the two apart. It is written before the first of those steps runs, and
// it is the only line that cannot use `RunState`, because no state exists yet.
//
// The capsule id is caller-supplied, so it is digested here by the same function the rest of the
// run uses: the prologue line and every later line share one correlation key.
function logJobReceived(options: IndexingOptions, jobId: string): void {
  emitKnowledgeLogEvent(options.logSink, {
    level: "info",
    category: "indexing",
    op: "indexing.job.received",
    correlationId: jobId,
    extra: {
      capsuleIdDigest: logDigest(String(options.capsuleId)),
      sourceIdFilterCount: options.sourceIds?.length ?? 0,
      force: options.force === true,
      resume: options.resume === true,
    },
  });
}

// ─── Public entrypoint ────────────────────────────────────────────────────────
export async function* runIndexingJob(options: IndexingOptions): AsyncIterable<IndexingEvent> {
  // The job id is minted first so the prologue line can carry the correlation key every later
  // line uses. `idSource` is called exactly once here, as before.
  const idSource = options.idSource ?? ((): string => randomUUID());
  const jobId = idSource();
  logJobReceived(options, jobId);
  const capsule = resolveCapsule(options);
  const sources = resolveSources(options, capsule);
  const startedAt = (options.now ?? options.store._internal.now)();
  const policyFailure = modelUsePolicyPreflightFailure(capsule, options);
  const tokenizer =
    policyFailure === undefined
      ? await resolveIndexingTokenizer(options)
      : resolvePolicyFailureTokenizer(options);
  const state = buildInitialState(options, capsule, sources, jobId, startedAt, tokenizer);
  persistStartedJob(state, sources);
  yield emitJobStarted(state, sources);

  if (cancellationRequested(state)) {
    yield* finalize(state, undefined);
    return;
  }
  if (policyFailure !== undefined) {
    state.lastError = policyFailure;
    yield* finalize(state, policyFailure);
    return;
  }
  const preflightFailure = await verifyEmbeddingPreflight(state);
  if (cancellationRequested(state)) {
    yield* finalize(state, undefined);
    return;
  }
  if (preflightFailure !== undefined) {
    state.lastError = preflightFailure;
    yield* finalize(state, preflightFailure);
    return;
  }

  const identityFailure = yield* runSourcesWithProgress(state, sources);
  yield* finalize(state, identityFailure);
}

// Gateway-outage circuit breaker (2026-08 field review): with a dead or saturated embedding
// gateway, EVERY remaining document grinds through the full transient-retry ladder (attempts x
// provider timeout + backoff — minutes per document), so a large corpus "runs" for days doing
// nothing. Once this many transient adapter failures accumulate WITHOUT an intervening
// successfully embedded document, the run aborts with a distinct terminal error instead.
// Deterministic failures and skips never count — they say nothing about the gateway.
export const CONSECUTIVE_TRANSIENT_FAILURE_LIMIT = 5;

// `satisfies` pins both producer literals to the contract-owned code list: renaming or
// dropping a code in keiko-contracts breaks this compile instead of silently drifting from
// the capsule-detail consumer.
export const EMBEDDING_GATEWAY_UNAVAILABLE_CODE =
  "EMBEDDING_GATEWAY_UNAVAILABLE" satisfies (typeof INDEXING_EMBEDDING_STOPPED_ERROR_CODES)[number];

function gatewayUnavailableError(state: RunState): IndexingJobError {
  return {
    code: EMBEDDING_GATEWAY_UNAVAILABLE_CODE,
    message:
      `embedding gateway unreachable: ${String(state.consecutiveTransientEmbedFailures)} ` +
      "consecutive documents failed with transient adapter errors; aborting the run instead of " +
      "retrying every remaining document against a dead gateway",
    transient: true,
  };
}

// Trip check only — the evidence itself is tracked at the single owning site
// (trackGatewayEvidence in applyEmbedResult), which both embed paths route through.
function breakerTripError(state: RunState): IndexingJobError | undefined {
  return state.consecutiveTransientEmbedFailures >= CONSECUTIVE_TRANSIENT_FAILURE_LIMIT
    ? gatewayUnavailableError(state)
    : undefined;
}

// Drains one source's event stream, yielding each event to the outer generator.
// Returns the fatal error (identity failure or tripped gateway breaker) if encountered,
// undefined otherwise. An early return here closes the source generator chain, so the
// discovery stream stops producing work for a run that is already lost.
async function* iterateSourceEvents(
  state: RunState,
  source: KnowledgeSource,
): AsyncGenerator<IndexingEvent, IndexingJobError | undefined> {
  for await (const evt of runOneSource(state, source)) {
    yield emit(state, evt);
    if (evt.kind === "document-failed" && evt.error.code === "INCOMPATIBLE_EMBEDDING_IDENTITY") {
      return evt.error;
    }
    const tripped = breakerTripError(state);
    if (tripped !== undefined) {
      return tripped;
    }
  }
  return undefined;
}

function emit(state: RunState, event: IndexingEvent): IndexingEvent {
  emitProgress(state.options, event);
  return event;
}

// Terminal capsule state reflects INDEX USABILITY, not run outcome (2026-08 field review,
// adversarially re-verified). Grounded surfaces hard-refuse "error" capsules, so demoting a
// capsule whose persisted vectors survived a failed or cancelled RUN intact takes a healthy
// corpus out of retrieval over a run-scoped problem — a five-document gateway blip during a
// nightly refresh must not black out thousands of indexed manuals. "error" is reserved for an
// index that cannot be trusted or used: an identity violation, or no persisted vectors at all.
// The failed run itself stays fully visible in the job history, counters, and health warnings.
function terminalCapsuleState(
  state: RunState,
  status: IndexingResult["status"],
): "ready" | "error" {
  if (status === "succeeded") return "ready";
  if (state.lastError?.code === "INCOMPATIBLE_EMBEDDING_IDENTITY") return "error";
  const vectors = countVectorsForCapsule(state.options.store._internal.db, state.capsule.id);
  return vectors > 0 ? "ready" : "error";
}

function resolveJobStatus(
  state: RunState,
  fatalFailure: IndexingJobError | undefined,
): IndexingResult["status"] {
  if (fatalFailure !== undefined) {
    state.lastError = fatalFailure;
    return "failed";
  }
  if (cancellationRequested(state)) return "cancelled";
  // Relocated pin: "everything attempted failed" is terminal ONLY when the run saw no healthy
  // corpus at all. A delta/repair run that re-attempts a handful of known-broken documents
  // while skipping a verified-unchanged corpus is not a whole-run failure (adversarial
  // review, 2026-08) — its per-document failures stay recorded, and the majority rule below
  // still fails any run whose failures outweigh the corpus it saw.
  if (state.failedDocuments > 0 && state.processedDocuments === 0 && state.skippedDocuments === 0) {
    return "failed";
  }
  // Honest terminal status (2026-08 field review, adversarially re-verified): "succeeded
  // whenever anything processed" reported SUCCEEDED for 800 processed / 4,200 failed while
  // most of the corpus was silently absent from retrieval. The ratio is CORPUS-scoped, not
  // run-scoped: skipped (verified-unchanged) documents are healthy-corpus evidence and count
  // in the denominator, so a repair or incremental run over a mostly-healthy corpus whose
  // small delta partially fails is still a success with recorded per-document failures —
  // only a run that leaves the majority of the corpus it saw unindexed fails as a whole.
  // Walk-level discovery diagnostics (LIMIT_REACHED frames et al.) are not attempted
  // documents and stay out of the numerator.
  const embedFailedDocuments = state.failedDocuments - state.discoveryFailedDocuments;
  if (embedFailedDocuments > state.processedDocuments + state.skippedDocuments) {
    // Job-level classification deliberately REPLACES the last per-document error: the
    // document-failed events keep every individual cause, while the terminal error names why
    // the RUN as a whole is not a success.
    state.lastError = {
      code: "MAJORITY_DOCUMENTS_FAILED" satisfies (typeof INDEXING_EMBEDDING_STOPPED_ERROR_CODES)[number],
      message:
        `${String(embedFailedDocuments)} of ` +
        `${String(embedFailedDocuments + state.processedDocuments + state.skippedDocuments)} ` +
        "documents in this run's scope failed; refusing to report this run as succeeded",
    };
    return "failed";
  }
  return "succeeded";
}

// The closing line of the run's spine, and the one an operator reads first. It restates every
// counter the UI shows next to the terminal status and the total wall time, so "cancelled after
// six minutes with zero vectors" is a single greppable line rather than an inference across the
// whole file. `warn` for a cancellation and `error` for a failure: a run that did not succeed
// must be visible at a level an operator filters TO, not one they filter out.
const JOB_FINISH_LEVELS = {
  succeeded: "info",
  cancelled: "warn",
  failed: "error",
} as const satisfies Record<IndexingResult["status"], KnowledgeLogEvent["level"]>;

function logJobFinished(state: RunState, result: IndexingResult): void {
  logIndexing(state, {
    level: JOB_FINISH_LEVELS[result.status],
    op: "indexing.job.finished",
    durationMs: state.elapsed(),
    ...(state.lastError !== undefined ? { errorKind: state.lastError.code } : {}),
    extra: {
      // NOT `status`. The sink flattens `extra` onto the same record as the envelope, whose
      // `status` field is the numeric HTTP status every operator query and dashboard filter
      // reads. A run's terminal state written under that name puts the string "succeeded" where
      // a number belongs and silently poisons those queries for every other line's `status`.
      jobStatus: result.status,
      totalDocuments: result.totalDocuments,
      processedDocuments: result.processedDocuments,
      failedDocuments: result.failedDocuments,
      skippedDocuments: result.skippedDocuments,
      vectorsPersisted: result.vectorsPersisted,
    },
  });
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
    updateCapsuleState(state.options.store, state.capsule.id, terminalCapsuleState(state, status));
  } catch {
    // informational only — see the started block for the rationale
  }

  const result = buildResult(state, status, finishedAt);
  logJobFinished(state, result);
  if (status === "cancelled") {
    yield emit(state, { kind: "job-cancelled", jobId: state.jobId, result });
    return;
  }
  if (status === "failed") {
    const err = state.lastError ?? { code: "EMBEDDING_ADAPTER_FAILED", message: "indexing failed" };
    state.options.auditSink?.emit({
      kind: "indexing-job-failed",
      capsuleId: state.capsule.id,
      sourceIds: sourceIdsForState(state),
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
    sourceIds: sourceIdsForState(state),
    jobId: state.jobId,
    processedDocuments: result.processedDocuments,
    failedDocuments: result.failedDocuments,
    occurredAt: finishedAt,
  });
  yield emit(state, { kind: "job-completed", jobId: state.jobId, result });
}
