// capsuleCorpus.ts — synchronous full-corpus reader for QI ingestion (Epic #710, Issue #717).
//
// Reads every indexed document text for a capsule from the `document_texts` table. The QI
// ingestion pipeline uses this to build atoms directly from the corpus (no retrieval query),
// so knowledge workers can generate test cases from a connected Local Knowledge connector
// without needing a search query.
//
// SYNC: keiko-local-knowledge uses node:sqlite (synchronous API) throughout; this function
// follows the same pattern used in capsule-lifecycle.ts (_internal.db.prepare().all()).

import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { KnowledgeStore } from "../store.js";

export interface CapsuleDocumentText {
  readonly documentId: string;
  readonly text: string;
}

const SELECT_DOCUMENT_TEXTS_SQL =
  "SELECT document_id, normalized_text FROM document_texts WHERE capsule_id = ? ORDER BY document_id";

/**
 * Returns the full normalized text for every indexed document in a capsule, ordered by
 * document_id for deterministic output. Documents with empty text are skipped. Sync — reads the
 * node:sqlite handle directly like the capsule-lifecycle queries.
 */
export function listCapsuleDocumentTexts(
  store: KnowledgeStore,
  capsuleId: string | KnowledgeCapsuleId,
): readonly CapsuleDocumentText[] {
  const rows = store._internal.db.prepare(SELECT_DOCUMENT_TEXTS_SQL).all(String(capsuleId));
  const result: CapsuleDocumentText[] = [];
  for (const row of rows) {
    const documentId = row.document_id;
    const text = row.normalized_text;
    if (typeof documentId === "string" && typeof text === "string" && text.length > 0) {
      result.push({ documentId, text });
    }
  }
  return result;
}
