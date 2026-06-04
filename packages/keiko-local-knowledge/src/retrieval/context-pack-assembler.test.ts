// Tests for `assembleGroundedContext` (Epic #189, Issue #199). Pure-function tests — no
// store, no fixtures, no IO. Each test builds a small synthetic ref list and asserts the
// pack's structural invariants:
//   * citations preserve the input score-desc order
//   * scope.capsuleIds / sourceIds are sorted, deduplicated, lexicographic
//   * counts match the deduplicated cardinalities
//   * empty input → empty pack with schemaVersion still set

import { describe, expect, it } from "vitest";

import type {
  CitationReference,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import {
  LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION,
  assembleGroundedContext,
} from "./context-pack-assembler.js";

function ref(input: {
  readonly capsuleId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly chunkId: string;
  readonly score: number;
  readonly pageNumber?: number;
}): RetrievalReference {
  const citation: CitationReference = {
    chunkId: input.chunkId as CitationReference["chunkId"],
    capsuleId: input.capsuleId as CitationReference["capsuleId"],
    sourceId: input.sourceId as CitationReference["sourceId"],
    documentId: input.documentId as CitationReference["documentId"],
    safeDisplayName: `${input.documentId}.txt`,
    ...(input.pageNumber !== undefined ? { pageNumber: input.pageNumber } : {}),
  };
  return {
    chunkId: citation.chunkId,
    capsuleId: input.capsuleId as KnowledgeCapsuleId,
    score: input.score,
    citation,
  };
}

describe("assembleGroundedContext — single capsule", () => {
  it("returns a pack with the schema version, one capsule, one source, and the input citations", () => {
    const refs: readonly RetrievalReference[] = [
      ref({
        capsuleId: "cap-a",
        sourceId: "src-1",
        documentId: "doc-1",
        chunkId: "c1",
        score: 0.9,
      }),
      ref({
        capsuleId: "cap-a",
        sourceId: "src-1",
        documentId: "doc-1",
        chunkId: "c2",
        score: 0.7,
      }),
    ];
    const pack = assembleGroundedContext(refs);
    expect(pack.schemaVersion).toBe(LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION);
    expect(pack.scope.capsuleIds).toEqual(["cap-a" as KnowledgeCapsuleId]);
    expect(pack.scope.sourceIds).toEqual(["src-1" as KnowledgeSourceId]);
    expect(pack.scope.capsuleCount).toBe(1);
    expect(pack.scope.sourceCount).toBe(1);
    expect(pack.counts.totalReferences).toBe(2);
    expect(pack.counts.distinctCapsules).toBe(1);
    expect(pack.counts.distinctSources).toBe(1);
  });

  it("preserves the input ordering of citations (score-desc from the search layer)", () => {
    const refs: readonly RetrievalReference[] = [
      ref({
        capsuleId: "cap-a",
        sourceId: "src-1",
        documentId: "doc-1",
        chunkId: "c1",
        score: 0.9,
      }),
      ref({
        capsuleId: "cap-a",
        sourceId: "src-1",
        documentId: "doc-1",
        chunkId: "c2",
        score: 0.7,
      }),
      ref({
        capsuleId: "cap-a",
        sourceId: "src-1",
        documentId: "doc-1",
        chunkId: "c3",
        score: 0.5,
      }),
    ];
    const pack = assembleGroundedContext(refs);
    expect(pack.citations.map((c) => c.chunkId)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("assembleGroundedContext — multiple capsules and sources", () => {
  it("deduplicates capsuleIds / sourceIds and sorts them lexicographically", () => {
    const refs: readonly RetrievalReference[] = [
      ref({
        capsuleId: "cap-b",
        sourceId: "src-2",
        documentId: "doc-1",
        chunkId: "x1",
        score: 0.9,
      }),
      ref({
        capsuleId: "cap-a",
        sourceId: "src-1",
        documentId: "doc-1",
        chunkId: "x2",
        score: 0.8,
      }),
      ref({
        capsuleId: "cap-b",
        sourceId: "src-2",
        documentId: "doc-1",
        chunkId: "x3",
        score: 0.7,
      }),
      ref({
        capsuleId: "cap-a",
        sourceId: "src-3",
        documentId: "doc-2",
        chunkId: "x4",
        score: 0.6,
      }),
    ];
    const pack = assembleGroundedContext(refs);
    expect(pack.scope.capsuleIds).toEqual([
      "cap-a" as KnowledgeCapsuleId,
      "cap-b" as KnowledgeCapsuleId,
    ]);
    expect(pack.scope.sourceIds).toEqual([
      "src-1" as KnowledgeSourceId,
      "src-2" as KnowledgeSourceId,
      "src-3" as KnowledgeSourceId,
    ]);
    expect(pack.counts).toEqual({
      totalReferences: 4,
      distinctCapsules: 2,
      distinctSources: 3,
    });
  });
});

describe("assembleGroundedContext — empty input", () => {
  it("returns an empty pack with the schema version still set and zero counts", () => {
    const pack = assembleGroundedContext([]);
    expect(pack.schemaVersion).toBe(LOCAL_KNOWLEDGE_GROUNDED_CONTEXT_PACK_VERSION);
    expect(pack.citations).toEqual([]);
    expect(pack.scope.capsuleIds).toEqual([]);
    expect(pack.scope.sourceIds).toEqual([]);
    expect(pack.scope.capsuleCount).toBe(0);
    expect(pack.scope.sourceCount).toBe(0);
    expect(pack.counts).toEqual({
      totalReferences: 0,
      distinctCapsules: 0,
      distinctSources: 0,
    });
  });
});
