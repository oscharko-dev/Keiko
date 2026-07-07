// Tests for the scoped vector search (Epic #189, Issue #199). Pins the load-bearing
// invariants:
//   * empty capsule → noEvidenceReason: "no-vectors"
//   * scope to capsule A only → never returns refs from capsule B
//   * composed scope (A + B) → returns refs from both, no global pool
//   * topK clamping and minScore filtering
//   * dim mismatch on adapter response → noEvidenceReason: "incompatible-embedding-identity"
//   * citation fields (pageNumber / sectionPath / characterStart / characterEnd) carry through

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CapsuleSetId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";

import type { ComposedRetrievalScope } from "../composition.js";
import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import {
  searchVectorsForScope,
  toScopeInput,
  type RetrievalScopeInput,
} from "./scoped-vector-search.js";
import type { VectorIndexAdapter } from "./vector-index.js";
import { QWEN3_QUERY_INSTRUCTION_TASK } from "./embedding-query-shaping.js";
import {
  deterministicVector,
  scriptedAdapter,
  seedCapsuleWithVectors,
  type ParsedUnitWithoutDocId,
} from "./_support.js";
import type { KnowledgeStore } from "../store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

const LEGACY_EMBEDDING: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
};

let fixture: Fixture | undefined;

beforeEach(() => {
  fixture = freshStore();
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function getFixture(): Fixture {
  if (fixture === undefined) throw new Error("fixture not initialised");
  return fixture;
}

function vectorBlob(first: number, second: number): Uint8Array {
  const vector = new Float32Array(DEFAULT_EMBEDDING.vectorDimensions);
  vector[0] = first;
  vector[1] = second;
  return new Uint8Array(vector.buffer.slice(0));
}

function isEmbeddingCapabilityProbe(input: string): boolean {
  return input === "ping" || input.startsWith("Keiko embedding space probe:");
}

function userEmbeddingInputs(inputs: readonly string[]): readonly string[] {
  return inputs.filter((input) => !isEmbeddingCapabilityProbe(input));
}

function fixedQueryVectorOutcome(
  req: { readonly input: string; readonly modelId: string },
  vector: Float32Array,
  dimensions: number = DEFAULT_EMBEDDING.vectorDimensions,
): OpenAIEmbeddingOutcome {
  return {
    ok: true,
    value: {
      vector: isEmbeddingCapabilityProbe(req.input)
        ? deterministicVector(req.input, dimensions)
        : vector,
      modelId: req.modelId,
    },
  };
}

function setCapsuleVector(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  blob: Uint8Array,
): void {
  store._internal.db
    .prepare("UPDATE vectors SET embedding = :embedding WHERE capsule_id = :capsule_id")
    .run({ embedding: blob, capsule_id: capsuleId });
}

function setChunkVector(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkId: string,
  blob: Uint8Array,
): void {
  store._internal.db
    .prepare(
      "UPDATE vectors SET embedding = :embedding WHERE capsule_id = :capsule_id AND chunk_id = :chunk_id",
    )
    .run({ embedding: blob, capsule_id: capsuleId, chunk_id: chunkId });
}

function setChunkVectorAt(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  chunkId: string,
  blob: Uint8Array,
  createdAt: number,
): void {
  store._internal.db
    .prepare(
      [
        "UPDATE vectors",
        "SET embedding = :embedding, created_at = :created_at",
        "WHERE capsule_id = :capsule_id AND chunk_id = :chunk_id",
      ].join(" "),
    )
    .run({ embedding: blob, created_at: createdAt, capsule_id: capsuleId, chunk_id: chunkId });
}

function duplicateFirstVectorRows(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  copies: number,
  sourceId?: KnowledgeSourceId,
): void {
  const insert = store._internal.db.prepare(
    [
      "INSERT INTO vectors (",
      "  id, capsule_id, source_id, document_id, chunk_id, embedding,",
      "  embedding_model_provider, embedding_model_id, embedding_model_revision,",
      "  embedding_normalization, embedding_instruction_version, embedding_space_fingerprint,",
      "  embedding_dimensions_param, vector_dimensions, vector_metric, storage_reference, created_at",
      ")",
      "SELECT :id, capsule_id, source_id, document_id, chunk_id, embedding,",
      "  embedding_model_provider, embedding_model_id, embedding_model_revision,",
      "  embedding_normalization, embedding_instruction_version, embedding_space_fingerprint,",
      "  embedding_dimensions_param, vector_dimensions, vector_metric, :storage_reference,",
      "  created_at + :offset",
      "FROM vectors",
      "WHERE capsule_id = :capsule_id AND (:source_id IS NULL OR source_id = :source_id)",
      "ORDER BY id ASC",
      "LIMIT 1",
    ].join(" "),
  );
  for (let i = 0; i < copies; i += 1) {
    insert.run({
      id: `vec:${String(capsuleId)}:duplicate:${String(i)}`,
      capsule_id: String(capsuleId),
      source_id: sourceId === undefined ? null : String(sourceId),
      storage_reference: `duplicate-${String(i)}`,
      offset: i + 1,
    });
  }
}

describe("searchVectorsForScope — empty capsule", () => {
  it("returns noEvidenceReason 'no-vectors' when the capsule has zero vectors", async () => {
    const { store } = getFixture();
    // Create the capsule + source + document but DO NOT embed any chunks. We do this by
    // bypassing the seedCapsuleWithVectors helper and using its lower-level pieces.
    const { createCapsule } = await import("../capsule-lifecycle.js");
    const { addSourceToCapsule } = await import("../source-lifecycle.js");
    const { sampleCapsuleInput, sampleSourceInput } = await import("../_support.js");
    createCapsule(store, sampleCapsuleInput({ id: "cap-empty" as KnowledgeCapsuleId }));
    addSourceToCapsule(store, "cap-empty" as KnowledgeCapsuleId, sampleSourceInput("src-empty"));

    const scope: RetrievalScopeInput = { capsuleIds: ["cap-empty" as KnowledgeCapsuleId] };
    const outcome = await searchVectorsForScope(store, scriptedAdapter(), scope, "query", {
      topK: 10,
    });
    expect(outcome.references).toHaveLength(0);
    expect(outcome.noEvidenceReason).toBe("no-vectors");
  });
});

describe("searchVectorsForScope — single capsule", () => {
  it("returns ONLY capsule A's references when scope is capsule A", async () => {
    const { store } = getFixture();
    const a = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      sourceId: "src-a",
      documentId: "doc-a",
      text:
        "alpha alpha alpha beta beta beta gamma gamma gamma delta delta delta " +
        "epsilon epsilon epsilon zeta zeta zeta eta eta eta theta theta theta",
    });
    const b = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-b",
      sourceId: "src-b",
      documentId: "doc-b",
      text:
        "iota iota iota kappa kappa kappa lambda lambda lambda mu mu mu " +
        "nu nu nu xi xi xi omicron omicron omicron pi pi pi",
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [a.capsuleId] },
      "query",
      { topK: 10 },
    );
    expect(outcome.references.length).toBeGreaterThan(0);
    for (const ref of outcome.references) {
      expect(String(ref.capsuleId)).toBe("cap-a");
      expect(String(ref.citation.capsuleId)).toBe("cap-a");
    }
    // Sanity: capsule B's chunks were seeded but never surface in capsule-A scope.
    expect(b.chunkIds.length).toBeGreaterThan(0);
  });

  it("returns references in score-descending order", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 10 },
    );
    expect(outcome.references.length).toBeGreaterThan(1);
    for (let i = 1; i < outcome.references.length; i += 1) {
      const prev = outcome.references[i - 1];
      const curr = outcome.references[i];
      if (prev === undefined || curr === undefined) throw new Error("unreachable");
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
  });

  it("restricts references to the optional source filter", async () => {
    const { store } = getFixture();
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      sourceId: "src-a",
      documentId: "doc-a",
      contentHash: "a".repeat(64),
      text: "alpha alpha alpha beta beta beta gamma gamma gamma delta delta delta",
    });
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      sourceId: "src-b",
      documentId: "doc-b",
      contentHash: "b".repeat(64),
      text: "iota iota iota kappa kappa kappa lambda lambda lambda mu mu mu",
      unitId: "unit-cap-a-src-b",
      skipCapsule: true,
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [seededA.capsuleId], sourceFilter: [seededA.sourceId] },
      "query",
      { topK: 50 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    expect(new Set(outcome.references.map((ref) => String(ref.citation.sourceId)))).toEqual(
      new Set(["src-a"]),
    );
  });
});

