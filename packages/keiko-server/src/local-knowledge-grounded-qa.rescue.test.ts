// #189 citation attachment: a connector answer is cited only when the model emitted markers.
// Missing markers are not treated as "no evidence", but the server must not claim that every
// prompt reference was cited after the fact.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  scriptedAdapter,
  seedCapsuleWithVectors,
} from "@oscharko-dev/keiko-local-knowledge/testing";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  buildLocalKnowledgeCitations,
  createEmbeddingAdapter,
  enforcedNoEvidenceReason,
  handleLocalKnowledgeGroundedAsk,
  LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER,
  localKnowledgeNoEvidenceAnswer,
  renderCitationLabel,
} from "./local-knowledge-grounded-qa.js";
import type { UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

type GroundedResult = Parameters<typeof buildLocalKnowledgeCitations>[0];

function ref(
  n: number,
  citationOverrides: Partial<RetrievalReference["citation"]> = {},
): RetrievalReference {
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
      ...citationOverrides,
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

  it("does not attach citations when the model answered without [n] markers", () => {
    const citations = buildLocalKnowledgeCitations(
      result({ references: [ref(1), ref(2)], citations: [] }),
      undefined,
      () => "Alpha Capsule / Product Manual",
    );
    expect(citations).toEqual([]);
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

  it("redacts citation metadata labels before prompt and wire projection", () => {
    const secret = "TOKEN-12345";
    const redactor = (value: string): string => value.replaceAll(secret, "[REDACTED]");
    const reference = ref(1, {
      safeDisplayName: `manual-${secret}.md`,
      pageLabel: secret,
      sectionPath: [`Section ${secret}`],
      jsonPointer: `/policy/${secret}`,
      tableName: `table-${secret}`,
      rowIndex: 2,
    });

    expect(renderCitationLabel(reference.citation, redactor)).not.toContain(secret);
    const citations = buildLocalKnowledgeCitations(
      result({
        references: [reference],
        citations: [{ reference, marker: "[1]", index: 1, citation: reference.citation }],
      }),
      undefined,
      () => `Alpha ${secret}`,
      redactor,
    );

    expect(citations[0]?.label).not.toContain(secret);
    expect(citations[0]?.source).not.toContain(secret);
    expect(citations[0]?.label).toContain("[REDACTED]");
    expect(citations[0]?.lineage.chunkId).toBe("chunk-1");
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
          answer: LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER,
          references: [ref(1)],
        }),
      ),
    ).toBe("no-evidence");
  });

  it("still recognizes the legacy German no-evidence sentence", () => {
    expect(
      enforcedNoEvidenceReason(
        result({
          answer: "Keine Evidenz im ausgewählten Wissensumfang gefunden.",
          references: [ref(1)],
        }),
      ),
    ).toBe("no-evidence");
  });

  it("recognizes a short English refusal pattern without exact string equality", () => {
    expect(
      enforcedNoEvidenceReason(
        result({
          answer: "Insufficient evidence in the selected sources.",
          references: [ref(1)],
        }),
      ),
    ).toBe("no-evidence");
  });

  it("phrases incompatible embedding identity as an actionable re-index state", () => {
    expect(localKnowledgeNoEvidenceAnswer("incompatible-embedding-identity")).toContain(
      "Re-index it for the current embedding model",
    );
  });

  it("mirrors German questions for server-generated no-evidence states", () => {
    expect(
      localKnowledgeNoEvidenceAnswer(
        "incompatible-embedding-identity",
        "Warum findet der Connector keine Evidenz?",
      ),
    ).toContain("Dieser Connector wurde");
    expect(localKnowledgeNoEvidenceAnswer(undefined, "Welche Belege gibt es?")).toContain(
      "Keine Evidenz",
    );
  });
});

// ─── redactText fallback ──────────────────────────────────────────────────────
// redactText is private, but it is called on both user content and assistant content before
// they are persisted via persistGroundedExchange. We drive it through handleLocalKnowledgeGroundedAsk
// so that a bidi char in the question content reaches the fallback path (redactor returns non-string)
// and we observe the persisted message in the UiStore to confirm the char was stripped, not kept.

let rescueStore: UiStore;
let rescueTmp: string;

beforeEach(() => {
  rescueStore = createInMemoryUiStore();
  rescueTmp = mkdtempSync(join(tmpdir(), "keiko-lk-redact-"));
});

afterEach(() => {
  rescueStore.close();
  rmSync(rescueTmp, { recursive: true, force: true });
});

