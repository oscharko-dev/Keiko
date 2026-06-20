// Bounded chunking + embedding for progressively-extracted large documents (Epic #1160,
// Issue #1286).
//
// The standard chunk/embed path loads the whole document text into a JS string and slices each
// chunk from it. For a large document that defeats the bounded-memory guarantee. These helpers read
// each parsed unit's / chunk's text back through the unified `readDocumentTextSpan` (SQLite SUBSTR
// over the bounded document_text_windows rows), so peak memory stays O(window/batch) regardless of
// document size. The chunk ids, offsets, token counts, and excerpt hashes are byte-identical to the
// standard chunker, so the bounded path and the standard path produce the same retrievable index.

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  IndexingJobError,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  LargeDocumentResourcePolicy,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";
import type { DatabaseSync } from "node:sqlite";

import {
  chunkParsedUnit,
  chunkingStrategyKey,
  resolveChunkingOptions,
} from "../chunking/chunker.js";
import type { ChunkingOptions } from "../chunking/types.js";
import { composeChunkId, rowToParsedUnit } from "../chunking/chunker-runner.js";
import {
  deleteChunksForDocument,
  insertChunkRow,
  selectParsedUnitsForDocument,
} from "../chunking/chunker-persist.js";
import { readDocumentTextSpan } from "../discovery/persist.js";
import type { KnowledgeStore } from "../store.js";
import type { StoreContentCipher } from "../store-content-cipher.js";
import { embedChunkBatch } from "./embedding-batcher.js";
import type { ChunkToEmbed, EmbedBatchResult } from "./types.js";

export interface BoundedChunkParams {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
}

export class BoundedIndexingCancelledError extends Error {
  public constructor(message = "bounded indexing cancelled") {
    super(message);
    this.name = "BoundedIndexingCancelledError";
  }
}

export class BoundedIndexingPolicyError extends Error {
  public readonly code = "RESOURCE_POLICY_EXCEEDED";
  public constructor(message: string) {
    super(message);
    this.name = "BoundedIndexingPolicyError";
  }

  public toIndexingError(): IndexingJobError {
    return { code: this.code, message: this.message };
  }
}

function rebaseUnit(unit: ParsedUnit, length: number): ParsedUnit {
  if (unit.kind === "unsupported-media") return unit;
  return { ...unit, characterStart: 0, characterEnd: length };
}

interface ChunkUnitContext {
  readonly db: DatabaseSync;
  readonly cipher: StoreContentCipher;
  readonly params: BoundedChunkParams;
  readonly options: ChunkingOptions | undefined;
  readonly strategyKey: string;
  readonly maxChunks: number;
}

function boundedMaxChunks(
  options: ChunkingOptions | undefined,
  policy: LargeDocumentResourcePolicy | undefined,
): number {
  return Math.min(
    resolveChunkingOptions(options).maxChunks,
    policy?.maxChunkCount ?? Number.POSITIVE_INFINITY,
  );
}

function assertChunkingCanContinue(
  signal: AbortSignal | undefined,
  orderIndex: number,
  maxChunks: number,
): void {
  if (signal?.aborted === true) throw new BoundedIndexingCancelledError();
  if (orderIndex >= maxChunks) {
    throw new BoundedIndexingPolicyError(
      "large-document chunk count exceeded the configured resource policy",
    );
  }
}

function assertChunkingHasRemainder(
  orderIndex: number,
  rowIndex: number,
  rowCount: number,
  maxChunks: number,
): void {
  if (orderIndex < maxChunks || rowIndex >= rowCount - 1) return;
  throw new BoundedIndexingPolicyError(
    "large-document chunk count exceeded the configured resource policy",
  );
}

// Chunks one parsed unit (read via SUBSTR, rebased to window-local offsets) and persists its chunks
// with document-relative offsets. Returns the next order index.
function chunkOneUnit(
  ctx: ChunkUnitContext,
  row: ReturnType<typeof selectParsedUnitsForDocument>[number],
  orderIndex: number,
): number {
  const { db, cipher, params } = ctx;
  const start = row.character_start ?? 0;
  const end = row.character_end ?? start;
  const unitText =
    readDocumentTextSpan(db, cipher, params.capsuleId, params.documentId, start, end) ?? "";
  const rebased = rebaseUnit(rowToParsedUnit(row, params.documentId, cipher), unitText.length);
  const chunks = chunkParsedUnit(
    rebased,
    unitText,
    optionsWithBudget(ctx.options, ctx.maxChunks - orderIndex),
  );
  let next = orderIndex;
  for (const chunk of chunks) {
    insertChunkRow(db, {
      id: composeChunkId(params.documentId, row.id, next),
      capsuleId: params.capsuleId,
      sourceId: params.sourceId,
      documentId: params.documentId,
      parsedUnitId: row.id,
      orderIndex: next,
      tokenCount: chunk.tokenCount,
      safeExcerptHash: chunk.safeExcerptHash,
      chunkingStrategyVersion: ctx.strategyKey,
      characterStart: start + chunk.characterStart,
      characterEnd: start + chunk.characterEnd,
    });
    next += 1;
  }
  return next;
}

