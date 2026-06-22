// capsuleCorpus.ts — synchronous full-corpus reader for QI ingestion (Epic #710, Issue #717).
//
// Reads every indexed document text for a capsule from the `document_texts` table. The QI
// ingestion pipeline uses this to build atoms directly from the corpus (no retrieval query),
// so knowledge workers can generate test cases from a connected Local Knowledge connector
// without needing a search query.
//
// SYNC: keiko-local-knowledge uses node:sqlite (synchronous API) throughout; this function
// follows the same pattern used in capsule-lifecycle.ts (_internal.db.prepare().all()).

import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { KnowledgeStore } from "../store.js";
import { getCapsuleSet } from "../capsule-set-lifecycle.js";

export interface CapsuleDocumentText {
  readonly documentId: string;
  readonly text: string;
}

// Safe default: caps the in-process document load to prevent unbounded memory
// consumption on large capsules. Callers may override with a smaller value.
const DEFAULT_MAX_DOCUMENTS = 10_000;

export interface ListCapsuleDocumentTextsOptions {
  /** Maximum number of documents to return (SQL LIMIT). Defaults to 10 000. */
  readonly maxDocuments?: number;
}

/**
 * Returns the full normalized text for up to `maxDocuments` indexed documents in a
 * capsule, ordered by document_id for deterministic output. Documents with empty text
 * are skipped. Sync — reads the node:sqlite handle directly like the capsule-lifecycle
 * queries.
 */
export function listCapsuleDocumentTexts(
  store: KnowledgeStore,
  capsuleId: string | KnowledgeCapsuleId,
  options: ListCapsuleDocumentTextsOptions = {},
): readonly CapsuleDocumentText[] {
  const limit = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  const sql =
    "SELECT document_id, normalized_text FROM document_texts WHERE capsule_id = ? ORDER BY document_id LIMIT ?";
  const rows = store._internal.db.prepare(sql).all(String(capsuleId), limit);
  const cipher = store._internal.contentCipher;
  const result: CapsuleDocumentText[] = [];
  for (const row of rows) {
    const documentId = row.document_id;
    const stored = row.normalized_text;
    if (typeof documentId !== "string" || typeof stored !== "string") continue;
    // Decrypt at the store boundary so QI ingestion always receives plaintext corpus text.
    const text = cipher.openText(stored);
    if (text.length > 0) {
      result.push({ documentId, text });
    }
  }
  return result;
}

/**
 * Returns the full corpus text for every member capsule of a capsule-set, concatenated in
 * membership order (ordinal). Each member's documents stay ordered by document_id. An unknown
 * capsule-set yields an empty list, which the QI ingestion layer maps to QI_CAPSULE_UNAVAILABLE.
 * Capsule-sets are logical compositions (no own documents), so this fans out over the members and
 * reuses {@link listCapsuleDocumentTexts} — it does not touch a new storage path (Epic #710,
 * Issue #716/#717). Sync, like the single-capsule reader.
 */
export function listCapsuleSetDocumentTexts(
  store: KnowledgeStore,
  capsuleSetId: string | CapsuleSetId,
): readonly CapsuleDocumentText[] {
  const set = getCapsuleSet(store, capsuleSetId as CapsuleSetId);
  if (set === undefined) return [];
  const result: CapsuleDocumentText[] = [];
  for (const capsuleId of set.capsuleIds) {
    for (const doc of listCapsuleDocumentTexts(store, capsuleId)) {
      result.push(doc);
    }
  }
  return result;
}
