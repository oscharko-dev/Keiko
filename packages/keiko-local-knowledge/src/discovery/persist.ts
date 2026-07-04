// SQLite persistence helpers for the discovery layer (Issue #194). Every helper here is a
// prepared-statement wrapper around a single table; the transaction boundary lives in
// extract.ts so a per-file failure rolls back exactly the rows from that file.
//
// Document writes use an UPSERT rather than INSERT OR REPLACE. REPLACE deletes the existing
// document row before inserting the replacement, which would cascade through long-lived child
// tables such as document_blobs. The volatile extraction dependents are still cleaned explicitly
// via deleteDependentRows, keeping re-extract idempotent without deleting historical PDF blobs.

import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  PageRecord,
  ParsedUnit,
  ParserDiagnostic,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import { sectionPathHash } from "../section-path-hash.js";
import type { StoreContentCipher } from "../store-content-cipher.js";

const INSERT_DOCUMENT_SQL = [
  "INSERT INTO documents (",
  "  id, capsule_id, source_id, document_path, size_bytes, media_type,",
  "  content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name",
  ") VALUES (",
  "  :id, :capsule_id, :source_id, :document_path, :size_bytes, :media_type,",
  "  :content_hash, :parser_id, :parser_version, :last_extracted_at, :status, :safe_display_name",
  ")",
  "ON CONFLICT(id) DO UPDATE SET",
  "  capsule_id = excluded.capsule_id,",
  "  source_id = excluded.source_id,",
  "  document_path = excluded.document_path,",
  "  size_bytes = excluded.size_bytes,",
  "  media_type = excluded.media_type,",
  "  blob_ref = CASE",
  "    WHEN documents.content_hash = excluded.content_hash THEN documents.blob_ref",
  "    ELSE NULL",
  "  END,",
  "  content_hash = excluded.content_hash,",
  "  parser_id = excluded.parser_id,",
  "  parser_version = excluded.parser_version,",
  "  last_extracted_at = excluded.last_extracted_at,",
  "  status = excluded.status,",
  "  safe_display_name = excluded.safe_display_name",
].join(" ");

const INSERT_DOCUMENT_TEXT_SQL = [
  "INSERT OR REPLACE INTO document_texts (",
  "  capsule_id, document_id, normalized_text",
  ") VALUES (",
  "  :capsule_id, :document_id, :normalized_text",
  ")",
].join(" ");

const INSERT_PAGE_SQL = [
  "INSERT INTO pages (",
  "  capsule_id, document_id, page_number, page_label, character_start, character_end,",
  "  bbox_x, bbox_y, bbox_w, bbox_h",
  ") VALUES (",
  "  :capsule_id, :document_id, :page_number, :page_label, :character_start, :character_end,",
  "  :bbox_x, :bbox_y, :bbox_w, :bbox_h",
  ")",
].join(" ");

const INSERT_SECTION_SQL = [
  "INSERT INTO sections (",
  "  capsule_id, document_id, section_path_json, section_path_hash, character_start, character_end",
  ") VALUES (",
  "  :capsule_id, :document_id, :section_path_json, :section_path_hash, :character_start, :character_end",
  ")",
].join(" ");

const INSERT_PARSED_UNIT_SQL = [
  "INSERT INTO parsed_units (",
  "  id, capsule_id, document_id, kind, page_number, page_label, section_path_json,",
  "  json_pointer, table_name, row_index, heading_path_json, unsupported_reason,",
  "  character_start, character_end",
  ") VALUES (",
  "  :id, :capsule_id, :document_id, :kind, :page_number, :page_label, :section_path_json,",
  "  :json_pointer, :table_name, :row_index, :heading_path_json, :unsupported_reason,",
  "  :character_start, :character_end",
  ")",
].join(" ");

const INSERT_DIAGNOSTIC_SQL = [
  "INSERT INTO parser_diagnostics (",
  "  id, capsule_id, document_id, severity, code, message, page_number, created_at",
  ") VALUES (",
  "  :id, :capsule_id, :document_id, :severity, :code, :message, :page_number, :created_at",
  ")",
].join(" ");

