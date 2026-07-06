// Per-document chunker orchestrator (Epic #189, Issue #195).
//
// Reads parsed_units for the document, runs the pure `chunkParsedUnit` per unit, and
// persists chunks inside a single transaction so a mid-document failure (or AbortSignal
// cancellation) rolls back ALL chunks for the document — never half-chunked state.
//
// Idempotency: with `force: false` (default) and existing chunks already in the table,
// the runner is a no-op and returns `skippedExisting: true`. With `force: true`, prior
// chunks are deleted at the start of the transaction.

import { createHash } from "node:crypto";

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";

import { chunkParsedUnit, chunkingStrategyKey, resolveChunkingOptions } from "./chunker.js";
import {
  countChunksForDocument,
  deleteChunksForDocument,
  hasStaleChunksForDocument,
  insertChunkRow,
  selectDocumentSourceId,
  selectParsedUnitsForDocument,
  type ParsedUnitRow,
} from "./chunker-persist.js";
import type { KnowledgeStore } from "../store.js";
import type { StoreContentCipher } from "../store-content-cipher.js";
import type {
  ChunkDocumentParams,
  ChunkDocumentResult,
  ChunkingOptions,
  ChunkingResult,
} from "./types.js";
import { ChunkingError } from "./types.js";

// ─── Row → ParsedUnit reconstitution ──────────────────────────────────────────
// The parsed_units table is the canonical write surface for #194. We re-hydrate the
// discriminant union here so the pure chunker stays unaware of SQLite. Defensive: any
// row with a missing field for its kind raises a ChunkingError rather than producing a
// partially-typed value that crashes the slicer later.

function expectNumber(value: number | null, field: string, unitId: string): number {
  if (value === null) {
    throw new ChunkingError(`parsed_unit ${unitId} is missing required field ${field}`);
  }
  return value;
}

function parseStringArrayField(
  raw: string | null,
  field: string,
  unitId: string,
  cipher: StoreContentCipher,
): readonly string[] {
  if (raw === null) {
    throw new ChunkingError(`parsed_unit ${unitId} is missing required field ${field}`);
  }
  const parsed: unknown = JSON.parse(cipher.openText(raw));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new ChunkingError(`parsed_unit ${unitId} field ${field} did not deserialise to string[]`);
  }
  return parsed;
}

function rowToPageUnit(row: ParsedUnitRow, documentId: DocumentId): ParsedUnit {
  return {
    kind: "page",
    documentId,
    pageNumber: expectNumber(row.page_number, "page_number", row.id),
    ...(row.page_label !== null ? { pageLabel: row.page_label } : {}),
    characterStart: expectNumber(row.character_start, "character_start", row.id),
    characterEnd: expectNumber(row.character_end, "character_end", row.id),
  };
}

function rowToSectionUnit(
  row: ParsedUnitRow,
  documentId: DocumentId,
  cipher: StoreContentCipher,
): ParsedUnit {
  return {
    kind: "section",
    documentId,
    sectionPath: parseStringArrayField(row.section_path_json, "section_path_json", row.id, cipher),
    characterStart: expectNumber(row.character_start, "character_start", row.id),
    characterEnd: expectNumber(row.character_end, "character_end", row.id),
  };
}

function rowToJsonPathUnit(row: ParsedUnitRow, documentId: DocumentId): ParsedUnit {
  if (row.json_pointer === null) {
    throw new ChunkingError(`parsed_unit ${row.id} missing json_pointer`);
  }
  return {
    kind: "json-path",
    documentId,
    jsonPointer: row.json_pointer,
    characterStart: expectNumber(row.character_start, "character_start", row.id),
    characterEnd: expectNumber(row.character_end, "character_end", row.id),
  };
}

function rowToCsvRowUnit(row: ParsedUnitRow, documentId: DocumentId): ParsedUnit {
  if (row.table_name === null) {
    throw new ChunkingError(`parsed_unit ${row.id} missing table_name`);
  }
  return {
    kind: "csv-row",
    documentId,
    tableName: row.table_name,
    rowIndex: expectNumber(row.row_index, "row_index", row.id),
    characterStart: expectNumber(row.character_start, "character_start", row.id),
    characterEnd: expectNumber(row.character_end, "character_end", row.id),
  };
}

