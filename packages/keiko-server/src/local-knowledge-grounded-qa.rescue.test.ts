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
  getCapsule,
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
  buildKnowledgePodRetrievalActivity,
  buildLocalKnowledgeCitations,
  createEmbeddingAdapter,
  enforcedNoEvidenceReason,
  handleLocalKnowledgeGroundedAsk,
  LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER,
  localKnowledgeNoEvidenceAnswer,
  renderCitationLabel,
  retrievalActivityResultFromScoped,
  tryBuildKnowledgePodRetrievalActivity,
  type KnowledgePodRetrievalActivityResultInput,
  type SelectedLocalKnowledgeScope,
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

function retrievalActivityReference(
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): RetrievalReference {
  const chunkId = "chunk-activity-state" as ChunkId;
  return {
    chunkId,
    capsuleId,
    score: 0.7,
    citation: {
      documentId: "doc-activity-state" as DocumentId,
      capsuleId,
      sourceId,
      chunkId,
      safeDisplayName: "activity-state.md",
    },
  };
}

function requireCapsule(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: KnowledgeCapsuleId,
): KnowledgeCapsule {
  const found = getCapsule(store, capsuleId);
  if (found === undefined) throw new Error(`missing capsule ${String(capsuleId)}`);
  return found;
}

function selectedActivityScope(capsuleValue: KnowledgeCapsule): SelectedLocalKnowledgeScope {
  return {
    capsules: [capsuleValue],
    scopeKind: "capsule",
    scopeLabel: capsuleValue.displayName,
  };
}

type KnowledgeDb = ReturnType<typeof openKnowledgeStore>["_internal"]["db"];
type ActivityDiagnostics = NonNullable<
  KnowledgePodRetrievalActivityResultInput["retrievalDiagnostics"]
>;

function countPrepareCalls(db: KnowledgeDb, onPrepare: () => void): () => void {
  const originalPrepare: KnowledgeDb["prepare"] = db.prepare.bind(db);
  const patchedPrepare: KnowledgeDb["prepare"] = (sql: string) => {
    onPrepare();
    return originalPrepare(sql);
  };
  db.prepare = patchedPrepare;
  return (): void => {
    db.prepare = originalPrepare;
  };
}

function activityDiagnostics(mode: ActivityDiagnostics["mode"]): ActivityDiagnostics {
  return {
    mode,
    strategy: "balanced",
    denseCandidateCount: 4,
    lexicalCandidateCount: 3,
    fusedCandidateCount: 5,
    denseCandidateBudget: 40,
    lexicalCandidateBudget: 50,
    fusedCandidateBudget: 50,
    queryVariantCount: 1,
    denseIndex: "available",
    lexicalIndex: "available",
    vectorIndex: { provider: "brute-force", status: "available" },
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

type LocalKnowledgeAnswer = Extract<GroundedAnswer, { readonly groundingKind: "local-knowledge" }>;

function expectAppliedRerankerDiagnostics(
  answer: LocalKnowledgeAnswer,
  capsuleId: KnowledgeCapsuleId,
): void {
  const reranker = answer.contextPack.reranker;
  const indexLifecycle = answer.contextPack.indexLifecycle;
  const indexedCapsule = indexLifecycle?.capsules[0];
  const citation = answer.citations[0];
  expect(reranker).toMatchObject({ status: "applied", keptCount: 1 });
  expect(reranker?.candidateCount).toBeGreaterThan(0);
  expect(reranker?.documentCount).toBe(reranker?.candidateCount);
  expect(answer.contextPack.referencesUsed).toBe(1);
  expect(indexLifecycle).toMatchObject({
    schemaVersion: "local-knowledge-index-lifecycle-v1",
    stale: false,
  });
  expect(indexLifecycle?.capsules).toHaveLength(1);
  expect(indexedCapsule?.capsuleId).toBe(capsuleId);
  expect(typeof indexedCapsule?.updatedAt).toBe("number");
  expect(citation?.score).toBe(0.91);
}

function expectRerankedRetrievalActivity(
  answer: LocalKnowledgeAnswer,
  capsuleId: KnowledgeCapsuleId,
): void {
  const activity = answer.retrievalActivity;
  const activityPod = activity?.pods[0];
  expect(activity).toMatchObject({
    schemaVersion: "1",
    privacy: {
      localFirst: true,
      rawContentExposed: false,
      rawQueryExposed: false,
      privatePathsExposed: false,
      directVectorScoreComparison: false,
    },
  });
  expect(activity?.summary.referenceCount).toBe(1);
  expect(activity?.summary.citationCount).toBe(1);
  expect(activityPod).toMatchObject({
    podId: capsuleId,
    displayName: "Reranker Diagnostics Capsule",
    state: "searched",
    reasonCodes: ["searched"],
    counts: { referenceCount: 1, citationCount: 1 },
  });
  expect(activityPod?.modes).toContain("local-only");
  expect(activityPod?.modes).toContain("reranked");
  expect(JSON.stringify(activity)).not.toContain("alpha beta reranked citation evidence");
}

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
    expectAppliedRerankerDiagnostics(answer, seeded.capsuleId);
    expectRerankedRetrievalActivity(answer, seeded.capsuleId);
  });
});

