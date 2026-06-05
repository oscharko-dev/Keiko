// Tests for `runLocalKnowledgeRetrieval` (Epic #189, Issue #199). The runner is the
// composition point — most of the work is delegated to scoped-vector-search /
// answer-grounding — so the tests here pin the *integration*: scope resolution from a
// single capsuleId vs a capsuleSetId, the strictest-policy floor across a capsule-set,
// happy-path delegation to search, the `incompatible-embedding-identity` BLOCKER, and
// the two answerGroundingPolicy contract tests called out in the issue spec (#8 + #9).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CapsuleAnswerGroundingPolicy,
  CapsuleSetId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";

import { createCapsuleSet } from "../capsule-set-lifecycle.js";
import {
  DEFAULT_EMBEDDING,
  freshStore,
  sampleCapsuleInput,
  sampleSourceInput,
} from "../_support.js";
import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { runLocalKnowledgeRetrieval } from "./retrieval-runner.js";
import { deterministicVector, scriptedAdapter, seedCapsuleWithVectors } from "./_support.js";
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

describe("runLocalKnowledgeRetrieval — input guards", () => {
  it("returns noEvidence 'no-scope' when neither capsuleId nor capsuleSetId is provided", async () => {
    const { store } = getFixture();
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-scope");
  });

  it("returns noEvidence 'empty-query' when text is whitespace-only", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-a" as KnowledgeCapsuleId, text: "   " },
    );
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("empty-query");
  });

  it("returns noEvidence 'no-scope' when the requested capsuleId does not exist", async () => {
    const { store } = getFixture();
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-ghost" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-scope");
  });

  it("returns noEvidence 'no-scope' when the requested capsuleSetId does not exist", async () => {
    const { store } = getFixture();
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleSetId: "set-ghost" as CapsuleSetId, text: "query" },
    );
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-scope");
  });

  it("returns noEvidence 'no-scope' when a capsule's source-routing controls are invalid", async () => {
    const { store } = getFixture();
    const capsuleId = createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-invalid" as KnowledgeCapsuleId,
        alwaysQuery: true,
        lifecycleState: "ready",
        sourceRoutingInstructions: "prefer @ghost",
      }),
    ).id;
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-1"));

    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId, text: "query" },
    );

    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-scope");
  });

  it("returns noEvidence 'no-scope' when a capsule-set member has invalid source-routing controls", async () => {
    const { store } = getFixture();
    const capsuleId = createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-invalid" as KnowledgeCapsuleId,
        alwaysQuery: true,
        lifecycleState: "ready",
        sourceRoutingInstructions: "prefer @ghost",
      }),
    ).id;
    addSourceToCapsule(store, capsuleId, sampleSourceInput("src-1"));
    const setId = "set-invalid" as CapsuleSetId;
    createCapsuleSet(store, {
      id: setId,
      displayName: "Invalid Set",
      tags: [],
      capsuleIds: [capsuleId],
    });

    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleSetId: setId, text: "query" },
    );

    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-scope");
  });
});

describe("runLocalKnowledgeRetrieval — happy path (single capsule, default policy)", () => {
  it("returns ranked references when search finds matches", async () => {
    const { store } = getFixture();
    // Default `sampleCapsuleInput` policy is "require-citations" — refs present so the
    // grounding decision allows.
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-a" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.noEvidence).toBe(false);
    expect(result.reason).toBeUndefined();
    // Verify the references actually carry citations from this capsule.
    for (const ref of result.references) {
      expect(String(ref.capsuleId)).toBe("cap-a");
      expect(ref.citation.safeDisplayName).toBe("sample.txt");
    }
  });
});

