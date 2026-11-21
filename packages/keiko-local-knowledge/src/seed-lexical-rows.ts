import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { KnowledgeStoreError } from "./errors.js";
import { replaceLexicalRowsForDocument } from "./indexing/lexical-index-persist.js";
import { nullableNumberColumn, textColumn, type KnowledgeSqlRow } from "./sql-row.js";
import type { KnowledgeStore } from "./store.js";

// The one document a seed helper indexed: its capsule, its source, its id and the text its chunks
// span.
export interface SeedLexicalDocument {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly text: string;
}

interface SeedChunkSpan {
  readonly chunkId: ChunkId;
  readonly start: number | null;
  readonly end: number | null;
}

// A stored chunk of the seeded document. Its id must be one the chunker returned and its source
// the seeded source, so both keep their brands without an assertion.
function seedChunkSpan(
  row: KnowledgeSqlRow,
  seed: SeedLexicalDocument,
  chunkIds: readonly ChunkId[],
): SeedChunkSpan {
  const id = textColumn(row, "id");
  const chunkId = chunkIds.find((candidate) => candidate === id);
  if (chunkId === undefined || textColumn(row, "source_id") !== seed.sourceId) {
    throw new KnowledgeStoreError("A seeded chunk does not belong to the seeded document");
  }
  return {
    chunkId,
    start: nullableNumberColumn(row, "character_start"),
    end: nullableNumberColumn(row, "character_end"),
  };
}

/** Indexes the lexical rows of the chunks a seed helper stored, for the seeded test stores. */
export function indexSeedLexicalRows(
  store: KnowledgeStore,
  seed: SeedLexicalDocument,
  chunkIds: readonly ChunkId[],
): void {
  if (chunkIds.length === 0) {
    replaceLexicalRowsForDocument(store._internal.db, seed.capsuleId, seed.documentId, []);
    return;
  }
  const spans = store._internal.db
    .prepare(
      [
        "SELECT id, source_id, character_start, character_end",
        "FROM chunks",
        "WHERE capsule_id = :c AND document_id = :d",
        "ORDER BY order_index ASC",
      ].join(" "),
    )
    .all({ c: String(seed.capsuleId), d: String(seed.documentId) })
    .map((row) => seedChunkSpan(row, seed, chunkIds));
  replaceLexicalRowsForDocument(
    store._internal.db,
    seed.capsuleId,
    seed.documentId,
    spans.map((span) => {
      const text = seed.text.slice(span.start ?? 0, span.end ?? seed.text.length);
      return {
        capsuleId: seed.capsuleId,
        sourceId: seed.sourceId,
        documentId: seed.documentId,
        chunkId: span.chunkId,
        text,
        exactText: text,
        updatedAt: 1_700_000_000_000,
      };
    }),
  );
}