const DELETE_PAGES_SQL = "DELETE FROM pages WHERE capsule_id = :c AND document_id = :d";
const DELETE_SECTIONS_SQL = "DELETE FROM sections WHERE capsule_id = :c AND document_id = :d";
const DELETE_DOCUMENT_TEXT_SQL =
  "DELETE FROM document_texts WHERE capsule_id = :c AND document_id = :d";
const DELETE_PARSED_UNITS_SQL =
  "DELETE FROM parsed_units WHERE capsule_id = :c AND document_id = :d";
const DELETE_DIAGNOSTICS_SQL =
  "DELETE FROM parser_diagnostics WHERE capsule_id = :c AND document_id = :d";
const SELECT_DOCUMENT_TEXT_SQL =
  "SELECT normalized_text FROM document_texts WHERE capsule_id = :c AND document_id = :d";

// ─── Bounded large-document text windows (Epic #1160, Issue #1286) ─────────────
const INSERT_DOCUMENT_TEXT_WINDOW_SQL = [
  "INSERT OR REPLACE INTO document_text_windows (",
  "  capsule_id, document_id, window_index, character_start, character_end, normalized_text",
  ") VALUES (",
  "  :capsule_id, :document_id, :window_index, :character_start, :character_end, :normalized_text",
  ")",
].join(" ");

const DELETE_DOCUMENT_TEXT_WINDOWS_SQL =
  "DELETE FROM document_text_windows WHERE capsule_id = :c AND document_id = :d";
const DELETE_EXTRACTION_CHECKPOINT_SQL =
  "DELETE FROM extraction_checkpoints WHERE capsule_id = :c AND document_id = :d";

// SQLite SUBSTR is 1-indexed; a document-relative char offset `s` maps to SUBSTR position `s + 1`.
const SELECT_DOCUMENT_TEXT_SPAN_SQL =
  "SELECT SUBSTR(normalized_text, :start + 1, :len) AS span FROM document_texts WHERE capsule_id = :c AND document_id = :d";

const SELECT_DOCUMENT_TEXT_WINDOW_SPAN_SQL = [
  "SELECT SUBSTR(normalized_text, :start - character_start + 1, :len) AS span",
  "FROM document_text_windows",
  "WHERE capsule_id = :c AND document_id = :d AND character_start <= :start AND character_end >= :end",
  "ORDER BY window_index ASC LIMIT 1",
].join(" ");

// Encrypted-store span read: SQLite SUBSTR cannot slice a sealed envelope, so the encrypted path
// fetches the one bounded window that contains the span (with its character_start), decrypts that
// single window, and slices in JS. Returns the whole sealed window text so the caller decrypts once.
const SELECT_DOCUMENT_TEXT_WINDOW_FULL_SQL = [
  "SELECT normalized_text, character_start AS character_start",
  "FROM document_text_windows",
  "WHERE capsule_id = :c AND document_id = :d AND character_start <= :start AND character_end >= :end",
  "ORDER BY window_index ASC LIMIT 1",
].join(" ");
const SELECT_DOCUMENTS_FOR_SOURCE_SQL = [
  "SELECT id, document_path FROM documents",
  "WHERE capsule_id = :c AND source_id = :s",
  "ORDER BY document_path ASC",
].join(" ");
const DELETE_DOCUMENT_SQL = "DELETE FROM documents WHERE capsule_id = :c AND id = :d";
const DELETE_DOCUMENT_BY_ID_SQL = "DELETE FROM documents WHERE id = :id";
const SELECT_DOCUMENT_CAPSULE_BY_ID_SQL =
  "SELECT capsule_id, content_hash FROM documents WHERE id = :id";
const UPDATE_DOCUMENT_STATUS_SQL =
  "UPDATE documents SET status = :status WHERE capsule_id = :c AND id = :d";