describe("searchVectorsForScope — composed capsule set", () => {
  it("returns references from both capsules when scope spans A and B", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      sourceId: "src-a",
      documentId: "doc-a",
      text: "alpha alpha alpha beta beta beta gamma gamma gamma delta delta delta",
    });
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-b",
      sourceId: "src-b",
      documentId: "doc-b",
      text: "epsilon epsilon epsilon zeta zeta zeta eta eta eta theta theta theta",
    });
    const scope: RetrievalScopeInput = {
      capsuleIds: ["cap-a" as KnowledgeCapsuleId, "cap-b" as KnowledgeCapsuleId],
    };
    const outcome = await searchVectorsForScope(store, scriptedAdapter(), scope, "query", {
      topK: 20,
    });
    const capsuleIds = new Set(outcome.references.map((r) => String(r.capsuleId)));
    expect(capsuleIds.has("cap-a")).toBe(true);
    expect(capsuleIds.has("cap-b")).toBe(true);
  });

  it("gates each member independently: a sealed member's model is never embedded", async () => {
    const { store } = getFixture();
    // Distinct model ids put the sealed and standard members in separate lanes, so every
    // provider call names the member it belongs to and per-member gating is observable.
    const sealedIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "model-sealed",
    };
    const standardIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "model-standard",
    };
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-sealed",
      sourceId: "src-sealed",
      documentId: "doc-sealed",
      identity: sealedIdentity,
      modelUsePolicy: sealedLocalPodModelUsePolicy(),
      text: "alpha alpha alpha beta beta beta gamma gamma gamma",
    });
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-standard",
      sourceId: "src-standard",
      documentId: "doc-standard",
      identity: standardIdentity,
      modelUsePolicy: standardPodModelUsePolicy(),
      text: "epsilon epsilon epsilon zeta zeta zeta eta eta eta",
    });
    const embeddedModelIds: string[] = [];
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        embeddedModelIds.push(req.modelId);
        return {
          ok: true,
          value: { vector: deterministicVector(req.input, 1536), modelId: req.modelId },
        };
      },
    });
    const scope: RetrievalScopeInput = {
      capsuleIds: ["cap-sealed" as KnowledgeCapsuleId, "cap-standard" as KnowledgeCapsuleId],
    };

    const outcome = await searchVectorsForScope(store, adapter, scope, "query", { topK: 20 });

    expect(embeddedModelIds).not.toContain("model-sealed");
    expect(embeddedModelIds).toContain("model-standard");
    const refCapsuleIds = new Set(outcome.references.map((r) => String(r.capsuleId)));
    expect(refCapsuleIds.has("cap-standard")).toBe(true);
    expect(refCapsuleIds.has("cap-sealed")).toBe(false);
    const laneStatuses = (outcome.diagnostics.embeddingLanes ?? []).map((lane) => lane.status);
    expect(laneStatuses).toContain("policy-denied");
    expect(laneStatuses).toContain("searched");
  });

  // Regression for #2011 audit finding: a sealed pod's dense lane is policy-gated
  // (`isExternalEmbeddingAllowed`), but the lexical/BM25 lane read raw FTS rows with no
  // policy check at all. A query that lexically matches the sealed content (rather than
  // the fixture's deliberately-disjoint governance query) returned the chunk as a normal
  // reference. Before the fix this test fails with `referenceCount > 0` and
  // `noEvidenceReason` unset.
  it("denies the lexical lane too: a sealed capsule cannot leak via a lexically-matching query", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-sealed",
      sourceId: "src-sealed",
      documentId: "doc-sealed",
      modelUsePolicy: sealedLocalPodModelUsePolicy(),
      text: "restricted compliance dossier body retained inside the sealed capsule",
      // A single full-text chunk, matching how `readFtsCandidatesForCapsule` is exercised
      // elsewhere in this file — the default small chunking would split the phrase across
      // multiple 2-token chunks and mask the lexical match this test needs.
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const scope: RetrievalScopeInput = { capsuleIds: ["cap-sealed" as KnowledgeCapsuleId] };

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      scope,
      // Exact lexical overlap with the seeded text — the dense lane is denied by policy,
      // so the only route to the chunk is the (previously ungated) lexical lane.
      "restricted compliance dossier body",
      { topK: 20 },
    );

    expect(outcome.references).toHaveLength(0);
    expect(outcome.noEvidenceReason).toBe("policy-denied");
  });

  it("preserves configured gateway egress on the actual query embedding request", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-egress",
      sourceId: "src-egress",
      documentId: "doc-egress",
      text: "alpha beta gamma delta",
      modelUsePolicy: standardPodModelUsePolicy(),
    });
    const egress = { allowPrivateNetwork: true } as const;
    const requests: OpenAIEmbeddingRequest[] = [];
    const base = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, deterministicVector(req.input, 1536)),
    });
    const adapter: OpenAIEmbeddingAdapter = {
      ...base,
      egress,
      request: async (req): Promise<OpenAIEmbeddingOutcome> => {
        requests.push(req);
        return base.request(req);
      },
    };

    await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-egress" as KnowledgeCapsuleId] },
      "query requiring egress policy",
      { topK: 1 },
    );

    const queryRequest = requests.find((req) => !isEmbeddingCapabilityProbe(req.input));
    expect(queryRequest).toBeDefined();
    expect(queryRequest?.egress).toBe(egress);
  });

  it("uses lane-local dense ranks before fusing incompatible raw score spaces", async () => {
    const { store } = getFixture();
    const identityA: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "model-a" };
    const identityB: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "model-b" };
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-lane-a",
      sourceId: "src-lane-a",
      documentId: "doc-lane-a",
      identity: identityA,
      text: "alpha beta gamma delta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const seededB = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-lane-b",
      sourceId: "src-lane-b",
      documentId: "doc-lane-b",
      identity: identityB,
      text: "epsilon zeta eta theta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const aChunk = seededA.chunkIds[0];
    const bFirst = seededB.chunkIds[0];
    const bSecond = seededB.chunkIds[1];
    if (aChunk === undefined || bFirst === undefined || bSecond === undefined) {
      throw new Error("expected seeded chunks");
    }
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id IN (:a, :b)")
      .run({ a: String(seededA.capsuleId), b: String(seededB.capsuleId) });
    const indexed: VectorIndexAdapter = {
      searchCapsule: (request) => ({
        ok: true,
        candidates:
          String(request.capsule.id) === "cap-lane-a"
            ? [
                {
                  chunkId: String(aChunk),
                  capsuleId: request.capsule.id,
                  sourceId: seededA.sourceId,
                  score: 0.1,
                },
              ]
            : [
                {
                  chunkId: String(bFirst),
                  capsuleId: request.capsule.id,
                  sourceId: seededB.sourceId,
                  score: 0.99,
                },
                {
                  chunkId: String(bSecond),
                  capsuleId: request.capsule.id,
                  sourceId: seededB.sourceId,
                  score: 0.98,
                },
              ],
        sawDimensionCompatible: true,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "available",
          indexName: "lane-local-test-index",
          vectorCount: 1,
        },
      }),
    };
    const embeddedModels: string[] = [];
    const embeddingAdapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        embeddedModels.push(req.modelId);
        return fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer));
      },
    });

    const outcome = await searchVectorsForScope(
      store,
      embeddingAdapter,
      { capsuleIds: [seededA.capsuleId, seededB.capsuleId] },
      "unmatched lane query",
      { topK: 2, vectorIndex: { adapter: indexed } },
    );

    expect(new Set(embeddedModels)).toEqual(new Set(["model-a", "model-b"]));
    expect(outcome.references).toHaveLength(2);
    expect(new Set(outcome.references.map((ref) => String(ref.capsuleId)))).toEqual(
      new Set(["cap-lane-a", "cap-lane-b"]),
    );
    expect(outcome.diagnostics.embeddingLaneCount).toBe(2);
    expect(outcome.diagnostics.embeddingLanes?.map((lane) => lane.status).sort()).toEqual([
      "searched",
      "searched",
    ]);
  });

  it("keeps hash-colliding display lane ids separate by canonical identity", async () => {
    const { store } = getFixture();
    const identityA: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "collision-model-01wl8",
    };
    const identityB: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "collision-model-0yqd6",
    };
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-collision-a",
      sourceId: "src-collision-a",
      documentId: "doc-collision-a",
      identity: identityA,
      text: "alpha beta gamma delta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const seededB = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-collision-b",
      sourceId: "src-collision-b",
      documentId: "doc-collision-b",
      identity: identityB,
      text: "epsilon zeta eta theta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const aChunk = seededA.chunkIds[0];
    const bFirst = seededB.chunkIds[0];
    const bSecond = seededB.chunkIds[1];
    if (aChunk === undefined || bFirst === undefined || bSecond === undefined) {
      throw new Error("expected seeded chunks");
    }
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id IN (:a, :b)")
      .run({ a: String(seededA.capsuleId), b: String(seededB.capsuleId) });
    const indexed: VectorIndexAdapter = {
      searchCapsule: (request) => ({
        ok: true,
        candidates:
          String(request.capsule.id) === "cap-collision-a"
            ? [
                {
                  chunkId: String(aChunk),
                  capsuleId: request.capsule.id,
                  sourceId: seededA.sourceId,
                  score: 0.1,
                },
              ]
            : [
                {
                  chunkId: String(bFirst),
                  capsuleId: request.capsule.id,
                  sourceId: seededB.sourceId,
                  score: 0.99,
                },
                {
                  chunkId: String(bSecond),
                  capsuleId: request.capsule.id,
                  sourceId: seededB.sourceId,
                  score: 0.98,
                },
              ],
        sawDimensionCompatible: true,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "available",
          indexName: "hash-collision-test-index",
          vectorCount: 1,
        },
      }),
    };
    const embeddingAdapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      embeddingAdapter,
      { capsuleIds: [seededA.capsuleId, seededB.capsuleId] },
      "hash collision lane query",
      { topK: 2, vectorIndex: { adapter: indexed } },
    );

    expect(outcome.diagnostics.embeddingLaneCount).toBe(2);
    expect(new Set(outcome.diagnostics.embeddingLanes?.map((lane) => lane.laneId))).toEqual(
      new Set(["embedding-lane-1245e5ed"]),
    );
    expect(new Set(outcome.references.map((ref) => String(ref.capsuleId)))).toEqual(
      new Set(["cap-collision-a", "cap-collision-b"]),
    );
  });

  it("breaks a full cross-lane RRF tie deterministically and stably by chunk id", async () => {
    const { store } = getFixture();
    const identityA: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "tie-model-a" };
    const identityB: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "tie-model-b" };
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-tie-a",
      sourceId: "src-tie-a",
      documentId: "doc-tie-a",
      identity: identityA,
      text: "governed lane evidence alpha",
      chunkingOptions: { maxTokens: 64, minTokens: 0, overlapTokens: 0 },
    });
    const seededB = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-tie-b",
      sourceId: "src-tie-b",
      documentId: "doc-tie-b",
      identity: identityB,
      text: "governed lane evidence beta",
      chunkingOptions: { maxTokens: 64, minTokens: 0, overlapTokens: 0 },
    });
    const aChunk = seededA.chunkIds[0];
    const bChunk = seededB.chunkIds[0];
    if (aChunk === undefined || bChunk === undefined) {
      throw new Error("expected seeded chunks");
    }
    // Drop lexical rows so only the two dense lanes fuse — each contributes a single rank-1
    // candidate, so both chunks receive exactly rrf(1) and the fused scores are equal. Ordering is
    // therefore decided purely by the total-order tiebreak in fusedScoreDesc (chunk id), and must
    // be identical run-to-run.
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id IN (:a, :b)")
      .run({ a: String(seededA.capsuleId), b: String(seededB.capsuleId) });
    const denseScore = 0.5;
    const indexed: VectorIndexAdapter = {
      searchCapsule: (request) => ({
        ok: true,
        candidates:
          String(request.capsule.id) === "cap-tie-a"
            ? [
                {
                  chunkId: String(aChunk),
                  capsuleId: request.capsule.id,
                  sourceId: seededA.sourceId,
                  score: denseScore,
                },
              ]
            : [
                {
                  chunkId: String(bChunk),
                  capsuleId: request.capsule.id,
                  sourceId: seededB.sourceId,
                  score: denseScore,
                },
              ],
        sawDimensionCompatible: true,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "available",
          indexName: "tie-break-test-index",
          vectorCount: 1,
        },
      }),
    };
    const embeddingAdapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const run = async (): Promise<readonly string[]> => {
      const outcome = await searchVectorsForScope(
        store,
        embeddingAdapter,
        { capsuleIds: [seededA.capsuleId, seededB.capsuleId] },
        "tie-break lane query",
        { topK: 2, vectorIndex: { adapter: indexed } },
      );
      expect(outcome.references).toHaveLength(2);
      // A genuine full tie: both survivors carry the same fused RRF score.
      expect(outcome.references[0]?.score).toBe(outcome.references[1]?.score);
      return outcome.references.map((ref) => String(ref.chunkId));
    };

    const first = await run();
    const second = await run();
    const chunkIdAscending = [...first].sort((left, right) => left.localeCompare(right));
    expect(first).toEqual(chunkIdAscending);
    expect(second).toEqual(first);
  });
});

