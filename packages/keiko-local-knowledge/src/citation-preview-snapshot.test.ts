import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StoredPdfCitationPreviewCitation } from "@oscharko-dev/keiko-contracts/local-knowledge-preview";

import { freshStore } from "./_support.js";
import { seedCapsuleSourceAndDocument, seedPage, seedParsedUnit } from "./chunking/_support.js";
import { chunkDocument } from "./chunking/chunker-runner.js";
import { lookupCitationPreviewSnapshotForStoredCitation } from "./citation-preview-snapshot.js";
import type { KnowledgeStore } from "./store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly seeded: ReturnType<typeof seedCapsuleSourceAndDocument>;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  return { store, cleanup, seeded: seedCapsuleSourceAndDocument(store) };
}

describe("lookupCitationPreviewSnapshotForStoredCitation", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("re-anchors legacy positional chunk ids by stored document span", () => {
    const text = "Stable citation span.";
    seedPage(fixture.store, fixture.seeded.capsuleId, fixture.seeded.documentId, {
      pageNumber: 1,
      characterStart: 0,
      characterEnd: text.length,
    });
    seedParsedUnit(fixture.store, fixture.seeded.capsuleId, "unit-after-reindex", {
      kind: "page",
      documentId: fixture.seeded.documentId,
      pageNumber: 1,
      characterStart: 0,
      characterEnd: text.length,
    });
    const chunked = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });
    const currentChunkId = chunked.chunkIds[0];
    expect(currentChunkId).toBeDefined();

    const stored: StoredPdfCitationPreviewCitation = {
      stableId: "legacy-stable",
      marker: "[1]",
      markerIndex: 1,
      documentLabel: "sample.txt",
      lineage: {
        capsuleId: fixture.seeded.capsuleId,
        sourceId: fixture.seeded.sourceId,
        documentId: fixture.seeded.documentId,
        chunkId: "doc-1#unit-before-reindex#c0" as never,
      },
      documentMediaType: "text/plain",
      documentContentHash: "a".repeat(64),
      pageNumber: 1,
      characterStart: 0,
      characterEnd: text.length,
    };

    const result = lookupCitationPreviewSnapshotForStoredCitation(fixture.store, stored);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.snapshot.lineage.chunkId).toBe(currentChunkId);
      expect(result.snapshot.pageNumber).toBe(1);
      expect(result.snapshot.characterStart).toBe(0);
      expect(result.snapshot.characterEnd).toBe(text.length);
    }
  });
});
