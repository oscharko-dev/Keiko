import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type {
  CurrentPdfCitationPreviewSnapshot,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts/local-knowledge-preview";
import type { DatabaseSync } from "node:sqlite";

import { readExistingDocumentRow } from "./discovery/persist.js";
import type { KnowledgeStore } from "./store.js";
import { mapChunkToCitation } from "./chunking/citation-mapper.js";

interface ChunkRow {
  readonly id: string;
  readonly source_id: string;
  readonly document_id: string;
}

const SELECT_CHUNK_SQL = [
  "SELECT id, source_id, document_id",
  "FROM chunks",
  "WHERE capsule_id = :capsule_id AND id = :chunk_id",
].join(" ");

const SELECT_CHUNK_BY_SPAN_SQL = [
  "SELECT id, source_id, document_id",
  "FROM chunks",
  "WHERE capsule_id = :capsule_id",
  "  AND source_id = :source_id",
  "  AND document_id = :document_id",
  "  AND character_start = :character_start",
  "  AND character_end = :character_end",
  "ORDER BY order_index ASC, id ASC",
  "LIMIT 1",
].join(" ");

export type CitationPreviewSnapshotLookup =
  | { readonly kind: "missing-chunk" }
  | {
      readonly kind: "missing-document";
      readonly sourceId: KnowledgeSourceId;
      readonly documentId: DocumentId;
    }
  | {
      readonly kind: "ok";
      readonly snapshot: CurrentPdfCitationPreviewSnapshot;
    };

function readChunkRow(
  db: DatabaseSync,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
): ChunkRow | undefined {
  const row = db
    .prepare(SELECT_CHUNK_SQL)
    .get({ capsule_id: String(capsuleId), chunk_id: String(chunkId) });
  return row === undefined ? undefined : (row as unknown as ChunkRow);
}

function readChunkRowByStoredSpan(
  db: DatabaseSync,
  citation: StoredPdfCitationPreviewCitation,
): ChunkRow | undefined {
  if (citation.characterStart === undefined || citation.characterEnd === undefined) {
    return undefined;
  }
  const row = db.prepare(SELECT_CHUNK_BY_SPAN_SQL).get({
    capsule_id: String(citation.lineage.capsuleId),
    source_id: String(citation.lineage.sourceId),
    document_id: String(citation.lineage.documentId),
    character_start: citation.characterStart,
    character_end: citation.characterEnd,
  });
  return row === undefined ? undefined : (row as unknown as ChunkRow);
}

function buildSnapshot(
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  document: NonNullable<ReturnType<typeof readExistingDocumentRow>>,
  citation: ReturnType<typeof mapChunkToCitation>,
): CurrentPdfCitationPreviewSnapshot {
  return {
    lineage: {
      capsuleId,
      sourceId,
      documentId,
      chunkId,
    },
    documentLabel: document.safe_display_name,
    documentMediaType: document.media_type,
    documentContentHash: document.content_hash,
    documentStatus: document.status as CurrentPdfCitationPreviewSnapshot["documentStatus"],
    ...(citation?.pageNumber !== undefined ? { pageNumber: citation.pageNumber } : {}),
    ...(citation?.pageLabel !== undefined ? { pageLabel: citation.pageLabel } : {}),
    ...(citation?.characterStart !== undefined ? { characterStart: citation.characterStart } : {}),
    ...(citation?.characterEnd !== undefined ? { characterEnd: citation.characterEnd } : {}),
  };
}

function readInSnapshot<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

export function lookupCitationPreviewSnapshot(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
): CitationPreviewSnapshotLookup {
  const db = store._internal.db;
  return readInSnapshot(db, () => {
    const chunk = readChunkRow(db, capsuleId, chunkId);
    if (chunk === undefined) {
      return { kind: "missing-chunk" };
    }
    const documentId = chunk.document_id as DocumentId;
    const sourceId = chunk.source_id as KnowledgeSourceId;
    const document = readExistingDocumentRow(db, capsuleId, documentId);
    if (document === undefined) {
      return { kind: "missing-document", sourceId, documentId };
    }
    const citation = mapChunkToCitation(store, capsuleId, chunkId);
    return {
      kind: "ok",
      snapshot: buildSnapshot(capsuleId, chunkId, sourceId, documentId, document, citation),
    };
  });
}

export function lookupCitationPreviewSnapshotForStoredCitation(
  store: KnowledgeStore,
  citation: StoredPdfCitationPreviewCitation,
): CitationPreviewSnapshotLookup {
  const exact = lookupCitationPreviewSnapshot(
    store,
    citation.lineage.capsuleId,
    citation.lineage.chunkId,
  );
  if (exact.kind !== "missing-chunk") return exact;

  const db = store._internal.db;
  return readInSnapshot(db, () => {
    const chunk = readChunkRowByStoredSpan(db, citation);
    if (chunk === undefined) return exact;

    const documentId = chunk.document_id as DocumentId;
    const sourceId = chunk.source_id as KnowledgeSourceId;
    const document = readExistingDocumentRow(db, citation.lineage.capsuleId, documentId);
    if (document === undefined) {
      return { kind: "missing-document", sourceId, documentId };
    }

    const resolvedChunkId = chunk.id as ChunkId;
    const currentCitation = mapChunkToCitation(store, citation.lineage.capsuleId, resolvedChunkId);
    return {
      kind: "ok",
      snapshot: buildSnapshot(
        citation.lineage.capsuleId,
        resolvedChunkId,
        sourceId,
        documentId,
        document,
        currentCitation,
      ),
    };
  });
}