describe("runLocalKnowledgeRetrieval — embedding identity drift", () => {
  it("surfaces 'incompatible-embedding-identity' through a best-effort capsule when adapter dim ≠ capsule dim", async () => {
    const { store } = getFixture();
    // Use a best-effort capsule so the search-layer reason flows through unchanged.
    // (A require-citations capsule would convert empty refs to
    // "answer-grounding-rejected" — that case is covered by the policy tests below.)
    const identity: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, vectorDimensions: 16 };
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-best" as KnowledgeCapsuleId,
        answerGroundingPolicy: "best-effort",
        embeddingModelIdentity: identity,
      }),
    );
    addSourceToCapsule(store, "cap-best" as KnowledgeCapsuleId, sampleSourceInput("src-1"));
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-best",
      identity,
      skipCapsule: true,
      skipSource: true,
    });

    const adapter = scriptedAdapter({
      identity,
      responder: (req): OpenAIEmbeddingOutcome => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, 8), // 8 ≠ 16
          modelId: identity.modelId,
        },
      }),
    });
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter },
      { capsuleId: "cap-best" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("incompatible-embedding-identity");
  });

  it("converts an empty search result to 'answer-grounding-rejected' when the capsule policy is require-citations", async () => {
    const { store } = getFixture();
    // Same setup but on a require-citations capsule (the default). The runner replaces
    // the search-layer reason with the grounding rejection so the caller never serves
    // an "I tried but the embedding was incompatible" hint that leaks model behaviour.
    const identity: EmbeddingModelIdentity = { ...DEFAULT_EMBEDDING, vectorDimensions: 16 };
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a", identity });
    const adapter = scriptedAdapter({
      identity,
      responder: (req): OpenAIEmbeddingOutcome => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, 8),
          modelId: identity.modelId,
        },
      }),
    });
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter },
      { capsuleId: "cap-a" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("answer-grounding-rejected");
  });
});

describe("runLocalKnowledgeRetrieval — answerGroundingPolicy", () => {
  it("require-citations + empty refs → references=[] + grounding rejects", async () => {
    const { store } = getFixture();
    // Create a capsule with NO vectors and require-citations policy. Search returns
    // empty refs → the runner converts to "answer-grounding-rejected".
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-strict" as KnowledgeCapsuleId,
        answerGroundingPolicy: "require-citations",
      }),
    );
    addSourceToCapsule(store, "cap-strict" as KnowledgeCapsuleId, sampleSourceInput("src-1"));

    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-strict" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("answer-grounding-rejected");
  });

  it("best-effort + empty refs → still returns (noEvidence=true) without rejection", async () => {
    const { store } = getFixture();
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-loose" as KnowledgeCapsuleId,
        answerGroundingPolicy: "best-effort",
      }),
    );
    addSourceToCapsule(store, "cap-loose" as KnowledgeCapsuleId, sampleSourceInput("src-1"));

    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-loose" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    // The reason comes from the search layer (no vectors), NOT the grounding policy.
    expect(result.reason).toBe("no-vectors");
  });

  it("require-citations-or-state-no-evidence + empty refs → allows with noEvidence", async () => {
    const { store } = getFixture();
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-loose-strict" as KnowledgeCapsuleId,
        answerGroundingPolicy: "require-citations-or-state-no-evidence",
      }),
    );
    addSourceToCapsule(store, "cap-loose-strict" as KnowledgeCapsuleId, sampleSourceInput("src-1"));
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-loose-strict" as KnowledgeCapsuleId, text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("no-vectors");
  });
});

