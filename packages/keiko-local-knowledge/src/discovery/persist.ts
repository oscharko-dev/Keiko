// SQLite persistence helpers for the discovery layer (Issue #194). Every helper here is a
// prepared-statement wrapper around a single table; the transaction boundary lives in
// extract.ts so a per-file failure rolls back exactly the rows from that file.
//
// All inserts use REPLACE semantics on the document row (PRIMARY KEY id), but the
// dependent rows (pages, sections, parsed_units, parser_diagnostics) are deleted first via
// the documents-cascade chain — see deleteDependentRows. That keeps a re-extract idempotent:
// running extract twice on the same file leaves exactly one set of rows on disk.

import type {
  DocumentId,
  KnowledgeCapsuleId,
  PageRecord,
  ParsedUnit,
  ParserDiagnostic,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

const INSERT_DOCUMENT_SQL = [
  "INSERT OR REPLACE INTO documents (",
  "  id, capsule_id, source_id, document_path, size_bytes, media_type,",
  "  content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name",
  ") VALUES (",
  "  :id, :capsule_id, :source_id, :document_path, :size_bytes, :media_type,",
  "  :content_hash, :parser_id, :parser_version, :last_extracted_at, :status, :safe_display_name",
  ")",
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
  "  capsule_id, document_id, section_path_json, character_start, character_end",
  ") VALUES (",
  "  :capsule_id, :document_id, :section_path_json, :character_start, :character_end",
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
  db.prepare(INSERT_DOCUMENT_SQL).run({
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
  db.prepare(DELETE_DOCUMENT_TEXT_SQL).run(params);
  db.prepare(DELETE_PAGES_SQL).run(params);
  db.prepare(DELETE_SECTIONS_SQL).run(params);
  db.prepare(DELETE_PARSED_UNITS_SQL).run(params);
  db.prepare(DELETE_DIAGNOSTICS_SQL).run(params);
}

export function insertDocumentTextRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  normalizedText: string,
): void {
  db.prepare(INSERT_DOCUMENT_TEXT_SQL).run({
    capsule_id: capsuleId,
    document_id: documentId,
    normalized_text: normalizedText,
  });
}

interface DocumentTextRow {
  readonly normalized_text: string;
}

export function readDocumentTextRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): string | undefined {
  const row = db.prepare(SELECT_DOCUMENT_TEXT_SQL).get({
    c: capsuleId,
    d: documentId,
  }) as DocumentTextRow | undefined;
  return row?.normalized_text;
}

export function insertPageRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  page: PageRecord,
): void {
  db.prepare(INSERT_PAGE_SQL).run({
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
  capsuleId: KnowledgeCapsuleId,
  section: SectionRecord,
): void {
  db.prepare(INSERT_SECTION_SQL).run({
    capsule_id: capsuleId,
    document_id: section.documentId,
    section_path_json: JSON.stringify(section.sectionPath),
    character_start: section.characterStart,
    character_end: section.characterEnd,
  });
}

// Mutable record shape — `Statement.run` requires `Record<string, SQLInputValue>`, which
// rejects `readonly` field signatures.
type ParsedUnitParams = Record<string, string | number | null>;

function parsedUnitParams(
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
  return populateUnitFields(base, unit);
}

function populateUnitFields(base: ParsedUnitParams, unit: ParsedUnit): ParsedUnitParams {
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
      section_path_json: JSON.stringify(unit.sectionPath),
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
      heading_path_json: unit.headingPath !== undefined ? JSON.stringify(unit.headingPath) : null,
      character_start: unit.characterStart,
      character_end: unit.characterEnd,
    };
  }
  return { ...base, unsupported_reason: unit.reason };
}

export function insertParsedUnitRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  unitId: string,
  unit: ParsedUnit,
): void {
  db.prepare(INSERT_PARSED_UNIT_SQL).run(parsedUnitParams(capsuleId, unitId, unit));
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
  db.prepare(INSERT_DIAGNOSTIC_SQL).run({
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
