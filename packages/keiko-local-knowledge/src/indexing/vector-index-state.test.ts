import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  readVectorIndexState,
  writeVectorIndexState,
  type VectorIndexStateRecord,
} from "./vector-index-state.js";

const CREATE_STATE_TABLE = `
CREATE TABLE vector_index_state (
  capsule_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  index_name TEXT NOT NULL,
  vector_dimensions INTEGER NOT NULL,
  vector_metric TEXT NOT NULL,
  embedding_identity_key TEXT NOT NULL,
  vector_count INTEGER NOT NULL,
  vector_max_created_at INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    capsule_id, provider, index_name, vector_dimensions, vector_metric, embedding_identity_key
  )
) STRICT;
`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(CREATE_STATE_TABLE);
  return db;
}

function record(
  embeddingIdentityKey: string,
  overrides: Partial<VectorIndexStateRecord> = {},
): VectorIndexStateRecord {
  return {
    capsuleId: "capsule-1" as KnowledgeCapsuleId,
    provider: "usearch",
    indexName: "keiko-hnsw-4-cosine",
    vectorDimensions: 4,
    vectorMetric: "cosine",
    embeddingIdentityKey,
    vectorCount: 3,
    vectorMaxCreatedAt: 100,
    status: "ready",
    updatedAt: 200,
    ...overrides,
  };
}

describe("vector index state", () => {
  it("upserts one identity without changing the logical index cardinality", () => {
    const db = database();
    try {
      const initial = record("identity-v2");
      writeVectorIndexState(db, initial);
      writeVectorIndexState(db, record("identity-v2", { vectorCount: 4, updatedAt: 300 }));

      expect(readVectorIndexState(db, initial)).toMatchObject({
        vectorCount: 4,
        updatedAt: 300,
      });
      expect(db.prepare("SELECT COUNT(*) AS n FROM vector_index_state").get()).toMatchObject({
        n: 1,
      });
    } finally {
      db.close();
    }
  });

  it("removes obsolete identity state while preserving the current logical index", () => {
    const db = database();
    try {
      const obsolete = record("identity-v1");
      const current = record("identity-v2", { updatedAt: 300 });
      writeVectorIndexState(db, obsolete);
      writeVectorIndexState(db, current);

      expect(readVectorIndexState(db, obsolete)).toBeUndefined();
      expect(readVectorIndexState(db, current)).toMatchObject(current);
      expect(db.prepare("SELECT COUNT(*) AS n FROM vector_index_state").get()).toMatchObject({
        n: 1,
      });
    } finally {
      db.close();
    }
  });
});
