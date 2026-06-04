import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { runMigrations } from "./schema.js";
import { insertMemoryRow } from "./memories.js";
import { getEmbeddingRow, MAX_EMBEDDING_DIMENSIONS, upsertEmbeddingRow } from "./embeddings.js";
import { gateEmbeddingInput } from "./validate.js";
import { MemoryStorageValidationError } from "./errors.js";
import type { MemoryEmbeddingMetric } from "./types.js";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeMemory(id: string): MemoryRecord {
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: `b-${id}`,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1,
      confidence: 1,
      sensitivity: "confidential",
    },
    validity: { validFrom: 1 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function pseudoVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) {
    // Mix in non-trivial values (negatives, fractions, small magnitudes) so a byte-equal check
    // exercises every Float32 byte position, not just zero-bytes.
    v[i] = Math.sin(i) * 0.5 + (i % 7) * 0.0125 - 0.1;
  }
  return v;
}

describe("embeddings round-trip", () => {
  it("round-trips a Float32Array(384) byte-equal", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    const vector = pseudoVector(384);
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      {
        provider: "openai",
        modelId: "text-embedding-3-small",
        modelRevision: "2026-01",
        metric: "cosine",
        vector,
      },
      100,
    );
    const back = getEmbeddingRow(db, "m1" as MemoryId);
    expect(back).toBeDefined();
    expect(back?.dimensions).toBe(384);
    expect(back?.metric).toBe("cosine");
    expect(back?.provider).toBe("openai");
    expect(back?.modelId).toBe("text-embedding-3-small");
    expect(back?.modelRevision).toBe("2026-01");
    expect(back?.createdAt).toBe(100);
    expect(back?.vector.length).toBe(384);
    // Byte-equal compare via Buffer over the underlying ArrayBuffer.
    expect(Buffer.from(back?.vector.buffer ?? new ArrayBuffer(0))).toEqual(
      Buffer.from(vector.buffer),
    );
  });

  it("omits modelRevision on the way back when absent", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      { provider: "p", modelId: "id", metric: "dot", vector: pseudoVector(8) },
      1,
    );
    const back = getEmbeddingRow(db, "m1" as MemoryId);
    expect(back).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(back, "modelRevision")).toBe(false);
  });

  it("upsert replaces the prior row (last-write-wins per memory)", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      { provider: "p1", modelId: "m", metric: "cosine", vector: new Float32Array([1, 2, 3]) },
      1,
    );
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      {
        provider: "p2",
        modelId: "m",
        metric: "euclidean",
        vector: new Float32Array([9, 8, 7, 6]),
      },
      2,
    );
    const back = getEmbeddingRow(db, "m1" as MemoryId);
    expect(back?.provider).toBe("p2");
    expect(back?.metric).toBe("euclidean");
    expect(back?.dimensions).toBe(4);
    expect(Array.from(back?.vector ?? [])).toEqual([9, 8, 7, 6]);
    expect(back?.createdAt).toBe(2);
  });

  it("returns undefined for a memory with no embedding", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    expect(getEmbeddingRow(db, "m1" as MemoryId)).toBeUndefined();
  });

  it("cascades when the memory is deleted (FK ON DELETE CASCADE)", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      { provider: "p", modelId: "m", metric: "cosine", vector: new Float32Array([1]) },
      1,
    );
    db.prepare("DELETE FROM memories WHERE id = ?").run("m1");
    expect(getEmbeddingRow(db, "m1" as MemoryId)).toBeUndefined();
  });
});

describe("encodeVectorLE deterministic encoding (regression)", () => {
  it("encodes a known vector as the expected LE byte sequence", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    // 1.0f in IEEE-754 LE = 00 00 80 3F; 2.0f LE = 00 00 00 40
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      {
        provider: "p",
        modelId: "m",
        metric: "dot",
        vector: new Float32Array([1.0, 2.0]),
      },
      1,
    );
    const row = db
      .prepare("SELECT vector FROM memory_embeddings WHERE memory_id = ?")
      .get("m1") as { vector: Uint8Array };
    expect(Array.from(row.vector)).toEqual([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x40]);
  });
});

describe("gateEmbeddingInput (DoS + cast soundness)", () => {
  it("rejects vector.length === 0", () => {
    expect(() => {
      gateEmbeddingInput({
        provider: "p",
        modelId: "m",
        metric: "cosine",
        vector: new Float32Array([]),
      });
    }).toThrow(MemoryStorageValidationError);
  });

  it("rejects vector.length > MAX_EMBEDDING_DIMENSIONS", () => {
    expect(() => {
      gateEmbeddingInput({
        provider: "p",
        modelId: "m",
        metric: "cosine",
        vector: new Float32Array(MAX_EMBEDDING_DIMENSIONS + 1),
      });
    }).toThrow(MemoryStorageValidationError);
  });

  it("accepts a vector at exactly MAX_EMBEDDING_DIMENSIONS", () => {
    expect(() => {
      gateEmbeddingInput({
        provider: "p",
        modelId: "m",
        metric: "cosine",
        vector: new Float32Array(MAX_EMBEDDING_DIMENSIONS),
      });
    }).not.toThrow();
  });

  it("rejects an unknown metric", () => {
    expect(() => {
      gateEmbeddingInput({
        provider: "p",
        modelId: "m",
        // Force-cast simulates a caller bypassing the typed surface (JSON over the wire).
        metric: "bogus" as MemoryEmbeddingMetric,
        vector: new Float32Array([1]),
      });
    }).toThrow(MemoryStorageValidationError);
  });

  it("rejects an empty provider", () => {
    expect(() => {
      gateEmbeddingInput({
        provider: "",
        modelId: "m",
        metric: "cosine",
        vector: new Float32Array([1]),
      });
    }).toThrow(MemoryStorageValidationError);
  });

  it("rejects an empty modelId", () => {
    expect(() => {
      gateEmbeddingInput({
        provider: "p",
        modelId: "",
        metric: "cosine",
        vector: new Float32Array([1]),
      });
    }).toThrow(MemoryStorageValidationError);
  });
});

describe("read-side embedding soundness", () => {
  it("throws schema-mismatch on a tampered metric column", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      { provider: "p", modelId: "m", metric: "cosine", vector: new Float32Array([1]) },
      1,
    );
    db.prepare("UPDATE memory_embeddings SET vector_metric = ? WHERE memory_id = ?").run(
      "bogus",
      "m1",
    );
    expect(() => getEmbeddingRow(db, "m1" as MemoryId)).toThrow(/metric/);
    db.close();
  });

  it("throws schema-mismatch when vector_dimensions disagrees with the BLOB byte length", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("m1"));
    upsertEmbeddingRow(
      db,
      "m1" as MemoryId,
      { provider: "p", modelId: "m", metric: "cosine", vector: new Float32Array([1, 2, 3]) },
      1,
    );
    db.prepare("UPDATE memory_embeddings SET vector_dimensions = ? WHERE memory_id = ?").run(
      99,
      "m1",
    );
    expect(() => getEmbeddingRow(db, "m1" as MemoryId)).toThrow(/byte length/);
    db.close();
  });
});