const DELETE_UNREFERENCED_DOCUMENT_BLOBS_SQL = [
  "DELETE FROM document_blobs",
  "WHERE capsule_id = :c",
  "  AND NOT EXISTS (",
  "    SELECT 1 FROM documents",
  "    WHERE documents.capsule_id = document_blobs.capsule_id",
  "      AND documents.blob_ref = document_blobs.content_hash",
  "  )",
].join(" ");

type SqlValue = string | number | null | Uint8Array;
type SqlParams = Record<string, SqlValue>;

interface RunStatement {
  readonly run: (params?: SqlParams) => unknown;
}

interface GetStatement {
  readonly get: (params?: SqlParams) => unknown;
}

interface DiscoveryStatements {
  readonly insertDocument: RunStatement;
  readonly insertDocumentText: RunStatement;
  readonly insertPage: RunStatement;
  readonly insertSection: RunStatement;
  readonly insertParsedUnit: RunStatement;
  readonly insertDiagnostic: RunStatement;
  readonly deletePages: RunStatement;
  readonly deleteSections: RunStatement;
  readonly deleteDocumentText: RunStatement;
  readonly deleteParsedUnits: RunStatement;
  readonly deleteDiagnostics: RunStatement;
  readonly deleteDocument: RunStatement;
  readonly deleteDocumentById: RunStatement;
  readonly deleteUnreferencedDocumentBlobs: RunStatement;
  readonly selectDocumentCapsuleById: GetStatement;
  readonly selectDocumentText: GetStatement;
  readonly insertDocumentTextWindow: RunStatement;
  readonly deleteDocumentTextWindows: RunStatement;
  readonly deleteExtractionCheckpoint: RunStatement;
  readonly selectDocumentTextSpan: GetStatement;
  readonly selectDocumentTextWindowSpan: GetStatement;
  readonly selectDocumentTextWindowFull: GetStatement;
  readonly selectDocumentsForSource: {
    readonly all: (params?: SqlParams) => readonly unknown[];
  };
}

const statementsByDb = new WeakMap<DatabaseSync, DiscoveryStatements>();

function statements(db: DatabaseSync): DiscoveryStatements {
  const cached = statementsByDb.get(db);
  if (cached !== undefined) {
    return cached;
  }
  const prepared: DiscoveryStatements = {
    insertDocument: db.prepare(INSERT_DOCUMENT_SQL) as RunStatement,
    insertDocumentText: db.prepare(INSERT_DOCUMENT_TEXT_SQL) as RunStatement,
    insertPage: db.prepare(INSERT_PAGE_SQL) as RunStatement,
    insertSection: db.prepare(INSERT_SECTION_SQL) as RunStatement,
    insertParsedUnit: db.prepare(INSERT_PARSED_UNIT_SQL) as RunStatement,
    insertDiagnostic: db.prepare(INSERT_DIAGNOSTIC_SQL) as RunStatement,
    deletePages: db.prepare(DELETE_PAGES_SQL) as RunStatement,
    deleteSections: db.prepare(DELETE_SECTIONS_SQL) as RunStatement,
    deleteDocumentText: db.prepare(DELETE_DOCUMENT_TEXT_SQL) as RunStatement,
    deleteParsedUnits: db.prepare(DELETE_PARSED_UNITS_SQL) as RunStatement,
    deleteDiagnostics: db.prepare(DELETE_DIAGNOSTICS_SQL) as RunStatement,
    deleteDocument: db.prepare(DELETE_DOCUMENT_SQL) as RunStatement,
    deleteDocumentById: db.prepare(DELETE_DOCUMENT_BY_ID_SQL) as RunStatement,
    deleteUnreferencedDocumentBlobs: db.prepare(
      DELETE_UNREFERENCED_DOCUMENT_BLOBS_SQL,
    ) as RunStatement,
    selectDocumentCapsuleById: db.prepare(SELECT_DOCUMENT_CAPSULE_BY_ID_SQL) as GetStatement,
    selectDocumentText: db.prepare(SELECT_DOCUMENT_TEXT_SQL) as GetStatement,
    insertDocumentTextWindow: db.prepare(INSERT_DOCUMENT_TEXT_WINDOW_SQL) as RunStatement,
    deleteDocumentTextWindows: db.prepare(DELETE_DOCUMENT_TEXT_WINDOWS_SQL) as RunStatement,
    deleteExtractionCheckpoint: db.prepare(DELETE_EXTRACTION_CHECKPOINT_SQL) as RunStatement,
    selectDocumentTextSpan: db.prepare(SELECT_DOCUMENT_TEXT_SPAN_SQL) as GetStatement,
    selectDocumentTextWindowSpan: db.prepare(SELECT_DOCUMENT_TEXT_WINDOW_SPAN_SQL) as GetStatement,
    selectDocumentTextWindowFull: db.prepare(SELECT_DOCUMENT_TEXT_WINDOW_FULL_SQL) as GetStatement,
    selectDocumentsForSource: db.prepare(SELECT_DOCUMENTS_FOR_SOURCE_SQL) as {
      readonly all: (params?: SqlParams) => readonly unknown[];
    },
  };
  statementsByDb.set(db, prepared);
  return prepared;
}

