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
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";

import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import {
  searchVectorsForScope,
  toScopeInput,
  type RetrievalScopeInput,
} from "./scoped-vector-search.js";
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

function setCapsuleVector(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  blob: Uint8Array,
): void {
  store._internal.db
    .prepare("UPDATE vectors SET embedding = :embedding WHERE capsule_id = :capsule_id")
    .run({ embedding: blob, capsule_id: capsuleId });
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
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    // Score everything against the existing vectors then pick a threshold above the
    // smallest score so at least one row is dropped.
    const unfiltered = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 50 },
    );
    expect(unfiltered.references.length).toBeGreaterThan(1);
    const last = unfiltered.references[unfiltered.references.length - 1];
    const first = unfiltered.references[0];
    if (last === undefined || first === undefined) throw new Error("unreachable");
    const threshold = (last.score + first.score) / 2;
    const filtered = await searchVectorsForScope(
      store,
      scriptedAdapter(),
      { capsuleIds: ["cap-a" as KnowledgeCapsuleId] },
      "query",
      { topK: 50, minScore: threshold },
    );
    expect(filtered.references.length).toBeLessThan(unfiltered.references.length);
    for (const ref of filtered.references) {
      expect(ref.score).toBeGreaterThanOrEqual(threshold);
    }
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

describe("searchVectorsForScope — citation fields", () => {
  it("populates pageNumber + characterStart + characterEnd on every reference (page unit)", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, {
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
      expect(ref.citation.pageNumber).toBe(42);
      expect(ref.citation.pageLabel).toBe("xlii");
      expect(ref.citation.characterStart).toBe(100);
      expect(ref.citation.characterEnd).toBe(500);
      expect(ref.citation.safeDisplayName).toBe("sample.txt");
    }
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

  it("applies a lexical metadata bonus from section titles and document names", async () => {
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
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
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
  });

  it("lets lexical metadata promote an oversampled candidate outside the raw vector topK", async () => {
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
      text: "controls ".repeat(32),
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    setCapsuleVector(store, fast.capsuleId, vectorBlob(1, 0));
    setCapsuleVector(store, metadata.capsuleId, vectorBlob(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const adapter = scriptedAdapter({
      responder: (): OpenAIEmbeddingOutcome => ({
        ok: true,
        value: {
          vector: new Float32Array(vectorBlob(1, 0).buffer),
          modelId: DEFAULT_EMBEDDING.modelId,
        },
      }),
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
    expect(outcome.references[0]?.score).toBeGreaterThan(1);
  });
});

describe("toScopeInput — single capsule sugar", () => {
  it("wraps a { capsuleId } object into a RetrievalScopeInput", () => {
    const input = toScopeInput({ capsuleId: "cap-a" as KnowledgeCapsuleId });
    expect(input.capsuleIds).toEqual(["cap-a"]);
  });

  it("preserves composed source filters", () => {
    const input = toScopeInput({
      capsuleSetId: "set-a" as CapsuleSetId,
      capsuleIds: ["cap-a" as KnowledgeCapsuleId],
      sourceIds: ["src-a" as KnowledgeSourceId],
      alwaysQueryCapsuleIds: [],
      sourceRoutingByCapsule: new Map(),
    });
    expect(input.capsuleIds).toEqual(["cap-a"]);
    expect(input.sourceFilter).toEqual(["src-a"]);
  });
});
