// Repository code-chunk → one-based line mapping (Issue #2569, ADR-0152 D8).
//
// The mapping is package-owned sidecar state: no shared contract or schema field is widened. It is
// written in the same transaction as each code chunk and cascades with that chunk. Paths remain in
// the owning store; the public resolver returns them only to an authorized retrieval consumer.

import type { ChunkId, DocumentId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import type { KnowledgeStore } from "../store.js";

const INSERT_LINE_RANGE_SQL = `
INSERT INTO repository_chunk_line_ranges (
  capsule_id, chunk_id, document_id, start_line, end_line, document_line_count
) VALUES (
  :capsule_id, :chunk_id, :document_id, :start_line, :end_line, :document_line_count
)
ON CONFLICT(capsule_id, chunk_id) DO UPDATE SET
  document_id = excluded.document_id,
  start_line = excluded.start_line,
  end_line = excluded.end_line,
  document_line_count = excluded.document_line_count
`.trim();

export interface DocumentLineIndex {
  readonly newlineOffsets: readonly number[];
  readonly textLength: number;
  readonly lineCount: number;
}

export interface RepositoryChunkLineRange {
  readonly chunkId: ChunkId;
  readonly documentId: DocumentId;
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly documentLineCount: number;
}

export function buildDocumentLineIndex(text: string): DocumentLineIndex {
  const newlineOffsets: number[] = [];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    newlineOffsets.push(index);
  }
  return { newlineOffsets, textLength: text.length, lineCount: newlineOffsets.length + 1 };
}

function newlineCountBefore(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? Number.POSITIVE_INFINITY) < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function repositoryLineRangeForSpan(
  index: DocumentLineIndex,
  characterStart: number,
  characterEnd: number,
): Pick<RepositoryChunkLineRange, "startLine" | "endLine" | "documentLineCount"> {
  const start = Math.max(0, Math.min(characterStart, index.textLength));
  const end = Math.max(start, Math.min(characterEnd, index.textLength));
  const lastCharacter = end > start ? end - 1 : start;
  return {
    startLine: newlineCountBefore(index.newlineOffsets, start) + 1,
    endLine: newlineCountBefore(index.newlineOffsets, lastCharacter) + 1,
    documentLineCount: index.lineCount,
  };
}

interface PersistRepositoryChunkLineRangeInput {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly chunkId: ChunkId;
  readonly documentId: DocumentId;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly lineIndex: DocumentLineIndex;
}

export function persistRepositoryChunkLineRange(
  db: DatabaseSync,
  input: PersistRepositoryChunkLineRangeInput,
): void {
  const range = repositoryLineRangeForSpan(
    input.lineIndex,
    input.characterStart,
    input.characterEnd,
  );
  db.prepare(INSERT_LINE_RANGE_SQL).run({
    capsule_id: input.capsuleId,
    chunk_id: input.chunkId,
    document_id: input.documentId,
    start_line: range.startLine,
    end_line: range.endLine,
    document_line_count: range.documentLineCount,
  });
}

interface StoredLineRangeRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly document_path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly document_line_count: number;
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

// The driver hands back `unknown`, and casting straight to the row shape would let an undefined
// field surface deep inside citation rendering, far from whatever produced it.
//
// Honest scope: this cannot fire against the current schema. Both tables in the join are STRICT
// with NOT NULL on every column read here, so SQLite itself rejects a row that would fail this
// check. It guards the next migration, not today's data — relax a column or add a LEFT JOIN and
// the cast would start lying silently, whereas this stops at the row that broke the contract.
function asLineRangeRow(value: unknown): StoredLineRangeRow {
  const row = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const chunkId = stringField(row, "chunk_id");
  const documentId = stringField(row, "document_id");
  const documentPath = stringField(row, "document_path");
  const startLine = integerField(row, "start_line");
  const endLine = integerField(row, "end_line");
  const lineCount = integerField(row, "document_line_count");
  if (
    chunkId === undefined ||
    documentId === undefined ||
    documentPath === undefined ||
    startLine === undefined ||
    endLine === undefined ||
    lineCount === undefined
  ) {
    throw new Error("REPOSITORY_CHUNK_LINE_RANGE_ROW_INVALID");
  }
  return {
    chunk_id: chunkId,
    document_id: documentId,
    document_path: documentPath,
    start_line: startLine,
    end_line: endLine,
    document_line_count: lineCount,
  };
}

function toLineRange(row: StoredLineRangeRow): RepositoryChunkLineRange {
  return {
    chunkId: row.chunk_id as ChunkId,
    documentId: row.document_id as DocumentId,
    relativePath: row.document_path,
    startLine: row.start_line,
    endLine: row.end_line,
    documentLineCount: row.document_line_count,
  };
}

export function resolveRepositoryChunkLineRange(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
): RepositoryChunkLineRange | undefined {
  const row = store._internal.db
    .prepare(
      `SELECT r.chunk_id, r.document_id, d.document_path, r.start_line, r.end_line,
              r.document_line_count
       FROM repository_chunk_line_ranges AS r
       JOIN documents AS d ON d.capsule_id = r.capsule_id AND d.id = r.document_id
       WHERE r.capsule_id = :capsule_id AND r.chunk_id = :chunk_id`,
    )
    .get({ capsule_id: capsuleId, chunk_id: chunkId }) as unknown;
  return row === undefined ? undefined : toLineRange(asLineRangeRow(row));
}

export function listRepositoryChunkLineRanges(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId?: DocumentId,
): readonly RepositoryChunkLineRange[] {
  const whereDocument = documentId === undefined ? "" : " AND r.document_id = :document_id";
  const rows = store._internal.db
    .prepare(
      `SELECT r.chunk_id, r.document_id, d.document_path, r.start_line, r.end_line,
              r.document_line_count
       FROM repository_chunk_line_ranges AS r
       JOIN documents AS d ON d.capsule_id = r.capsule_id AND d.id = r.document_id
       WHERE r.capsule_id = :capsule_id${whereDocument}
       ORDER BY d.document_path ASC, r.start_line ASC, r.chunk_id ASC`,
    )
    .all(
      documentId === undefined
        ? { capsule_id: capsuleId }
        : { capsule_id: capsuleId, document_id: documentId },
    ) as readonly unknown[];
  return rows.map((row) => toLineRange(asLineRangeRow(row)));
}
