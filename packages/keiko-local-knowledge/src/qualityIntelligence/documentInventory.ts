// Metadata enumeration over the same admitted scope as the complete document reader. Extraction
// failures stay visible; a text-only inventory must not silently shrink a whole-Pod denominator.
import type { DocumentId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { KnowledgeStore } from "../store.js";
import type { ScopeDocumentScope } from "./scopeDocuments.js";

export interface ScopeDocumentInventoryEntry {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: DocumentId;
  readonly displayName: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly extractionStatus: string;
}

export interface ScopeDocumentInventory {
  readonly documents: readonly ScopeDocumentInventoryEntry[];
  readonly totalCount: number;
  readonly omittedCount: number;
}

interface Row {
  readonly id: string;
  readonly source_id: string;
  readonly safe_display_name: string;
  readonly content_hash: string;
  readonly media_type: string;
  readonly status: string;
}

function inventoryEntry(row: Row, capsuleId: KnowledgeCapsuleId): ScopeDocumentInventoryEntry {
  return {
    capsuleId,
    documentId: row.id as DocumentId,
    displayName: row.safe_display_name,
    contentHash: row.content_hash,
    mediaType: row.media_type,
    extractionStatus: row.status,
  };
}

/** Bounded metadata only; callers page this list and state the count of any excluded documents. */
export function listScopeDocumentInventory(
  store: KnowledgeStore,
  scope: ScopeDocumentScope,
  maxDocuments = 10_000,
): ScopeDocumentInventory {
  const limit = Math.min(10_000, Math.max(0, Math.floor(maxDocuments))) || 0;
  const sources = scope.sourceFilter === undefined ? undefined : JSON.stringify(scope.sourceFilter);
  const sourceClause =
    sources === undefined ? "" : " AND source_id IN (SELECT value FROM json_each(:sources))";
  const count = store._internal.db.prepare(
    `SELECT COUNT(*) AS total FROM documents WHERE capsule_id = :capsule${sourceClause}`,
  );
  const query = store._internal.db.prepare(
    `SELECT id, source_id, safe_display_name, content_hash, media_type, status FROM documents WHERE capsule_id = :capsule${sourceClause} ORDER BY document_path, id LIMIT :limit`,
  );
  const documents: ScopeDocumentInventoryEntry[] = [];
  let totalCount = 0;
  for (const capsuleId of scope.capsuleIds) {
    const parameters = {
      capsule: String(capsuleId),
      ...(sources === undefined ? {} : { sources }),
    };
    totalCount += (count.get(parameters) as { total: number }).total;
    if (documents.length >= limit) continue;
    for (const row of query.iterate({ ...parameters, limit: limit - documents.length }))
      documents.push(inventoryEntry(row as unknown as Row, capsuleId));
  }
  return { documents, totalCount, omittedCount: totalCount - documents.length };
}
