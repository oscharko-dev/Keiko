// Citation hop (Epic #189, Issue #195).
//
// Given a (capsuleId, chunkId), produce a `CitationReference` by walking
// chunk → parsed_unit → document → page/section. The function is read-only and pure
// with respect to the store: it never mutates rows.
//
// Hop strategy:
//   1. Look up the chunk row. Returns null when the chunk is absent — distinct from
//      throwing, because retrieval callers (#199) treat missing-chunk as "stale index
//      pointer" and recover by re-running chunking, not by surfacing an error.
//   2. Look up its parsed_unit row in the same capsule scope.
//   3. From the parsed_unit's kind, hop:
//        - kind=page: copy pageNumber/pageLabel + characterStart/End directly.
//        - kind=section: copy sectionPath + characterStart/End directly.
//        - kind=html-block: copy headingPath + characterStart/End.
//        - other kinds (json-path, csv-row, unsupported-media): characterStart/End only.
//      THEN: if the parsed_unit's span overlaps any persisted `pages` row, attach that
//      page's pageNumber/pageLabel — section units inside a paged document still
//      surface a citation page number.
//   4. Document row provides safeDisplayName + sourceId.

import type {
  CapsuleSetId,
  ChunkId,
  CitationReference,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import type { KnowledgeStore } from "../store.js";

interface ChunkRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly parsed_unit_id: string;
}

interface ParsedUnitHopRow {
  readonly kind: string;
  readonly page_number: number | null;
  readonly page_label: string | null;
  readonly section_path_json: string | null;
  readonly heading_path_json: string | null;
  readonly character_start: number | null;
  readonly character_end: number | null;
}

interface DocumentHopRow {
  readonly source_id: string;
  readonly safe_display_name: string;
}

interface PageHopRow {
  readonly page_number: number;
  readonly page_label: string | null;
}

const SELECT_CHUNK_SQL =
  "SELECT id, capsule_id, source_id, document_id, parsed_unit_id FROM chunks WHERE capsule_id = :c AND id = :id";

const SELECT_PARSED_UNIT_SQL = [
  "SELECT kind, page_number, page_label, section_path_json,",
  "  heading_path_json, character_start, character_end",
  "FROM parsed_units",
  "WHERE capsule_id = :c AND id = :id",
].join(" ");

const SELECT_DOCUMENT_SQL =
  "SELECT source_id, safe_display_name FROM documents WHERE capsule_id = :c AND id = :id";

// Page-hop query: find a page row that contains the parsed_unit's character span.
// Used to attach a page number to non-page units (e.g. sections / html-blocks inside a
// paged document). Limit 1 — citations point at the first containing page.
const SELECT_PAGE_FOR_RANGE_SQL = [
  "SELECT page_number, page_label FROM pages",
  "WHERE capsule_id = :c AND document_id = :d",
  "  AND character_start <= :s AND character_end >= :e",
  "ORDER BY page_number ASC LIMIT 1",
].join(" ");

function fetchChunkRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
): ChunkRow | undefined {
  const row = db.prepare(SELECT_CHUNK_SQL).get({ c: capsuleId, id: String(chunkId) });
  return row === undefined ? undefined : (row as unknown as ChunkRow);
}

function fetchParsedUnitRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  parsedUnitId: string,
): ParsedUnitHopRow | undefined {
  const row = db.prepare(SELECT_PARSED_UNIT_SQL).get({ c: capsuleId, id: parsedUnitId });
  return row === undefined ? undefined : (row as unknown as ParsedUnitHopRow);
}

function fetchDocumentRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
): DocumentHopRow | undefined {
  const row = db.prepare(SELECT_DOCUMENT_SQL).get({ c: capsuleId, id: String(documentId) });
  return row === undefined ? undefined : (row as unknown as DocumentHopRow);
}

function fetchPageForRange(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  characterStart: number,
  characterEnd: number,
): PageHopRow | undefined {
  const row = db
    .prepare(SELECT_PAGE_FOR_RANGE_SQL)
    .get({ c: capsuleId, d: String(documentId), s: characterStart, e: characterEnd });
  return row === undefined ? undefined : (row as unknown as PageHopRow);
}

