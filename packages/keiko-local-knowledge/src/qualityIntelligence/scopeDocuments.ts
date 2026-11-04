// scopeDocuments.ts — complete, bounded read of a resolved scope's documents (#4179, Epic #4173).
//
// A request for every requirement of a specification cannot be answered from a few top-ranked
// excerpts, so the documents of the already-resolved scope are read whole, in a deterministic
// order, together with their recorded section boundaries. Nothing here widens a scope: the caller
// passes the capsule and source set retrieval itself resolved, and only text-extracted documents
// are read (no OCR, no image extraction). Everything the bounds cut is counted, never dropped
// silently, so the caller can state an incomplete enumeration as incomplete.

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import { mapChunkToCitation } from "../chunking/citation-mapper.js";
import type { StoreContentCipher } from "../store-content-cipher.js";
import type { KnowledgeStore } from "../store.js";

export const SCOPE_DOCUMENTS_MAX = 64;
export const SCOPE_DOCUMENT_CHARS_MAX = 4_000_000;
/** Text held in memory for one read, across all documents. */
export const SCOPE_TOTAL_CHARS_MAX = 16_000_000;

export interface ScopeDocumentSection {
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
}

export interface ScopeDocument {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly displayName: string;
  /** Content hash of the stored document version. */
  readonly contentHash: string;
  readonly text: string;
  readonly sections: readonly ScopeDocumentSection[];
}

export interface ScopeDocumentRead {
  readonly documents: readonly ScopeDocument[];
  /** Text-extracted documents the scope holds, whether or not they were read. */
  readonly eligibleDocumentCount: number;
  /** Documents of the scope that are not text-extracted (failed, unsupported, skipped, pending, image). */
  readonly notExtractedDocumentCount: number;
  /** Documents left out because the document bound was reached. */
  readonly omittedByCountCount: number;
  /** Documents left out because their text exceeds the per-document bound or cannot be read. */
  readonly omittedByTextCount: number;
}

export interface ScopeDocumentLimits {
  readonly maxDocuments?: number;
  readonly maxCharsPerDocument?: number;
  readonly maxTotalChars?: number;
}

export interface ScopeDocumentScope {
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly sourceFilter?: readonly KnowledgeSourceId[] | undefined;
}

interface DocumentRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly content_hash: string;
  readonly safe_display_name: string;
}

const EXTRACTED_STATUS = "extracted";

function notExtractedCount(db: DatabaseSync, scope: ScopeDocumentScope): number {
  const allowed =
    scope.sourceFilter === undefined ? undefined : new Set(scope.sourceFilter.map(String));
  const statement = db.prepare(
    "SELECT source_id FROM documents WHERE capsule_id = :c AND status <> :s",
  );
  let count = 0;
  for (const capsuleId of scope.capsuleIds) {
    const rows = statement.all({
      c: String(capsuleId),
      s: EXTRACTED_STATUS,
    }) as unknown as readonly {
      readonly source_id: string;
    }[];
    count += rows.filter((row) => allowed === undefined || allowed.has(row.source_id)).length;
  }
  return count;
}

function eligibleDocumentRows(db: DatabaseSync, scope: ScopeDocumentScope): readonly DocumentRow[] {
  const allowed =
    scope.sourceFilter === undefined ? undefined : new Set(scope.sourceFilter.map(String));
  const rows: DocumentRow[] = [];
  const statement = db.prepare(
    "SELECT id, capsule_id, source_id, content_hash, safe_display_name FROM documents WHERE capsule_id = :c AND status = :s ORDER BY document_path, id",
  );
  for (const capsuleId of scope.capsuleIds) {
    for (const row of statement.all({
      c: String(capsuleId),
      s: EXTRACTED_STATUS,
    }) as unknown as readonly DocumentRow[]) {
      if (allowed === undefined || allowed.has(row.source_id)) rows.push(row);
    }
  }
  return rows;
}

interface TextRow {
  readonly normalized_text: string;
}
interface WindowRow {
  readonly normalized_text: string;
  readonly character_start: number;
  readonly character_end: number;
}