export interface DocumentInsertRow {
  readonly id: DocumentId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: string;
  readonly documentPath: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly lastExtractedAt: number;
  readonly status: string;
  readonly safeDisplayName: string;
}

export function insertDocumentRow(db: DatabaseSync, row: DocumentInsertRow): void {
  const prepared = statements(db);
  const existing = prepared.selectDocumentCapsuleById.get({ id: row.id }) as
    { readonly capsule_id: string; readonly content_hash: string } | undefined;
  if (existing !== undefined && existing.capsule_id !== row.capsuleId) {
    // Document ids are globally primary-keyed in the current schema. Production ids include the
    // capsule/source lineage, but older tests and seeds can collide across capsules; preserve the
    // legacy replacement behavior for that impossible production state while keeping same-capsule
    // re-extraction non-destructive for document_blobs.
    prepared.deleteDocumentById.run({ id: row.id });
    prepared.deleteUnreferencedDocumentBlobs.run({ c: existing.capsule_id });
  }
  prepared.insertDocument.run({
    id: row.id,
    capsule_id: row.capsuleId,
    source_id: row.sourceId,
    document_path: row.documentPath,
    size_bytes: row.sizeBytes,
    media_type: row.mediaType,
    content_hash: row.contentHash,
    parser_id: row.parserId,
    parser_version: row.parserVersion,
    last_extracted_at: row.lastExtractedAt,
    status: row.status,
    safe_display_name: row.safeDisplayName,
  });
}

export function deleteDependentRows(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  const params = { c: capsuleId, d: documentId };
  statements(db).deleteDocumentText.run(params);
  statements(db).deleteDocumentTextWindows.run(params);
  statements(db).deleteExtractionCheckpoint.run(params);
  statements(db).deletePages.run(params);
  statements(db).deleteSections.run(params);
  statements(db).deleteParsedUnits.run(params);
  statements(db).deleteDiagnostics.run(params);
}

export function insertDocumentTextRow(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  normalizedText: string,
): void {
  statements(db).insertDocumentText.run({
    capsule_id: capsuleId,
    document_id: documentId,
    normalized_text: cipher.sealText(normalizedText),
  });
}

interface DocumentTextRow {
  readonly normalized_text: string;
}

export function readDocumentTextRow(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): string | undefined {
  const row = statements(db).selectDocumentText.get({
    c: capsuleId,
    d: documentId,
  }) as DocumentTextRow | undefined;
  return row === undefined ? undefined : cipher.openText(row.normalized_text);
}

// ─── Bounded large-document text windows (Epic #1160, Issue #1286) ─────────────
export interface DocumentTextWindowInsertRow {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: DocumentId;
  readonly windowIndex: number;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly normalizedText: string;
}

export function insertDocumentTextWindowRow(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  row: DocumentTextWindowInsertRow,
): void {
  statements(db).insertDocumentTextWindow.run({
    capsule_id: String(row.capsuleId),
    document_id: String(row.documentId),
    window_index: row.windowIndex,
    character_start: row.characterStart,
    character_end: row.characterEnd,
    normalized_text: cipher.sealText(row.normalizedText),
  });
}

