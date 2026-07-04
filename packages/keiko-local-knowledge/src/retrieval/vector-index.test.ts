import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EmbeddingModelIdentity,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { openKnowledgeStore, type KnowledgeStore } from "../store.js";
import { PLAINTEXT_CONTENT_CIPHER } from "../store-content-cipher.js";

import {
  searchVectorIndex,
  type SqliteVecModule,
  type VectorIndexAdapter,
  type VectorIndexSearchRequest,
} from "./vector-index.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

interface VectorIndexStateRow {
  readonly status: string;
  readonly reason: string | null;
  readonly index_name: string;
  readonly updated_at: number;
}

interface FakeSqliteVecIndexRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly embedding: Uint8Array;
  readonly embedding_model_provider: string;
  readonly embedding_model_id: string;
  readonly embedding_model_revision: string | null;
  readonly embedding_normalization: string | null;
  readonly embedding_instruction_version: string | null;
  readonly embedding_space_fingerprint: string | null;
  readonly embedding_dimensions_param: number | null;
  readonly vector_dimensions: number;
  readonly vector_metric: string;
  readonly created_at: number;
}

interface FakeSqliteVecCandidateRow {
  readonly chunk_id: string;
  readonly capsule_id: string;
  readonly source_id: string;
  readonly distance: number;
}

interface FakeVectorIndexState {
  readonly vectorRows: readonly FakeSqliteVecIndexRow[];
  readonly queryRows: readonly FakeSqliteVecCandidateRow[];
  readonly tempRowCount?: number;
  vectorIndexState?: {
    readonly status: "ready" | "dirty" | "unavailable";
    readonly vector_count: number;
    readonly vector_max_created_at: number | null;
  };
  insertedTempRows: Record<string, unknown>[];
  wroteReadyState: boolean;
  deletedTempRows: boolean;
}

interface FakePreparedStatement {
  readonly get?: (params?: Record<string, unknown>) => unknown;
  readonly all?: (params?: Record<string, unknown>) => readonly unknown[];
  readonly run?: (params?: Record<string, unknown>) => { readonly changes: number };
}

function encryptedFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "keiko-lk-vector-index-"));
  const key = new Uint8Array(32).fill(7);
  const store = openKnowledgeStore({
    dbPath: join(dir, "capsules.db"),
    protection: {
      mode: "encrypted-key-provider",
      keyProvider: {
        providerId: "test-static-key",
        resolveKey: () => key,
      },
    },
  });
  return {
    store,
    cleanup: (): void => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function detachedCapsule(
  identity: EmbeddingModelIdentity = DEFAULT_EMBEDDING,
  id = "cap-vector-index",
): KnowledgeCapsule {
  const fixture = freshStore();
  try {
    return createTestCapsule(fixture.store, { id, identity });
  } finally {
    fixture.cleanup();
  }
}

function createTestCapsule(
  store: KnowledgeStore,
  options: {
    readonly id?: string;
    readonly identity?: EmbeddingModelIdentity;
  } = {},
): KnowledgeCapsule {
  return createCapsule(
    store,
    sampleCapsuleInput({
      id: (options.id ?? "cap-vector-index") as KnowledgeCapsuleId,
      embeddingModelIdentity: options.identity ?? DEFAULT_EMBEDDING,
    }),
  );
}

function fakeVectorIndexStore(state: FakeVectorIndexState): KnowledgeStore {
  const db = {
    exec: (sql: string): void => {
      void sql;
    },
    prepare: (sql: string): FakePreparedStatement => {
      if (sql.includes("MAX(created_at)")) {
        return {
          get: (): { readonly n: number; readonly max_created_at: number | null } => ({
            n: state.vectorRows.length,
            max_created_at:
              state.vectorRows.length === 0
                ? null
                : Math.max(...state.vectorRows.map((row) => row.created_at)),
          }),
        };
      }
      if (sql.includes("FROM vector_index_state")) {
        return {
          get: (): unknown => {
            if (state.vectorIndexState === undefined) return undefined;
            return {
              capsule_id: state.vectorRows[0]?.capsule_id ?? "cap-vector-index",
              provider: "sqlite-vec",
              index_name: "keiko_lk_vec_1536_cosine",
              vector_dimensions: DEFAULT_EMBEDDING.vectorDimensions,
              vector_metric: DEFAULT_EMBEDDING.vectorMetric,
              embedding_identity_key: "fake-identity-key",
              status: state.vectorIndexState.status,
              reason: null,
              vector_count: state.vectorIndexState.vector_count,
              vector_max_created_at: state.vectorIndexState.vector_max_created_at,
              updated_at: 1,
            };
          },
        };
      }
      if (sql.includes("SELECT COUNT(*) AS n FROM temp.")) {
        return {
          get: (): { readonly n: number } => ({
            n: state.tempRowCount ?? state.insertedTempRows.length,
          }),
        };
      }
      if (sql.includes("FROM vectors")) {
        return {
          all: (): readonly FakeSqliteVecIndexRow[] => state.vectorRows,
        };
      }
      if (sql.includes("DELETE FROM temp.")) {
        return {
          run: (): { readonly changes: number } => {
            state.deletedTempRows = true;
            state.insertedTempRows = [];
            return { changes: 1 };
          },
        };
      }
      if (sql.includes("INSERT INTO temp.")) {
        return {
          run: (params: Record<string, unknown> = {}): { readonly changes: number } => {
            state.insertedTempRows.push(params);
            return { changes: 1 };
          },
        };
      }
      if (sql.includes("INSERT INTO vector_index_state")) {
        return {
          run: (): { readonly changes: number } => {
            state.wroteReadyState = true;
            return { changes: 1 };
          },
        };
      }
      if (sql.includes("WHERE embedding MATCH")) {
        return {
          all: (params: Record<string, unknown> = {}): readonly FakeSqliteVecCandidateRow[] => {
            const sourceId = typeof params.source_id === "string" ? params.source_id : undefined;
            return state.queryRows.filter(
              (row) => sourceId === undefined || row.source_id === sourceId,
            );
          },
        };
      }
      throw new Error(`unexpected fake sqlite statement: ${sql}`);
    },
  };
  return {
    close: (): void => {
      void state;
    },
    _internal: {
      db: db as unknown as DatabaseSync,
      now: () => 1,
      contentCipher: PLAINTEXT_CONTENT_CIPHER,
    },
  };
}

function fakeVectorRow(
  overrides: Partial<FakeSqliteVecIndexRow> = {},
  identity: EmbeddingModelIdentity = DEFAULT_EMBEDDING,
): FakeSqliteVecIndexRow {
  return {
    chunk_id: "chunk-a",
    capsule_id: "cap-vector-index",
    source_id: "src-a",
    embedding: new Uint8Array(new Float32Array(identity.vectorDimensions).buffer.slice(0)),
    embedding_model_provider: identity.provider,
    embedding_model_id: identity.modelId,
    embedding_model_revision: identity.modelRevision ?? null,
    embedding_normalization: identity.normalization ?? null,
    embedding_instruction_version: identity.instructionVersion ?? null,
    embedding_space_fingerprint: identity.embeddingSpaceFingerprint ?? null,
    embedding_dimensions_param: identity.dimensionsParam ?? null,
    vector_dimensions: identity.vectorDimensions,
    vector_metric: identity.vectorMetric,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function requestFor(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
  queryVector = new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
): VectorIndexSearchRequest {
  return {
    store,
    capsule,
    queryVector,
    candidateLimit: 3,
  };
}

function readVectorIndexStateRows(store: KnowledgeStore): readonly VectorIndexStateRow[] {
  return store._internal.db
    .prepare(
      [
        "SELECT status, reason, index_name, updated_at",
        "FROM vector_index_state",
        "ORDER BY index_name ASC",
      ].join(" "),
    )
    .all() as unknown as readonly VectorIndexStateRow[];
}

describe("searchVectorIndex", () => {
  it("returns explicit disabled diagnostics without probing sqlite-vec", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const result = searchVectorIndex(requestFor(fixture.store, capsule), { mode: "disabled" });

      expect(result).toMatchObject({
        ok: false,
        candidates: [],
        sawDimensionCompatible: false,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "brute-force",
          status: "disabled",
          reason: "vector-index-disabled",
        },
      });
      expect(readVectorIndexStateRows(fixture.store)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("delegates to an explicit adapter before sqlite-vec mode handling", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const calls: string[] = [];
      const adapter: VectorIndexAdapter = {
        searchCapsule: (request) => {
          calls.push(String(request.capsule.id));
          return {
            ok: true,
            candidates: [
              {
                chunkId: "chunk-from-adapter",
                capsuleId: request.capsule.id,
                score: 0.9,
              },
            ],
            sawDimensionCompatible: true,
            sawIdentityIncompatible: false,
            diagnostics: {
              provider: "sqlite-vec",
              status: "available",
              indexName: "adapter-index",
              vectorCount: 1,
            },
          };
        },
      };

      const result = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "disabled",
        adapter,
      });

      expect(calls).toEqual(["cap-vector-index"]);
      expect(result.ok).toBe(true);
      expect(result.candidates).toEqual([
        { chunkId: "chunk-from-adapter", capsuleId: capsule.id, score: 0.9 },
      ]);
      expect(result.diagnostics).toMatchObject({
        provider: "sqlite-vec",
        status: "available",
        indexName: "adapter-index",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("falls back and records unavailable state when sqlite-vec is not configured", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const result = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "auto",
        now: () => 1_700_000_000_123,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-unavailable",
          reason: "sqlite-vec-runtime-not-configured",
          indexName: "keiko_lk_vec_1536_cosine",
        },
      });
      expect(readVectorIndexStateRows(fixture.store)).toEqual([
        {
          status: "unavailable",
          reason: "sqlite-vec-runtime-not-configured",
          index_name: "keiko_lk_vec_1536_cosine",
          updated_at: 1_700_000_000_123,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("caches sqlite-vec module load failures per store", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      let loads = 0;
      const sqliteVec: SqliteVecModule = {
        load: () => {
          loads += 1;
          throw new Error("missing extension");
        },
      };

      const first = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "sqlite-vec",
        sqliteVec,
      });
      const second = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "sqlite-vec",
        sqliteVec,
      });

      expect(loads).toBe(1);
      expect(first.diagnostics).toMatchObject({
        status: "fallback-unavailable",
        reason: "sqlite-vec-module-load-failed",
      });
      expect(second.diagnostics).toMatchObject({
        status: "fallback-unavailable",
        reason: "sqlite-vec-module-load-failed",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed on encrypted stores before loading sqlite-vec", () => {
    const fixture = encryptedFixture();
    try {
      const capsule = createTestCapsule(fixture.store);
      let loads = 0;
      const sqliteVec: SqliteVecModule = {
        load: () => {
          loads += 1;
        },
      };

      const result = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "sqlite-vec",
        sqliteVec,
        now: () => 1_700_000_000_456,
      });

      expect(loads).toBe(0);
      expect(result).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-encrypted-store",
          reason: "encrypted-store",
          indexName: "keiko_lk_vec_1536_cosine",
        },
      });
      expect(readVectorIndexStateRows(fixture.store)).toEqual([
        {
          status: "unavailable",
          reason: "encrypted-store",
          index_name: "keiko_lk_vec_1536_cosine",
          updated_at: 1_700_000_000_456,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects unsupported vector metrics before loading sqlite-vec", () => {
    const fixture = freshStore();
    try {
      const identity: EmbeddingModelIdentity = {
        ...DEFAULT_EMBEDDING,
        vectorMetric: "dot",
      };
      const capsule = createTestCapsule(fixture.store, { identity });
      let loads = 0;
      const sqliteVec: SqliteVecModule = {
        load: () => {
          loads += 1;
        },
      };

      const result = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "sqlite-vec",
        sqliteVec,
        now: () => 1_700_000_000_789,
      });

      expect(loads).toBe(0);
      expect(result).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-unsupported-metric",
          reason: "unsupported-metric",
          indexName: "keiko_lk_vec_1536_dot",
        },
      });
      expect(readVectorIndexStateRows(fixture.store)).toEqual([
        {
          status: "unavailable",
          reason: "unsupported-metric",
          index_name: "keiko_lk_vec_1536_dot",
          updated_at: 1_700_000_000_789,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects query vector dimension mismatches without recording runtime fallback", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      let loads = 0;
      const sqliteVec: SqliteVecModule = {
        load: () => {
          loads += 1;
        },
      };

      const result = searchVectorIndex(requestFor(fixture.store, capsule, new Float32Array(32)), {
        mode: "sqlite-vec",
        sqliteVec,
      });

      expect(loads).toBe(0);
      expect(result).toMatchObject({
        ok: false,
        sawDimensionCompatible: false,
        sawIdentityIncompatible: true,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-incompatible-identity",
          reason: "query-dimension-mismatch",
          indexName: "keiko_lk_vec_1536_cosine",
        },
      });
      expect(readVectorIndexStateRows(fixture.store)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports query fallback when sqlite-vec loads but the virtual table is unavailable", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      let loads = 0;
      const sqliteVec: SqliteVecModule = {
        load: (_db: DatabaseSync) => {
          loads += 1;
        },
      };

      const result = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "sqlite-vec",
        sqliteVec,
        now: () => 1_700_000_001_000,
      });

      expect(loads).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-query-error",
          reason: "sqlite-vec-query-error",
          indexName: "keiko_lk_vec_1536_cosine",
        },
      });
      expect(readVectorIndexStateRows(fixture.store)).toEqual([
        {
          status: "unavailable",
          reason: "sqlite-vec-query-error",
          index_name: "keiko_lk_vec_1536_cosine",
          updated_at: 1_700_000_001_000,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports a controlled fallback when a configured loadable extension cannot load", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const result = searchVectorIndex(requestFor(fixture.store, capsule), {
        mode: "sqlite-vec",
        sqliteVecExtensionPath: "/missing/keiko/sqlite-vec",
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics.provider).toBe("sqlite-vec");
      expect(result.diagnostics.status).toBe("fallback-unavailable");
      expect(result.diagnostics.indexName).toBe("keiko_lk_vec_1536_cosine");
      expect(["sqlite-load-extension-unavailable", "sqlite-vec-extension-load-failed"]).toContain(
        result.diagnostics.reason,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rebuilds and queries a loaded sqlite-vec index without leaking other source scopes", () => {
    const identity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelRevision: "2026-07-01",
      normalization: "l2",
      instructionVersion: "query-v1",
      embeddingSpaceFingerprint: "space-a",
      dimensionsParam: DEFAULT_EMBEDDING.vectorDimensions,
    };
    const capsule = detachedCapsule(identity);
    const state: FakeVectorIndexState = {
      vectorRows: [
        fakeVectorRow({ chunk_id: "chunk-a", source_id: "src-a" }, identity),
        fakeVectorRow({ chunk_id: "chunk-b", source_id: "src-b" }, identity),
      ],
      queryRows: [
        { chunk_id: "chunk-b", capsule_id: "cap-vector-index", source_id: "src-b", distance: 0.1 },
        { chunk_id: "chunk-a", capsule_id: "cap-vector-index", source_id: "src-a", distance: 0.1 },
        {
          chunk_id: "chunk-low",
          capsule_id: "cap-vector-index",
          source_id: "src-a",
          distance: 0.9,
        },
      ],
      insertedTempRows: [],
      wroteReadyState: false,
      deletedTempRows: false,
    };
    const store = fakeVectorIndexStore(state);

    const result = searchVectorIndex(
      {
        ...requestFor(store, capsule),
        sourceFilter: ["src-a" as KnowledgeSourceId, "src-b" as KnowledgeSourceId],
        minScore: 0.5,
      },
      {
        mode: "sqlite-vec",
        sqliteVec: {
          load: (dbHandle) => {
            void dbHandle;
          },
        },
      },
    );

    expect(state.deletedTempRows).toBe(true);
    expect(state.insertedTempRows).toHaveLength(2);
    expect(state.wroteReadyState).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      sawDimensionCompatible: true,
      sawIdentityIncompatible: false,
      diagnostics: {
        provider: "sqlite-vec",
        status: "available",
        indexName: "keiko_lk_vec_1536_cosine",
        vectorCount: 2,
      },
    });
    expect(result.candidates.map((candidate) => candidate.chunkId)).toEqual(["chunk-a", "chunk-b"]);
  });

  it("reuses ready sqlite-vec state when the temp table still matches the vector stamp", () => {
    const capsule = detachedCapsule();
    const state: FakeVectorIndexState = {
      vectorRows: [fakeVectorRow({ chunk_id: "chunk-ready", created_at: 1_700_000_000_321 })],
      queryRows: [
        {
          chunk_id: "chunk-ready",
          capsule_id: "cap-vector-index",
          source_id: "src-a",
          distance: 0.25,
        },
      ],
      tempRowCount: 1,
      vectorIndexState: {
        status: "ready",
        vector_count: 1,
        vector_max_created_at: 1_700_000_000_321,
      },
      insertedTempRows: [],
      wroteReadyState: false,
      deletedTempRows: false,
    };
    const store = fakeVectorIndexStore(state);

    const result = searchVectorIndex(requestFor(store, capsule), {
      mode: "sqlite-vec",
      sqliteVec: {
        load: (dbHandle) => {
          void dbHandle;
        },
      },
    });

    expect(state.deletedTempRows).toBe(false);
    expect(state.insertedTempRows).toEqual([]);
    expect(state.wroteReadyState).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.candidates).toEqual([
      {
        chunkId: "chunk-ready",
        capsuleId: "cap-vector-index",
        sourceId: "src-a",
        score: 0.75,
      },
    ]);
  });

  it("fails closed when stored vector rows do not match the capsule identity", () => {
    const capsule = detachedCapsule();
    const state: FakeVectorIndexState = {
      vectorRows: [fakeVectorRow({ vector_metric: "invalid" })],
      queryRows: [],
      insertedTempRows: [],
      wroteReadyState: false,
      deletedTempRows: false,
    };
    const store = fakeVectorIndexStore(state);

    const result = searchVectorIndex(requestFor(store, capsule), {
      mode: "sqlite-vec",
      sqliteVec: {
        load: (dbHandle) => {
          void dbHandle;
        },
      },
    });

    expect(state.deletedTempRows).toBe(false);
    expect(state.wroteReadyState).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      sawDimensionCompatible: false,
      sawIdentityIncompatible: true,
      diagnostics: {
        provider: "sqlite-vec",
        status: "fallback-incompatible-identity",
        reason: "stored-vector-identity-mismatch",
        indexName: "keiko_lk_vec_1536_cosine",
      },
    });
  });
});