describe("local-knowledge retrieval activity", () => {
  it("redacts unsafe pod metadata without dropping retrieval activity", async () => {
    const unsafeCapsuleId = "owner@example.com" as KnowledgeCapsuleId;
    const unsafeSourceId = "source@example.com" as KnowledgeSourceId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "owner@example.com",
        capsuleId: unsafeCapsuleId,
        sourceId: unsafeSourceId,
      });
      const capsuleValue = requireCapsule(knowledgeStore, unsafeCapsuleId);
      const input = {
        store: knowledgeStore,
        sources: [
          {
            selected: selectedActivityScope(capsuleValue),
            result: {
              references: [retrievalActivityReference(unsafeCapsuleId, unsafeSourceId)],
              citationCounts: new Map([[String(unsafeCapsuleId), 1]]),
              noEvidence: false,
            },
          },
        ],
      } as const;

      const activity = buildKnowledgePodRetrievalActivity(input);
      expect(activity.pods[0]).toMatchObject({
        displayName: "Knowledge Pod",
        counts: { referenceCount: 1, citationCount: 1 },
      });
      expect(activity.pods[0]?.podId).toMatch(/^pod-[a-f0-9]{16}$/u);
      expect(activity.pods[0]?.sourceIds[0]).toMatch(/^source-[a-f0-9]{16}$/u);
      expect(JSON.stringify(activity)).not.toContain("owner@example.com");
      expect(JSON.stringify(activity)).not.toContain("source@example.com");
      expect(tryBuildKnowledgePodRetrievalActivity(input)).toEqual(activity);
    } finally {
      knowledgeStore.close();
    }
  });

  it("returns redacted not-ready activity when unsafe state-failure metadata is present", async () => {
    const unsafeCapsuleId = "state-owner@example.com" as KnowledgeCapsuleId;
    const unsafeSourceId = "state-source@example.com" as KnowledgeSourceId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "state-owner@example.com",
      capsuleId: unsafeCapsuleId,
      sourceId: unsafeSourceId,
    });
    updateCapsuleState(knowledgeStore, unsafeCapsuleId, "indexing");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "unsafe-activity-project");
    const created = rescueStore.createChat(project.path, "Unsafe activity", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: unsafeCapsuleId, connectedAtMs: 1 },
    });
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: (value: unknown): unknown => value,
      registry: createRunRegistry(),
      modelPortFactory: () => {
        throw new Error("model must not be called for state-failure activity");
      },
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
    };

    const result = await handleLocalKnowledgeGroundedAsk(
      chat,
      { chatId: chat.id, content: "What is indexed?", modelId: "chat-model" },
      deps,
      new AbortController().signal,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as Extract<
      GroundedAnswer,
      { readonly groundingKind: "local-knowledge" }
    >;
    expect(answer.noEvidence).toBe(true);
    expect(answer.retrievalActivity?.pods[0]).toMatchObject({
      displayName: "Knowledge Pod",
      state: "unavailable",
      reasonCodes: ["indexing-in-progress"],
    });
    expect(answer.retrievalActivity?.pods[0]?.podId).toMatch(/^pod-[a-f0-9]{16}$/u);
    expect(JSON.stringify(answer.retrievalActivity)).not.toContain("state-owner@example.com");
    expect(JSON.stringify(answer.retrievalActivity)).not.toContain("state-source@example.com");
  });

  it("maps retrieval diagnostics modes to activity modes", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Activity Mode Capsule",
        capsuleId: "cap-activity-modes",
        sourceId: "src-activity-modes",
      });
      const capsuleValue = requireCapsule(knowledgeStore, seeded.capsuleId);
      const selected = selectedActivityScope(capsuleValue);
      const cases = [
        ["hybrid", ["local-only", "hybrid", "lexical", "vector"]],
        ["dense-only", ["local-only", "vector"]],
        ["lexical-only", ["local-only", "lexical"]],
        ["lexical-degraded", ["local-only", "lexical"]],
      ] as const;

      for (const [mode, expectedModes] of cases) {
        const activity = buildKnowledgePodRetrievalActivity({
          store: knowledgeStore,
          sources: [
            {
              selected,
              result: {
                references: [],
                citationCounts: new Map(),
                noEvidence: false,
                retrievalDiagnostics: activityDiagnostics(mode),
              },
            },
          ],
        });
        expect(activity.pods[0]?.modes).toEqual(expectedModes);
      }
    } finally {
      knowledgeStore.close();
    }
  });

  it("uses enforced no-evidence reasons in retrieval activity", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Empty Answer Activity Capsule",
        capsuleId: "cap-empty-answer-activity",
        sourceId: "src-empty-answer-activity",
      });
      const capsuleValue = requireCapsule(knowledgeStore, seeded.capsuleId);
      const selected = selectedActivityScope(capsuleValue);
      const reference = retrievalActivityReference(seeded.capsuleId, seeded.sourceId);
      const grounded = result({ answer: "   ", references: [reference] });
      const activity = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected,
            result: retrievalActivityResultFromScoped(
              grounded,
              [],
              enforcedNoEvidenceReason(grounded),
            ),
          },
        ],
      });

      expect(activity.pods[0]).toMatchObject({
        state: "searched",
        reasonCodes: ["searched", "empty-answer"],
        counts: { referenceCount: 1, citationCount: 0 },
      });
    } finally {
      knowledgeStore.close();
    }
  });

  it("marks selected pods without retrieved references as not selected", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const first = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Selected Pod",
        capsuleId: "cap-selected-activity",
        sourceId: "src-selected-activity",
      });
      const second = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Filtered Pod",
        capsuleId: "cap-filtered-activity",
        sourceId: "src-filtered-activity",
      });
      const selected: SelectedLocalKnowledgeScope = {
        capsules: [
          requireCapsule(knowledgeStore, first.capsuleId),
          requireCapsule(knowledgeStore, second.capsuleId),
        ],
        scopeKind: "capsule-set",
        scopeLabel: "Activity Set",
      };
      const activity = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected,
            result: {
              references: [retrievalActivityReference(first.capsuleId, first.sourceId)],
              citationCounts: new Map([[String(first.capsuleId), 1]]),
              noEvidence: false,
            },
          },
        ],
      });

      expect(activity.summary.notSelectedCount).toBe(1);
      expect(activity.pods.find((pod) => pod.podId === second.capsuleId)).toMatchObject({
        state: "not-selected",
        reasonCodes: ["not-selected"],
        counts: { referenceCount: 0, citationCount: 0 },
      });
    } finally {
      knowledgeStore.close();
    }
  });

  it("caches Knowledge Pod summaries across repeated activity scopes", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const capsules: KnowledgeCapsule[] = [];
      for (let index = 0; index < 16; index += 1) {
        const id = String(index).padStart(2, "0");
        const seeded = await seedCapsuleWithVectors(knowledgeStore, {
          displayName: `Cached Activity Pod ${id}`,
          capsuleId: `cap-cache-${id}`,
          sourceId: `src-cache-${id}`,
          documentId: `doc-cache-${id}`,
          contentHash: id.repeat(32),
        });
        capsules.push(requireCapsule(knowledgeStore, seeded.capsuleId));
      }
      const selected: SelectedLocalKnowledgeScope = {
        capsules,
        scopeKind: "capsule-set",
        scopeLabel: "Cached Activity Set",
      };
      let prepareCalls = 0;
      const restorePrepare = countPrepareCalls(knowledgeStore._internal.db, () => {
        prepareCalls += 1;
      });
      try {
        const activity = buildKnowledgePodRetrievalActivity({
          store: knowledgeStore,
          sources: Array.from({ length: 16 }, () => ({
            selected,
            result: {
              references: [],
              citationCounts: new Map(),
              noEvidence: false,
              retrievalDiagnostics: activityDiagnostics("hybrid"),
            },
          })),
        });
        expect(activity.summary.searchedCount).toBe(256);
        expect(activity.pods).toHaveLength(24);
        expect(activity.pods.at(-1)).toMatchObject({
          podKind: "pod-set",
          displayName: "233 additional Knowledge Pods",
          state: "skipped",
          reasonCodes: ["max-sources-exceeded"],
        });
      } finally {
        restorePrepare();
      }
      expect(prepareCalls).toBeLessThan(128);
    } finally {
      knowledgeStore.close();
    }
  });

  it("prioritizes denied and degraded activity states over searched references", async () => {
    const sourceId = "src-activity-states" as KnowledgeSourceId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Activity State Capsule",
        capsuleId: "cap-activity-states",
        sourceId,
      });
      const capsuleValue = requireCapsule(knowledgeStore, seeded.capsuleId);
      const reference = retrievalActivityReference(seeded.capsuleId, sourceId);
      const selected = selectedActivityScope(capsuleValue);

      const denied = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected,
            result: {
              references: [reference],
              citationCounts: new Map(),
              noEvidence: true,
              reason: "answer-grounding-rejected",
            },
          },
        ],
      });
      const degraded = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected,
            result: {
              references: [reference],
              citationCounts: new Map([[String(seeded.capsuleId), 1]]),
              noEvidence: false,
              embeddingDegraded: true,
            },
          },
        ],
      });

      expect(denied.pods[0]).toMatchObject({
        state: "denied",
        reasonCodes: ["searched", "answer-grounding-rejected"],
      });
      expect(degraded.pods[0]).toMatchObject({
        state: "degraded",
        reasonCodes: ["searched", "embedding-failed"],
      });
    } finally {
      knowledgeStore.close();
    }
  });

  it("maps embedding lane diagnostics to the affected pod only", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seededA = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Lane Healthy Capsule",
        capsuleId: "cap-lane-healthy",
        sourceId: "src-lane-healthy",
        documentId: "doc-lane-healthy",
      });
      const seededB = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Lane Incompatible Capsule",
        capsuleId: "cap-lane-incompatible",
        sourceId: "src-lane-incompatible",
        documentId: "doc-lane-incompatible",
      });
      const capA = requireCapsule(knowledgeStore, seededA.capsuleId);
      const capB = requireCapsule(knowledgeStore, seededB.capsuleId);
      const activity = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected: {
              capsules: [capA, capB],
              scopeKind: "capsule-set",
              scopeLabel: "Lane Set",
            },
            result: {
              references: [retrievalActivityReference(seededA.capsuleId, seededA.sourceId)],
              citationCounts: new Map([[String(seededA.capsuleId), 1]]),
              noEvidence: false,
              embeddingDegraded: true,
              retrievalDiagnostics: {
                ...activityDiagnostics("lexical-degraded"),
                embeddingLaneCount: 2,
                embeddingLanes: [
                  {
                    laneId: "embedding-lane-healthy",
                    capsuleIds: [seededA.capsuleId],
                    status: "searched",
                    queryEmbeddingRequested: true,
                    vectorCount: 1,
                    denseCandidateCount: 1,
                  },
                  {
                    laneId: "embedding-lane-incompatible",
                    capsuleIds: [seededB.capsuleId],
                    status: "identity-incompatible",
                    queryEmbeddingRequested: true,
                    vectorCount: 1,
                    denseCandidateCount: 0,
                  },
                ],
              },
            },
          },
        ],
      });

      const healthy = activity.pods.find((pod) => String(pod.podId) === String(seededA.capsuleId));
      const incompatible = activity.pods.find(
        (pod) => String(pod.podId) === String(seededB.capsuleId),
      );
      expect(healthy).toMatchObject({ state: "searched", reasonCodes: ["searched"] });
      expect(incompatible).toMatchObject({
        state: "unavailable",
        reasonCodes: ["not-selected", "incompatible-embedding-identity"],
      });
    } finally {
      knowledgeStore.close();
    }
  });

  it("surfaces not-ready Knowledge Pods without retrieving or leaking raw content", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Indexing Activity Capsule",
      capsuleId: "cap-indexing-activity",
      sourceId: "src-indexing-activity",
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "indexing");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "retrieval-activity-project");
    const created = rescueStore.createChat(project.path, "Retrieval activity", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: (value: unknown): unknown => value,
      registry: createRunRegistry(),
      modelPortFactory: () => {
        throw new Error("model must not be called for state-failure activity");
      },
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
    };

    const result = await handleLocalKnowledgeGroundedAsk(
      chat,
      { chatId: chat.id, content: "What is indexed?", modelId: "chat-model" },
      deps,
      new AbortController().signal,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as Extract<
      GroundedAnswer,
      { readonly groundingKind: "local-knowledge" }
    >;
    const activity = answer.retrievalActivity;
    expect(activity?.summary.unavailableCount).toBe(1);
    expect(activity?.summary.referenceCount).toBe(0);
    expect(activity?.summary.citationCount).toBe(0);
    expect(activity?.pods[0]).toMatchObject({
      podId: seeded.capsuleId,
      displayName: "Indexing Activity Capsule",
      state: "unavailable",
      reasonCodes: ["indexing-in-progress"],
      counts: { referenceCount: 0, citationCount: 0 },
    });
    expect(activity?.privacy.rawContentExposed).toBe(false);
    expect(activity?.privacy.rawQueryExposed).toBe(false);
    expect(JSON.stringify(activity)).not.toContain("What is indexed?");
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