export function deleteDocumentTextWindows(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  statements(db).deleteDocumentTextWindows.run({ c: capsuleId, d: documentId });
}

interface SpanRow {
  readonly span: string | null;
}

interface WindowFullRow {
  readonly normalized_text: string;
  readonly character_start: number;
}

// Reads a bounded, document-relative character span without ever materializing the whole
// document text. Resolves from the one `document_text_windows` row that contains the span
// when a large document has bounded windows, otherwise falls back to `document_texts` for
// small files. Returns undefined when no text is stored for the document.
//
// Plaintext stores slice the span in SQLite via SUBSTR so the whole column never enters JS. Encrypted
// stores cannot SUBSTR a sealed envelope, so they decrypt exactly one bounded unit — the small-document
// row or the single window that contains the span — and slice in JS. The Issue #1286 memory bound holds
// either way: a window is bounded and a document_texts row is only used for small documents.
export function readDocumentTextSpan(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  charStart: number,
  charEnd: number,
): string | undefined {
  const start = Math.max(0, Math.floor(charStart));
  const end = Math.max(start, Math.floor(charEnd));
  const len = end - start;
  const c = String(capsuleId);
  const d = String(documentId);
  if (!cipher.isEncrypted) {
    const windowed = statements(db).selectDocumentTextWindowSpan.get({ c, d, start, end, len }) as
      SpanRow | undefined;
    if (windowed !== undefined) {
      return windowed.span ?? "";
    }
    const single = statements(db).selectDocumentTextSpan.get({ c, d, start, len }) as
      SpanRow | undefined;
    return single === undefined ? undefined : (single.span ?? "");
  }
  const windowed = statements(db).selectDocumentTextWindowFull.get({ c, d, start, end }) as
    WindowFullRow | undefined;
  if (windowed !== undefined) {
    const offset = start - windowed.character_start;
    return cipher.openText(windowed.normalized_text).slice(offset, offset + len);
  }
  const single = statements(db).selectDocumentText.get({ c, d }) as DocumentTextRow | undefined;
  if (single !== undefined) {
    return cipher.openText(single.normalized_text).slice(start, start + len);
  }
  return undefined;
}

export interface PersistedSourceDocumentRow {
  readonly id: DocumentId;
  readonly document_path: string;
}

export function listPersistedDocumentsForSource(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): readonly PersistedSourceDocumentRow[] {
  const rows = statements(db).selectDocumentsForSource.all({
    c: capsuleId,
    s: sourceId,
  });
  return rows as readonly PersistedSourceDocumentRow[];
}

export function deleteDocumentRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): void {
  deleteDependentRows(db, capsuleId, documentId);
  statements(db).deleteDocument.run({ c: capsuleId, d: documentId });
  collectGarbageDocumentBlobs(db, capsuleId);
}

export function collectGarbageDocumentBlobs(db: DatabaseSync, capsuleId: KnowledgeCapsuleId): void {
  statements(db).deleteUnreferencedDocumentBlobs.run({ c: capsuleId });
}

export function updateDocumentStatusRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  status: DocumentInsertRow["status"],
): void {
  db.prepare(UPDATE_DOCUMENT_STATUS_SQL).run({
    status,
    c: capsuleId,
    d: documentId,
  });
}

export function insertPageRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  page: PageRecord,
): void {
  statements(db).insertPage.run({
    capsule_id: capsuleId,
    document_id: page.documentId,
    page_number: page.pageNumber,
    page_label: page.pageLabel ?? null,
    character_start: page.characterStart,
    character_end: page.characterEnd,
    bbox_x: page.boundingBox?.x ?? null,
    bbox_y: page.boundingBox?.y ?? null,
    bbox_w: page.boundingBox?.w ?? null,
    bbox_h: page.boundingBox?.h ?? null,
  });
}

