import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VectorId } from "@oscharko-dev/keiko-contracts";

import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import { KnowledgeStoreError } from "../errors.js";
import type { KnowledgeStore } from "../store.js";
import {
  deterministicVector,
  seedCapsuleSourceAndDocument,
  seedDocumentWithChunks,
} from "./_support.js";
import {
  composeVectorRecord,
  countVectorsForDocument,
  insertVectorRow,
  invalidateVectorIndexStateForCapsules,
  type VectorInsertRow,
} from "./vector-persist.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly seeded: ReturnType<typeof seedCapsuleSourceAndDocument>;
  readonly chunkId: VectorInsertRow["chunkId"];
}

function toBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function buildRow(fixture: Fixture, overrides: Partial<VectorInsertRow> = {}): VectorInsertRow {
  return {
    id: "vec:test-1" as string as VectorId,
    capsuleId: fixture.seeded.capsuleId,
    sourceId: fixture.seeded.sourceId,
    documentId: fixture.seeded.documentId,
    chunkId: fixture.chunkId,
    embedding: toBytes(deterministicVector("alpha", DEFAULT_EMBEDDING.vectorDimensions)),
    identity: DEFAULT_EMBEDDING,
    storageReference: "vectors/vec:test-1",
    createdAt: 1,
    ...overrides,
  };
}

let fixture: Fixture;

beforeEach(() => {
  const fresh = freshStore();
  const seeded = seedCapsuleSourceAndDocument(fresh.store);
  const [chunkId] = seedDocumentWithChunks(fresh.store, seeded, "alpha beta gamma delta epsilon");
  if (chunkId === undefined) {
    throw new Error("expected seeded chunk");
  }
  fixture = {
    store: fresh.store,
    cleanup: fresh.cleanup,
    seeded,
    chunkId,
  };
});

afterEach(() => {
  fixture.cleanup();
});

describe("insertVectorRow", () => {
  it("persists a vector row for an existing chunk lineage", () => {
    insertVectorRow(
      fixture.store._internal.db,
      fixture.store._internal.contentCipher,
      buildRow(fixture),
    );

    expect(
      countVectorsForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(1);
  });

  it("rejects a vector blob whose byte length does not match the declared dimensions", () => {
    const mismatched = buildRow(fixture, {
      embedding: toBytes(new Float32Array([1, 2])),
    });

    expect(() => {
      insertVectorRow(
        fixture.store._internal.db,
        fixture.store._internal.contentCipher,
        mismatched,
      );
    }).toThrow(KnowledgeStoreError);
    expect(
      countVectorsForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(0);
  });
});

describe("composeVectorRecord", () => {
  it("keeps capsule, source, document, and chunk lineage explicit", () => {
    const record = composeVectorRecord(buildRow(fixture));
    expect(record.capsuleId).toBe(fixture.seeded.capsuleId);
    expect(record.sourceId).toBe(fixture.seeded.sourceId);
    expect(record.documentId).toBe(fixture.seeded.documentId);
    expect(record.chunkId).toBe(fixture.chunkId);
  });
});

// GEN-PERF-PERSISTENCE-013: per-row insert must not invalidate the capsule's vector-index state once
// per row (a DELETE that is a no-op after the first row of a document). Batch callers invalidate ONCE
// at the transaction boundary. We count db.prepare calls compiling the index-state DELETE as the proxy.
describe("insertVectorRow index-state invalidation (GEN-PERF-PERSISTENCE-013)", () => {
  const INVALIDATE_MARKER = "DELETE FROM vector_index_state";

  function countInvalidations(run: () => void): number {
    const db = fixture.store._internal.db as unknown as {
      prepare: (sql: string) => unknown;
    };
    const original = db.prepare.bind(db);
    let count = 0;
    db.prepare = (sql: string): unknown => {
      if (sql.includes(INVALIDATE_MARKER)) count += 1;
      return original(sql);
    };
    try {
      run();
    } finally {
      db.prepare = original;
    }
    return count;
  }

  it("still invalidates once by default (single-row caller unchanged)", () => {
    const invalidations = countInvalidations(() => {
      insertVectorRow(
        fixture.store._internal.db,
        fixture.store._internal.contentCipher,
        buildRow(fixture, { id: "vec:default-1" as string as VectorId }),
      );
    });
    expect(invalidations).toBe(1);
  });

  it("does NOT invalidate per row when invalidateIndexState:false", () => {
    const [c2, c3] = seedDocumentWithChunks(
      fixture.store,
      fixture.seeded,
      "one two three four five six seven eight nine ten eleven twelve thirteen",
      "unit-2",
    );
    const invalidations = countInvalidations(() => {
      insertVectorRow(
        fixture.store._internal.db,
        fixture.store._internal.contentCipher,
        buildRow(fixture, { id: "vec:batch-1" as string as VectorId }),
        { invalidateIndexState: false },
      );
      if (c2 !== undefined) {
        insertVectorRow(
          fixture.store._internal.db,
          fixture.store._internal.contentCipher,
          buildRow(fixture, { id: "vec:batch-2" as string as VectorId, chunkId: c2 }),
          { invalidateIndexState: false },
        );
      }
      if (c3 !== undefined) {
        insertVectorRow(
          fixture.store._internal.db,
          fixture.store._internal.contentCipher,
          buildRow(fixture, { id: "vec:batch-3" as string as VectorId, chunkId: c3 }),
          { invalidateIndexState: false },
        );
      }
    });
    // Pre-fix: 3 rows => 3 invalidations. Fixed: 0 during inserts (deferred to the batch boundary).
    expect(invalidations).toBe(0);
  });

  it("invalidateVectorIndexStateForCapsules invalidates once per DISTINCT capsule", () => {
    const capsuleA = fixture.seeded.capsuleId;
    const invalidations = countInvalidations(() => {
      // Same capsule repeated 5x collapses to a single invalidation.
      invalidateVectorIndexStateForCapsules(fixture.store._internal.db, [
        capsuleA,
        capsuleA,
        capsuleA,
        capsuleA,
        capsuleA,
      ]);
    });
    expect(invalidations).toBe(1);
  });
});
