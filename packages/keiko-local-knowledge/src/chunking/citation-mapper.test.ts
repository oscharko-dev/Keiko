// Hop tests for mapChunkToCitation. Each test seeds a fresh store with a capsule +
// source + document, then injects parsed_units + pages + sections + chunks so the
// citation hop chain (chunk → parsed_unit → document → page/section) can be exercised
// end to end.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChunkId, KnowledgeCapsuleId, ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { freshStore } from "../_support.js";
import { chunkDocument } from "./chunker-runner.js";
import { mapChunkToCitation } from "./citation-mapper.js";
import { seedCapsuleSourceAndDocument, seedPage, seedParsedUnit, seedSection } from "./_support.js";
import type { KnowledgeStore } from "../store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly capsuleId: KnowledgeCapsuleId;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  const seeded = seedCapsuleSourceAndDocument(store);
  return { store, cleanup, capsuleId: seeded.capsuleId };
}

describe("mapChunkToCitation", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns null when the chunk does not exist", () => {
    const result = mapChunkToCitation(fixture.store, fixture.capsuleId, "no-such-chunk" as ChunkId);
    expect(result).toBeNull();
  });

  it("returns null when chunkId exists but capsuleId scope mismatches", () => {
    // Seed a chunk in cap-1 then look it up under a different capsule scope.
    const text = "Hello world.";
    const unit: ParsedUnit = {
      kind: "page",
      documentId: "doc-1" as never,
      pageNumber: 1,
      characterStart: 0,
      characterEnd: text.length,
    };
    seedParsedUnit(fixture.store, fixture.capsuleId, "u-1", unit);
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.capsuleId,
      sourceId: "src-1" as never,
      documentId: "doc-1" as never,
      sourceText: text,
    });
    expect(result.chunkIds.length).toBeGreaterThan(0);

    const wrong = mapChunkToCitation(
      fixture.store,
      "different-capsule" as KnowledgeCapsuleId,
      result.chunkIds[0] ?? ("" as never),
    );
    expect(wrong).toBeNull();
  });

  it("returns pageNumber/pageLabel/characterStart/End for a page parsed-unit chunk", () => {
    const text = "Hello world.";
    seedParsedUnit(fixture.store, fixture.capsuleId, "u-1", {
      kind: "page",
      documentId: "doc-1" as never,
      pageNumber: 7,
      pageLabel: "vii",
      characterStart: 0,
      characterEnd: text.length,
    });
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.capsuleId,
      sourceId: "src-1" as never,
      documentId: "doc-1" as never,
      sourceText: text,
    });
    const chunkId = result.chunkIds[0] ?? ("" as never);
    const citation = mapChunkToCitation(fixture.store, fixture.capsuleId, chunkId);
    expect(citation).not.toBeNull();
    expect(citation?.pageNumber).toBe(7);
    expect(citation?.pageLabel).toBe("vii");
    expect(citation?.characterStart).toBe(0);
    expect(citation?.characterEnd).toBe(text.length);
    expect(citation?.documentId).toBe("doc-1");
    expect(citation?.sourceId).toBe("src-1");
    expect(citation?.safeDisplayName).toBe("sample.txt");
  });

  it("returns sectionPath plus a containing page hop for a section parsed-unit chunk", () => {
    // Document with two pages and one section that lives on page 2.
    const text = "AAAA".repeat(50) + "BBBB".repeat(50); // 400 chars
    // page 1 covers 0..199
    seedPage(fixture.store, fixture.capsuleId, "doc-1" as never, {
      pageNumber: 1,
      pageLabel: "1",
      characterStart: 0,
      characterEnd: 199,
    });
    // page 2 covers 200..399
    seedPage(fixture.store, fixture.capsuleId, "doc-1" as never, {
      pageNumber: 2,
      pageLabel: "2",
      characterStart: 200,
      characterEnd: 399,
    });
    seedSection(fixture.store, fixture.capsuleId, "doc-1" as never, {
      sectionPath: ["Chapter 1", "1.2 Risks"],
      characterStart: 220,
      characterEnd: 280,
    });
    seedParsedUnit(fixture.store, fixture.capsuleId, "u-1", {
      kind: "section",
      documentId: "doc-1" as never,
      sectionPath: ["Chapter 1", "1.2 Risks"],
      characterStart: 220,
      characterEnd: 280,
    });

    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.capsuleId,
      sourceId: "src-1" as never,
      documentId: "doc-1" as never,
      sourceText: text,
    });
    const chunkId = result.chunkIds[0] ?? ("" as never);
    const citation = mapChunkToCitation(fixture.store, fixture.capsuleId, chunkId);

    expect(citation?.sectionPath).toEqual(["Chapter 1", "1.2 Risks"]);
    expect(citation?.characterStart).toBe(220);
    expect(citation?.characterEnd).toBe(280);
    // Page-hop: section sits inside page 2, so the mapper attaches pageNumber=2.
    expect(citation?.pageNumber).toBe(2);
    expect(citation?.pageLabel).toBe("2");
  });

  it("omits page fields when no page row contains the section's range", () => {
    // No `pages` rows seeded — page-hop must NOT produce a phantom value.
    seedParsedUnit(fixture.store, fixture.capsuleId, "u-1", {
      kind: "section",
      documentId: "doc-1" as never,
      sectionPath: ["Top"],
      characterStart: 10,
      characterEnd: 20,
    });
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.capsuleId,
      sourceId: "src-1" as never,
      documentId: "doc-1" as never,
      sourceText: "x".repeat(200),
    });
    const chunkId = result.chunkIds[0] ?? ("" as never);
    const citation = mapChunkToCitation(fixture.store, fixture.capsuleId, chunkId);
    expect(citation).not.toBeNull();
    expect(citation?.pageNumber).toBeUndefined();
    expect(citation?.pageLabel).toBeUndefined();
    expect(citation?.sectionPath).toEqual(["Top"]);
  });

  it("preserves headingPath for html-block parsed units in the sectionPath slot", () => {
    seedParsedUnit(fixture.store, fixture.capsuleId, "u-1", {
      kind: "html-block",
      documentId: "doc-1" as never,
      headingPath: ["h1", "h2"],
      characterStart: 0,
      characterEnd: 10,
    });
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.capsuleId,
      sourceId: "src-1" as never,
      documentId: "doc-1" as never,
      sourceText: "0123456789",
    });
    const chunkId = result.chunkIds[0] ?? ("" as never);
    const citation = mapChunkToCitation(fixture.store, fixture.capsuleId, chunkId);
    expect(citation?.sectionPath).toEqual(["h1", "h2"]);
  });
});