// Bounded re-implementation of the chunker: reads each parsed unit's text via SUBSTR, chunks it with
// window-relative offsets, then rebases the chunk offsets back to document-relative before persist,
// so the rows are byte-identical to chunkDocument run over the full text. Returns the chunk count.
export function chunkDocumentBounded(
  store: KnowledgeStore,
  params: BoundedChunkParams,
  options: ChunkingOptions | undefined,
  signal: AbortSignal | undefined,
  policy?: LargeDocumentResourcePolicy,
): number {
  const db = store._internal.db;
  const rows = selectParsedUnitsForDocument(db, params.capsuleId, params.documentId);
  if (rows.length === 0) return 0;
  const ctx: ChunkUnitContext = {
    db,
    cipher: store._internal.contentCipher,
    params,
    options,
    strategyKey: chunkingStrategyKey(options),
    maxChunks: boundedMaxChunks(options, policy),
  };
  db.exec("BEGIN");
  try {
    deleteChunksForDocument(db, params.capsuleId, params.documentId);
    let orderIndex = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined) continue;
      assertChunkingCanContinue(signal, orderIndex, ctx.maxChunks);
      orderIndex = chunkOneUnit(ctx, row, orderIndex);
      assertChunkingHasRemainder(orderIndex, rowIndex, rows.length, ctx.maxChunks);
    }
    db.exec("COMMIT");
    return orderIndex;
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function optionsWithBudget(options: ChunkingOptions | undefined, budget: number): ChunkingOptions {
  return { ...(options ?? {}), maxChunks: budget };
}

// ─── Bounded embedding ────────────────────────────────────────────────────────
interface ChunkOffsetRow {
  readonly id: string;
  readonly source_id: string;
  readonly order_index: number;
  readonly char_start: number | null;
  readonly char_end: number | null;
}

// Selects the next batch of chunks that do NOT yet have a vector. The missing-vector gate is the
// resume mechanism: it self-heals across an interrupted embed, an externally deleted vector, and an
// incompatible-checkpoint restart (which deletes vectors first), without trusting a fragile cursor.
const SELECT_BOUNDED_CHUNKS_SQL = [
  "SELECT c.id, c.source_id, c.order_index,",
  "  COALESCE(c.character_start, pu.character_start) AS char_start,",
  "  COALESCE(c.character_end, pu.character_end) AS char_end",
  "FROM chunks AS c",
  "JOIN parsed_units AS pu ON pu.capsule_id = c.capsule_id AND pu.id = c.parsed_unit_id",
  "LEFT JOIN vectors AS v ON v.capsule_id = c.capsule_id AND v.chunk_id = c.id",
  "WHERE c.capsule_id = :c AND c.document_id = :d AND v.id IS NULL",
  "ORDER BY c.order_index ASC",
  "LIMIT :limit",
].join(" ");

const COUNT_VECTORS_SQL =
  "SELECT COUNT(*) AS n FROM vectors WHERE capsule_id = :c AND document_id = :d";

function embeddedChunkCount(db: DatabaseSync, deps: BoundedEmbedDeps): number {
  const row = db
    .prepare(COUNT_VECTORS_SQL)
    .get({ c: String(deps.capsuleId), d: String(deps.documentId) }) as { n: number };
  return row.n;
}

export interface BoundedEmbedDeps {
  readonly store: KnowledgeStore;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: DocumentId;
  readonly adapter: OpenAIEmbeddingAdapter;
  readonly identity: EmbeddingModelIdentity;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly now: () => number;
  readonly idSource: () => string;
  readonly signal?: AbortSignal;
  readonly policy?: LargeDocumentResourcePolicy;
  // Called after each successfully embedded batch with the new embedded-chunk cursor and id, so the
  // caller can advance the durable checkpoint between model calls.
  readonly onBatch?: (cursor: number, lastChunkId: ChunkId) => void;
}

export interface BoundedEmbedResult {
  readonly vectorCount: number;
  readonly errors: readonly IndexingJobError[];
  readonly lastChunkId: ChunkId | null;
  readonly embeddedCursor: number;
  readonly cancelled: boolean;
}

function nextBatch(db: DatabaseSync, deps: BoundedEmbedDeps): readonly ChunkOffsetRow[] {
  return db.prepare(SELECT_BOUNDED_CHUNKS_SQL).all({
    c: String(deps.capsuleId),
    d: String(deps.documentId),
    limit: deps.batchSize,
  }) as unknown as readonly ChunkOffsetRow[];
}