/** The whole text, or undefined when it is absent, not contiguous or beyond the bound. */
function readWholeText(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  row: DocumentRow,
  maxChars: number,
): string | undefined {
  const params = { c: row.capsule_id, d: row.id };
  const single = db
    .prepare(
      "SELECT normalized_text FROM document_texts WHERE capsule_id = :c AND document_id = :d",
    )
    .get(params) as TextRow | undefined;
  if (single !== undefined) {
    const text = cipher.openText(single.normalized_text);
    return text.length <= maxChars ? text : undefined;
  }
  const windows = db
    .prepare(
      "SELECT normalized_text, character_start, character_end FROM document_text_windows WHERE capsule_id = :c AND document_id = :d ORDER BY window_index",
    )
    .all(params) as unknown as readonly WindowRow[];
  if (windows.length === 0) return undefined;
  if ((windows.at(-1)?.character_end ?? Number.POSITIVE_INFINITY) > maxChars) return undefined;
  const parts: string[] = [];
  let expected = 0;
  for (const window of windows) {
    if (window.character_start !== expected) return undefined;
    parts.push(cipher.openText(window.normalized_text));
    expected = window.character_end;
  }
  return parts.join("");
}

function parsePath(raw: string | null, cipher: StoreContentCipher): readonly string[] | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(cipher.openText(raw));
  return Array.isArray(parsed) && parsed.every((part) => typeof part === "string")
    ? parsed
    : undefined;
}

interface SectionRow {
  readonly section_path_json: string;
  readonly character_start: number;
  readonly character_end: number;
}
interface UnitRow {
  readonly section_path_json: string | null;
  readonly heading_path_json: string | null;
  readonly character_start: number;
  readonly character_end: number;
}

/**
 * Section boundaries as the parsers recorded them: the `sections` table (Word, PowerPoint) and the
 * section and HTML-block units (Markdown, HTML), which carry the heading paths those formats keep.
 */
function readSections(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  row: DocumentRow,
): readonly ScopeDocumentSection[] {
  const params = { c: row.capsule_id, d: row.id };
  const recorded = (
    db
      .prepare(
        "SELECT section_path_json, character_start, character_end FROM sections WHERE capsule_id = :c AND document_id = :d",
      )
      .all(params) as unknown as readonly SectionRow[]
  ).flatMap((entry) => {
    const sectionPath = parsePath(entry.section_path_json, cipher);
    return sectionPath === undefined
      ? []
      : [{ sectionPath, characterStart: entry.character_start, characterEnd: entry.character_end }];
  });
  const units = (
    db
      .prepare(
        "SELECT section_path_json, heading_path_json, character_start, character_end FROM parsed_units WHERE capsule_id = :c AND document_id = :d AND kind IN ('section', 'html-block') AND character_start IS NOT NULL AND character_end IS NOT NULL ORDER BY rowid",
      )
      .all(params) as unknown as readonly UnitRow[]
  ).flatMap((unit) => {
    const sectionPath = parsePath(unit.section_path_json ?? unit.heading_path_json, cipher);
    return sectionPath === undefined || sectionPath.length === 0
      ? []
      : [{ sectionPath, characterStart: unit.character_start, characterEnd: unit.character_end }];
  });
  return unionSections(recorded, units);
}

function samePath(a: ScopeDocumentSection, b: ScopeDocumentSection): boolean {
  return a.sectionPath.join("\u0000") === b.sectionPath.join("\u0000");
}

/**
 * The recorded sections and the unit sections as one list in document order: consecutive units of
 * one heading path are one section, and a section both sources report is listed once.
 */
export function unionSections(
  recorded: readonly ScopeDocumentSection[],
  units: readonly ScopeDocumentSection[],
): readonly ScopeDocumentSection[] {
  const merged: ScopeDocumentSection[] = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    if (previous !== undefined && samePath(previous, unit))
      merged[merged.length - 1] = {
        sectionPath: previous.sectionPath,
        characterStart: Math.min(previous.characterStart, unit.characterStart),
        characterEnd: Math.max(previous.characterEnd, unit.characterEnd),
      };
    else merged.push(unit);
  }
  const seen = new Set<string>();
  return [...recorded, ...merged]
    .filter((section) => {
      const key = `${section.sectionPath.join("\u0000")}\u0001${String(section.characterStart)}\u0001${String(section.characterEnd)}`;
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => a.characterStart - b.characterStart || a.characterEnd - b.characterEnd);
}