describe("redactText fallback — non-string redactor output strips unsafe chars instead of returning raw", () => {
  it("persists stripped (not raw) content when the redactor returns a non-string", async () => {
    // Arrange: seed a ready capsule so embedding + retrieval succeed and persistGroundedExchange
    // is unconditionally reached. Using scriptedAdapter (deterministic vectors) so the embedding
    // step does not fail before redactText is called.
    const embeddingModelId = "text-embedding-3-small";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Redact Fallback Capsule",
      capsuleId: "cap-redact-fallback",
      sourceId: "src-redact-fallback",
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "redact-fallback-project");
    const created = rescueStore.createChat(project.path, "Redact fallback", "chat-model");
    // Capture the UPDATED chat — createChat returns it WITHOUT the scope, and the handler reads
    // chat.localKnowledgeScope, so passing the stale pre-update object 400s ("no local knowledge scope").
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });

    // The bidi char that must be stripped by the fallback.
    const RLO = "‮"; // RIGHT-TO-LEFT OVERRIDE — unsafe format char
    const questionWithBidi = `What is${RLO}alpha?`;

    // Model returns the canonical no-evidence sentence so persistGroundedExchange is called.
    const fakeModel: ModelPort = {
      call: () =>
        Promise.resolve({
          modelId: "chat-model",
          content: LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER,
          finishReason: "stop" as const,
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "redact-test",
            promptTokens: 5,
            completionTokens: 12,
            latencyMs: 1,
            costClass: "medium" as const,
          },
        }),
    };

    // The non-string redactor: returns undefined cast as string to trigger the fallback branch.
    // Before the fix: redactText returned the raw original (containing RLO).
    // After the fix: redactText returns stripUnsafeFormatChars(value) — RLO is removed.
    // Redactor is (value: unknown) => unknown; this stub deliberately returns a NON-string so the
    // redactText fallback (return stripUnsafeFormatChars(value)) is exercised instead of the redacted path.
    const nonStringRedactor = (_v: unknown): unknown => undefined;

    // scriptedAdapter produces deterministic vectors so embedding succeeds end-to-end.
    const adapter = scriptedAdapter();

    const deps: UiHandlerDeps = {
      config: {
        providers: [
          {
            modelId: "chat-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "test-api-key-1234567890",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 500,
          },
          {
            modelId: embeddingModelId,
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
            id: "chat-model",
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
      configPresent: true,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: nonStringRedactor,
      registry: createRunRegistry(),
      modelPortFactory: () => fakeModel,
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: adapter.request,
    };

    // Act
    const result = await handleLocalKnowledgeGroundedAsk(
      chat,
      { chatId: chat.id, content: questionWithBidi, modelId: "chat-model" },
      deps,
      new AbortController().signal,
    );

    // persistGroundedExchange is reached via the no-evidence path → two messages persisted.
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const messages = rescueStore.listMessages(chat.id);
    const userMessage = messages.find((m) => m.role === "user");

    // The persisted user message must exist (confirms persistGroundedExchange was reached).
    // mutation: removing the persistGroundedExchange call → userMessage would be undefined
    expect(userMessage).toBeDefined();

    // The persisted content must NOT contain the RLO char — the fallback stripped it.
    // mutation: reverting the fallback from stripUnsafeFormatChars(value) to value →
    //   userMessage.content contains RLO and this assertion fails
    expect(userMessage?.content).not.toContain(RLO);
  });
});

describe("local-knowledge preview metadata persistence", () => {
  it("does not persist preview citation metadata when the assistant omitted markers", async () => {
    const embeddingModelId = "text-embedding-3-small";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Preview Metadata Capsule",
      capsuleId: "cap-preview-metadata",
      sourceId: "src-preview-metadata",
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "preview-metadata-project");
    const created = rescueStore.createChat(project.path, "Preview metadata", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });

    const fakeModel: ModelPort = {
      call: () =>
        Promise.resolve({
          modelId: "chat-model",
          content: "The answer is grounded in the capsule.",
          finishReason: "stop" as const,
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "preview-metadata",
            promptTokens: 5,
            completionTokens: 12,
            latencyMs: 1,
            costClass: "medium" as const,
          },
        }),
    };

    const adapter = scriptedAdapter();
    const deps: UiHandlerDeps = {
      config: {
        providers: [
          {
            modelId: "chat-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "test-api-key-1234567890",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 500,
          },
          {
            modelId: embeddingModelId,
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
            id: "chat-model",
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
          {
            id: embeddingModelId,
            kind: "embedding",
            contextWindow: 8_191,
            maxOutputTokens: 0,
            toolCalling: false,
            structuredOutput: false,
            streaming: false,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "low",
            latencyClass: "fast",
            throughputHint: "test",
            preferredUseCases: [],
            knownLimitations: [],
          },
        ],
      },
      configPresent: true,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: (value: unknown): unknown => value,
      registry: createRunRegistry(),
      modelPortFactory: () => fakeModel,
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: adapter.request,
    };

    const result = await handleLocalKnowledgeGroundedAsk(
      chat,
      { chatId: chat.id, content: "What is in the capsule?", modelId: "chat-model" },
      deps,
      new AbortController().signal,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as Extract<
      GroundedAnswer,
      { readonly groundingKind: "local-knowledge" }
    >;
    expect(answer.citations).toEqual([]);
    expect(rescueStore.findGroundedPreviewCitations(answer.assistantMessageId)).toEqual([]);
  });
});