describe("searchVectorsForScope — decoded vector cache", () => {
  it("invalidates cached decoded vectors when a reindex changes the vector stamp", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-cache",
      text: "alpha beta gamma delta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const firstChunk = seeded.chunkIds[0];
    const secondChunk = seeded.chunkIds[1];
    if (firstChunk === undefined || secondChunk === undefined) {
      throw new Error("expected two seeded chunks");
    }
    const capsuleId = seeded.capsuleId;
    setChunkVectorAt(store, capsuleId, String(firstChunk), vectorBlob(1, 0), 1_700_000_000_100);
    setChunkVectorAt(store, capsuleId, String(secondChunk), vectorBlob(0, 1), 1_700_000_000_100);
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const beforeReindex = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [capsuleId] },
      "cache probe",
      { topK: 1 },
    );
    expect(String(beforeReindex.references[0]?.chunkId)).toBe(String(firstChunk));

    setChunkVectorAt(store, capsuleId, String(firstChunk), vectorBlob(0, 1), 1_700_000_000_200);
    setChunkVectorAt(store, capsuleId, String(secondChunk), vectorBlob(1, 0), 1_700_000_000_200);

    const afterReindex = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [capsuleId] },
      "cache probe",
      { topK: 1 },
    );
    expect(String(afterReindex.references[0]?.chunkId)).toBe(String(secondChunk));
  });
});

describe("searchVectorsForScope — vector index adapter", () => {
  it("uses an available vector index adapter for dense candidates", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-indexed",
      text: "alpha beta gamma delta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const firstChunk = seeded.chunkIds[0];
    const secondChunk = seeded.chunkIds[1];
    if (firstChunk === undefined || secondChunk === undefined) {
      throw new Error("expected two seeded chunks");
    }
    const calls: string[] = [];
    const adapter: VectorIndexAdapter = {
      searchCapsule: (request) => {
        calls.push(String(request.capsule.id));
        return {
          ok: true,
          candidates: [
            {
              chunkId: String(secondChunk),
              capsuleId: request.capsule.id,
              sourceId: seeded.sourceId,
              score: 0.99,
            },
          ],
          sawDimensionCompatible: true,
          sawIdentityIncompatible: false,
          diagnostics: {
            provider: "sqlite-vec",
            status: "available",
            indexName: "fake-test-index",
            vectorCount: 1,
          },
        };
      },
    };

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [seeded.capsuleId] },
      "unmatched indexed query",
      { topK: 1, vectorIndex: { adapter } },
    );

    expect(calls).toEqual(["cap-indexed"]);
    expect(String(outcome.references[0]?.chunkId)).toBe(String(secondChunk));
    expect(outcome.diagnostics.vectorIndex).toMatchObject({
      provider: "sqlite-vec",
      status: "available",
      indexName: "fake-test-index",
    });
  });

  it("falls back to brute-force scoring when the vector index is unavailable", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-index-fallback",
      text: "alpha beta gamma delta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const firstChunk = seeded.chunkIds[0];
    const secondChunk = seeded.chunkIds[1];
    if (firstChunk === undefined || secondChunk === undefined) {
      throw new Error("expected two seeded chunks");
    }
    setChunkVector(store, seeded.capsuleId, String(firstChunk), vectorBlob(1, 0));
    setChunkVector(store, seeded.capsuleId, String(secondChunk), vectorBlob(0, 1));
    const embeddingAdapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });
    const adapter: VectorIndexAdapter = {
      searchCapsule: () => ({
        ok: false,
        candidates: [],
        sawDimensionCompatible: false,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "fallback-unavailable",
          reason: "sqlite-vec-runtime-not-configured",
          indexName: "fake-test-index",
        },
      }),
    };

    const outcome = await searchVectorsForScope(
      store,
      embeddingAdapter,
      { capsuleIds: [seeded.capsuleId] },
      "fallback query",
      { topK: 1, vectorIndex: { adapter } },
    );

    expect(String(outcome.references[0]?.chunkId)).toBe(String(firstChunk));
    expect(outcome.diagnostics.vectorIndex).toMatchObject({
      provider: "sqlite-vec",
      status: "fallback-unavailable",
      reason: "sqlite-vec-runtime-not-configured",
    });
  });

  it("rejects indexed candidates outside the active capsule/source scope", async () => {
    const { store } = getFixture();
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-index-scope",
      sourceId: "src-index-a",
      documentId: "doc-index-a",
      contentHash: "a".repeat(64),
      text: "alpha beta gamma delta",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
    });
    const seededB = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-index-scope",
      sourceId: "src-index-b",
      documentId: "doc-index-b",
      contentHash: "b".repeat(64),
      text: "epsilon zeta eta theta",
      unitId: "unit-cap-index-scope-b",
      chunkingOptions: { maxTokens: 2, minTokens: 0, overlapTokens: 0 },
      skipCapsule: true,
    });
    const allowedChunk = seededA.chunkIds[0];
    const disallowedChunk = seededB.chunkIds[0];
    if (allowedChunk === undefined || disallowedChunk === undefined) {
      throw new Error("expected seeded chunks");
    }
    const adapter: VectorIndexAdapter = {
      searchCapsule: (request) => ({
        ok: true,
        candidates: [
          {
            chunkId: String(disallowedChunk),
            capsuleId: request.capsule.id,
            sourceId: seededB.sourceId,
            score: 1,
          },
          {
            chunkId: String(allowedChunk),
            capsuleId: request.capsule.id,
            sourceId: seededA.sourceId,
            score: 0.5,
          },
        ],
        sawDimensionCompatible: true,
        sawIdentityIncompatible: false,
        diagnostics: {
          provider: "sqlite-vec",
          status: "available",
          indexName: "fake-test-index",
          vectorCount: 2,
        },
      }),
    };

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [seededA.capsuleId], sourceFilter: [seededA.sourceId] },
      "indexed scoped query",
      { topK: 2, vectorIndex: { adapter } },
    );

    expect(outcome.references).toHaveLength(1);
    expect(String(outcome.references[0]?.chunkId)).toBe(String(allowedChunk));
    expect(String(outcome.references[0]?.citation.sourceId)).toBe("src-index-a");
  });
});

describe("searchVectorsForScope — topK clamping", () => {
  it("honours an explicit topK override and never exceeds it", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 2 },
    );
    expect(outcome.references.length).toBeLessThanOrEqual(2);
  });
});

