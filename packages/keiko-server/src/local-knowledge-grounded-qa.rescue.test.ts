// #189 citation rescue: a connector answer that uses retrieved references but whose model did
// NOT emit [n] markers (some models emit fullwidth 【n】 or no markers at all) is still grounded —
// it must surface the references it was given, not be discarded as "no evidence". Proven live with
// gpt-oss-120b (which emitted 【1】 not [1]); these unit tests pin the behaviour.
import { describe, expect, it } from "vitest";
import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  buildLocalKnowledgeCitations,
  createEmbeddingAdapter,
  enforcedNoEvidenceReason,
} from "./local-knowledge-grounded-qa.js";
import type { UiHandlerDeps } from "./deps.js";

type GroundedResult = Parameters<typeof buildLocalKnowledgeCitations>[0];

function ref(n: number): RetrievalReference {
  const chunkId = `chunk-${String(n)}` as ChunkId;
  return {
    chunkId,
    capsuleId: "cap-1" as KnowledgeCapsuleId,
    score: 1 - n * 0.1,
    citation: {
      documentId: `doc-${String(n)}` as DocumentId,
      capsuleId: "cap-1" as KnowledgeCapsuleId,
      sourceId: "src-1" as KnowledgeSourceId,
      chunkId,
      safeDisplayName: `manual-${String(n)}.md`,
    },
  };
}

function result(over: Partial<GroundedResult>): GroundedResult {
  return {
    answer: "The activation code is ZX-LIVE-4471.",
    references: [],
    citations: [],
    pack: undefined as never,
    noEvidence: false,
    ...over,
  };
}

function capsule(provider = "openai"): KnowledgeCapsule {
  return {
    id: "cap-1" as KnowledgeCapsuleId,
    displayName: "Alpha Capsule",
    tags: [],
    sourceIds: [],
    retrievalEffort: "default",
    outputMode: "snippets",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: {
      provider,
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    lifecycleState: "ready",
    storageReference: "capsules/cap-1",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("local-knowledge citation rescue (#189)", () => {
  it("does not flag no-evidence when references exist but the model emitted no [n] markers", () => {
    expect(
      enforcedNoEvidenceReason(result({ references: [ref(1), ref(2)], citations: [] })),
    ).toBeUndefined();
  });

  it("rescues the references as citations when the model answered without [n] markers", () => {
    const citations = buildLocalKnowledgeCitations(
      result({ references: [ref(1), ref(2)], citations: [] }),
      undefined,
      () => "Alpha Capsule / Product Manual",
    );
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.marker)).toEqual(["[1]", "[2]"]);
    expect(citations[0]?.label).toBe("manual-1.md");
    expect(citations[0]?.source).toBe("Alpha Capsule / Product Manual");
    expect(citations[0]?.score).toBe(0.9);
  });

  it("honours the model's explicit [n] citations when it did mark them", () => {
    const citations = buildLocalKnowledgeCitations(
      result({
        references: [ref(1), ref(2)],
        citations: [{ reference: ref(1), marker: "[1]", index: 1, citation: ref(1).citation }],
      }),
      undefined,
      () => "Alpha Capsule / Product Manual",
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]?.marker).toBe("[1]");
    expect(citations[0]?.label).toBe("manual-1.md");
    expect(citations[0]?.source).toBe("Alpha Capsule / Product Manual");
    expect(citations[0]?.label.includes("chunk")).toBe(false);
  });

  it("still returns no evidence for a genuinely empty retrieval", () => {
    const r = result({ references: [], citations: [], noEvidence: true, reason: "no-scope" });
    expect(enforcedNoEvidenceReason(r)).toBe("no-scope");
    expect(buildLocalKnowledgeCitations(r, "no-scope")).toEqual([]);
  });

  it("flags empty-answer when the model produced nothing even with references", () => {
    expect(enforcedNoEvidenceReason(result({ answer: "   ", references: [ref(1)] }))).toBe(
      "empty-answer",
    );
  });

  it("flags the canonical no-evidence sentence even when the runner did not set noEvidence", () => {
    expect(
      enforcedNoEvidenceReason(
        result({
          answer: "No evidence found in the selected knowledge scope.",
          references: [ref(1)],
        }),
      ),
    ).toBe("no-evidence");
  });
});

describe("local-knowledge embedding capability gate", () => {
  it("rejects a provider whose configured capability is not embedding", () => {
    let embeddingRequests = 0;
    const deps = {
      config: {
        providers: [
          {
            modelId: "text-embedding-3-small",
            baseUrl: "https://provider.example/v1",
            apiKey: "test-api-key-1234567890",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [
          {
            id: "text-embedding-3-small",
            kind: "chat",
            contextWindow: 64_000,
            maxOutputTokens: 4_096,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "test",
            preferredUseCases: [],
            knownLimitations: [],
          },
        ],
      },
      localKnowledgeEmbeddingRequest: () => {
        embeddingRequests += 1;
        return Promise.resolve({ ok: false, kind: "unsupported-model" });
      },
    } as unknown as UiHandlerDeps;

    const adapter = createEmbeddingAdapter(deps, [capsule()]);

    expect("status" in adapter ? adapter.status : 200).toBe(409);
    expect(embeddingRequests).toBe(0);
  });

  it("rejects a fingerprinted capsule when the configured gateway changes", () => {
    const deps = {
      config: {
        providers: [
          {
            modelId: "text-embedding-3-small",
            baseUrl: "https://provider-b.example/v1",
            apiKey: "test-api-key-1234567890",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
    } as unknown as UiHandlerDeps;

    const adapter = createEmbeddingAdapter(deps, [capsule("openai-compatible:0000000000000000")]);

    expect("status" in adapter ? adapter.status : 200).toBe(409);
    expect("body" in adapter ? JSON.stringify(adapter.body) : "").not.toContain("provider-b");
  });
});
