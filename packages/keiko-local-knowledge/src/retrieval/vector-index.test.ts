import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingModelIdentity, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import { getCapsule } from "../capsule-lifecycle.js";
import { openKnowledgeStore, type KnowledgeStore } from "../store.js";

import { clearUsearchAnnCacheForTests } from "./usearch-ann-index.js";
import { seedCapsuleWithVectors } from "./_support.js";
import {
  resolveVectorIndexOptions,
  searchVectorIndex,
  usearchIndexName,
  type VectorIndexSearchRequest,
} from "./vector-index.js";

function requestFor(
  store: KnowledgeStore,
  capsuleId: string,
  queryVector = new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(1),
): VectorIndexSearchRequest {
  const capsule = getCapsule(store, capsuleId as KnowledgeCapsuleId);
  if (capsule === undefined) throw new Error("expected seeded capsule");
  return {
    store,
    capsule,
    queryVector,
    candidateLimit: 10,
  };
}

function encryptedStore(): {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "keiko-usearch-encrypted-"));
  const store = openKnowledgeStore({
    dbPath: join(dir, "capsules.db"),
    protection: {
      mode: "encrypted-key-provider",
      keyProvider: {
        providerId: "test-key",
        resolveKey: () => new Uint8Array(32).fill(17),
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

afterEach(() => {
  clearUsearchAnnCacheForTests();
});

describe("vector index service", () => {
  it("defaults to capability-driven USearch and carries only the approved runtime path", () => {
    expect(resolveVectorIndexOptions(undefined, {})).toMatchObject({
      mode: "auto",
      maxIndexedVectorBytes: 256 * 1024 * 1024,
    });
    expect(
      resolveVectorIndexOptions(undefined, {
        KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "usearch",
        KEIKO_USEARCH_BINARY_PATH: "/approved/usearch.node",
      }),
    ).toMatchObject({
      mode: "usearch",
      usearchBinaryPath: "/approved/usearch.node",
    });
    expect(
      resolveVectorIndexOptions(undefined, {
        KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "disabled",
      }),
    ).toMatchObject({ mode: "disabled" });
  });

  it("delegates to the one explicit port adapter before built-in mode handling", async () => {
    const fixture = freshStore();
    try {
      const capsule = {
        id: "cap-adapter",
        embeddingModelIdentity: DEFAULT_EMBEDDING,
      } as VectorIndexSearchRequest["capsule"];
      const expected = {
        ok: true,
        candidates: [],
        sawDimensionCompatible: true,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "usearch" as const,
          status: "available" as const,
        },
      };
      expect(
        await searchVectorIndex(
          {
            store: fixture.store,
            capsule,
            queryVector: new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(1),
            candidateLimit: 5,
          },
          {
            mode: "disabled",
            adapter: { searchCapsule: () => Promise.resolve(expected) },
          },
        ),
      ).toBe(expected);
    } finally {
      fixture.cleanup();
    }
  });

  it("scores encrypted-store vectors in memory without SQLite extension authority", async () => {
    const fixture = encryptedStore();
    try {
      const seeded = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "cap-encrypted",
        text: "alpha beta gamma delta epsilon ".repeat(80),
        chunkingOptions: { minTokens: 4, maxTokens: 8, overlapTokens: 0 },
      });
      expect(fixture.store._internal.contentCipher.isEncrypted).toBe(true);
      expect(() => {
        fixture.store._internal.db.loadExtension("/not/allowed");
      }).toThrow(/extension loading is not allowed/i);
      const result = await searchVectorIndex(
        requestFor(fixture.store, String(seeded.capsuleId)),
        undefined,
      );
      expect(result).toMatchObject({
        ok: true,
        sawDimensionCompatible: true,
        diagnostics: {
          provider: "usearch",
          status: "available",
          searchMode: "exact",
        },
      });
      expect(result.candidates.length).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("enforces source and chunk allow-lists as narrowing filters", async () => {
    const fixture = freshStore();
    try {
      const first = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "cap-scope",
        sourceId: "source-a",
        documentId: "doc-a",
      });
      const second = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "cap-scope",
        sourceId: "source-b",
        documentId: "doc-b",
        unitId: "unit-cap-scope-b",
        skipCapsule: true,
      });
      const request = requestFor(fixture.store, "cap-scope");
      const chunkId = second.chunkIds[0];
      expect(chunkId).toBeDefined();
      const filtered = await searchVectorIndex(
        {
          ...request,
          sourceFilter: [second.sourceId],
          chunkFilter: chunkId === undefined ? [] : [String(chunkId)],
        },
        undefined,
      );
      expect(filtered.ok).toBe(true);
      expect(filtered.candidates.map((candidate) => candidate.chunkId)).toEqual(
        chunkId === undefined ? [] : [String(chunkId)],
      );
      expect(
        filtered.candidates.every(
          (candidate) => String(candidate.sourceId) === String(second.sourceId),
        ),
      ).toBe(true);
      expect(first.sourceId).not.toBe(second.sourceId);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps delimiter-bearing capsule and source ids in distinct cache partitions", async () => {
    const fixture = freshStore();
    try {
      const first = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "a",
        sourceId: "b||c",
        documentId: "doc-a",
      });
      const second = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "a||b",
        sourceId: "c",
        documentId: "doc-b",
      });
      fixture.store._internal.db.prepare("UPDATE vectors SET created_at = 1000").run();
      const firstRequest = {
        ...requestFor(fixture.store, String(first.capsuleId)),
        sourceFilter: [first.sourceId],
      };
      const secondRequest = {
        ...requestFor(fixture.store, String(second.capsuleId)),
        sourceFilter: [second.sourceId],
      };

      expect((await searchVectorIndex(firstRequest, undefined)).candidates).not.toHaveLength(0);
      expect((await searchVectorIndex(secondRequest, undefined)).candidates).not.toHaveLength(0);
      const firstAgain = await searchVectorIndex(firstRequest, undefined);

      expect(firstAgain.ok).toBe(true);
      expect(firstAgain.candidates).not.toHaveLength(0);
      expect(
        firstAgain.candidates.every(
          (candidate) =>
            String(candidate.capsuleId) === String(first.capsuleId) &&
            String(candidate.sourceId) === String(first.sourceId),
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed on dimension, identity, decryption, and memory-bound violations", async () => {
    const fixture = encryptedStore();
    try {
      const seeded = await seedCapsuleWithVectors(fixture.store, {
        capsuleId: "cap-invalid",
      });
      const request = requestFor(fixture.store, String(seeded.capsuleId));
      expect(
        await searchVectorIndex({ ...request, queryVector: new Float32Array(2) }, undefined),
      ).toMatchObject({
        ok: false,
        sawIdentityIncompatible: true,
        diagnostics: { reason: "query-dimension-mismatch" },
      });

      fixture.store._internal.db
        .prepare(
          "UPDATE vectors SET embedding_space_fingerprint = :fingerprint WHERE capsule_id = :capsule",
        )
        .run({ capsule: String(seeded.capsuleId), fingerprint: "wrong-space" });
      expect(await searchVectorIndex(request, undefined)).toMatchObject({
        ok: false,
        sawIdentityIncompatible: true,
        diagnostics: { reason: "stored-vector-identity-mismatch" },
      });

      fixture.store._internal.db
        .prepare(
          "UPDATE vectors SET embedding_space_fingerprint = :fingerprint, embedding = :embedding WHERE capsule_id = :capsule",
        )
        .run({
          capsule: String(seeded.capsuleId),
          fingerprint: DEFAULT_EMBEDDING.embeddingSpaceFingerprint ?? "",
          embedding: new Uint8Array([1, 2, 3]),
        });
      expect(await searchVectorIndex(request, undefined)).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "usearch",
          status: "fallback-query-error",
          reason: "stored-vector-decrypt-failed",
        },
      });

      expect(await searchVectorIndex(request, { maxIndexedVectorBytes: 1 })).toMatchObject({
        ok: false,
        diagnostics: {
          status: "fallback-index-too-large",
          reason: "index-bytes-over-bound",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("uses a content/identity-bound name without exposing content", () => {
    const alternative: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      embeddingSpaceFingerprint: "other-space",
    };
    expect(usearchIndexName(DEFAULT_EMBEDDING)).toContain("keiko-hnsw");
    expect(usearchIndexName(alternative)).not.toBe(usearchIndexName(DEFAULT_EMBEDDING));
  });
});
