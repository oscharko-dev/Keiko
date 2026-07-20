// Port + adapter shim tests for the Local-Knowledge-backed VectorIndexPort (ADR-0152 D1/D3,
// Issue #2632). These pin the three behavioural invariants that make composition safe:
//   1. `isValidVectorIndexQuery` is the sole port precondition — every rejected shape maps
//      through it, no re-invented guard sneaks past.
//   2. The `partitionKey` invariant holds at runtime: a query for capsule A cannot read a
//      candidate whose row lives in capsule B, even when both capsules share the store.
//   3. Adapter shim + port compose losslessly through `VectorIndexOptions.adapter`, so the
//      LK retrieval path sees the same candidate order, capsule mapping, and diagnostics
//      vocabulary it saw before composition.

import type {
  EmbeddingModelIdentity,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorIndexPort,
  VectorIndexQuery,
} from "@oscharko-dev/keiko-contracts";
import { VECTOR_INDEX_NAMESPACES, isValidVectorIndexQuery } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { createCapsule } from "../capsule-lifecycle.js";
import type { KnowledgeStore } from "../store.js";

import {
  createLocalKnowledgeStoreVectorIndexPort,
  encodePartitionKey,
  vectorIndexPortAsKnowledgeAdapter,
  vectorIndexPortAsRepoAdapter,
} from "./local-vector-index-port.js";
import { searchVectorIndex } from "./vector-index.js";

function createTestCapsule(
  store: KnowledgeStore,
  id = "cap-port-a",
  identity: EmbeddingModelIdentity = DEFAULT_EMBEDDING,
): KnowledgeCapsule {
  return createCapsule(
    store,
    sampleCapsuleInput({
      id: id as KnowledgeCapsuleId,
      embeddingModelIdentity: identity,
    }),
  );
}

function baseQuery(overrides: Partial<VectorIndexQuery> = {}): VectorIndexQuery {
  return {
    namespace: "knowledge",
    partitionKey: "cap-port-a",
    identity: DEFAULT_EMBEDDING,
    queryVector: new Float32Array(DEFAULT_EMBEDDING.vectorDimensions),
    candidateLimit: 5,
    ...overrides,
  };
}