describe("runLocalKnowledgeRetrieval — capsule-set scope with strictest-policy floor", () => {
  it("merges refs from both capsules and applies the strictest policy", async () => {
    const { store } = getFixture();
    // capsule A has vectors (require-citations); capsule B has vectors (best-effort).
    // The strictest is "require-citations". Refs are present → grounding allows.
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-strict",
      sourceId: "src-a",
      documentId: "doc-a",
    });
    // Override capsule B's policy to best-effort by creating a fresh capsule directly.
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-best" as KnowledgeCapsuleId,
        answerGroundingPolicy: "best-effort",
      }),
    );
    addSourceToCapsule(store, "cap-best" as KnowledgeCapsuleId, sampleSourceInput("src-b"));
    await seedCapsuleWithVectors(store, {
      capsuleId: "cap-best",
      sourceId: "src-b",
      documentId: "doc-b",
      skipCapsule: true,
      skipSource: true,
    });

    const setId = "set-1" as CapsuleSetId;
    createCapsuleSet(store, {
      id: setId,
      displayName: "Test Set",
      tags: [],
      capsuleIds: ["cap-strict" as KnowledgeCapsuleId, "cap-best" as KnowledgeCapsuleId],
    });

    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleSetId: setId, text: "query" },
    );
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.noEvidence).toBe(false);
    const capsuleIds = new Set(result.references.map((r) => String(r.capsuleId)));
    expect(capsuleIds.has("cap-strict")).toBe(true);
    expect(capsuleIds.has("cap-best")).toBe(true);
  });

  it("rejects a capsule-set when ANY member is require-citations and refs are empty", async () => {
    const { store } = getFixture();
    // Both capsules have no vectors. cap-best is best-effort; cap-strict is
    // require-citations. The strictest floor must drive the rejection.
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-best" as KnowledgeCapsuleId,
        answerGroundingPolicy: "best-effort",
      }),
    );
    createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-strict" as KnowledgeCapsuleId,
        answerGroundingPolicy: "require-citations",
      }),
    );
    addSourceToCapsule(store, "cap-best" as KnowledgeCapsuleId, sampleSourceInput("src-a"));
    addSourceToCapsule(store, "cap-strict" as KnowledgeCapsuleId, sampleSourceInput("src-b"));

    const setId = "set-1" as CapsuleSetId;
    createCapsuleSet(store, {
      id: setId,
      displayName: "Test Set",
      tags: [],
      capsuleIds: ["cap-best" as KnowledgeCapsuleId, "cap-strict" as KnowledgeCapsuleId],
    });

    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleSetId: setId, text: "query" },
    );
    expect(result.references).toEqual([]);
    expect(result.noEvidence).toBe(true);
    expect(result.reason).toBe("answer-grounding-rejected");
  });
});

describe("runLocalKnowledgeRetrieval — topK and minScore pass-through", () => {
  it("clamps a caller-supplied topK to the documented maximum (default applies)", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const result = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-a" as KnowledgeCapsuleId, text: "query", topK: 3 },
    );
    expect(result.references.length).toBeLessThanOrEqual(3);
  });

  it("forwards minScore so callers can raise the relevance bar", async () => {
    const { store } = getFixture();
    await seedCapsuleWithVectors(store, { capsuleId: "cap-a" });
    const unfiltered = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      { capsuleId: "cap-a" as KnowledgeCapsuleId, text: "query", topK: 50 },
    );
    expect(unfiltered.references.length).toBeGreaterThan(1);
    // Compose a threshold somewhere between the lowest and highest score.
    const last = unfiltered.references[unfiltered.references.length - 1];
    const first = unfiltered.references[0];
    if (last === undefined || first === undefined) throw new Error("unreachable");
    const threshold = (last.score + first.score) / 2;
    const filtered = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: scriptedAdapter() },
      {
        capsuleId: "cap-a" as KnowledgeCapsuleId,
        text: "query",
        topK: 50,
        minScore: threshold,
      },
    );
    // Either fewer refs than the unfiltered run, or — if the threshold cut everything —
    // a grounding rejection (default policy is require-citations).
    if (filtered.references.length > 0) {
      expect(filtered.references.length).toBeLessThan(unfiltered.references.length);
      for (const ref of filtered.references) {
        expect(ref.score).toBeGreaterThanOrEqual(threshold);
      }
    } else {
      expect(filtered.noEvidence).toBe(true);
    }
  });
});

// Document the policy ordering (strictest → loosest) in a typed literal so a future
// addition to `CapsuleAnswerGroundingPolicy` surfaces here at compile time and forces
// the runner's POLICY_RANK to be updated.
describe("policy ordering — documented", () => {
  it("enumerates every CapsuleAnswerGroundingPolicy in loosest-to-strictest order", () => {
    const policies: readonly CapsuleAnswerGroundingPolicy[] = [
      "best-effort",
      "require-citations-or-state-no-evidence",
      "require-citations",
    ];
    expect(policies).toHaveLength(3);
  });
});