describe("searchVectorsForScope — minScore filtering", () => {
  it("excludes references with score below minScore", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      text: "alpha beta gamma delta epsilon zeta eta theta",
    });
    seeded.chunkIds.forEach((chunkId, index) => {
      setChunkVector(
        store,
        seeded.capsuleId,
        String(chunkId),
        index === 0 ? vectorBlob(1, 0) : vectorBlob(0, 1),
      );
    });
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });
    const unfiltered = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "unmatched-query",
      { topK: 50 },
    );
    expect(unfiltered.references.length).toBeGreaterThan(1);
    const filtered = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "unmatched-query",
      { topK: 50, minScore: 0.9 },
    );
    expect(filtered.diagnostics.denseCandidateCount).toBeLessThan(
      unfiltered.diagnostics.denseCandidateCount,
    );
    expect(filtered.references).toHaveLength(1);
  });

  it("applies minScore only to dense candidates and still allows lexical BM25 matches", async () => {
    const { store } = getFixture();
    const dims = DEFAULT_EMBEDDING.vectorDimensions;
    const blob = (a: number, b: number): Uint8Array => {
      const v = new Float32Array(dims);
      v[0] = a;
      v[1] = b;
      return new Uint8Array(v.buffer.slice(0));
    };
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      text: "treasury ".repeat(40),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    // Make every chunk vector ORTHOGONAL to the query vector (cosine ~ 0).
    for (const ch of seeded.chunkIds) {
      store._internal.db
        .prepare("UPDATE vectors SET embedding = :e WHERE capsule_id = :c AND chunk_id = :id")
        .run({ e: blob(0, 1), c: "cap-a", id: String(ch) });
    }
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(blob(1, 0).buffer)),
    });
    const scope = { capsuleIds: ["cap-a" as KnowledgeCapsuleId] };

    const floored = await searchVectorsForScope(store, adapter, scope, "treasury", {
      topK: 50,
      minScore: 0.95,
    });
    expect(floored.references).toHaveLength(1);
    expect(floored.diagnostics.denseCandidateCount).toBe(0);
    expect(floored.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
    expect(floored.diagnostics.mode).toBe("lexical-only");

    const unfloored = await searchVectorsForScope(store, adapter, scope, "treasury", { topK: 50 });
    expect(unfloored.references.length).toBeGreaterThan(0);
  });
});

describe("searchVectorsForScope — embedding dim mismatch", () => {
  it("returns noEvidenceReason 'incompatible-embedding-identity' when adapter dim != capsule dim", async () => {
    const { store } = getFixture();
    const identity: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, vectorDimensions: 16 };
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a", identity });
    // Build an adapter that returns a *different* dim than the capsule pinned. This
    // simulates a re-bound model whose vector space drifted.
    const wrongDimAdapter = scriptedAdapter({
      identity,
      responder: (req): OpenAIEmbeddingOutcome => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, 8), // 8 ≠ 16
          modelId: identity.modelId,
        },
      }),
    });
    const outcome = await searchVectorsForScope(
      store,
      wrongDimAdapter,
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 10 },
    );
    expect(outcome.references).toHaveLength(0);
    expect(outcome.noEvidenceReason).toBe("incompatible-embedding-identity");
  });
});

describe("searchVectorsForScope — hardened embedding identity", () => {
  it("keeps dense retrieval available on embedding-space fingerprint drift", async () => {
    const { store } = getFixture();
    const identity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      normalization: "l2",
      instructionVersion: "keiko-embedding-input-v1",
      embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:aaaaaaaaaaaaaaaaaaaaaaaa",
    };
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-fingerprint",
      identity,
      text: "treasury controls treasury controls treasury controls",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const adapter = scriptedAdapter({
      identity,
      responder: (req): OpenAIEmbeddingOutcome => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, identity.vectorDimensions),
          modelId: identity.modelId,
        },
      }),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-fingerprint" as KnowledgeCapsuleId] },
      "treasury controls",
      { topK: 10 },
    );

    expect(outcome.references).toHaveLength(1);
    expect(outcome.embeddingDegraded).toBeUndefined();
    expect(outcome.noEvidenceReason).toBeUndefined();
    expect(outcome.diagnostics.mode).not.toBe("lexical-degraded");
    expect(outcome.diagnostics.embeddingLanes).toEqual([
      expect.objectContaining({
        capsuleIds: ["cap-fingerprint"],
        status: "searched",
        denseCandidateCount: 1,
      }),
    ]);
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("keeps available lanes when another embedding model is unavailable", async () => {
    const { store } = getFixture();
    const identityA: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "model-a" };
    const identityB: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "model-b" };
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-available-lane",
      sourceId: "src-available-lane",
      documentId: "doc-available-lane",
      identity: identityA,
      text: "treasury controls evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const seededB = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-unavailable-lane",
      sourceId: "src-unavailable-lane",
      documentId: "doc-unavailable-lane",
      identity: identityB,
      text: "unavailable semantic lane",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id = :c")
      .run({ c: String(seededB.capsuleId) });
    const embeddingAdapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        req.modelId === "model-b"
          ? { ok: false, kind: "unsupported-model" }
          : {
              ok: true,
              value: {
                vector: deterministicVector(req.input, identityA.vectorDimensions),
                modelId: req.modelId,
              },
            },
    });

    const outcome = await searchVectorsForScope(
      store,
      embeddingAdapter,
      { capsuleIds: [seededA.capsuleId, seededB.capsuleId] },
      "treasury controls",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    expect(new Set(outcome.references.map((ref) => String(ref.capsuleId)))).toEqual(
      new Set(["cap-available-lane"]),
    );
    expect(outcome.embeddingDegraded).toBe(true);
    expect(outcome.diagnostics.embeddingLanes?.map((lane) => lane.status).sort()).toEqual([
      "embedding-failed",
      "searched",
    ]);
  });

  it("keeps same-model lanes searchable when their fingerprints differ", async () => {
    const { store } = getFixture();
    const compatibleIdentity = DEFAULT_EMBEDDING;
    const driftedIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:bbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const seededCompatible = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-compatible-same-model",
      sourceId: "src-compatible-same-model",
      documentId: "doc-compatible-same-model",
      identity: compatibleIdentity,
      text: "compatible semantic lane treasury evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const seededDrifted = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-drifted-same-model",
      sourceId: "src-drifted-same-model",
      documentId: "doc-drifted-same-model",
      identity: driftedIdentity,
      text: "drifted semantic lane",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id = :c")
      .run({ c: String(seededDrifted.capsuleId) });
    const embeddingAdapter = scriptedAdapter({
      identity: compatibleIdentity,
      responder: (req): OpenAIEmbeddingOutcome => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, compatibleIdentity.vectorDimensions),
          modelId: req.modelId,
        },
      }),
    });

    const outcome = await searchVectorsForScope(
      store,
      embeddingAdapter,
      { capsuleIds: [seededCompatible.capsuleId, seededDrifted.capsuleId] },
      "treasury evidence",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    expect(new Set(outcome.references.map((ref) => String(ref.capsuleId)))).toEqual(
      new Set(["cap-compatible-same-model", "cap-drifted-same-model"]),
    );
    expect(outcome.embeddingDegraded).toBeUndefined();
    expect(outcome.noEvidenceReason).toBeUndefined();
    expect(outcome.diagnostics.embeddingLanes?.map((lane) => lane.status).sort()).toEqual([
      "searched",
      "searched",
    ]);
  });
});

describe("searchVectorsForScope — selective query transformation", () => {
  it("uses optional broad-query variants and keeps exact queries single-pass", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-transform",
      text: "SOC2 access reviews quarterly control owner approval evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const inputs: string[] = [];
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        inputs.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });
    const rewrites: string[] = [];
    const queryTransformer = {
      rewrite: ({ query }: { readonly query: string }): Promise<readonly string[]> => {
        rewrites.push(query);
        return Promise.resolve(["quarterly access review", "SOC2 control owner"]);
      },
    };

    await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-transform" as KnowledgeCapsuleId] },
      "compare and summarize the quarterly access review controls for policy owners across teams",
      { topK: 5, queryTransformer },
    );
    expect(rewrites).toHaveLength(1);
    expect(new Set(userEmbeddingInputs(inputs)).size).toBeGreaterThan(1);

    inputs.length = 0;
    rewrites.length = 0;
    await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-transform" as KnowledgeCapsuleId] },
      "SOC2-AC-3",
      { topK: 5, queryTransformer },
    );
    expect(rewrites).toHaveLength(0);
    expect(new Set(userEmbeddingInputs(inputs)).size).toBe(1);
  });
});

describe("searchVectorsForScope — query shaping", () => {
  it("sends the official Qwen3 query instruction prefix to the embedding adapter", async () => {
    const { store } = getFixture();
    const identity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "Qwen3-Embedding-8B",
    };
    await seedCapsuleWithVectors(store, { capsuleId: "cap-qwen", identity });
    const inputs: string[] = [];
    const adapter = scriptedAdapter({
      identity,
      responder: (req): OpenAIEmbeddingOutcome => {
        inputs.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, identity.vectorDimensions),
            modelId: identity.modelId,
          },
        };
      },
    });

    await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-qwen" as KnowledgeCapsuleId] },
      "Which policy mentions SOC2?",
      { topK: 1 },
    );

    expect(userEmbeddingInputs(inputs)[0]).toBe(
      `Instruct: ${QWEN3_QUERY_INSTRUCTION_TASK}\nQuery:Which policy mentions SOC2?`,
    );
  });

  it("leaves non-Qwen3 query text unchanged", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, { capsuleId: "cap-openai" });
    const inputs: string[] = [];
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        inputs.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: ["cap-openai" as KnowledgeCapsuleId] },
      "Which policy mentions SOC2?",
      { topK: 1 },
    );

    expect(userEmbeddingInputs(inputs)[0]).toBe("Which policy mentions SOC2?");
  });
});