function parseStringArray(raw: string | null): readonly string[] | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return parsed;
}

interface HopFields {
  readonly pageNumber: number | undefined;
  readonly pageLabel: string | undefined;
  readonly sectionPath: readonly string[] | undefined;
  readonly characterStart: number | undefined;
  readonly characterEnd: number | undefined;
}

function hopFieldsForUnit(unit: ParsedUnitHopRow): HopFields {
  const characterStart = unit.character_start ?? undefined;
  const characterEnd = unit.character_end ?? undefined;
  if (unit.kind === "page") {
    return {
      pageNumber: unit.page_number ?? undefined,
      pageLabel: unit.page_label ?? undefined,
      sectionPath: undefined,
      characterStart,
      characterEnd,
    };
  }
  if (unit.kind === "section") {
    return {
      pageNumber: undefined,
      pageLabel: undefined,
      sectionPath: parseStringArray(unit.section_path_json),
      characterStart,
      characterEnd,
    };
  }
  if (unit.kind === "html-block") {
    return {
      pageNumber: undefined,
      pageLabel: undefined,
      sectionPath: parseStringArray(unit.heading_path_json),
      characterStart,
      characterEnd,
    };
  }
  // json-path / csv-row / unsupported-media — character offsets only when present.
  return {
    pageNumber: undefined,
    pageLabel: undefined,
    sectionPath: undefined,
    characterStart,
    characterEnd,
  };
}

function attachPageHop(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  hop: HopFields,
): HopFields {
  if (hop.pageNumber !== undefined) return hop;
  if (hop.characterStart === undefined || hop.characterEnd === undefined) return hop;
  const page = fetchPageForRange(db, capsuleId, documentId, hop.characterStart, hop.characterEnd);
  if (page === undefined) return hop;
  return {
    ...hop,
    pageNumber: page.page_number,
    pageLabel: page.page_label ?? undefined,
  };
}

// Builds an `exactOptionalPropertyTypes`-friendly CitationReference: optional fields are
// only present when defined. Spreading conditional objects keeps tsc happy under that
// strict option.
function buildCitation(
  chunk: ChunkRow,
  document: DocumentHopRow,
  hop: HopFields,
  chunkId: ChunkId,
  capsuleId: KnowledgeCapsuleId,
): CitationReference {
  return {
    chunkId,
    capsuleId,
    sourceId: document.source_id as KnowledgeSourceId,
    documentId: chunk.document_id as DocumentId,
    safeDisplayName: document.safe_display_name,
    ...(hop.pageNumber !== undefined ? { pageNumber: hop.pageNumber } : {}),
    ...(hop.pageLabel !== undefined ? { pageLabel: hop.pageLabel } : {}),
    ...(hop.sectionPath !== undefined ? { sectionPath: hop.sectionPath } : {}),
    ...(hop.characterStart !== undefined ? { characterStart: hop.characterStart } : {}),
    ...(hop.characterEnd !== undefined ? { characterEnd: hop.characterEnd } : {}),
  };
}

// `_capsuleSetId` is reserved for the future capsule-set-scoped lookup that retrieval
// (#199) will need — for now the citation hop is strictly capsule-scoped so we keep
// the API stable but ignore the parameter. The signature is exported via the barrel.
export function mapChunkToCitation(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
  _capsuleSetId?: CapsuleSetId,
): CitationReference | null {
  const db = store._internal.db;
  const chunk = fetchChunkRow(db, capsuleId, chunkId);
  if (chunk === undefined) return null;

  const unit = fetchParsedUnitRow(db, capsuleId, chunk.parsed_unit_id);
  if (unit === undefined) return null;

  const document = fetchDocumentRow(db, capsuleId, chunk.document_id as DocumentId);
  if (document === undefined) return null;

  const baseHop = hopFieldsForUnit(unit);
  const hop = attachPageHop(db, capsuleId, chunk.document_id as DocumentId, baseHop);
  return buildCitation(chunk, document, hop, chunkId, capsuleId);
}