function rowToHtmlBlockUnit(
  row: ParsedUnitRow,
  documentId: DocumentId,
  cipher: StoreContentCipher,
): ParsedUnit {
  const heading =
    row.heading_path_json === null
      ? undefined
      : parseStringArrayField(row.heading_path_json, "heading_path_json", row.id, cipher);
  // anchor_id is sealed at rest (persist.ts) — open it here before it re-enters the ParsedUnit.
  const anchorId = row.anchor_id === null ? undefined : cipher.openText(row.anchor_id);
  return {
    kind: "html-block",
    documentId,
    ...(heading !== undefined ? { headingPath: heading } : {}),
    ...(anchorId !== undefined ? { anchorId } : {}),
    characterStart: expectNumber(row.character_start, "character_start", row.id),
    characterEnd: expectNumber(row.character_end, "character_end", row.id),
  };
}

export function rowToParsedUnit(
  row: ParsedUnitRow,
  documentId: DocumentId,
  cipher: StoreContentCipher,
): ParsedUnit {
  switch (row.kind) {
    case "page":
      return rowToPageUnit(row, documentId);
    case "section":
      return rowToSectionUnit(row, documentId, cipher);
    case "json-path":
      return rowToJsonPathUnit(row, documentId);
    case "csv-row":
      return rowToCsvRowUnit(row, documentId);
    case "html-block":
      return rowToHtmlBlockUnit(row, documentId, cipher);
    case "unsupported-media":
      return {
        kind: "unsupported-media",
        documentId,
        reason: row.unsupported_reason ?? "unknown",
      };
    default:
      throw new ChunkingError(`parsed_unit ${row.id} has unknown kind ${row.kind}`);
  }
}

// ─── Cancellation helper ─────────────────────────────────────────────────────
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ChunkingError("chunkDocument aborted via AbortSignal");
  }
}

// ─── ID composition ──────────────────────────────────────────────────────────
// Chunk IDs are deterministic on the document, semantic parsed-unit anchor, chunk span,
// and safe excerpt hash. They deliberately do not include parsed_units.id or orderIndex:
// those are write-order artefacts and can drift when a parser emits an extra unit before
// an otherwise unchanged citation target.
function stableUnitAnchor(unit: ParsedUnit): Record<string, unknown> {
  switch (unit.kind) {
    case "page":
      return {
        kind: unit.kind,
        pageNumber: unit.pageNumber,
        ...(unit.pageLabel !== undefined ? { pageLabel: unit.pageLabel } : {}),
      };
    case "section":
      return { kind: unit.kind, sectionPath: unit.sectionPath };
    case "json-path":
      return { kind: unit.kind, jsonPointer: unit.jsonPointer };
    case "csv-row":
      return { kind: unit.kind, tableName: unit.tableName, rowIndex: unit.rowIndex };
    case "html-block":
      return {
        kind: unit.kind,
        ...(unit.headingPath !== undefined ? { headingPath: unit.headingPath } : {}),
      };
    case "unsupported-media":
      return { kind: unit.kind, reason: unit.reason };
  }
}

function chunkIdDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 32);
}

export function composeChunkId(
  documentId: DocumentId,
  unit: ParsedUnit,
  chunk: ChunkingResult,
): ChunkId {
  return `${String(documentId)}#ch_${chunkIdDigest({
    version: 2,
    documentId: String(documentId),
    unit: stableUnitAnchor(unit),
    characterStart: chunk.characterStart,
    characterEnd: chunk.characterEnd,
    safeExcerptHash: chunk.safeExcerptHash,
  })}` as ChunkId;
}

// ─── Top-level entrypoint ────────────────────────────────────────────────────
interface PersistContext {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly sourceText: string;
}

function documentMaxChunks(options: ChunkingOptions | undefined): number {
  return resolveChunkingOptions(options).maxChunks;
}

function optionsWithRemainingChunkBudget(
  options: ChunkingOptions | undefined,
  remaining: number,
): ChunkingOptions {
  return options === undefined ? { maxChunks: remaining } : { ...options, maxChunks: remaining };
}

