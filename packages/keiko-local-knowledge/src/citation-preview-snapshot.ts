import type {
  ChunkId,
  DocumentId,
  DocumentStatus,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { DOCUMENT_STATUSES } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-records";
import type {
  CurrentPdfCitationPreviewSnapshot,
  StoredPdfCitationPreviewCitation,
} from "@oscharko-dev/keiko-contracts/local-knowledge-preview";
import type { DatabaseSync } from "node:sqlite";

import { readExistingDocumentRow } from "./discovery/persist.js";
import { KnowledgeStoreError } from "./errors.js";
import { chunkIdColumn, documentIdColumn, sourceIdColumn } from "./knowledge-ids.js";
import type { KnowledgeStore } from "./store.js";
import { type KnowledgeSqlRow, vocabularyAdmission } from "./sql-row.js";
import { mapChunkToCitation } from "./chunking/citation-mapper.js";

interface ChunkRow {
  readonly id: ChunkId;
  readonly source_id: KnowledgeSourceId;
  readonly document_id: DocumentId;
}

function chunkRowFrom(row: KnowledgeSqlRow): ChunkRow {
  return {
    id: chunkIdColumn(row, "id"),
    source_id: sourceIdColumn(row, "source_id"),
    document_id: documentIdColumn(row, "document_id"),
  };
}

const isDocumentStatus = vocabularyAdmission(DOCUMENT_STATUSES);

// Discovery writes a document's status from the contracts' DocumentStatus vocabulary.
function storedDocumentStatus(status: string): DocumentStatus {
  if (!isDocumentStatus(status)) {
    throw new KnowledgeStoreError("A stored document holds a status outside its vocabulary.");
  }
  return status;
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
  return row === undefined ? undefined : chunkRowFrom(row);
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
  return row === undefined ? undefined : chunkRowFrom(row);
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
    documentStatus: storedDocumentStatus(document.status),
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
    const documentId = chunk.document_id;
    const sourceId = chunk.source_id;
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

    const documentId = chunk.document_id;
    const sourceId = chunk.source_id;
    const document = readExistingDocumentRow(db, citation.lineage.capsuleId, documentId);
    if (document === undefined) {
      return { kind: "missing-document", sourceId, documentId };
    }

    const resolvedChunkId = chunk.id;
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
