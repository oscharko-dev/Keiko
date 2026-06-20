import type { CitationReference, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

import { readDocumentTextSpan } from "../discovery/persist.js";
import type { KnowledgeStore } from "../store.js";

const DEFAULT_MAX_EXCERPT_CHARS = 900;

interface DocumentTextRow {
  readonly normalized_text?: string;
}

function readDocumentText(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  citation: CitationReference,
): string | undefined {
  const row = store._internal.db
    .prepare(
      "SELECT normalized_text FROM document_texts WHERE capsule_id = :capsule_id AND document_id = :document_id",
    )
    .get({
      capsule_id: capsuleId,
      document_id: citation.documentId,
    }) as DocumentTextRow | undefined;
  return typeof row?.normalized_text === "string" ? row.normalized_text : undefined;
}

function capExcerpt(raw: string, maxChars: number): string {
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function sliceExcerpt(
  text: string,
  start: number | undefined,
  end: number | undefined,
  maxChars: number,
): string {
  if (text.length === 0) return "";
  const safeStart = Math.max(0, Math.min(text.length, start ?? 0));
  const safeEnd = Math.max(safeStart, Math.min(text.length, end ?? safeStart + maxChars));
  return capExcerpt(text.slice(safeStart, safeEnd), maxChars);
}

// Reads a citation's excerpt as a bounded span. When the chunk carries character offsets the span is
// read through `readDocumentTextSpan` (SUBSTR over `document_texts` for small files OR over the
// bounded `document_text_windows` rows for progressively-extracted large files), so a large
// document's citation excerpt renders without materializing the whole document text. Chunks without
// offsets fall back to the full small-file text projection.
export function readCitationExcerpt(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  citation: CitationReference,
  maxChars = DEFAULT_MAX_EXCERPT_CHARS,
): string {
  const { characterStart, characterEnd } = citation;
  if (characterStart !== undefined && characterEnd !== undefined) {
    const span = readDocumentTextSpan(
      store._internal.db,
      capsuleId,
      citation.documentId,
      characterStart,
      characterEnd,
    );
    return span === undefined ? "" : capExcerpt(span, maxChars);
  }
  const text = readDocumentText(store, capsuleId, citation);
  if (text === undefined) return "";
  return sliceExcerpt(text, characterStart, characterEnd, maxChars);
}
