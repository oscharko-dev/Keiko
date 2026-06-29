import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { CurrentPdfCitationPreviewSnapshot } from "@oscharko-dev/keiko-contracts/local-knowledge-preview";
import type { DatabaseSync } from "node:sqlite";

import { readExistingDocumentRow } from "./discovery/persist.js";
import type { KnowledgeStore } from "./store.js";
import { mapChunkToCitation } from "./chunking/citation-mapper.js";

interface ChunkRow {
  readonly source_id: string;
  readonly document_id: string;
}

const SELECT_CHUNK_SQL = [
  "SELECT source_id, document_id",
  "FROM chunks",
  "WHERE capsule_id = :capsule_id AND id = :chunk_id",
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

export function lookupCitationPreviewSnapshot(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkId: ChunkId,
): CitationPreviewSnapshotLookup {
  const db = store._internal.db;
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
}
