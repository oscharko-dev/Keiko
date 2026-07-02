import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChunkId } from "@oscharko-dev/keiko-contracts";

import { freshStore } from "../_support.js";
import { insertDocumentTextRow } from "../discovery/persist.js";
import type { KnowledgeStore } from "../store.js";
import {
  seedCapsuleSourceAndDocument,
  seedDocumentWithChunks,
  type SeededFixture,
} from "./_support.js";
import {
  countLexicalRowsForCapsule,
  countLexicalRowsForDocument,
  deleteLexicalRowsForCapsule,
  deleteLexicalRowsForDocument,
  replaceLexicalRowsForDocument,
  replaceLexicalRowsFromStoredSpans,
  upsertLexicalRows,
  type LexicalChunkIndexRow,
} from "./lexical-index-persist.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly seeded: SeededFixture;
}

let fixture: Fixture | undefined;

beforeEach(() => {
  const { store, cleanup } = freshStore();
  fixture = { store, cleanup, seeded: seedCapsuleSourceAndDocument(store) };
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function getFixture(): Fixture {
  if (fixture === undefined) throw new Error("fixture not initialised");
  return fixture;
}

function row(chunkId: string, overrides: Partial<LexicalChunkIndexRow> = {}): LexicalChunkIndexRow {
  const { seeded } = getFixture();
  return {
    capsuleId: seeded.capsuleId,
    sourceId: seeded.sourceId,
    documentId: seeded.documentId,
    chunkId: chunkId as ChunkId,
    text: `Raw text ${chunkId}`,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function exactTextFor(chunkId: string): string | undefined {
  const { store, seeded } = getFixture();
  const record = store._internal.db
    .prepare(
      "SELECT exact_text FROM chunk_lexical_index WHERE capsule_id = :capsule_id AND chunk_id = :chunk_id",
    )
    .get({ capsule_id: String(seeded.capsuleId), chunk_id: chunkId }) as
    | { readonly exact_text: string }
    | undefined;
  return record?.exact_text;
}

describe("lexical index persistence", () => {
  it("replaces, upserts, counts, and deletes lexical rows", () => {
    const { store, seeded } = getFixture();
    const chunks = seedDocumentWithChunks(
      store,
      seeded,
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(200),
    );
    const chunkA = chunks[0];
    const chunkB = chunks[1];
    if (chunkA === undefined || chunkB === undefined) {
      throw new Error("fixture produced fewer than two chunks");
    }

    expect(countLexicalRowsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
      0,
    );

    replaceLexicalRowsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId, [
      row(String(chunkA)),
      row(String(chunkB), { exactText: "Exact B" }),
    ]);

    expect(countLexicalRowsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
      2,
    );
    expect(countLexicalRowsForCapsule(store._internal.db, seeded.capsuleId)).toBe(2);
    expect(exactTextFor(String(chunkA))).toBe(`Raw text ${String(chunkA)}\n${String(chunkA)}`);
    expect(exactTextFor(String(chunkB))).toBe("Exact B");

    upsertLexicalRows(store._internal.db, [
      row(String(chunkA), { text: "Updated lexical text", exactText: "Updated exact text" }),
    ]);
    expect(countLexicalRowsForCapsule(store._internal.db, seeded.capsuleId)).toBe(2);
    expect(exactTextFor(String(chunkA))).toBe("Updated exact text");

    deleteLexicalRowsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId);
    expect(countLexicalRowsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
      0,
    );

    upsertLexicalRows(store._internal.db, [row(String(chunkA))]);
    deleteLexicalRowsForCapsule(store._internal.db, seeded.capsuleId);
    expect(countLexicalRowsForCapsule(store._internal.db, seeded.capsuleId)).toBe(0);
  });

  it("rebuilds lexical rows from stored chunk spans", () => {
    const { store, seeded } = getFixture();
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    insertDocumentTextRow(
      store._internal.db,
      store._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      text,
    );
    const chunks = seedDocumentWithChunks(store, seeded, text);
    expect(chunks.length).toBeGreaterThan(0);

    replaceLexicalRowsFromStoredSpans(
      store,
      seeded.capsuleId,
      seeded.documentId,
      1_700_000_000_123,
    );

    expect(countLexicalRowsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
      chunks.length,
    );
    expect(exactTextFor(String(chunks[0]))).toContain("alpha");
  });
});