describe("searchVectorsForScope — citation fields", () => {
  it("populates pageNumber + characterStart + characterEnd on every reference (page unit)", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      unit: {
        kind: "page",
        pageNumber: 42,
        pageLabel: "xlii",
        characterStart: 100,
        characterEnd: 500,
      } satisfies ParsedUnitWithoutDocId,
      documentId: "doc-a",
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    });
    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 10 },
    );
    expect(outcome.references.length).toBeGreaterThan(0);
    for (const ref of outcome.references) {
      const chunkRow = store._internal.db
        .prepare(
          "SELECT character_start, character_end FROM chunks WHERE capsule_id = :c AND id = :id",
        )
        .get({ c: String(seeded.capsuleId), id: String(ref.citation.chunkId) }) as
        { readonly character_start: number; readonly character_end: number } | undefined;
      expect(chunkRow).toBeDefined();
      expect(ref.citation.pageNumber).toBe(42);
      expect(ref.citation.pageLabel).toBe("xlii");
      expect(ref.citation.characterStart).toBe(chunkRow?.character_start);
      expect(ref.citation.characterEnd).toBe(chunkRow?.character_end);
      expect(ref.citation.characterStart).toBeGreaterThanOrEqual(100);
      expect(ref.citation.characterEnd).toBeLessThanOrEqual(500);
      expect(ref.citation.safeDisplayName).toBe("sample.txt");
    }
    expect(
      outcome.references.some(
        (ref) => ref.citation.characterStart !== 100 || ref.citation.characterEnd !== 500,
      ),
    ).toBe(true);
    expect(seeded.chunkIds.length).toBeGreaterThan(1);
  });

  it("populates sectionPath when the parsed unit is a section", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      documentId: "doc-a",
      unit: {
        kind: "section",
        sectionPath: ["Chapter 1", "1.2 Risk Controls"],
        characterStart: 50,
        characterEnd: 200,
      } satisfies ParsedUnitWithoutDocId,
      text: "alpha beta gamma delta epsilon zeta eta theta",
    });
    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 5 },
    );
    expect(outcome.references.length).toBeGreaterThan(0);
    for (const ref of outcome.references) {
      expect(ref.citation.sectionPath).toEqual(["Chapter 1", "1.2 Risk Controls"]);
      expect(ref.citation.pageNumber).toBeUndefined();
    }
  });

  it("attaches a containing page hop for section chunks", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      documentId: "doc-a",
      unit: {
        kind: "section",
        sectionPath: ["Chapter 2", "Controls"],
        characterStart: 50,
        characterEnd: 200,
      } satisfies ParsedUnitWithoutDocId,
      text: "alpha beta gamma delta epsilon zeta eta theta",
    });
    store._internal.db
      .prepare(
        "INSERT INTO pages (capsule_id, document_id, page_number, page_label, character_start, character_end, bbox_x, bbox_y, bbox_w, bbox_h) VALUES (:c, :d, :n, :l, :s, :e, NULL, NULL, NULL, NULL)",
      )
      .run({
        c: seeded.capsuleId,
        d: seeded.documentId,
        n: 3,
        l: "iii",
        s: 40,
        e: 210,
      });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    for (const ref of outcome.references) {
      expect(ref.citation.sectionPath).toEqual(["Chapter 2", "Controls"]);
      expect(ref.citation.pageNumber).toBe(3);
      expect(ref.citation.pageLabel).toBe("iii");
    }
  });

  it("attaches the first overlapping page hop for section chunks that cross pages", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      documentId: "doc-a",
      unit: {
        kind: "section",
        sectionPath: ["Boundary"],
        characterStart: 80,
        characterEnd: 130,
      } satisfies ParsedUnitWithoutDocId,
      text: "x ".repeat(120),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const insertPage = store._internal.db.prepare(
      "INSERT INTO pages (capsule_id, document_id, page_number, page_label, character_start, character_end, bbox_x, bbox_y, bbox_w, bbox_h) VALUES (:c, :d, :n, :l, :s, :e, NULL, NULL, NULL, NULL)",
    );
    insertPage.run({ c: seeded.capsuleId, d: seeded.documentId, n: 1, l: "1", s: 0, e: 100 });
    insertPage.run({ c: seeded.capsuleId, d: seeded.documentId, n: 2, l: "2", s: 101, e: 200 });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    expect(outcome.references[0]?.citation.pageNumber).toBe(1);
    expect(outcome.references[0]?.citation.pageLabel).toBe("1");
  });

  it("does not let empty placeholder pages claim a following text span", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      documentId: "doc-a",
      unit: {
        kind: "section",
        sectionPath: ["Body"],
        characterStart: 0,
        characterEnd: 50,
      } satisfies ParsedUnitWithoutDocId,
      text: "x ".repeat(60),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const insertPage = store._internal.db.prepare(
      "INSERT INTO pages (capsule_id, document_id, page_number, page_label, character_start, character_end, bbox_x, bbox_y, bbox_w, bbox_h) VALUES (:c, :d, :n, :l, :s, :e, NULL, NULL, NULL, NULL)",
    );
    insertPage.run({ c: seeded.capsuleId, d: seeded.documentId, n: 1, l: "blank", s: 0, e: 0 });
    insertPage.run({ c: seeded.capsuleId, d: seeded.documentId, n: 2, l: "2", s: 0, e: 100 });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    expect(outcome.references[0]?.citation.pageNumber).toBe(2);
    expect(outcome.references[0]?.citation.pageLabel).toBe("2");
  });

  it("preserves jsonPointer for json-path citations", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      documentId: "doc-json",
      safeDisplayName: "policy.json",
      unit: {
        kind: "json-path",
        jsonPointer: "/policy/title",
        characterStart: 0,
        characterEnd: 64,
      } satisfies ParsedUnitWithoutDocId,
      text: '{"policy":{"title":"Controls"}}',
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "policy title",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    for (const ref of outcome.references) {
      expect(ref.citation.safeDisplayName).toBe("policy.json");
      expect(ref.citation.jsonPointer).toBe("/policy/title");
    }
  });

  it("preserves tableName and rowIndex for csv-row citations", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      documentId: "doc-csv",
      safeDisplayName: "scores.csv",
      unit: {
        kind: "csv-row",
        tableName: "scores",
        rowIndex: 2,
        characterStart: 0,
        characterEnd: 64,
      } satisfies ParsedUnitWithoutDocId,
      text: "name,score\nalpha,98\n",
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "scores row",
      { topK: 5 },
    );

    expect(outcome.references.length).toBeGreaterThan(0);
    for (const ref of outcome.references) {
      expect(ref.citation.safeDisplayName).toBe("scores.csv");
      expect(ref.citation.tableName).toBe("scores");
      expect(ref.citation.rowIndex).toBe(2);
    }
  });

  it("uses FTS BM25 chunk text when the query matches the indexed chunk", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-a",
      sourceId: "src-a",
      documentId: "doc-a",
      safeDisplayName: "controls-handbook.docx",
      unit: {
        kind: "section",
        sectionPath: ["Policy", "Controls"],
        characterStart: 0,
        characterEnd: 120,
      } satisfies ParsedUnitWithoutDocId,
      text: "controls handbook alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-b",
      sourceId: "src-b",
      documentId: "doc-b",
      safeDisplayName: "glossary.txt",
      unit: {
        kind: "section",
        sectionPath: ["Glossary"],
        characterStart: 0,
        characterEnd: 120,
      } satisfies ParsedUnitWithoutDocId,
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      {
        capsuleIds: ["cap-a" as KnowledgeCapsuleId, "cap-b" as KnowledgeCapsuleId],
      },
      "controls handbook",
      { topK: 2 },
    );
    expect(outcome.references[0]?.citation.safeDisplayName).toBe("controls-handbook.docx");
    expect(outcome.references[0]?.citation.sectionPath).toEqual(["Policy", "Controls"]);
    expect(outcome.diagnostics.mode).toBe("hybrid");
  });

  it("lets BM25 promote an oversampled candidate outside the raw vector topK", async () => {
    const { store } = getFixture();
    const fast = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-vector",
      sourceId: "src-vector",
      documentId: "doc-vector",
      safeDisplayName: "zeta.txt",
      unit: {
        kind: "section",
        sectionPath: ["Zeta"],
        characterStart: 0,
        characterEnd: 120,
      } satisfies ParsedUnitWithoutDocId,
      text: "zeta ".repeat(32),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const metadata = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-metadata",
      sourceId: "src-metadata",
      documentId: "doc-metadata",
      safeDisplayName: "controls-handbook.docx",
      unit: {
        kind: "section",
        sectionPath: ["Policy", "Controls"],
        characterStart: 0,
        characterEnd: 120,
      } satisfies ParsedUnitWithoutDocId,
      text: "controls handbook ".repeat(16),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    setCapsuleVector(store, fast.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, metadata.capsuleId, vectorBlob(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [fast.capsuleId, metadata.capsuleId] },
      "controls handbook",
      { topK: 1 },
    );

    expect(outcome.references).toHaveLength(1);
    expect(outcome.references[0]?.citation.safeDisplayName).toBe("controls-handbook.docx");
    expect(outcome.references[0]?.score).toBeLessThan(1);
    expect(outcome.diagnostics.mode).toBe("hybrid");
  });

  it("uses chunk text to promote exact domain terms beyond pure vector order", async () => {
    const { store } = getFixture();
    const vectorOnlyText =
      "General agentic AI overview with orchestration planning and workflow automation. ".repeat(4);
    const exactText =
      "NVIDIA NeMo Retriever RAG connects enterprise content to retrieval augmented " +
      "generation. Nemotron reasoning models are discussed as a related NVIDIA capability.";
    const vectorOnly = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-vector",
      sourceId: "src-vector",
      documentId: "doc-vector",
      safeDisplayName: "general-agentic-ai.docx",
      unit: {
        kind: "section",
        sectionPath: ["Overview"],
        characterStart: 0,
        characterEnd: 220,
      } satisfies ParsedUnitWithoutDocId,
      text: vectorOnlyText,
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const exact = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-exact",
      sourceId: "src-exact",
      documentId: "doc-exact",
      safeDisplayName: "nvidia-notes.docx",
      unit: {
        kind: "section",
        sectionPath: ["Products"],
        characterStart: 0,
        characterEnd: 260,
      } satisfies ParsedUnitWithoutDocId,
      text: exactText,
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    store._internal.db
      .prepare(
        "INSERT OR REPLACE INTO document_texts (capsule_id, document_id, normalized_text) VALUES (:c, :d, :t)",
      )
      .run({
        c: String(vectorOnly.capsuleId),
        d: String(vectorOnly.documentId),
        t: vectorOnlyText,
      });
    store._internal.db
      .prepare(
        "INSERT OR REPLACE INTO document_texts (capsule_id, document_id, normalized_text) VALUES (:c, :d, :t)",
      )
      .run({ c: String(exact.capsuleId), d: String(exact.documentId), t: exactText });
    setCapsuleVector(store, vectorOnly.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, exact.capsuleId, vectorBlob(0.96, Math.sqrt(1 - 0.96 * 0.96)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [vectorOnly.capsuleId, exact.capsuleId] },
      "NVIDIA NeMo Retriever RAG Nemotron",
      { topK: 1 },
    );

    expect(outcome.references).toHaveLength(1);
    expect(outcome.references[0]?.citation.safeDisplayName).toBe("nvidia-notes.docx");
    expect(outcome.references[0]?.score).toBeLessThan(1);
    expect(outcome.diagnostics.mode).toBe("hybrid");
  });

  it("preserves German umlauts in the FTS lexical leg instead of folding to ASCII", async () => {
    const { store } = getFixture();
    const ascii = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-ascii",
      sourceId: "src-ascii",
      documentId: "doc-ascii",
      safeDisplayName: "ascii-transfer.md",
      text: "Uberweisung Zahlungsziel im Exportprozess",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const umlaut = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-umlaut",
      sourceId: "src-umlaut",
      documentId: "doc-umlaut",
      safeDisplayName: "umlaut-transfer.md",
      text: "Überweisung Zahlungsziel im Exportprozess",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    setCapsuleVector(store, ascii.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, umlaut.capsuleId, vectorBlob(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const exactUmlaut = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [ascii.capsuleId, umlaut.capsuleId] },
      "Überweisung Zahlungsziel",
      { topK: 1 },
    );
    expect(exactUmlaut.references[0]?.citation.safeDisplayName).toBe("umlaut-transfer.md");

    const asciiQuery = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [ascii.capsuleId, umlaut.capsuleId] },
      "Uberweisung Zahlungsziel",
      { topK: 1 },
    );
    expect(asciiQuery.references[0]?.citation.safeDisplayName).toBe("ascii-transfer.md");
  });

  it("adds light German stem variants for BM25 without folding umlauts", async () => {
    const { store } = getFixture();
    const general = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-general-de",
      sourceId: "src-general-de",
      documentId: "doc-general-de",
      safeDisplayName: "allgemein.md",
      text: "Allgemeine Prozessbeschreibung fuer Buchhaltung und Einkauf.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const inflected = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-inflected-de",
      sourceId: "src-inflected-de",
      documentId: "doc-inflected-de",
      safeDisplayName: "richtlinien.md",
      text: "Richtlinien fuer Zahlungen und Freigaben im Monatsabschluss.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    setCapsuleVector(store, general.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, inflected.capsuleId, vectorBlob(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [general.capsuleId, inflected.capsuleId] },
      "Richtlinie Zahlung",
      { topK: 1 },
    );

    expect(outcome.references[0]?.citation.safeDisplayName).toBe("richtlinien.md");
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("uses chunk-indexed exact identifiers to recover code-like terms", async () => {
    const { store } = getFixture();
    const genericText = "General integration overview for connector deployments.".repeat(4);
    const contextualText =
      "Release ticket TS-999 belongs to the connector hardening rollout. " +
      "The implementation details are validated by the platform test matrix.";
    const generic = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-generic",
      sourceId: "src-generic",
      documentId: "doc-generic",
      safeDisplayName: "generic.txt",
      text: genericText,
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const contextual = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-contextual",
      sourceId: "src-contextual",
      documentId: "doc-contextual",
      safeDisplayName: "release-notes.txt",
      unit: {
        kind: "section",
        sectionPath: ["Implementation"],
        characterStart: 0,
        characterEnd: contextualText.length,
      } satisfies ParsedUnitWithoutDocId,
      text: contextualText,
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    setCapsuleVector(store, generic.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, contextual.capsuleId, vectorBlob(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [generic.capsuleId, contextual.capsuleId] },
      "What changed in TS-999?",
      { topK: 1 },
    );

    expect(outcome.references).toHaveLength(1);
    expect(outcome.references[0]?.citation.safeDisplayName).toBe("release-notes.txt");
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("does not promote exact identifier near-collisions", async () => {
    const { store } = getFixture();
    const decoy = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-exact-boundary",
      sourceId: "src-exact-boundary",
      documentId: "doc-decoy-boundary",
      safeDisplayName: "adr-00360.txt",
      text: "ADR-00360 describes a separate deployment review and adjacent identifier policy.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const target = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-exact-boundary",
      sourceId: "src-exact-boundary",
      documentId: "doc-target-boundary",
      safeDisplayName: "adr-0036.txt",
      text: "ADR-0036 documents the RRF hybrid retrieval evidence policy.",
      skipCapsule: true,
      skipSource: true,
      contentHash: "b".repeat(64),
      unitId: "unit-target-boundary",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const targetChunk = target.chunkIds[0];
    if (targetChunk === undefined) throw new Error("expected target chunk");
    setCapsuleVector(store, decoy.capsuleId, vectorBlob(1, 0));
    setChunkVector(store, target.capsuleId, targetChunk, vectorBlob(0.95, 0.3122499));

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [decoy.capsuleId] },
      "ADR-0036",
      { topK: 1 },
    );

    expect(outcome.references[0]?.citation.safeDisplayName).toBe("adr-0036.txt");
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("uses exact lookup for short acronyms and one-token quoted phrases", async () => {
    const { store } = getFixture();
    const decoy = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-short-exact",
      sourceId: "src-short-exact",
      documentId: "doc-short-decoy",
      safeDisplayName: "general-platform.txt",
      text: "General platform rollout notes and unrelated review guidance.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const target = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-short-exact",
      sourceId: "src-short-exact",
      documentId: "doc-short-target",
      safeDisplayName: "api-policy.txt",
      text: "The API policy requires a second reviewer before publication.",
      skipCapsule: true,
      skipSource: true,
      contentHash: "a".repeat(64),
      unitId: "unit-short-target",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const targetChunk = target.chunkIds[0];
    if (targetChunk === undefined) throw new Error("expected target chunk");
    setCapsuleVector(store, decoy.capsuleId, vectorBlob(1, 0));
    setChunkVector(store, target.capsuleId, targetChunk, vectorBlob(0.94, 0.3411747));

    const acronym = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [decoy.capsuleId] },
      "API",
      { topK: 1 },
    );
    const quoted = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [decoy.capsuleId] },
      '"policy"',
      { topK: 1 },
    );

    expect(acronym.references[0]?.citation.safeDisplayName).toBe("api-policy.txt");
    expect(quoted.references[0]?.citation.safeDisplayName).toBe("api-policy.txt");
    expect(quoted.diagnostics.strategy).toBe("exact");
  });

  it("reports the selected retrieval strategy without exposing query text", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-strategy",
      text: "ADR-0036 RRF retrieval policy evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const scope = { capsuleIds: ["cap-strategy" as KnowledgeCapsuleId] };

    const balanced = await searchVectorsForScope(store, scriptedAdapter(), scope, "policy", {
      topK: 1,
    });
    expect(balanced.diagnostics.strategy).toBe("balanced");

    const exact = await searchVectorsForScope(store, scriptedAdapter(), scope, "ADR-0036", {
      topK: 1,
    });
    expect(exact.diagnostics.strategy).toBe("exact");

    const broad = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      scope,
      "Summarize retrieval policy evidence across teams and compare risk signals",
      { topK: 1 },
    );
    expect(broad.diagnostics.strategy).toBe("broad");

    const explicit = await searchVectorsForScope(store, scriptedAdapter(), scope, "ADR-0036", {
      topK: 1,
      strategy: "balanced",
    });
    expect(explicit.diagnostics.strategy).toBe("balanced");
    expect(JSON.stringify(explicit.diagnostics)).not.toContain("ADR-0036");
  });

  it("resolves the auto strategy for identifier-bearing questions without disabling semantic recall", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-auto-strategy",
      text: "ADR-0036 documents how RRF_K governs hybrid retrieval fusion for Knowledge Pods.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const scope = { capsuleIds: ["cap-auto-strategy" as KnowledgeCapsuleId] };

    // A natural-language QUESTION that names a concrete identifier resolves to `exact`. This is
    // intentional (the caller referenced a specific id, so lexical precision leads), and it must
    // NOT disable semantic recall: the dense leg still runs and the identifier chunk is still
    // returned even though the question words ("how", "work") are absent from the document.
    const identifierQuestion = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      scope,
      "How does ADR-0036 work?",
      { topK: 1 },
    );
    expect(identifierQuestion.diagnostics.strategy).toBe("exact");
    expect(identifierQuestion.references.length).toBeGreaterThan(0);

    // A plain natural-language question with no identifier falls back to the safe `balanced`
    // default rather than being forced into exact or broad.
    const plainQuestion = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      scope,
      "What is the capital of France?",
      { topK: 1 },
    );
    expect(plainQuestion.diagnostics.strategy).toBe("balanced");

    // A comparison/summary-style question resolves to `broad` for wider recall.
    const broadQuestion = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      scope,
      "Compare and summarize the retrieval policy evidence across every connected source",
      { topK: 1 },
    );
    expect(broadQuestion.diagnostics.strategy).toBe("broad");
  });

  it("reports strategy-specific candidate budgets as redacted diagnostics", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-budget",
      text: "ADR-0036 RRF retrieval policy evidence and multilingual strategy notes",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const scope = { capsuleIds: ["cap-budget" as KnowledgeCapsuleId] };

    const balanced = await searchVectorsForScope(store, scriptedAdapter(), scope, "policy", {
      topK: 2,
    });
    const exact = await searchVectorsForScope(store, scriptedAdapter(), scope, "ADR-0036", {
      topK: 2,
    });
    const broad = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      scope,
      "Summarize retrieval policy evidence across teams and compare strategy notes",
      { topK: 2 },
    );

    expect(exact.diagnostics.lexicalCandidateBudget).toBeGreaterThan(
      balanced.diagnostics.lexicalCandidateBudget,
    );
    expect(balanced.diagnostics.lexicalCandidateBudget).toBeGreaterThan(
      broad.diagnostics.lexicalCandidateBudget,
    );
    expect(exact.diagnostics.fusedCandidateBudget).toBe(exact.diagnostics.lexicalCandidateBudget);
    expect(broad.diagnostics.fusedCandidateBudget).toBe(broad.diagnostics.denseCandidateBudget);
    expect(balanced.diagnostics.queryVariantCount).toBe(1);
    expect(JSON.stringify(exact.diagnostics)).not.toContain("ADR-0036");
  });

  it("treats quoted phrases as exact lexical retrieval signals", async () => {
    const { store } = getFixture();
    const generic = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-phrase-generic",
      sourceId: "src-phrase-generic",
      documentId: "doc-phrase-generic",
      safeDisplayName: "generic-recovery.txt",
      text: "General recovery control overview for platform response planning.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const phrase = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-phrase-exact",
      sourceId: "src-phrase-exact",
      documentId: "doc-phrase-exact",
      safeDisplayName: "exact-recovery.txt",
      text: "The treasury recovery checklist must preserve redacted audit evidence.",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    setCapsuleVector(store, generic.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, phrase.capsuleId, vectorBlob(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [generic.capsuleId, phrase.capsuleId] },
      '"treasury recovery checklist"',
      { topK: 1 },
    );

    expect(outcome.references[0]?.citation.safeDisplayName).toBe("exact-recovery.txt");
    expect(outcome.diagnostics.strategy).toBe("exact");
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
    expect(JSON.stringify(outcome.diagnostics)).not.toContain("treasury recovery checklist");
  });

  it("retrieves evidence for BOTH legs of a chained question via deterministic decomposition", async () => {
    const { store } = getFixture();
    const torque = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-chain-a",
      sourceId: "src-chain-a",
      documentId: "doc-torque",
      safeDisplayName: "mounting.md",
      text: "spindle bracket mounting requires torque of twelve newton meters",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const errors = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-chain-b",
      sourceId: "src-chain-b",
      documentId: "doc-errors",
      safeDisplayName: "errors.md",
      text: "error E410 signals a sensor timeout during calibration",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [torque.capsuleId, errors.capsuleId] },
      "What torque do the spindle brackets need? What does error E410 mean?",
      { topK: 4 },
    );

    // The chain decomposes into two sub-queries plus the original (3 variants), and the fused
    // result must carry evidence from BOTH documents — a single-embedding search lands between
    // the topics and misses one leg.
    expect(outcome.diagnostics.queryVariantCount).toBe(3);
    const documents = new Set(outcome.references.map((ref) => String(ref.citation.documentId)));
    expect(documents.has("doc-torque")).toBe(true);
    expect(documents.has("doc-errors")).toBe(true);
  });

  it("recovers lexical recall via OR fallback when one query term is absent from the index", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-or-fallback",
      text: "torque wrench calibration procedure for spindle mounts",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });

    // Balanced strategy, three term groups; "flurbedingung" appears nowhere in the index, so
    // the strict AND query returns zero FTS rows. Pre-fallback the whole lexical lane died on
    // that single unmatched term (diagnostics.lexicalCandidateCount === 0); the bounded OR
    // retry recovers the chunk that matches the other terms.
    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [seeded.capsuleId] },
      "torque calibration flurbedingung",
      { topK: 3 },
    );

    expect(outcome.diagnostics.strategy).toBe("balanced");
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
    const seededChunkIds = new Set(seeded.chunkIds.map(String));
    expect(outcome.references.some((ref) => seededChunkIds.has(String(ref.chunkId)))).toBe(true);
  });

  it("keeps hostile lexical input scoped and redacted in diagnostics", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-hostile",
      text: "treasury controls evidence with approved recovery notes",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });

    const outcome = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: [seeded.capsuleId] },
      '"treasury" OR capsule_id:cap-hostile\'; DROP TABLE vectors; --',
      { topK: 2, strategy: "exact" },
    );

    expect(outcome.references.every((ref) => String(ref.capsuleId) === "cap-hostile")).toBe(true);
    expect(["available", "query-error"]).toContain(outcome.diagnostics.lexicalIndex);
    const diagnostics = JSON.stringify(outcome.diagnostics);
    expect(diagnostics).not.toContain("DROP TABLE");
    expect(diagnostics).not.toContain("capsule_id");
    expect(
      store._internal.db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as {
        readonly n: number;
      },
    ).toMatchObject({ n: 1 });
  });

  it("recalls exact text matches outside the raw vector oversampling window", async () => {
    const { store } = getFixture();
    const capsuleId = "cap-recall" as KnowledgeCapsuleId;
    const sourceId = "src-recall";
    const distractorChunks: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const seeded = await seedCapsuleWithVectors(store, {
        capsuleId,
        sourceId,
        documentId: `doc-distractor-${String(i).padStart(3, "0")}`,
        safeDisplayName: `distractor-${String(i).padStart(3, "0")}.txt`,
        text: "generic platform implementation overview without the target identifier",
        skipCapsule: i > 0,
        skipSource: i > 0,
        unitId: `unit-distractor-${String(i).padStart(3, "0")}`,
        contentHash: String(i).padStart(64, "0"),
        chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
      });
      const chunk = seeded.chunkIds[0];
      if (chunk !== undefined) distractorChunks.push(String(chunk));
    }
    const exactText =
      "Escalation record XR-7788 documents the treasury connector recovery checklist.";
    const exact = await seedCapsuleWithVectors(store, {
      capsuleId,
      sourceId,
      documentId: "doc-exact",
      safeDisplayName: "treasury-recovery.txt",
      text: exactText,
      skipCapsule: true,
      skipSource: true,
      unitId: "unit-exact",
      contentHash: "f".repeat(64),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    for (const chunkId of distractorChunks) {
      setChunkVector(store, capsuleId, chunkId, vectorBlob(1, 0));
    }
    const exactChunk = exact.chunkIds[0];
    if (exactChunk === undefined) throw new Error("expected exact chunk");
    setChunkVector(store, capsuleId, exactChunk, vectorBlob(0.1, Math.sqrt(1 - 0.1 * 0.1)));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [capsuleId] },
      "XR-7788 treasury recovery checklist",
      { topK: 1 },
    );

    expect(outcome.references).toHaveLength(1);
    expect(outcome.references[0]?.citation.safeDisplayName).toBe("treasury-recovery.txt");
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("diversifies broad query results across documents when scores are otherwise close", async () => {
    const { store } = getFixture();
    const first = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-diverse",
      sourceId: "src-diverse",
      documentId: "doc-a",
      safeDisplayName: "controls-a.md",
      text:
        "Primary controls overview and implementation details. " +
        "Repeated controls overview and implementation details.",
      chunkingOptions: { maxTokens: 4, minTokens: 0, overlapTokens: 0 },
    });
    const second = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-diverse",
      sourceId: "src-diverse",
      documentId: "doc-b",
      safeDisplayName: "controls-b.md",
      unitId: "unit-diverse-b",
      text: "Independent risk monitoring evidence and rollout status.",
      skipCapsule: true,
      skipSource: true,
      contentHash: "c".repeat(64),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const firstChunk = first.chunkIds[0];
    const duplicateChunk = first.chunkIds[1];
    const secondChunk = second.chunkIds[0];
    if (firstChunk === undefined || duplicateChunk === undefined || secondChunk === undefined) {
      throw new Error("expected seeded chunks");
    }
    setChunkVector(store, first.capsuleId, firstChunk, vectorBlob(1, 0));
    setChunkVector(store, first.capsuleId, duplicateChunk, vectorBlob(0.99, 0.14106736));
    setChunkVector(store, second.capsuleId, secondChunk, vectorBlob(0.98, 0.19899749));
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome =>
        fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer)),
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [first.capsuleId] },
      "Summarize controls implementation risk monitoring rollout evidence",
      { topK: 2 },
    );

    expect(outcome.references).toHaveLength(2);
    expect(new Set(outcome.references.map((ref) => String(ref.citation.documentId)))).toEqual(
      new Set(["doc-a", "doc-b"]),
    );
  });
});

