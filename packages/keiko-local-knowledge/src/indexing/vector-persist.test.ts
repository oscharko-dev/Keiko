import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VectorId } from "@oscharko-dev/keiko-contracts";

import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import { KnowledgeStoreError } from "../errors.js";
import type { KnowledgeStore } from "../store.js";
import { deterministicVector, seedCapsuleSourceAndDocument, seedDocumentWithChunks } from "./_support.js";
import {
  composeVectorRecord,
  countVectorsForDocument,
  insertVectorRow,
  type VectorInsertRow,
} from "./vector-persist.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly seeded: ReturnType<typeof seedCapsuleSourceAndDocument>;
  readonly chunkId: VectorInsertRow["chunkId"];
}

function toBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function buildRow(fixture: Fixture, overrides: Partial<VectorInsertRow> = {}): VectorInsertRow {
  return {
    id: ("vec:test-1" as string) as VectorId,
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
    insertVectorRow(fixture.store._internal.db, buildRow(fixture));

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
      insertVectorRow(fixture.store._internal.db, mismatched);
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
