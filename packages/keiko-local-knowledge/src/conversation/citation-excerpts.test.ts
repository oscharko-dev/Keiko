import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CitationReference, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

import { freshStore } from "../_support.js";
import { insertDocumentTextRow } from "../discovery/persist.js";
import { seedCapsuleSourceAndDocument, type SeededFixture } from "../indexing/_support.js";
import type { KnowledgeStore } from "../store.js";
import { readCitationExcerpt } from "./citation-excerpts.js";

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

function citation(overrides: Partial<CitationReference> = {}): CitationReference {
  const { seeded } = getFixture();
  return {
    capsuleId: seeded.capsuleId,
    sourceId: seeded.sourceId,
    documentId: seeded.documentId,
    chunkId: "chunk-1" as CitationReference["chunkId"],
    safeDisplayName: "sample.txt",
    ...overrides,
  };
}

function insertText(text: string): void {
  const { store, seeded } = getFixture();
  insertDocumentTextRow(
    store._internal.db,
    store._internal.contentCipher,
    seeded.capsuleId,
    seeded.documentId,
    text,
  );
}

describe("readCitationExcerpt", () => {
  it("reads bounded character spans without materializing the full fallback text", () => {
    insertText("0123456789abcdef");
    expect(
      readCitationExcerpt(
        getFixture().store,
        getFixture().seeded.capsuleId,
        citation({ characterStart: 2, characterEnd: 6 }),
        20,
      ),
    ).toBe("2345");
  });

  it("returns an empty excerpt when a stored span is unavailable", () => {
    expect(
      readCitationExcerpt(
        getFixture().store,
        getFixture().seeded.capsuleId,
        citation({ characterStart: 2, characterEnd: 6 }),
      ),
    ).toBe("");
  });

  it("falls back to the small-document text projection and caps long excerpts", () => {
    insertText("  alpha beta gamma delta  ");
    const excerpt = readCitationExcerpt(
      getFixture().store,
      getFixture().seeded.capsuleId,
      citation(),
      10,
    );
    expect(excerpt.startsWith("alpha be")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(11);
  });

  it("clamps fallback start and end offsets independently", () => {
    insertText("abcdefghij");
    expect(
      readCitationExcerpt(
        getFixture().store,
        getFixture().seeded.capsuleId,
        citation({ characterStart: 3 }),
        4,
      ),
    ).toBe("defg");
    expect(
      readCitationExcerpt(
        getFixture().store,
        getFixture().seeded.capsuleId,
        citation({ characterEnd: 4 }),
        8,
      ),
    ).toBe("abcd");
  });

  it("returns an empty fallback excerpt when the document text row is missing", () => {
    expect(
      readCitationExcerpt(getFixture().store, "missing-cap" as KnowledgeCapsuleId, citation()),
    ).toBe("");
  });
});
