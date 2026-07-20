import { describe, expect, it } from "vitest";

import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import type { KnowledgeStore } from "../store.js";
import {
  buildDocumentLineIndex,
  listRepositoryChunkLineRanges,
  persistRepositoryChunkLineRange,
  repositoryLineRangeForSpan,
} from "./repository-chunk-lines.js";

describe("repository_chunk_line_ranges ledger table", () => {
  it("exists immediately after opening a fresh store, before any chunk-line persist/read runs (Issue #2569 ledger migration)", () => {
    const fresh = freshStore();
    try {
      const row = fresh.store._internal.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'repository_chunk_line_ranges'",
        )
        .get() as unknown as { readonly n: number };
      expect(row.n).toBe(1);
    } finally {
      fresh.cleanup();
    }
  });
});

function seedChunk(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  documentId: DocumentId,
  chunkId: ChunkId,
): void {
  const db = store._internal.db;
  createCapsule(
    store,
    sampleCapsuleInput({ id: capsuleId, embeddingModelIdentity: DEFAULT_EMBEDDING }),
  );
  addSourceToCapsule(store, capsuleId, {
    id: sourceId,
    displayName: "Guard source",
    tags: [],
    scope: { kind: "folder", rootPath: "/repo", recursive: true },
  });
  db.prepare(
    "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (:id, :c, :s, '/repo/a.ts', 1, 'text/plain', 'h', 'p', '1', 1, 'ready', 'a.ts')",
  ).run({ id: documentId, c: capsuleId, s: sourceId });
  db.prepare(
    "INSERT INTO parsed_units (id, capsule_id, document_id, kind) VALUES ('unit-1', :c, :d, 'paragraph')",
  ).run({ c: capsuleId, d: documentId });
  db.prepare(
    "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (:id, :c, :s, :d, 'unit-1', 0, 10, 'hash')",
  ).run({ id: chunkId, c: capsuleId, s: sourceId, d: documentId });
}

describe("repository chunk line mapping", () => {
  it.each([
    ["", 0, 0, { startLine: 1, endLine: 1, documentLineCount: 1 }],
    ["one line", 0, 8, { startLine: 1, endLine: 1, documentLineCount: 1 }],
    ["one\ntwo\nthree", 4, 7, { startLine: 2, endLine: 2, documentLineCount: 3 }],
    ["one\r\ntwo\r\n", 5, 10, { startLine: 2, endLine: 2, documentLineCount: 3 }],
    ["\uFEFFdef load():\n  pass", 1, 12, { startLine: 1, endLine: 1, documentLineCount: 2 }],
  ])("round-trips adversarial newline offsets", (text, start, end, expected) => {
    expect(repositoryLineRangeForSpan(buildDocumentLineIndex(text), start, end)).toEqual(expected);
  });

  it("refuses a stored row whose joined document path is empty instead of citing a pathless file", () => {
    // The narrowing guard on the SQL rows is reachable, not decorative: document_path is TEXT
    // NOT NULL in a STRICT table, and the empty string satisfies both. A row like that would
    // otherwise render a citation pointing at a file with no name.
    const capsuleId = "cap-line-guard" as KnowledgeCapsuleId;
    const sourceId = "src-line-guard" as KnowledgeSourceId;
    const documentId = "doc-line-guard" as DocumentId;
    const chunkId = "chunk-line-guard" as ChunkId;
    const fresh = freshStore();
    try {
      seedChunk(fresh.store, capsuleId, sourceId, documentId, chunkId);
      persistRepositoryChunkLineRange(fresh.store._internal.db, {
        capsuleId,
        chunkId,
        documentId,
        characterStart: 0,
        characterEnd: 3,
        lineIndex: buildDocumentLineIndex("one\ntwo"),
      });
      expect(listRepositoryChunkLineRanges(fresh.store, capsuleId)).toHaveLength(1);

      fresh.store._internal.db
        .prepare("UPDATE documents SET document_path = '' WHERE capsule_id = :c AND id = :d")
        .run({ c: capsuleId, d: documentId });
      expect(() => listRepositoryChunkLineRanges(fresh.store, capsuleId)).toThrow(
        "REPOSITORY_CHUNK_LINE_RANGE_ROW_INVALID",
      );
    } finally {
      fresh.cleanup();
    }
  });

  it("keeps ranges monotonic for overlapping chunks and bounds a single overlong line", () => {
    const text = `${"x".repeat(10_000)}\nnext`;
    const index = buildDocumentLineIndex(text);
    const ranges = [
      repositoryLineRangeForSpan(index, 0, 4000),
      repositoryLineRangeForSpan(index, 3500, 8000),
      repositoryLineRangeForSpan(index, 7900, text.length),
    ];
    expect(ranges.map((range) => range.startLine)).toEqual([1, 1, 1]);
    expect(ranges.at(-1)).toEqual({ startLine: 1, endLine: 2, documentLineCount: 2 });
  });
});