describe("local-knowledge reranker diagnostics", () => {
  it("surfaces applied reranker diagnostics on the single-connector grounded answer", async () => {
    const embeddingModelId = "text-embedding-3-small";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Reranker Diagnostics Capsule",
      capsuleId: "cap-reranker-diagnostics",
      sourceId: "src-reranker-diagnostics",
      text: "alpha beta reranked citation evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "reranker-diagnostics-project");
    const created = rescueStore.createChat(project.path, "Reranker diagnostics", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });

    const fakeModel: ModelPort = {
      call: () =>
        Promise.resolve({
          modelId: "chat-model",
          content: "The alpha beta reranked citation is sufficient [1].",
          finishReason: "stop" as const,
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "reranker-diagnostics",
            promptTokens: 5,
            completionTokens: 12,
            latencyMs: 1,
            costClass: "medium" as const,
          },
        }),
    };

    const adapter = scriptedAdapter();
    let rerankCalls = 0;
    const deps: UiHandlerDeps = {
      config: {
        providers: [
          {
            modelId: "chat-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "test-api-key-1234567890",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 500,
          },
          {
            modelId: embeddingModelId,
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
            id: "chat-model",
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
          {
            id: embeddingModelId,
            kind: "embedding",
            contextWindow: 8_191,
            maxOutputTokens: 0,
            toolCalling: false,
            structuredOutput: false,
            streaming: false,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "low",
            latencyClass: "fast",
            throughputHint: "test",
            preferredUseCases: [],
            knownLimitations: [],
          },
        ],
        reranker: {
          modelId: "qwen3-reranker",
          baseUrl: "https://reranker.example/v1",
          apiKey: "reranker-test-key",
          timeoutMs: 30_000,
        },
      },
      configPresent: true,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: (value: unknown): unknown => value,
      registry: createRunRegistry(),
      modelPortFactory: () => fakeModel,
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: adapter.request,
      rerankRequest: (request) => {
        rerankCalls += 1;
        expect(request.endpoint).toBe("https://reranker.example/v1");
        expect(request.modelId).toBe("qwen3-reranker");
        expect(request.topN).toBe(16);
        expect(request.query).toBe("alpha beta");
        expect(request.documents.length).toBeGreaterThan(0);
        return Promise.resolve({
          ok: true,
          value: {
            modelId: "qwen3-reranker",
            results: [{ index: 0, relevanceScore: 0.91 }],
          },
        });
      },
    };

    const result = await handleLocalKnowledgeGroundedAsk(
      chat,
      { chatId: chat.id, content: "alpha beta", modelId: "chat-model" },
      deps,
      new AbortController().signal,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as Extract<
      GroundedAnswer,
      { readonly groundingKind: "local-knowledge" }
    >;
    expect(rerankCalls).toBe(1);
    expect(answer.contextPack.reranker).toMatchObject({
      status: "applied",
      keptCount: 1,
    });
    expect(answer.contextPack.reranker?.candidateCount).toBeGreaterThan(0);
    expect(answer.contextPack.reranker?.documentCount).toBe(
      answer.contextPack.reranker?.candidateCount,
    );
    expect(answer.contextPack.referencesUsed).toBe(1);
    const indexLifecycle = answer.contextPack.indexLifecycle;
    expect(indexLifecycle).toMatchObject({
      schemaVersion: "local-knowledge-index-lifecycle-v1",
      stale: false,
    });
    expect(indexLifecycle?.capsules).toHaveLength(1);
    expect(indexLifecycle?.capsules[0]?.capsuleId).toBe(seeded.capsuleId);
    expect(typeof indexLifecycle?.capsules[0]?.updatedAt).toBe("number");
    expect(answer.citations[0]?.score).toBe(0.91);
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
