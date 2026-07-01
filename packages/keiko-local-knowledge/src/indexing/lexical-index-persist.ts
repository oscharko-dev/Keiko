import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import { readDocumentTextSpan } from "../discovery/persist.js";
import { lexicalExactText, lexicalIndexedText } from "../retrieval/lexical-normalization.js";
import type { KnowledgeStore } from "../store.js";

const DELETE_LEXICAL_FOR_DOCUMENT_SQL =
  "DELETE FROM chunk_lexical_index WHERE capsule_id = :c AND document_id = :d";

const DELETE_LEXICAL_FOR_CAPSULE_SQL = "DELETE FROM chunk_lexical_index WHERE capsule_id = :c";

const COUNT_LEXICAL_FOR_DOCUMENT_SQL =
  "SELECT COUNT(*) AS n FROM chunk_lexical_index WHERE capsule_id = :c AND document_id = :d";

const COUNT_LEXICAL_FOR_CAPSULE_SQL =
  "SELECT COUNT(*) AS n FROM chunk_lexical_index WHERE capsule_id = :c";

const INSERT_LEXICAL_SQL = [
  "INSERT INTO chunk_lexical_index (",
  "  capsule_id, source_id, document_id, chunk_id, text, exact_text, updated_at",
  ") VALUES (",
  "  :capsule_id, :source_id, :document_id, :chunk_id, :text, :exact_text, :updated_at",
  ")",
  "ON CONFLICT(capsule_id, chunk_id) DO UPDATE SET",
  "  source_id = excluded.source_id,",
  "  document_id = excluded.document_id,",
  "  text = excluded.text,",
  "  exact_text = excluded.exact_text,",
  "  updated_at = excluded.updated_at",
].join(" ");

const SELECT_CHUNK_LEXICAL_SPANS_SQL = [
  "SELECT c.id, c.source_id,",
  "  COALESCE(c.character_start, pu.character_start) AS char_start,",
  "  COALESCE(c.character_end, pu.character_end) AS char_end",
  "FROM chunks AS c",
  "JOIN parsed_units AS pu ON pu.capsule_id = c.capsule_id AND pu.id = c.parsed_unit_id",
  "WHERE c.capsule_id = :c AND c.document_id = :d",
  "ORDER BY c.order_index ASC",
].join(" ");

export interface LexicalChunkIndexRow {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
  readonly text: string;
  readonly exactText?: string;
  readonly updatedAt: number;
}

interface CountRow {
  readonly n: number;
}

interface ChunkLexicalSpanRow {
  readonly id: string;
  readonly source_id: string;
  readonly char_start: number | null;
  readonly char_end: number | null;
}

function runInSavepoint(db: DatabaseSync, name: string, work: () => void): void {
  db.exec(`SAVEPOINT ${name}`);
  try {
    work();
    db.exec(`RELEASE ${name}`);
  } catch (cause) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw cause;
  }
}

export function deleteLexicalRowsForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  db.prepare(DELETE_LEXICAL_FOR_DOCUMENT_SQL).run({ c: String(capsuleId), d: String(documentId) });
}

export function deleteLexicalRowsForCapsule(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
): void {
  db.prepare(DELETE_LEXICAL_FOR_CAPSULE_SQL).run({ c: String(capsuleId) });
}

export function countLexicalRowsForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): number {
  const row = db
    .prepare(COUNT_LEXICAL_FOR_DOCUMENT_SQL)
    .get({ c: String(capsuleId), d: String(documentId) }) as CountRow | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

export function countLexicalRowsForCapsule(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
): number {
  const row = db.prepare(COUNT_LEXICAL_FOR_CAPSULE_SQL).get({ c: String(capsuleId) }) as
    CountRow | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

export function replaceLexicalRowsForDocument(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  rows: readonly LexicalChunkIndexRow[],
): void {
  runInSavepoint(db, "replace_chunk_lexical_document", () => {
    deleteLexicalRowsForDocument(db, capsuleId, documentId);
    const insert = db.prepare(INSERT_LEXICAL_SQL);
    for (const row of rows) {
      insert.run({
        capsule_id: String(row.capsuleId),
        source_id: String(row.sourceId),
        document_id: String(row.documentId),
        chunk_id: String(row.chunkId),
        text: lexicalIndexedText(row.text),
        exact_text: lexicalExactText(row.exactText ?? row.text),
        updated_at: row.updatedAt,
      });
    }
  });
}

export function upsertLexicalRows(
  db: DatabaseSync,
  rows: readonly LexicalChunkIndexRow[],
): void {
  runInSavepoint(db, "upsert_chunk_lexical_rows", () => {
    for (const row of rows) {
      db.prepare(INSERT_LEXICAL_SQL).run({
        capsule_id: String(row.capsuleId),
        source_id: String(row.sourceId),
        document_id: String(row.documentId),
        chunk_id: String(row.chunkId),
        text: lexicalIndexedText(row.text),
        exact_text: lexicalExactText(row.exactText ?? row.text),
        updated_at: row.updatedAt,
      });
    }
  });
}

function selectChunkLexicalSpans(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): readonly ChunkLexicalSpanRow[] {
  return db
    .prepare(SELECT_CHUNK_LEXICAL_SPANS_SQL)
    .all({ c: String(capsuleId), d: String(documentId) }) as unknown as
    readonly ChunkLexicalSpanRow[];
}

export function replaceLexicalRowsFromStoredSpans(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  updatedAt: number,
): void {
  const db = store._internal.db;
  const rows = selectChunkLexicalSpans(db, capsuleId, documentId).map(
    (row): LexicalChunkIndexRow => {
      const start = row.char_start ?? 0;
      const end = row.char_end ?? start;
      const text =
        readDocumentTextSpan(
          db,
          store._internal.contentCipher,
          capsuleId,
          documentId,
          start,
          end,
        ) ?? "";
      return {
        capsuleId,
        sourceId: row.source_id as KnowledgeSourceId,
        documentId,
        chunkId: row.id as ChunkId,
        text,
        exactText: text,
        updatedAt,
      };
    },
  );
  replaceLexicalRowsForDocument(db, capsuleId, documentId, rows);
}
