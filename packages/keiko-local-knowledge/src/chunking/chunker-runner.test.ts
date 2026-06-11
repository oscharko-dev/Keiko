// Integration tests for `chunkDocument` — verifies transactional persistence,
// idempotency, force-rewrite, and abort-signal rollback against the real SQLite store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DocumentId, KnowledgeCapsuleId, ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { addSourceToCapsule } from "../source-lifecycle.js";
import { sampleSourceInput } from "../_support.js";
import { freshStore } from "../_support.js";
import { chunkDocument } from "./chunker-runner.js";
import { countChunksForDocument, hasStaleChunksForDocument } from "./chunker-persist.js";
import { seedCapsuleSourceAndDocument, seedParsedUnit, type SeededFixture } from "./_support.js";
import type { KnowledgeStore } from "../store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly seeded: SeededFixture;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  const seeded = seedCapsuleSourceAndDocument(store);
  return { store, cleanup, seeded };
}

function pageUnit(start: number, end: number, documentId: DocumentId): ParsedUnit {
  return {
    kind: "page",
    documentId,
    pageNumber: 1,
    characterStart: start,
    characterEnd: end,
  };
}

describe("chunkDocument", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns empty chunkIds when the document has no parsed units", () => {
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: "",
    });
    expect(result.chunkIds).toEqual([]);
    expect(result.skippedExisting).toBe(false);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(0);
  });

  it("emits one chunk for a small parsed unit", () => {
    const text = "Hello world.";
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });
    expect(result.chunkIds).toHaveLength(1);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(1);
  });

  it("splits a large parsed unit into multiple chunks with monotonic orderIndex", () => {
    const text = "a".repeat(8_000);
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const result = chunkDocument(
      fixture.store,
      {
        capsuleId: fixture.seeded.capsuleId,
        sourceId: fixture.seeded.sourceId,
        documentId: fixture.seeded.documentId,
        sourceText: text,
      },
      { maxTokens: 400, minTokens: 0, overlapTokens: 32 },
    );
    expect(result.chunkIds.length).toBeGreaterThan(1);
    const rows = fixture.store._internal.db
      .prepare(
        "SELECT order_index FROM chunks WHERE capsule_id = :c AND document_id = :d ORDER BY order_index ASC",
      )
      .all({ c: fixture.seeded.capsuleId, d: fixture.seeded.documentId }) as {
      readonly order_index: number;
    }[];
    expect(rows.map((r) => r.order_index)).toEqual(rows.map((_, i) => i));
  });

  it("preserves repeated boilerplate occurrences as distinct citation targets", () => {
    const boilerplate = "Standard footer";
    const text = `${boilerplate}\nunique body\n${boilerplate}`;
    const secondStart = text.lastIndexOf(boilerplate);
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, boilerplate.length, fixture.seeded.documentId),
    );
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-2",
      pageUnit(secondStart, secondStart + boilerplate.length, fixture.seeded.documentId),
    );

    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });

    expect(result.chunkIds).toHaveLength(2);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(2);
  });

  it("preserves identical text across capsules", () => {
    const text = "Shared policy footer";
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const first = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });

    const other = seedCapsuleSourceAndDocument(fixture.store, {
      capsuleId: "cap-2",
      sourceId: "src-2",
      documentId: "doc-2",
    });
    seedParsedUnit(
      fixture.store,
      other.capsuleId,
      "u-2",
      pageUnit(0, text.length, other.documentId),
    );
    const second = chunkDocument(fixture.store, {
      capsuleId: other.capsuleId,
      sourceId: other.sourceId,
      documentId: other.documentId,
      sourceText: text,
    });

    expect(first.chunkIds).toHaveLength(1);
    expect(second.chunkIds).toHaveLength(1);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(1);
    expect(
      countChunksForDocument(fixture.store._internal.db, other.capsuleId, other.documentId),
    ).toBe(1);
  });

  it("rolls back when maxChunks is exceeded", () => {
    const text = "alpha ".repeat(40);
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );

    expect(() =>
      chunkDocument(
        fixture.store,
        {
          capsuleId: fixture.seeded.capsuleId,
          sourceId: fixture.seeded.sourceId,
          documentId: fixture.seeded.documentId,
          sourceText: text,
        },
        { maxTokens: 1, minTokens: 0, overlapTokens: 0, maxChunks: 2 },
      ),
    ).toThrow(/maxChunks/);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(0);
  });

  it("is idempotent with force=false (second call is a no-op)", () => {
    const text = "Hello world.";
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const first = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });
    expect(first.chunkIds).toHaveLength(1);
    expect(first.skippedExisting).toBe(false);

    const second = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });
    expect(second.chunkIds).toEqual([]);
    expect(second.skippedExisting).toBe(true);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(1);
  });

  it("with force=true deletes prior chunks before re-chunking", () => {
    const text = "Hello world.";
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });

    // Add a second parsed_unit then re-run with force=true: total chunk count should
    // reflect ONLY the rerun (not the merge of prior + new).
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-2",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );

    const second = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
      force: true,
    });
    expect(second.skippedExisting).toBe(false);
    expect(second.chunkIds).toHaveLength(2);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(2);
  });

  it("re-chunks legacy rows whose chunking_strategy_version is missing", () => {
    const text = "Hello world.";
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const first = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });
    expect(first.chunkIds).toHaveLength(1);

    fixture.store._internal.db
      .prepare(
        "UPDATE chunks SET chunking_strategy_version = NULL WHERE capsule_id = :c AND document_id = :d",
      )
      .run({ c: fixture.seeded.capsuleId, d: fixture.seeded.documentId });
    expect(
      hasStaleChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(true);

    const second = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: text,
    });
    expect(second.skippedExisting).toBe(false);
    expect(second.chunkIds).toHaveLength(1);

    const row = fixture.store._internal.db
      .prepare(
        "SELECT chunking_strategy_version FROM chunks WHERE capsule_id = :c AND document_id = :d",
      )
      .get({ c: fixture.seeded.capsuleId, d: fixture.seeded.documentId }) as {
      readonly chunking_strategy_version: string | null;
    };
    expect(row.chunking_strategy_version).toContain("issue-195-v2");
    expect(row.chunking_strategy_version).toContain("max=400");
  });

  it("re-chunks when effective chunking options change", () => {
    const text = "alpha ".repeat(80);
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const first = chunkDocument(
      fixture.store,
      {
        capsuleId: fixture.seeded.capsuleId,
        sourceId: fixture.seeded.sourceId,
        documentId: fixture.seeded.documentId,
        sourceText: text,
      },
      { maxTokens: 50, minTokens: 0, overlapTokens: 0 },
    );
    expect(first.skippedExisting).toBe(false);

    const second = chunkDocument(
      fixture.store,
      {
        capsuleId: fixture.seeded.capsuleId,
        sourceId: fixture.seeded.sourceId,
        documentId: fixture.seeded.documentId,
        sourceText: text,
      },
      { maxTokens: 10, minTokens: 0, overlapTokens: 0 },
    );

    expect(second.skippedExisting).toBe(false);
    expect(second.chunkIds.length).toBeGreaterThan(first.chunkIds.length);
  });

  it("rolls back the transaction when AbortSignal aborts mid-document", () => {
    // This test must catch a *partial* persist: insert the first unit's chunks, THEN
    // abort, and assert zero rows survive. The transaction rollback is the only thing
    // that keeps the chunk table clean. A token estimator hook flips the signal AFTER
    // the first parsed_unit's chunks finish but BEFORE the second parsed_unit starts —
    // simulating a real-world mid-document cancellation.
    const text = "a".repeat(8_000);
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-2",
      pageUnit(0, text.length, fixture.seeded.documentId),
    );
    const controller = new AbortController();
    let firstUnitDone = false;
    // After ~20 invocations (mid-first-unit), keep going; once we hit a high-tide mark
    // matching second unit, abort. Since the second unit's first invocation comes
    // AFTER the first unit's chunks all persisted, we know at least one chunk row was
    // inserted before the abort throws. The transaction guard is now the only thing
    // preventing those rows from surviving.
    let callCount = 0;
    const estimator = (text2: string): number => {
      callCount += 1;
      // After many invocations within unit-1 (large text + many strides), assume unit-1
      // is done and abort. The runner's throwIfAborted at the top of the next iteration
      // of the outer for-loop will then fire after the BEGIN, after inserts.
      if (callCount > 40 && !firstUnitDone) {
        firstUnitDone = true;
        controller.abort();
      }
      return Math.ceil(text2.length / 4);
    };
    expect(() =>
      chunkDocument(
        fixture.store,
        {
          capsuleId: fixture.seeded.capsuleId,
          sourceId: fixture.seeded.sourceId,
          documentId: fixture.seeded.documentId,
          sourceText: text,
          signal: controller.signal,
        },
        { tokenEstimator: estimator, maxTokens: 50, minTokens: 0, overlapTokens: 0 },
      ),
    ).toThrow(/aborted/);
    // No partial rows survive — the transaction guard rolls back the inserts that
    // happened before the abort. WITHOUT the rollback, ~40 chunk rows would persist.
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(0);
  });

  it("skips unsupported-media units silently (no chunk row written)", () => {
    seedParsedUnit(fixture.store, fixture.seeded.capsuleId, "u-1", {
      kind: "unsupported-media",
      documentId: fixture.seeded.documentId,
      reason: "image/png",
    });
    const result = chunkDocument(fixture.store, {
      capsuleId: fixture.seeded.capsuleId,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: "anything",
    });
    expect(result.chunkIds).toEqual([]);
    expect(
      countChunksForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(0);
  });

  it("fails closed when the caller passes a sourceId that does not own the document", () => {
    addSourceToCapsule(fixture.store, fixture.seeded.capsuleId, sampleSourceInput("src-2"));
    seedParsedUnit(
      fixture.store,
      fixture.seeded.capsuleId,
      "u-1",
      pageUnit(0, 5, fixture.seeded.documentId),
    );
    expect(() =>
      chunkDocument(fixture.store, {
        capsuleId: fixture.seeded.capsuleId,
        sourceId: "src-2" as never,
        documentId: fixture.seeded.documentId,
        sourceText: "hello",
      }),
    ).toThrow(/sourceId .* does not match document/);
  });

  it("isolates failures to one document — capsule-scoped capsuleId mismatch returns empty", () => {
    const other: KnowledgeCapsuleId = "cap-other" as KnowledgeCapsuleId;
    const result = chunkDocument(fixture.store, {
      capsuleId: other,
      sourceId: fixture.seeded.sourceId,
      documentId: fixture.seeded.documentId,
      sourceText: "anything",
    });
    expect(result.chunkIds).toEqual([]);
  });
});