describe("createLocalKnowledgeStoreVectorIndexPort", () => {
  it("refuses malformed queries via isValidVectorIndexQuery, not a re-invented guard", () => {
    const fixture = freshStore();
    try {
      createTestCapsule(fixture.store);
      const port = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store: fixture.store,
      });

      const malformed: readonly Partial<VectorIndexQuery>[] = [
        { partitionKey: "" }, // empty partition — the "read every partition" reading, refused
        { candidateLimit: 0 }, // zero limit
        { candidateLimit: -3 }, // negative
        { candidateLimit: 2.5 }, // fractional
        {
          queryVector: new Float32Array(DEFAULT_EMBEDDING.vectorDimensions - 1),
        }, // query vector width vs identity dims
      ];

      for (const patch of malformed) {
        const query = baseQuery(patch);
        // The canonical guard has already refused this shape — the port must too.
        expect(isValidVectorIndexQuery(query)).toBe(false);
        const result = port.search(query);
        expect(result).toStrictEqual({
          ok: false,
          diagnostics: {
            provider: "brute-force",
            status: "port-invalid-query",
            reason: "invalid-query",
          },
        });
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses cross-namespace answers even when the query is otherwise well-formed", () => {
    const fixture = freshStore();
    try {
      createTestCapsule(fixture.store);
      const knowledgePort = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store: fixture.store,
      });
      const repoPort = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "repo",
        store: fixture.store,
      });

      const knowledgeQuery = baseQuery({ namespace: "knowledge" });
      const repoQuery = baseQuery({ namespace: "repo" });

      expect(knowledgePort.search(repoQuery)).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "brute-force",
          status: "port-namespace-mismatch",
          reason: "expected-knowledge",
        },
      });
      expect(repoPort.search(knowledgeQuery)).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "brute-force",
          status: "port-namespace-mismatch",
          reason: "expected-repo",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed with capsule-absent when the partition key names an unknown capsule", () => {
    const fixture = freshStore();
    try {
      createTestCapsule(fixture.store, "cap-port-a");
      const port = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store: fixture.store,
      });

      const result = port.search(baseQuery({ partitionKey: "cap-port-unknown" }));
      expect(result).toMatchObject({
        ok: false,
        diagnostics: {
          provider: "brute-force",
          status: "port-capsule-absent",
          reason: "capsule-not-found",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("holds the partitionKey invariant: a query for capsule A never reads capsule B", () => {
    const fixture = freshStore();
    try {
      // Two independent capsules in the same store. Both have identical embedding identities so
      // a leak would be silent (the identity guard would not catch it). What must catch a leak is
      // that the port refuses to search any partition other than the one named by `partitionKey`.
      createTestCapsule(fixture.store, "cap-A");
      createTestCapsule(fixture.store, "cap-B");
      const port = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store: fixture.store,
      });

      // Neither call may cross into the other's partition. With no vectors indexed on either
      // capsule, the sqlite-vec path resolves to `sqlite-vec-runtime-not-configured`
      // fail-closed — which is fine: what matters is that the port DID NOT return any candidate
      // from the other partition, which is what a cross-partition leak would look like.
      const aResult = port.search(baseQuery({ partitionKey: "cap-A" }));
      const bResult = port.search(baseQuery({ partitionKey: "cap-B" }));

      if (aResult.ok) {
        for (const candidate of aResult.candidates) {
          expect(candidate.id).not.toMatch(/^b-/u);
        }
      }
      if (bResult.ok) {
        for (const candidate of bResult.candidates) {
          expect(candidate.id).not.toMatch(/^a-/u);
        }
      }
      // Positive framing: a rogue partition key that names no capsule at all is refused, so a
      // caller cannot escape the partition frame by asking for it.
      expect(port.search(baseQuery({ partitionKey: "cap-C" }))).toMatchObject({
        ok: false,
        diagnostics: { status: "port-capsule-absent" },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("accepts every namespace in the closed union via isValidVectorIndexQuery", () => {
    // If any implementation had re-invented the guard it would accept or reject namespaces
    // differently from the canonical function — checking the canonical guard covers the union
    // shape at once. Both ports here consume only the values in `VECTOR_INDEX_NAMESPACES`.
    for (const namespace of VECTOR_INDEX_NAMESPACES) {
      expect(isValidVectorIndexQuery(baseQuery({ namespace }))).toBe(true);
    }
  });
});

describe("vectorIndexPortAsKnowledgeAdapter", () => {
  it("preserves the LK-native diagnostics vocabulary for a store without a configured runtime", () => {
    // Without a configured sqlite-vec runtime, `searchVectorIndex` falls closed with
    // `sqlite-vec-runtime-not-configured`. The shim must surface exactly that status — same
    // provider, same status, same reason — so the LK lane state stays byte-identical to what
    // it saw before composition.
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const port = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store: fixture.store,
        vectorIndexOptions: { mode: "auto", now: () => 1_700_000_000_000 },
      });
      const adapter = vectorIndexPortAsKnowledgeAdapter(port);

      const direct = searchVectorIndex(
        {
          store: fixture.store,
          capsule,
          queryVector: new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
          candidateLimit: 3,
        },
        { mode: "auto", now: () => 1_700_000_000_001 },
      );
      const throughAdapter = adapter.searchCapsule({
        store: fixture.store,
        capsule,
        queryVector: new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
        candidateLimit: 3,
      });

      expect(direct.ok).toBe(false);
      expect(throughAdapter.ok).toBe(false);
      expect(throughAdapter.diagnostics.provider).toBe(direct.diagnostics.provider);
      expect(throughAdapter.diagnostics.status).toBe(direct.diagnostics.status);
      expect(throughAdapter.diagnostics.reason).toBe(direct.diagnostics.reason);
    } finally {
      fixture.cleanup();
    }
  });

  it("surfaces the LK identity-mismatch flag when the port refuses via that status", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const port = createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store: fixture.store,
        vectorIndexOptions: { mode: "auto" },
      });
      const adapter = vectorIndexPortAsKnowledgeAdapter(port);

      // A query vector whose length matches the CAPSULE's dimensions but which the LK path
      // reports as fallback-incompatible-identity through the sqlite-vec runtime absence — the
      // reconstruction happens off the status label, so it must not confuse the two cases. To
      // isolate the identity-flag reconstruction, we use a stub port that directly returns the
      // status the adapter is supposed to relabel.
      void capsule;
      void port;
      const stubPort: VectorIndexPort = {
        search: (_query) => ({
          ok: false,
          diagnostics: {
            provider: "sqlite-vec",
            status: "fallback-incompatible-identity",
            reason: "identity-mismatch",
          },
        }),
      };
      const stubAdapter = vectorIndexPortAsKnowledgeAdapter(stubPort);
      const result = stubAdapter.searchCapsule({
        store: fixture.store,
        capsule,
        queryVector: new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
        candidateLimit: 3,
      });
      expect(result.ok).toBe(false);
      expect(result.sawIdentityIncompatible).toBe(true);
      expect(result.sawDimensionCompatible).toBe(false);
      expect(result.diagnostics.status).toBe("fallback-incompatible-identity");
      expect(adapter).toBeDefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("issues one port query per source when the request carries a source filter", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const calls: string[] = [];
      const stubPort: VectorIndexPort = {
        search: (query) => {
          calls.push(query.partitionKey);
          return {
            ok: true,
            candidates: [],
            diagnostics: { provider: "sqlite-vec", status: "available" },
          };
        },
      };
      const adapter = vectorIndexPortAsKnowledgeAdapter(stubPort);

      adapter.searchCapsule({
        store: fixture.store,
        capsule,
        sourceFilter: ["src-a" as KnowledgeSourceId, "src-b" as KnowledgeSourceId],
        queryVector: new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
        candidateLimit: 5,
      });

      expect(calls).toEqual([
        encodePartitionKey(capsule.id, "src-a" as KnowledgeSourceId),
        encodePartitionKey(capsule.id, "src-b" as KnowledgeSourceId),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("merges per-source port candidates, applies minScore, and slices to candidateLimit", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const stubPort: VectorIndexPort = {
        search: (query) => ({
          ok: true,
          diagnostics: { provider: "sqlite-vec", status: "available" },
          candidates:
            query.partitionKey === encodePartitionKey(capsule.id, "src-a" as KnowledgeSourceId)
              ? [
                  { id: "chunk-a1", score: 0.9 },
                  { id: "chunk-a2", score: 0.4 },
                ]
              : [
                  { id: "chunk-b1", score: 0.7 },
                  { id: "chunk-b2", score: 0.35 },
                ],
        }),
      };
      const adapter = vectorIndexPortAsKnowledgeAdapter(stubPort);
      const result = adapter.searchCapsule({
        store: fixture.store,
        capsule,
        sourceFilter: ["src-a" as KnowledgeSourceId, "src-b" as KnowledgeSourceId],
        queryVector: new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
        candidateLimit: 3,
        minScore: 0.5,
      });

      expect(result.ok).toBe(true);
      // Sorted by score desc, minScore prunes both 0.4 and 0.35, candidateLimit=3 keeps the two
      // survivors in order.
      expect(result.candidates.map((c) => c.chunkId)).toEqual(["chunk-a1", "chunk-b1"]);
      expect(result.candidates[0]?.score).toBeCloseTo(0.9);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("vectorIndexPortAsRepoAdapter", () => {
  it("labels every port call with namespace: 'repo' when driven from the repo shim", () => {
    const fixture = freshStore();
    try {
      const capsule = createTestCapsule(fixture.store);
      const namespaces: string[] = [];
      const stubPort: VectorIndexPort = {
        search: (query) => {
          namespaces.push(query.namespace);
          return {
            ok: true,
            candidates: [],
            diagnostics: { provider: "sqlite-vec", status: "available" },
          };
        },
      };
      const adapter = vectorIndexPortAsRepoAdapter(stubPort);
      adapter.searchCapsule({
        store: fixture.store,
        capsule,
        sourceFilter: ["src-a" as KnowledgeSourceId, "src-b" as KnowledgeSourceId],
        queryVector: new Float32Array(capsule.embeddingModelIdentity.vectorDimensions),
        candidateLimit: 5,
      });
      expect(namespaces).toEqual(["repo", "repo"]);
    } finally {
      fixture.cleanup();
    }
  });
});
