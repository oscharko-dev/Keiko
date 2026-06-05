import type { CitationReference, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

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

function sliceExcerpt(
  text: string,
  start: number | undefined,
  end: number | undefined,
  maxChars: number,
): string {
  if (text.length === 0) return "";
  const safeStart = Math.max(0, Math.min(text.length, start ?? 0));
  const safeEnd = Math.max(safeStart, Math.min(text.length, end ?? safeStart + maxChars));
  const raw = text.slice(safeStart, safeEnd).trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars).trimEnd()}…`;
}

export function readCitationExcerpt(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  citation: CitationReference,
  maxChars = DEFAULT_MAX_EXCERPT_CHARS,
): string {
  const text = readDocumentText(store, capsuleId, citation);
  if (text === undefined) return "";
  return sliceExcerpt(text, citation.characterStart, citation.characterEnd, maxChars);
}