function persistAllChunks(
  store: KnowledgeStore,
  ctx: PersistContext,
  rows: readonly ParsedUnitRow[],
  options: ChunkingOptions | undefined,
  signal: AbortSignal | undefined,
): readonly ChunkId[] {
  const db = store._internal.db;
  const chunkIds: ChunkId[] = [];
  const maxChunks = documentMaxChunks(options);
  const strategyKey = chunkingStrategyKey(options);
  let orderIndex = 0;
  for (const row of rows) {
    throwIfAborted(signal);
    const remaining = maxChunks - chunkIds.length;
    if (remaining <= 0) {
      throw new ChunkingError(`chunkDocument exceeded maxChunks ${String(maxChunks)}`);
    }
    const unit = rowToParsedUnit(row, ctx.documentId, store._internal.contentCipher);
    const chunks = chunkParsedUnit(
      unit,
      ctx.sourceText,
      optionsWithRemainingChunkBudget(options, remaining),
    );
    for (const chunk of chunks) {
      const id = composeChunkId(ctx.documentId, unit, chunk);
      insertChunkRow(db, {
        id,
        capsuleId: ctx.capsuleId,
        sourceId: ctx.sourceId,
        documentId: ctx.documentId,
        parsedUnitId: row.id,
        orderIndex,
        tokenCount: chunk.tokenCount,
        safeExcerptHash: chunk.safeExcerptHash,
        chunkingStrategyVersion: strategyKey,
        characterStart: chunk.characterStart,
        characterEnd: chunk.characterEnd,
      });
      chunkIds.push(id);
      orderIndex += 1;
    }
  }
  return chunkIds;
}

interface ChunkingPreflight {
  readonly existingCount: number;
  readonly staleChunks: boolean;
}

function loadChunkingPreflight(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  options: ChunkingOptions | undefined,
): ChunkingPreflight {
  const db = store._internal.db;
  const existingCount = countChunksForDocument(db, capsuleId, documentId);
  return {
    existingCount,
    staleChunks:
      existingCount > 0 &&
      hasStaleChunksForDocument(db, capsuleId, documentId, chunkingStrategyKey(options)),
  };
}

function assertDocumentSourceMatches(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  sourceId: KnowledgeSourceId,
): void {
  const documentSourceId = selectDocumentSourceId(store._internal.db, capsuleId, documentId);
  if (documentSourceId !== undefined && String(documentSourceId) !== String(sourceId)) {
    throw new ChunkingError(
      `chunkDocument sourceId ${String(sourceId)} does not match document ${String(documentId)} source ${String(documentSourceId)}`,
    );
  }
}

function shouldReuseExistingChunks(
  preflight: ChunkingPreflight,
  force: boolean | undefined,
): boolean {
  return preflight.existingCount > 0 && force !== true && !preflight.staleChunks;
}

function shouldDeleteExistingChunks(
  preflight: ChunkingPreflight,
  force: boolean | undefined,
): boolean {
  return (force === true || preflight.staleChunks) && preflight.existingCount > 0;
}

export function chunkDocument(
  store: KnowledgeStore,
  params: ChunkDocumentParams,
  options?: ChunkingOptions,
): ChunkDocumentResult {
  const { capsuleId, sourceId, documentId, sourceText, force, signal } = params;
  throwIfAborted(signal);

  const db = store._internal.db;
  const preflight = loadChunkingPreflight(store, capsuleId, documentId, options);
  assertDocumentSourceMatches(store, capsuleId, documentId, sourceId);
  if (shouldReuseExistingChunks(preflight, force)) {
    return { capsuleId, documentId, chunkIds: [], skippedExisting: true };
  }

  const rows = selectParsedUnitsForDocument(db, capsuleId, documentId);
  if (rows.length === 0) {
    return { capsuleId, documentId, chunkIds: [], skippedExisting: false };
  }

  db.exec("BEGIN");
  try {
    if (shouldDeleteExistingChunks(preflight, force)) {
      deleteChunksForDocument(db, capsuleId, documentId);
    }
    const ctx: PersistContext = { capsuleId, sourceId, documentId, sourceText };
    const chunkIds = persistAllChunks(store, ctx, rows, options, signal);
    throwIfAborted(signal);
    db.exec("COMMIT");
    return { capsuleId, documentId, chunkIds, skippedExisting: false };
  } catch (cause) {
    db.exec("ROLLBACK");
    if (cause instanceof ChunkingError) throw cause;
    throw new ChunkingError(
      `chunkDocument failed for document ${String(documentId)}`,
      cause === undefined ? undefined : { cause },
    );
  }
}
