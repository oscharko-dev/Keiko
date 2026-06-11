// Prepared-statement helpers for the `chunks` table (Epic #189, Issue #195). Every helper
// wraps a single statement so the runner can compose them inside a transaction in
// `chunker-runner.ts`. The runner is the only module that issues transactions for chunks —
// mirrors the `discovery/persist.ts` boundary convention so a per-document failure rolls
// back exactly the rows from that document.

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_CHUNKING_STRATEGY_KEY } from "./types.js";

const INSERT_CHUNK_SQL = [
  "INSERT INTO chunks (",
  "  id, capsule_id, source_id, document_id, parsed_unit_id,",
  "  order_index, token_count, safe_excerpt_hash, chunking_strategy_version,",
  "  character_start, character_end",
  ") VALUES (",
  "  :id, :capsule_id, :source_id, :document_id, :parsed_unit_id,",
  "  :order_index, :token_count, :safe_excerpt_hash, :chunking_strategy_version,",
  "  :character_start, :character_end",
  ")",
].join(" ");

const DELETE_CHUNKS_FOR_DOCUMENT_SQL =
  "DELETE FROM chunks WHERE capsule_id = :c AND document_id = :d";

const COUNT_CHUNKS_FOR_DOCUMENT_SQL =
  "SELECT COUNT(*) AS n FROM chunks WHERE capsule_id = :c AND document_id = :d";

const COUNT_STALE_CHUNKS_FOR_DOCUMENT_SQL = [
  "SELECT COUNT(*) AS n FROM chunks",
  "WHERE capsule_id = :c AND document_id = :d",
  "  AND (chunking_strategy_version IS NULL OR chunking_strategy_version <> :v)",
].join(" ");

const SELECT_PARSED_UNITS_FOR_DOCUMENT_SQL = [
  "SELECT id, kind, page_number, page_label, section_path_json,",
  "  json_pointer, table_name, row_index, heading_path_json,",
  "  unsupported_reason, character_start, character_end",
  "FROM parsed_units",
  "WHERE capsule_id = :c AND document_id = :d",
  "ORDER BY rowid ASC",
].join(" ");

export interface ChunkInsertRow {
  readonly id: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly parsedUnitId: string;
  readonly orderIndex: number;
  readonly tokenCount: number;
  readonly safeExcerptHash: string;
  readonly chunkingStrategyVersion: string;
  // Document-relative span of this chunk (not its parsed unit). Persisting it lets the
  // indexing orchestrator embed each chunk's own bounded sub-span instead of re-deriving
  // the full parsed-unit span, which would emit duplicate vectors for multi-chunk units.
  readonly characterStart: number;
  readonly characterEnd: number;
}

export function insertChunkRow(db: DatabaseSync, row: ChunkInsertRow): void {
  db.prepare(INSERT_CHUNK_SQL).run({
    id: String(row.id),
    capsule_id: String(row.capsuleId),
    source_id: String(row.sourceId),
    document_id: String(row.documentId),
    parsed_unit_id: row.parsedUnitId,
    order_index: row.orderIndex,
    token_count: row.tokenCount,
    safe_excerpt_hash: row.safeExcerptHash,
    chunking_strategy_version: row.chunkingStrategyVersion,
    character_start: row.characterStart,
    character_end: row.characterEnd,
  });
}

export function deleteChunksForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  db.prepare(DELETE_CHUNKS_FOR_DOCUMENT_SQL).run({ c: capsuleId, d: documentId });
}

interface CountRow {
  readonly n: number;
}

export function countChunksForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): number {
  const row = db.prepare(COUNT_CHUNKS_FOR_DOCUMENT_SQL).get({ c: capsuleId, d: documentId }) as
    | CountRow
    | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

export function hasStaleChunksForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  chunkingStrategyVersion: string = DEFAULT_CHUNKING_STRATEGY_KEY,
): boolean {
  const row = db.prepare(COUNT_STALE_CHUNKS_FOR_DOCUMENT_SQL).get({
    c: capsuleId,
    d: documentId,
    v: chunkingStrategyVersion,
  }) as CountRow | undefined;
  return (row?.n ?? 0) > 0;
}

interface DocumentSourceRow {
  readonly source_id: string;
}

export function selectDocumentSourceId(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): KnowledgeSourceId | undefined {
  const row = db
    .prepare("SELECT source_id FROM documents WHERE capsule_id = :c AND id = :d")
    .get({ c: capsuleId, d: documentId }) as DocumentSourceRow | undefined;
  return row === undefined ? undefined : (row.source_id as KnowledgeSourceId);
}

// The raw row shape we read from `parsed_units`. `kind` and offset columns mirror the
// schema-#265 columns; the runner reconstitutes a typed `ParsedUnit` discriminant union
// from these fields.
export interface ParsedUnitRow {
  readonly id: string;
  readonly kind: string;
  readonly page_number: number | null;
  readonly page_label: string | null;
  readonly section_path_json: string | null;
  readonly json_pointer: string | null;
  readonly table_name: string | null;
  readonly row_index: number | null;
  readonly heading_path_json: string | null;
  readonly unsupported_reason: string | null;
  readonly character_start: number | null;
  readonly character_end: number | null;
}

export function selectParsedUnitsForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): readonly ParsedUnitRow[] {
  const rows = db
    .prepare(SELECT_PARSED_UNITS_FOR_DOCUMENT_SQL)
    .all({ c: capsuleId, d: documentId });
  return rows as unknown as readonly ParsedUnitRow[];
}