function toDocument(store: KnowledgeStore, row: DocumentRow, text: string): ScopeDocument {
  const { db, contentCipher } = store._internal;
  return {
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    sourceId: row.source_id as KnowledgeSourceId,
    documentId: row.id as DocumentId,
    displayName: row.safe_display_name,
    contentHash: row.content_hash,
    text,
    sections: readSections(db, contentCipher, row),
  };
}

/** The scope's text-extracted documents in a stable order (path, then id), under both bounds. */
export function readScopeDocuments(
  store: KnowledgeStore,
  scope: ScopeDocumentScope,
  limits: ScopeDocumentLimits = {},
): ScopeDocumentRead {
  const maxDocuments = limits.maxDocuments ?? SCOPE_DOCUMENTS_MAX;
  const maxChars = limits.maxCharsPerDocument ?? SCOPE_DOCUMENT_CHARS_MAX;
  const maxTotal = limits.maxTotalChars ?? SCOPE_TOTAL_CHARS_MAX;
  const { db, contentCipher } = store._internal;
  const rows = eligibleDocumentRows(db, scope);
  const documents: ScopeDocument[] = [];
  let omittedByText = 0;
  let held = 0;
  for (const row of rows.slice(0, maxDocuments)) {
    const text = readWholeText(db, contentCipher, row, Math.min(maxChars, maxTotal - held));
    if (text === undefined) {
      omittedByText += 1;
      continue;
    }
    held += text.length;
    documents.push(toDocument(store, row, text));
  }
  return {
    documents,
    eligibleDocumentCount: rows.length,
    notExtractedDocumentCount: notExtractedCount(db, scope),
    omittedByCountCount: Math.max(0, rows.length - maxDocuments),
    omittedByTextCount: omittedByText,
  };
}

export interface ScopeSpan {
  readonly characterStart: number;
  readonly characterEnd: number;
  /** Overrides the section path the covering chunk's parsed unit carries, when it carries none. */
  readonly sectionPath?: readonly string[];
}

type DocumentRef = Pick<ScopeDocument, "capsuleId" | "documentId">;

function coveringChunk(
  db: DatabaseSync,
  document: DocumentRef,
  offset: number,
): string | undefined {
  const params = { c: String(document.capsuleId), d: String(document.documentId), o: offset };
  const covering = db
    .prepare(
      "SELECT id FROM chunks WHERE capsule_id = :c AND document_id = :d AND character_start <= :o AND character_end > :o ORDER BY order_index LIMIT 1",
    )
    .get(params) as { readonly id: string } | undefined;
  if (covering !== undefined) return covering.id;
  const next = db
    .prepare(
      "SELECT id FROM chunks WHERE capsule_id = :c AND document_id = :d AND character_start >= :o ORDER BY character_start, order_index LIMIT 1",
    )
    .get(params) as { readonly id: string } | undefined;
  return next?.id;
}

/**
 * A retrieval reference whose citation points at the exact span, through the chunk that covers its
 * start, so the existing citation, excerpt and preview paths work unchanged. Undefined when the
 * document has no chunk to cite (it is then not retrievable either).
 */
export function referenceForSpan(
  store: KnowledgeStore,
  document: DocumentRef,
  span: ScopeSpan,
): RetrievalReference | undefined {
  const chunkId = coveringChunk(store._internal.db, document, span.characterStart);
  if (chunkId === undefined) return undefined;
  const citation = mapChunkToCitation(store, document.capsuleId, chunkId as ChunkId);
  if (citation === null) return undefined;
  const sectionPath = citation.sectionPath ?? span.sectionPath;
  return {
    chunkId: citation.chunkId,
    capsuleId: document.capsuleId,
    // Document order, not relevance: an enumeration has no ranking.
    score: 1,
    citation: {
      ...citation,
      ...(sectionPath === undefined || sectionPath.length === 0 ? {} : { sectionPath }),
      characterStart: span.characterStart,
      characterEnd: span.characterEnd,
    },
  };
}