function toChunkToEmbed(deps: BoundedEmbedDeps, row: ChunkOffsetRow): ChunkToEmbed {
  const text =
    readDocumentTextSpan(
      deps.store._internal.db,
      deps.store._internal.contentCipher,
      deps.capsuleId,
      deps.documentId,
      row.char_start ?? 0,
      row.char_end ?? 0,
    ) ?? "";
  return {
    id: row.id as ChunkId,
    capsuleId: deps.capsuleId,
    sourceId: row.source_id as KnowledgeSourceId,
    documentId: deps.documentId,
    text,
  };
}

function embedOptions(deps: BoundedEmbedDeps): Parameters<typeof embedChunkBatch>[1] {
  return {
    adapter: deps.adapter,
    store: deps.store,
    pinnedIdentity: deps.identity,
    concurrency: deps.concurrency,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    now: deps.now,
    idSource: deps.idSource,
  };
}

interface EmbedAccumulator {
  vectorCount: number;
  readonly errors: IndexingJobError[];
  lastChunkId: ChunkId | null;
  cancelled: boolean;
}

// Embeds one batch, updates the accumulator, and advances the durable checkpoint. Returns false to
// stop the loop (the batch reported an error).
async function embedOneBatch(
  db: DatabaseSync,
  deps: BoundedEmbedDeps,
  rows: readonly ChunkOffsetRow[],
  acc: EmbedAccumulator,
): Promise<boolean> {
  const batch = rows.map((row) => toChunkToEmbed(deps, row));
  const result: EmbedBatchResult = await embedChunkBatch(batch, embedOptions(deps));
  acc.vectorCount += result.vectors.length;
  acc.errors.push(...result.errors);
  const lastVector = result.vectors[result.vectors.length - 1];
  if (lastVector !== undefined) acc.lastChunkId = lastVector.chunkId;
  if (acc.lastChunkId !== null) deps.onBatch?.(embeddedChunkCount(db, deps), acc.lastChunkId);
  return result.errors.length === 0;
}

function markCancelled(acc: EmbedAccumulator): void {
  acc.cancelled = true;
}

function appendBatchPolicyError(acc: EmbedAccumulator): void {
  acc.errors.push({
    code: "RESOURCE_POLICY_EXCEEDED",
    message: "large-document embedding batch count exceeded the configured resource policy",
  });
}

function batchPolicyExceeded(deps: BoundedEmbedDeps, batchCount: number): boolean {
  return batchCount >= (deps.policy?.maxEmbeddingBatchCount ?? Number.POSITIVE_INFINITY);
}

function sawCancellationError(acc: EmbedAccumulator): boolean {
  return acc.errors.some((error) => error.code === "CANCELLED");
}

interface EmbedLoopState {
  previousFirstId?: string;
  batchCount: number;
}

async function embedLoopStep(
  db: DatabaseSync,
  deps: BoundedEmbedDeps,
  acc: EmbedAccumulator,
  loop: EmbedLoopState,
): Promise<"continue" | "stop"> {
  if (deps.signal?.aborted === true) {
    markCancelled(acc);
    return "stop";
  }
  const rows = nextBatch(db, deps);
  const firstRow = rows[0];
  if (firstRow === undefined || firstRow.id === loop.previousFirstId) return "stop";
  if (batchPolicyExceeded(deps, loop.batchCount)) {
    appendBatchPolicyError(acc);
    return "stop";
  }
  loop.batchCount += 1;
  loop.previousFirstId = firstRow.id;
  if (await embedOneBatch(db, deps, rows, acc)) return "continue";
  if (sawCancellationError(acc)) markCancelled(acc);
  return "stop";
}

// Embeds a document's not-yet-embedded chunks in bounded batches, reading each chunk's text via
// SUBSTR. Never materializes the whole document text or the whole chunk set, so peak memory stays
// O(batch) regardless of document size. Resume falls out of the missing-vector gate.
export async function embedDocumentChunksBounded(
  deps: BoundedEmbedDeps,
): Promise<BoundedEmbedResult> {
  const db = deps.store._internal.db;
  const acc: EmbedAccumulator = {
    vectorCount: 0,
    errors: [],
    lastChunkId: null,
    cancelled: false,
  };
  const loop: EmbedLoopState = { batchCount: 0 };
  for (;;) {
    if ((await embedLoopStep(db, deps, acc, loop)) === "stop") break;
  }
  return {
    vectorCount: acc.vectorCount,
    errors: acc.errors,
    lastChunkId: acc.lastChunkId,
    embeddedCursor: embeddedChunkCount(db, deps),
    cancelled: acc.cancelled,
  };
}
