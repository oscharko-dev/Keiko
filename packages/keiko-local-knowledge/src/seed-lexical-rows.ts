import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { replaceLexicalRowsForDocument } from "./indexing/lexical-index-persist.js";
import { chunkIdColumn, sourceIdColumn } from "./knowledge-ids.js";
import { nullableNumberColumn, type KnowledgeSqlRow } from "./sql-row.js";
import type { KnowledgeStore } from "./store.js";

// The one document a seed helper indexed: its capsule, its id and the text its chunks span.
export interface SeedLexicalDocument {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly documentId: DocumentId;
  readonly text: string;
}

interface SeedChunkSpanRow {
  readonly id: ChunkId;
  readonly source_id: KnowledgeSourceId;
  readonly character_start: number | null;
  readonly character_end: number | null;
}

function seedChunkSpanRow(row: KnowledgeSqlRow): SeedChunkSpanRow {
  return {
    id: chunkIdColumn(row, "id"),
    source_id: sourceIdColumn(row, "source_id"),
    character_start: nullableNumberColumn(row, "character_start"),
    character_end: nullableNumberColumn(row, "character_end"),
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
  const rows = store._internal.db
    .prepare(
      [
        "SELECT id, source_id, character_start, character_end",
        "FROM chunks",
        "WHERE capsule_id = :c AND document_id = :d",
        "ORDER BY order_index ASC",
      ].join(" "),
    )
    .all({
      c: String(seed.capsuleId),
      d: String(seed.documentId),
    })
    .map(seedChunkSpanRow);
  replaceLexicalRowsForDocument(
    store._internal.db,
    seed.capsuleId,
    seed.documentId,
    rows.map((row) => {
      const start = row.character_start ?? 0;
      const end = row.character_end ?? seed.text.length;
      const text = seed.text.slice(start, end);
      return {
        capsuleId: seed.capsuleId,
        sourceId: row.source_id,
        documentId: seed.documentId,
        chunkId: row.id,
        text,
        exactText: text,
        updatedAt: 1_700_000_000_000,
      };
    }),
  );
}
