import type { ChunkId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";

import type { StoreContentCipher } from "../store-content-cipher.js";
import type { ContextualRetrievalStatus } from "./contextual-retrieval.js";

const UPDATE_CHUNK_INDEXED_TEXT_SQL = [
  "UPDATE chunks SET",
  "  contextual_retrieval_key = :contextual_retrieval_key,",
  "  context_prefix = :context_prefix,",
  "  augmented_text = :augmented_text,",
  "  context_status = :context_status,",
  "  context_updated_at = :context_updated_at",
  "WHERE capsule_id = :capsule_id AND id = :chunk_id",
].join(" ");

export interface StoredChunkIndexedTextColumns {
  readonly contextual_retrieval_key: string | null;
  readonly context_prefix: string | null;
  readonly augmented_text: string | null;
  readonly context_status: string | null;
}

export interface PersistChunkIndexedTextRow {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly chunkId: ChunkId;
  readonly contextualRetrievalKey: string;
  readonly contextPrefix: string | null;
  readonly augmentedText: string;
  readonly contextStatus: ContextualRetrievalStatus;
  readonly updatedAt: number;
}

export function readStoredAugmentedText(
  cipher: StoreContentCipher,
  stored: StoredChunkIndexedTextColumns,
  expectedKey: string,
): string | undefined {
  if (stored.contextual_retrieval_key !== expectedKey || stored.augmented_text === null) {
    return undefined;
  }
  return cipher.openText(stored.augmented_text);
}

export function persistChunkIndexedText(
  db: DatabaseSync,
  cipher: StoreContentCipher,
  row: PersistChunkIndexedTextRow,
): void {
  db.prepare(UPDATE_CHUNK_INDEXED_TEXT_SQL).run({
    capsule_id: String(row.capsuleId),
    chunk_id: String(row.chunkId),
    contextual_retrieval_key: row.contextualRetrievalKey,
    context_prefix:
      row.contextPrefix === null || row.contextPrefix.length === 0
        ? null
        : cipher.sealText(row.contextPrefix),
    augmented_text: cipher.sealText(row.augmentedText),
    context_status: row.contextStatus,
    context_updated_at: row.updatedAt,
  });
}
