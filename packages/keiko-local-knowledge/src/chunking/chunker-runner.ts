// Per-document chunker orchestrator (Epic #189, Issue #195).
//
// Reads parsed_units for the document, runs the pure `chunkParsedUnit` per unit, and
// persists chunks inside a single transaction so a mid-document failure (or AbortSignal
// cancellation) rolls back ALL chunks for the document — never half-chunked state.
//
// Idempotency: with `force: false` (default) and existing chunks already in the table,
// the runner is a no-op and returns `skippedExisting: true`. With `force: true`, prior
// chunks are deleted at the start of the transaction.

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";

import { chunkParsedUnit } from "./chunker.js";
import {
  countChunksForDocument,
  deleteChunksForDocument,
  insertChunkRow,
  selectParsedUnitsForDocument,
  type ParsedUnitRow,
} from "./chunker-persist.js";
import type { KnowledgeStore } from "../store.js";
import type { ChunkDocumentParams, ChunkDocumentResult, ChunkingOptions } from "./types.js";
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
): readonly string[] {
  if (raw === null) {
    throw new ChunkingError(`parsed_unit ${unitId} is missing required field ${field}`);
  }
  const parsed: unknown = JSON.parse(raw);
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

function rowToSectionUnit(row: ParsedUnitRow, documentId: DocumentId): ParsedUnit {
  return {
    kind: "section",
    documentId,
    sectionPath: parseStringArrayField(row.section_path_json, "section_path_json", row.id),
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

function rowToHtmlBlockUnit(row: ParsedUnitRow, documentId: DocumentId): ParsedUnit {
  const heading =
    row.heading_path_json === null
      ? undefined
      : parseStringArrayField(row.heading_path_json, "heading_path_json", row.id);
  return {
    kind: "html-block",
    documentId,
    ...(heading !== undefined ? { headingPath: heading } : {}),
    characterStart: expectNumber(row.character_start, "character_start", row.id),
    characterEnd: expectNumber(row.character_end, "character_end", row.id),
  };
}

function rowToParsedUnit(row: ParsedUnitRow, documentId: DocumentId): ParsedUnit {
  switch (row.kind) {
    case "page":
      return rowToPageUnit(row, documentId);
    case "section":
      return rowToSectionUnit(row, documentId);
    case "json-path":
      return rowToJsonPathUnit(row, documentId);
    case "csv-row":
      return rowToCsvRowUnit(row, documentId);
    case "html-block":
      return rowToHtmlBlockUnit(row, documentId);
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
// Chunk IDs are deterministic on (documentId, parsedUnitRowId, orderIndex). Using a
// composite scheme — rather than UUIDs — keeps the chunks table re-runnable: a
// re-chunk with force=true reproduces byte-identical row IDs, which makes the audit /
// evidence-manifest layer's row-equality assertions hold across runs.
function composeChunkId(
  documentId: DocumentId,
  parsedUnitRowId: string,
  orderIndex: number,
): ChunkId {
  return `${String(documentId)}#${parsedUnitRowId}#c${String(orderIndex)}` as ChunkId;
}

// ─── Top-level entrypoint ────────────────────────────────────────────────────
interface PersistContext {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly sourceText: string;
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
  let orderIndex = 0;
  for (const row of rows) {
    throwIfAborted(signal);
    const unit = rowToParsedUnit(row, ctx.documentId);
    const chunks = chunkParsedUnit(unit, ctx.sourceText, options);
    for (const chunk of chunks) {
      const id = composeChunkId(ctx.documentId, row.id, orderIndex);
      insertChunkRow(db, {
        id,
        capsuleId: ctx.capsuleId,
        sourceId: ctx.sourceId,
        documentId: ctx.documentId,
        parsedUnitId: row.id,
        orderIndex,
        tokenCount: chunk.tokenCount,
        safeExcerptHash: chunk.safeExcerptHash,
      });
      chunkIds.push(id);
      orderIndex += 1;
    }
  }
  return chunkIds;
}

export function chunkDocument(
  store: KnowledgeStore,
  params: ChunkDocumentParams,
  options?: ChunkingOptions,
): ChunkDocumentResult {
  const { capsuleId, sourceId, documentId, sourceText, force, signal } = params;
  throwIfAborted(signal);

  const db = store._internal.db;
  const existingCount = countChunksForDocument(db, capsuleId, documentId);
  if (existingCount > 0 && force !== true) {
    return { capsuleId, documentId, chunkIds: [], skippedExisting: true };
  }

  const rows = selectParsedUnitsForDocument(db, capsuleId, documentId);
  if (rows.length === 0) {
    return { capsuleId, documentId, chunkIds: [], skippedExisting: false };
  }

  db.exec("BEGIN");
  try {
    if (force === true && existingCount > 0) {
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