export function insertSectionRow(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  capsuleId: KnowledgeCapsuleId,
  section: SectionRecord,
): void {
  const sectionPathJson = JSON.stringify(section.sectionPath);
  statements(db).insertSection.run({
    capsule_id: capsuleId,
    document_id: section.documentId,
    section_path_json: cipher.sealText(sectionPathJson),
    section_path_hash: sectionPathHash(section.sectionPath),
    character_start: section.characterStart,
    character_end: section.characterEnd,
  });
}

// Mutable record shape — `Statement.run` requires `Record<string, SQLInputValue>`, which
// rejects `readonly` field signatures.
type ParsedUnitParams = Record<string, string | number | null>;

function parsedUnitParams(
  cipher: StoreContentCipher,
  capsuleId: KnowledgeCapsuleId,
  unitId: string,
  unit: ParsedUnit,
): ParsedUnitParams {
  const base: ParsedUnitParams = {
    id: unitId,
    capsule_id: String(capsuleId),
    document_id: String(unit.documentId),
    kind: unit.kind,
    page_number: null,
    page_label: null,
    section_path_json: null,
    json_pointer: null,
    table_name: null,
    row_index: null,
    heading_path_json: null,
    unsupported_reason: null,
    character_start: null,
    character_end: null,
  };
  return populateUnitFields(base, unit, cipher);
}

function populateUnitFields(
  base: ParsedUnitParams,
  unit: ParsedUnit,
  cipher: StoreContentCipher,
): ParsedUnitParams {
  if (unit.kind === "page") {
    return {
      ...base,
      page_number: unit.pageNumber,
      page_label: unit.pageLabel ?? null,
      character_start: unit.characterStart,
      character_end: unit.characterEnd,
    };
  }
  if (unit.kind === "section") {
    return {
      ...base,
      section_path_json: cipher.sealText(JSON.stringify(unit.sectionPath)),
      character_start: unit.characterStart,
      character_end: unit.characterEnd,
    };
  }
  if (unit.kind === "json-path") {
    return {
      ...base,
      json_pointer: unit.jsonPointer,
      character_start: unit.characterStart,
      character_end: unit.characterEnd,
    };
  }
  if (unit.kind === "csv-row") {
    return {
      ...base,
      table_name: unit.tableName,
      row_index: unit.rowIndex,
      character_start: unit.characterStart,
      character_end: unit.characterEnd,
    };
  }
  if (unit.kind === "html-block") {
    return {
      ...base,
      heading_path_json:
        unit.headingPath !== undefined ? cipher.sealText(JSON.stringify(unit.headingPath)) : null,
      character_start: unit.characterStart,
      character_end: unit.characterEnd,
    };
  }
  return { ...base, unsupported_reason: unit.reason };
}

export function insertParsedUnitRow(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  capsuleId: KnowledgeCapsuleId,
  unitId: string,
  unit: ParsedUnit,
): void {
  statements(db).insertParsedUnit.run(parsedUnitParams(cipher, capsuleId, unitId, unit));
}

export function insertDiagnosticRow(
  db: DatabaseSync,
  params: {
    readonly id: string;
    readonly capsuleId: KnowledgeCapsuleId;
    readonly diagnostic: ParserDiagnostic;
    readonly createdAt: number;
  },
): void {
  statements(db).insertDiagnostic.run({
    id: params.id,
    capsule_id: params.capsuleId,
    document_id: params.diagnostic.documentId ?? null,
    severity: params.diagnostic.severity,
    code: params.diagnostic.code,
    message: params.diagnostic.message,
    page_number: params.diagnostic.pageNumber ?? null,
    created_at: params.createdAt,
  });
}

interface ExistingDocumentRow {
  readonly content_hash: string;
  readonly status: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly parser_id: string;
  readonly parser_version: string;
  readonly last_extracted_at: number;
  readonly safe_display_name: string;
  readonly document_path: string;
  readonly source_id: string;
}

export function readExistingDocumentRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): ExistingDocumentRow | undefined {
  const row = db
    .prepare("SELECT * FROM documents WHERE capsule_id = :c AND id = :d")
    .get({ c: capsuleId, d: documentId });
  return row === undefined ? undefined : (row as unknown as ExistingDocumentRow);
}