describe("searchVectorsForScope — embeddingDegraded", () => {
  it("reranks lexical candidates when an exact vector scan is oversized", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-large-lexical",
      text: "treasury evidence controls",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    duplicateFirstVectorRows(store, seeded.capsuleId, 1);
    let embeddingCalls = 0;
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        if (!isEmbeddingCapabilityProbe(req.input)) embeddingCalls += 1;
        return fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer));
      },
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [seeded.capsuleId] },
      "treasury evidence",
      { topK: 5, maxExactVectorScanRows: 1 },
    );

    expect(embeddingCalls).toBe(1);
    expect(outcome.references).toHaveLength(1);
    expect(outcome.noEvidenceReason).toBeUndefined();
    expect(outcome.diagnostics.mode).toBe("hybrid");
    expect(outcome.diagnostics.denseIndex).toBe("guided");
    expect(outcome.diagnostics.denseCandidateCount).toBeGreaterThan(0);
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("uses ANN when an oversized dense scan has no lexical fallback", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-large-no-lexical",
      text: "legacy treasury evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    duplicateFirstVectorRows(store, seeded.capsuleId, 1);
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id = :c")
      .run({ c: String(seeded.capsuleId) });
    let embeddingCalls = 0;
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        if (!isEmbeddingCapabilityProbe(req.input)) embeddingCalls += 1;
        return fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer));
      },
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [seeded.capsuleId] },
      "treasury evidence",
      { topK: 5, maxExactVectorScanRows: 1 },
    );

    expect(embeddingCalls).toBe(1);
    expect(outcome.references).toHaveLength(1);
    expect(outcome.noEvidenceReason).toBeUndefined();
    expect(outcome.diagnostics.mode).toBe("dense-only");
    expect(outcome.diagnostics.denseIndex).toBe("ann");
    expect(outcome.diagnostics.denseCandidateCount).toBeGreaterThan(0);
    expect(outcome.diagnostics.lexicalIndex).toBe("missing");
  });

  it("applies the exact-scan cap to the filtered source scope instead of the whole capsule", async () => {
    const { store } = getFixture();
    const scoped = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-source-filter-cap",
      sourceId: "src-small",
      documentId: "doc-small",
      contentHash: "1".repeat(64),
      text: "small source treasury evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const large = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-source-filter-cap",
      sourceId: "src-large",
      documentId: "doc-large",
      contentHash: "2".repeat(64),
      text: "large source unrelated evidence",
      unitId: "unit-source-filter-large",
      skipCapsule: true,
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    duplicateFirstVectorRows(store, large.capsuleId, 2, large.sourceId);
    let embeddingCalls = 0;
    const adapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        if (!isEmbeddingCapabilityProbe(req.input)) embeddingCalls += 1;
        return fixedQueryVectorOutcome(req, new Float32Array(vectorBlob(1, 0).buffer));
      },
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [scoped.capsuleId], sourceFilter: [scoped.sourceId] },
      "small source treasury evidence",
      { topK: 5, maxExactVectorScanRows: 1 },
    );

    expect(embeddingCalls).toBe(1);
    expect(outcome.references.length).toBeGreaterThan(0);
    expect(outcome.diagnostics.denseIndex).toBe("available");
    expect(new Set(outcome.references.map((ref) => String(ref.citation.sourceId)))).toEqual(
      new Set(["src-small"]),
    );
  });

  it("fails closed for legacy unverified vectors instead of running dense retrieval", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-legacy",
      identity: LEGACY_EMBEDDING,
      text: "legacy capsule alpha beta gamma",
    });
    store._internal.db
      .prepare("DELETE FROM chunk_lexical_index WHERE capsule_id = :c")
      .run({ c: String(seeded.capsuleId) });
    let embeddingCalls = 0;
    const adapter = scriptedAdapter({
      responder: (): OpenAIEmbeddingOutcome => {
        embeddingCalls += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector("alpha beta", DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [seeded.capsuleId] },
      "alpha beta",
      { topK: 5 },
    );

    expect(embeddingCalls).toBe(0);
    expect(outcome.references).toHaveLength(0);
    expect(outcome.noEvidenceReason).toBe("incompatible-embedding-identity");
    expect(outcome.diagnostics.lexicalIndex).toBe("missing");
    expect(outcome.diagnostics.embeddingLanes).toEqual([
      expect.objectContaining({
        capsuleIds: ["cap-legacy"],
        status: "identity-incompatible",
        queryEmbeddingRequested: true,
        denseCandidateCount: 0,
      }),
    ]);
  });

  it("keeps lexical fallback when legacy unverified vectors are rejected", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-legacy-lexical",
      identity: LEGACY_EMBEDDING,
      text: "legacy lexical fallback treasury evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    let embeddingCalls = 0;
    const adapter = scriptedAdapter({
      responder: (): OpenAIEmbeddingOutcome => {
        embeddingCalls += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(
              "legacy lexical fallback",
              DEFAULT_EMBEDDING.vectorDimensions,
            ),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const outcome = await searchVectorsForScope(
      store,
      adapter,
      { capsuleIds: [seeded.capsuleId] },
      "legacy lexical fallback",
      { topK: 5 },
    );

    expect(embeddingCalls).toBe(0);
    expect(outcome.references).toHaveLength(1);
    expect(outcome.embeddingDegraded).toBe(true);
    expect(outcome.diagnostics.mode).toBe("lexical-degraded");
    expect(outcome.diagnostics.embeddingLanes).toEqual([
      expect.objectContaining({
        capsuleIds: ["cap-legacy-lexical"],
        status: "identity-incompatible",
        denseCandidateCount: 0,
      }),
    ]);
  });

  it("falls back to lexical-degraded retrieval when query embedding fails", async () => {
    const { store } = getFixture();
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-lexical-degraded",
      text: "lexical degraded treasury evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    const failingAdapter = scriptedAdapter({
      responder: (): OpenAIEmbeddingOutcome => ({ ok: false, kind: "transport" }),
    });

    const outcome = await searchVectorsForScope(
      store,
      failingAdapter,
      { capsuleIds: [seeded.capsuleId] },
      "treasury evidence",
      { topK: 5 },
    );

    expect(outcome.references).toHaveLength(1);
    expect(outcome.embeddingDegraded).toBe(true);
    expect(outcome.diagnostics.mode).toBe("lexical-degraded");
    expect(outcome.diagnostics.denseCandidateCount).toBe(0);
    expect(outcome.diagnostics.lexicalCandidateCount).toBeGreaterThan(0);
  });

  it("sets embeddingDegraded=true when one capsule's embedding fails but another capsule's vectors keep result non-empty", async () => {
    const { store } = getFixture();
    const failingIdentity: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "model-a" };
    const availableIdentity: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, modelId: "model-b" };
    const seededA = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-deg-a",
      sourceId: "src-deg-a",
      documentId: "doc-deg-a",
      identity: failingIdentity,
      text: "alpha beta gamma delta epsilon zeta",
    });
    const seededB = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-deg-b",
      sourceId: "src-deg-b",
      documentId: "doc-deg-b",
      identity: availableIdentity,
      text: "alpha beta gamma delta epsilon zeta",
    });
    const partiallyFailingAdapter = scriptedAdapter({
      responder: (req): OpenAIEmbeddingOutcome => {
        if (req.modelId === failingIdentity.modelId) return { ok: false, kind: "transport" };
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, availableIdentity.vectorDimensions),
            modelId: req.modelId,
          },
        };
      },
    });
    const outcome = await searchVectorsForScope(
      store,
      partiallyFailingAdapter,
      { capsuleIds: [seededA.capsuleId, seededB.capsuleId] },
      "alpha beta",
      { topK: 10 },
    );
    expect(outcome.references.length).toBeGreaterThan(0);
    expect(outcome.embeddingDegraded).toBe(true);
    expect(outcome.noEvidenceReason).toBeUndefined();
  });
});

describe("toScopeInput — single capsule sugar", () => {
  it("wraps a { capsuleId } object into a RetrievalScopeInput", () => {
    const input = toScopeInput({ capsuleId: "cap-a" as KnowledgeCapsuleId });
    expect(input.capsuleIds).toEqual(["cap-a"]);
  });

  it("preserves composed source filters and threads the loaded capsules", () => {
    const threadedCapsules: ComposedRetrievalScope["capsules"] = [];
    const input = toScopeInput({
      capsuleSetId: "set-a" as CapsuleSetId,
      capsuleIds: ["cap-a" as KnowledgeCapsuleId],
      capsules: threadedCapsules,
      sourceIds: ["src-a" as KnowledgeSourceId],
      alwaysQueryCapsuleIds: [],
      sourceRoutingByCapsule: new Map(),
    });
    expect(input.capsuleIds).toEqual(["cap-a"]);
    expect(input.sourceFilter).toEqual(["src-a"]);
    // GEN-PERF-LK-001 — the pre-loaded member metadata rides along by identity.
    expect(input.capsules).toBe(threadedCapsules);
  });
});
