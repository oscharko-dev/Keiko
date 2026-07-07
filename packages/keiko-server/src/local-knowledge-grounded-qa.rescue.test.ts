// #189 citation attachment: a connector answer is cited only when the model emitted markers.
// Missing markers are not treated as "no evidence", but the server must not claim that every
// prompt reference was cited after the fact.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChunkId,
  CapsuleSetId,
  DocumentId,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgePodModelUsePolicy,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  createCapsuleSet,
  getCapsule,
  openKnowledgeStore,
  persistHtmlManualSourceMetadata,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  scriptedAdapter,
  seedCapsuleWithVectors,
} from "@oscharko-dev/keiko-local-knowledge/testing";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { DEFAULT_GROUNDING_LIMITS } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  applyReferenceRerankResults,
  buildKnowledgePodRetrievalActivity,
  buildLocalKnowledgeCitations,
  createEmbeddingAdapter,
  enforcedNoEvidenceReason,
  fallbackReferenceSelection,
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
type TestGatewayConfig = NonNullable<UiHandlerDeps["config"]>;
type TestGatewayProvider = TestGatewayConfig["providers"][number];
type TestModelCapability = NonNullable<TestGatewayConfig["capabilities"]>[number];

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

function externalRerankingDeniedPolicy(): KnowledgePodModelUsePolicy {
  return {
    schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
    mode: "custom",
    operations: {
      ...standardPodModelUsePolicy().operations,
      externalReranking: "deny",
    },
  };
}

function testProvider(modelId: string): TestGatewayProvider {
  return {
    modelId,
    baseUrl: "https://provider.example/v1",
    apiKey: "test-api-key-1234567890",
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 500,
  };
}

function chatCapability(modelId: string): TestModelCapability {
  return {
    id: modelId,
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
  };
}

function embeddingCapability(modelId: string): TestModelCapability {
  return {
    id: modelId,
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
  };
}

function answerModel(content: string, requestId: string): ModelPort {
  return {
    call: () =>
      Promise.resolve({
        modelId: "chat-model",
        content,
        finishReason: "stop" as const,
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId,
          promptTokens: 5,
          completionTokens: 12,
          latencyMs: 1,
          costClass: "medium" as const,
        },
      }),
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
    lexicalOrFallbackUsed: false,
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

  it("projects HTML manual citation metadata as safe labels plus an opaque docs-browser target", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        capsuleId: "cap-manual-citation",
        sourceId: "src-manual-citation",
        documentId: "doc-manual-citation",
        safeDisplayName: "device-handbook.html",
        unit: {
          kind: "html-block",
          headingPath: ["Troubleshooting", "Timeouts"],
          anchorId: "timeouts",
          characterStart: 0,
          characterEnd: 120,
        },
      });
      persistHtmlManualSourceMetadata(knowledgeStore, seeded.capsuleId, seeded.sourceId, {
        schemaVersion: "1",
        scope: {
          kind: "html-manual-http",
          origin: "https://manual.internal",
          pathPrefix: null,
        },
        limits: {
          maxPages: 20,
          maxDepth: 3,
          maxBytes: 2_000_000,
          maxLinkSample: 50,
          timeoutMs: 30_000,
          followRedirects: false,
        },
        sourceFingerprint: "fp-manual-citation",
        proposedPodName: "Device Handbook",
      });
      const chunkId = seeded.chunkIds[0];
      if (chunkId === undefined) throw new Error("seeded manual citation has no chunk");
      const reference: RetrievalReference = {
        chunkId,
        capsuleId: seeded.capsuleId,
        score: 0.99,
        citation: {
          documentId: seeded.documentId,
          capsuleId: seeded.capsuleId,
          sourceId: seeded.sourceId,
          chunkId,
          parsedUnitId: `unit-${String(seeded.capsuleId)}`,
          safeDisplayName: "device-handbook.html",
          sectionPath: ["Troubleshooting", "Timeouts"],
          anchorId: "timeouts",
        },
      };

      const citations = buildLocalKnowledgeCitations(
        result({
          references: [reference],
          citations: [{ reference, marker: "[1]", index: 1, citation: reference.citation }],
        }),
        undefined,
        () => "Device Handbook",
        undefined,
        knowledgeStore,
      );

      expect(citations[0]?.htmlManual).toMatchObject({
        sourceKind: "html-manual-http",
        pageTitle: "device-handbook.html",
        sectionPath: ["Troubleshooting", "Timeouts"],
        anchorId: "timeouts",
        open: { state: "available" },
      });
      const target = citations[0]?.htmlManual?.open;
      expect(target?.state === "available" ? target.target : "").toMatch(
        /^keiko-html-manual-citation:/u,
      );
      const serialized = JSON.stringify(citations);
      expect(serialized).not.toContain("https://manual.internal/private");
      expect(serialized).not.toContain("session=");
      expect(serialized).not.toContain("keiko-html-manual/");
      expect(serialized).not.toContain("API_KEY");
      expect(serialized).not.toContain("provider");
    } finally {
      knowledgeStore.close();
    }
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
    const answer = localKnowledgeNoEvidenceAnswer("incompatible-embedding-identity");
    expect(answer).toContain("Knowledge Pod");
    expect(answer).toContain("Re-index it for the current embedding model");
    expect(answer).not.toContain("connector");
  });

  it("mirrors German questions for server-generated no-evidence states", () => {
    expect(
      localKnowledgeNoEvidenceAnswer(
        "incompatible-embedding-identity",
        "Warum findet der Connector keine Evidenz?",
      ),
    ).toContain("Dieser Knowledge Pod wurde");
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

function expectProviderScoreNotProjected(
  citation: LocalKnowledgeAnswer["citations"][number] | undefined,
): void {
  expect(citation?.score).not.toBe(42);
  expect(citation?.score).toBeGreaterThanOrEqual(0);
  expect(citation?.score).toBeLessThanOrEqual(1);
}

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
  expectProviderScoreNotProjected(citation);
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
            results: [{ index: 0, relevanceScore: 42 }],
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

  it("caps reranker candidates and preserves retrieval scores on cited references", async () => {
    const embeddingModelId = "text-embedding-3-small";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Reranker Budget Capsule",
      capsuleId: "cap-reranker-budget",
      sourceId: "src-reranker-budget",
      text: "alpha beta first reference. alpha beta second reference. alpha beta third reference.",
      chunkingOptions: { maxTokens: 4, minTokens: 0, overlapTokens: 0 },
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "reranker-budget-project");
    const created = rescueStore.createChat(project.path, "Reranker budget", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });
    const adapter = scriptedAdapter();
    const deps: UiHandlerDeps = {
      config: {
        providers: [testProvider("chat-model"), testProvider(embeddingModelId)],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [chatCapability("chat-model"), embeddingCapability(embeddingModelId)],
        grounding: { maxPromptReferences: 2 },
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
      modelPortFactory: () => answerModel("Alpha beta [1]. Alpha beta [2].", "reranker-budget"),
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: adapter.request,
      rerankRequest: (request) => {
        expect(request.topN).toBe(2);
        expect(request.documents).toHaveLength(2);
        return Promise.resolve({
          ok: true,
          value: {
            modelId: "qwen3-reranker",
            results: [
              { index: 1, relevanceScore: 42 },
              { index: 0, relevanceScore: 41 },
            ],
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
    expect(answer.citations.map((citation) => citation.marker)).toEqual(["[1]", "[2]"]);
    expect(answer.citations.map((citation) => citation.score)).not.toContain(42);
    expect(answer.citations.map((citation) => citation.score)).not.toContain(41);
    expect(answer.citations.every((citation) => citation.score >= 0 && citation.score <= 1)).toBe(
      true,
    );
    expect(answer.contextPack).toMatchObject({
      referenceBudget: 2,
      referencesUsed: 2,
      reranker: {
        status: "applied",
        candidateCount: 2,
        documentCount: 2,
        keptCount: 2,
      },
    });
  });

  it("does not prepare external reranker requests when policy denies external reranking", async () => {
    const embeddingModelId = "text-embedding-3-small";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Reranker Policy Capsule",
      capsuleId: "cap-reranker-policy",
      sourceId: "src-reranker-policy",
      text: "alpha beta policy reranker evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
      modelUsePolicy: externalRerankingDeniedPolicy(),
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "reranker-policy-project");
    const created = rescueStore.createChat(project.path, "Reranker policy", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });
    const fakeModel: ModelPort = {
      call: () =>
        Promise.resolve({
          modelId: "chat-model",
          content: "The alpha beta policy evidence is sufficient [1].",
          finishReason: "stop" as const,
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "reranker-policy",
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
      rerankRequest: () => {
        rerankCalls += 1;
        throw new Error("reranker must not be called when policy denies external reranking");
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
    expect(rerankCalls).toBe(0);
    expect(answer.contextPack.reranker).toMatchObject({
      status: "denied",
      mode: "local-only",
      failureKind: "policy-denied",
      documentCount: 0,
    });
    expect(answer.retrievalActivity?.pods[0]).toMatchObject({
      state: "degraded",
      reasonCodes: ["searched", "policy-denied"],
    });
    expect(answer.retrievalActivity?.pods[0]?.modes).toContain("sealed");
  });

  it("denies external reranking across a mixed capsule-set while synthesis proceeds (deny-wins)", async () => {
    const embeddingModelId = "text-embedding-3-small";
    const setId = "set-mixed-external-rerank-deny" as CapsuleSetId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const open = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Open Rerank Member",
      capsuleId: "cap-open-rerank-member",
      sourceId: "src-open-rerank-member",
      text: "alpha beta open member evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
      modelUsePolicy: standardPodModelUsePolicy(),
    });
    const restricted = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Rerank-Restricted Member",
      capsuleId: "cap-rerank-restricted-member",
      sourceId: "src-rerank-restricted-member",
      text: "alpha beta restricted member evidence",
      chunkingOptions: { maxTokens: 400, minTokens: 0, overlapTokens: 0 },
      modelUsePolicy: externalRerankingDeniedPolicy(),
    });
    updateCapsuleState(knowledgeStore, open.capsuleId, "ready");
    updateCapsuleState(knowledgeStore, restricted.capsuleId, "ready");
    createCapsuleSet(knowledgeStore, {
      id: setId,
      displayName: "Mixed External Rerank Deny Set",
      tags: [],
      capsuleIds: [open.capsuleId, restricted.capsuleId],
    });
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "mixed-external-rerank-deny-project");
    const created = rescueStore.createChat(
      project.path,
      "Mixed external rerank deny",
      "chat-model",
    );
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule-set", capsuleSetId: setId, connectedAtMs: 1 },
    });
    const adapter = scriptedAdapter();
    let rerankCalls = 0;
    const deps: UiHandlerDeps = {
      config: {
        providers: [testProvider("chat-model"), testProvider(embeddingModelId)],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [chatCapability("chat-model"), embeddingCapability(embeddingModelId)],
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
      modelPortFactory: () => answerModel("Alpha beta evidence [1].", "mixed-external-rerank-deny"),
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: adapter.request,
      rerankRequest: () => {
        rerankCalls += 1;
        throw new Error(
          "reranker must not be called when any set member denies external reranking",
        );
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
    // Deny-wins: a single member that denies external reranking vetoes the provider call for the whole
    // fused candidate set, yet synthesis still proceeds over the preserved order (#1923 / #1924).
    expect(rerankCalls).toBe(0);
    expect(answer.contextPack.reranker).toMatchObject({
      status: "denied",
      mode: "local-only",
      failureKind: "policy-denied",
      documentCount: 0,
    });
  });

  it("preserves fused order without preparing reranker documents when no reranker is configured", async () => {
    const embeddingModelId = "text-embedding-3-small";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "No Reranker Capsule",
      capsuleId: "cap-no-reranker",
      sourceId: "src-no-reranker",
      text: "alpha beta no reranker first. alpha beta no reranker second. alpha beta third.",
      chunkingOptions: { maxTokens: 4, minTokens: 0, overlapTokens: 0 },
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "no-reranker-project");
    const created = rescueStore.createChat(project.path, "No reranker", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });
    const deps: UiHandlerDeps = {
      config: {
        providers: [testProvider("chat-model"), testProvider(embeddingModelId)],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [chatCapability("chat-model"), embeddingCapability(embeddingModelId)],
        grounding: { maxPromptReferences: 2 },
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
      modelPortFactory: () => answerModel("Alpha beta [1]. Alpha beta [2].", "no-reranker"),
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: scriptedAdapter().request,
      rerankRequest: () => {
        throw new Error("reranker must not be called without a configured reranker");
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
    expect(answer.contextPack.reranker).toMatchObject({
      status: "disabled",
      mode: "none",
      failureKind: "not-configured",
      documentCount: 0,
      keptCount: 2,
    });
    // A reranker that was simply never configured is the default, fully-supported install state — it
    // must NOT degrade the Knowledge Pod activity row (#1922 regression: the single-scope path now
    // matches the hybrid path, which already suppresses not-configured). The redacted diagnostics
    // still surface on the context pack for observability, but the activity pod stays "searched".
    expect(answer.retrievalActivity?.summary.degradedCount).toBe(0);
    expect(answer.retrievalActivity?.pods[0]).toMatchObject({
      state: "searched",
      reasonCodes: ["searched"],
    });
    expect(answer.retrievalActivity?.pods[0]?.reasonCodes).not.toContain("reranker-unavailable");
    expect(answer.contextPack).toMatchObject({
      referenceBudget: 2,
      referencesUsed: 2,
    });
    expect(answer.citations.map((citation) => citation.marker)).toEqual(["[1]", "[2]"]);
  });

  it.each([
    {
      kind: "timeout" as const,
      status: "unavailable" as const,
      reasonCode: "reranker-unavailable",
    },
    {
      kind: "invalid-response" as const,
      status: "invalid-response" as const,
      reasonCode: "reranker-invalid-response",
    },
  ])(
    "preserves fused order and degrades activity when the configured reranker returns $kind",
    async ({ kind, status, reasonCode }) => {
      const embeddingModelId = "text-embedding-3-small";
      const knowledgeStore = openKnowledgeStore({
        dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
      });
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Failed Reranker Capsule",
        capsuleId: `cap-reranker-${kind}` as KnowledgeCapsuleId,
        sourceId: `src-reranker-${kind}` as KnowledgeSourceId,
        text: "alpha beta failed reranker first. alpha beta failed reranker second.",
        chunkingOptions: { maxTokens: 4, minTokens: 0, overlapTokens: 0 },
      });
      updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
      knowledgeStore.close();

      const project = rescueStore.createProject(rescueTmp, `reranker-${kind}-project`);
      const created = rescueStore.createChat(project.path, `Reranker ${kind}`, "chat-model");
      const chat = rescueStore.updateChat(created.id, {
        localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
      });
      let rerankCalls = 0;
      const deps: UiHandlerDeps = {
        config: {
          providers: [testProvider("chat-model"), testProvider(embeddingModelId)],
          circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
          capabilities: [chatCapability("chat-model"), embeddingCapability(embeddingModelId)],
          grounding: { maxPromptReferences: 2 },
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
        modelPortFactory: () => answerModel("Alpha beta [1]. Alpha beta [2].", `reranker-${kind}`),
        store: rescueStore,
        uiDbPath: join(rescueTmp, "keiko-ui.db"),
        localKnowledgeEmbeddingRequest: scriptedAdapter().request,
        rerankRequest: (request) => {
          rerankCalls += 1;
          expect(request.documents).toHaveLength(2);
          return Promise.resolve({ ok: false, kind });
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
      expect(answer.citations.map((citation) => citation.marker)).toEqual(["[1]", "[2]"]);
      expect(answer.contextPack.reranker).toMatchObject({
        status,
        mode: "provider-backed",
        failureKind: kind,
        candidateCount: 2,
        documentCount: 2,
        keptCount: 2,
      });
      expect(JSON.stringify(answer.contextPack.reranker)).not.toContain("reranker.example");
      expect(JSON.stringify(answer.contextPack.reranker)).not.toContain("reranker-test-key");
      expect(answer.retrievalActivity?.pods[0]).toMatchObject({
        state: "degraded",
        reasonCodes: ["searched", reasonCode],
      });
    },
  );
});

describe("reranker reference selection helpers (#1922 / #1925 / #1926)", () => {
  const limits = { ...DEFAULT_GROUNDING_LIMITS, maxPromptReferences: 4 };

  it("no-op fallback preserves fused reference order and caps at the budget", () => {
    const references = [ref(1), ref(2), ref(3), ref(4), ref(5)];
    // A reverse / shuffle / dedupe mutation of the no-op path would fail this exact-order assertion.
    expect(fallbackReferenceSelection(references, limits).map((r) => String(r.chunkId))).toEqual([
      "chunk-1",
      "chunk-2",
      "chunk-3",
      "chunk-4",
    ]);
  });

  it("applies a valid provider reordering strictly by returned index", () => {
    const references = [ref(1), ref(2), ref(3)];
    const reranked = applyReferenceRerankResults(
      references,
      [{ index: 2 }, { index: 0 }, { index: 1 }],
      limits,
    );
    expect(reranked?.map((r) => String(r.chunkId))).toEqual(["chunk-3", "chunk-1", "chunk-2"]);
  });

  it("rejects malformed provider index mappings so the caller falls back to fused order", () => {
    const references = [ref(1), ref(2)];
    // Duplicate, out-of-range, and non-integer indices must all reject to undefined (→ invalid-response).
    expect(
      applyReferenceRerankResults(references, [{ index: 0 }, { index: 0 }], limits),
    ).toBeUndefined();
    expect(applyReferenceRerankResults(references, [{ index: 5 }], limits)).toBeUndefined();
    expect(applyReferenceRerankResults(references, [{ index: 1.5 }], limits)).toBeUndefined();
  });

  it("returns undefined for empty provider results but an empty selection for empty references", () => {
    expect(applyReferenceRerankResults([ref(1)], [], limits)).toBeUndefined();
    expect(applyReferenceRerankResults([], [{ index: 0 }], limits)).toEqual([]);
  });
});

describe("local-knowledge retrieval activity", () => {
  it("short-circuits answer synthesis before resolving a model when policy denies it", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Sealed Synthesis Capsule",
      capsuleId: "cap-policy-denied-synthesis",
      sourceId: "src-policy-denied-synthesis",
      modelUsePolicy: sealedLocalPodModelUsePolicy(),
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "policy-denied-synthesis-project");
    const created = rescueStore.createChat(project.path, "Policy denied", "chat-model");
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
        throw new Error("model must not be resolved for policy-denied synthesis");
      },
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
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
    expect(answer.noEvidence).toBe(true);
    expect(answer.noEvidenceReason).toBe("policy-denied");
    expect(answer.retrievalActivity?.pods[0]).toMatchObject({
      state: "denied",
      modes: ["local-only", "sealed"],
      reasonCodes: ["policy-denied"],
    });
  });

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

  it("redacts an unsafe scope label in the context pack on the real-evidence path, not only no-evidence", async () => {
    // buildNoEvidenceAnswer already gated its scopeLabel through the evidence-safe-text predicate;
    // buildLocalKnowledgeContextPack (the real-evidence/happy path) only whitespace-collapsed and
    // ran the audit/secret redactor, so a pod display name containing a filesystem path or PII
    // (not a known secret shape) reached this client-facing field verbatim.
    const unsafeDisplayName = "owner@example.com /Users/alice/private/plan.pdf";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const seeded = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: unsafeDisplayName,
      capsuleId: "cap-unsafe-scope-label",
      sourceId: "src-unsafe-scope-label",
      text: "alpha beta unsafe scope label evidence",
    });
    updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "unsafe-scope-label-project");
    const created = rescueStore.createChat(project.path, "Unsafe scope label", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule", capsuleId: seeded.capsuleId, connectedAtMs: 1 },
    });
    const embeddingModelId = "text-embedding-3-small";
    const deps: UiHandlerDeps = {
      config: {
        providers: [testProvider("chat-model"), testProvider(embeddingModelId)],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [chatCapability("chat-model"), embeddingCapability(embeddingModelId)],
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
      modelPortFactory: () =>
        answerModel("Alpha beta unsafe scope label [1].", "unsafe-scope-label"),
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
      localKnowledgeEmbeddingRequest: scriptedAdapter().request,
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
    expect(answer.noEvidence).toBe(false);
    expect(answer.contextPack.scopeLabel).toBe("Knowledge Pod");
    const serialized = JSON.stringify(answer);
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("/Users/alice/private");
  });

  it("returns redacted not-ready activity when unsafe state-failure metadata is present", async () => {
    const unsafeCapsuleId = "state-owner@example.com" as KnowledgeCapsuleId;
    const unsafeSourceId = "state-source@example.com" as KnowledgeSourceId;
    const unsafeDisplayName =
      "state-owner@example.com /Users/alice/private/pod.md https://reranker.example/v1 sk-rerank-secret";
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    await seedCapsuleWithVectors(knowledgeStore, {
      displayName: unsafeDisplayName,
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
    expect(answer.contextPack.scopeLabel).toBe("Knowledge Pod");
    const serialized = JSON.stringify(answer);
    expect(serialized).not.toContain("state-owner@example.com");
    expect(serialized).not.toContain("state-source@example.com");
    expect(serialized).not.toContain("/Users/alice/private");
    expect(serialized).not.toContain("reranker.example");
    expect(serialized).not.toContain("sk-rerank-secret");
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

  it("keeps mixed-readiness set activity reasons on the affected members", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const ready = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Ready Set Member",
        capsuleId: "cap-ready-set-member",
        sourceId: "src-ready-set-member",
      });
      const indexing = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Indexing Set Member",
        capsuleId: "cap-indexing-set-member",
        sourceId: "src-indexing-set-member",
      });
      const sealed = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Sealed During Indexing Member",
        capsuleId: "cap-sealed-during-indexing-member",
        sourceId: "src-sealed-during-indexing-member",
        modelUsePolicy: sealedLocalPodModelUsePolicy(),
      });
      updateCapsuleState(knowledgeStore, ready.capsuleId, "ready");
      updateCapsuleState(knowledgeStore, indexing.capsuleId, "indexing");
      updateCapsuleState(knowledgeStore, sealed.capsuleId, "ready");
      const selected: SelectedLocalKnowledgeScope = {
        capsules: [
          requireCapsule(knowledgeStore, ready.capsuleId),
          requireCapsule(knowledgeStore, indexing.capsuleId),
          requireCapsule(knowledgeStore, sealed.capsuleId),
        ],
        scopeKind: "capsule-set",
        scopeLabel: "Mixed Readiness Set",
      };

      const activity = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [],
        skipped: [{ selected, reason: "indexing-in-progress" }],
      });

      expect(activity.pods.find((pod) => pod.podId === ready.capsuleId)).toMatchObject({
        state: "skipped",
        reasonCodes: ["source-skipped"],
      });
      expect(activity.pods.find((pod) => pod.podId === indexing.capsuleId)).toMatchObject({
        state: "unavailable",
        reasonCodes: ["indexing-in-progress"],
      });
      expect(activity.pods.find((pod) => pod.podId === sealed.capsuleId)).toMatchObject({
        state: "denied",
        reasonCodes: ["policy-denied"],
      });
    } finally {
      knowledgeStore.close();
    }
  });

  it("preserves distinct member skip reasons for real capsule-set grounded asks", async () => {
    const setId = "set-mixed-grounded-activity" as CapsuleSetId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    const ready = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Ready Grounded Set Member",
      capsuleId: "cap-ready-grounded-set-member",
      sourceId: "src-ready-grounded-set-member",
    });
    const indexing = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Indexing Grounded Set Member",
      capsuleId: "cap-indexing-grounded-set-member",
      sourceId: "src-indexing-grounded-set-member",
    });
    const sealed = await seedCapsuleWithVectors(knowledgeStore, {
      displayName: "Sealed Grounded Set Member",
      capsuleId: "cap-sealed-grounded-set-member",
      sourceId: "src-sealed-grounded-set-member",
      modelUsePolicy: sealedLocalPodModelUsePolicy(),
    });
    updateCapsuleState(knowledgeStore, ready.capsuleId, "ready");
    updateCapsuleState(knowledgeStore, indexing.capsuleId, "indexing");
    updateCapsuleState(knowledgeStore, sealed.capsuleId, "ready");
    createCapsuleSet(knowledgeStore, {
      id: setId,
      displayName: "Mixed Grounded Activity Set",
      tags: [],
      capsuleIds: [ready.capsuleId, indexing.capsuleId, sealed.capsuleId],
    });
    knowledgeStore.close();

    const project = rescueStore.createProject(rescueTmp, "mixed-grounded-activity-project");
    const created = rescueStore.createChat(project.path, "Mixed grounded activity", "chat-model");
    const chat = rescueStore.updateChat(created.id, {
      localKnowledgeScope: { kind: "capsule-set", capsuleSetId: setId, connectedAtMs: 1 },
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
        throw new Error("model must not be called for set state-failure activity");
      },
      store: rescueStore,
      uiDbPath: join(rescueTmp, "keiko-ui.db"),
    };

    const result = await handleLocalKnowledgeGroundedAsk(
      chat,
      { chatId: chat.id, content: "Which set members can answer?", modelId: "chat-model" },
      deps,
      new AbortController().signal,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as Extract<
      GroundedAnswer,
      { readonly groundingKind: "local-knowledge" }
    >;
    expect(answer.noEvidenceReason).toBe("indexing-in-progress");
    expect(
      answer.retrievalActivity?.pods.find((pod) => pod.podId === ready.capsuleId),
    ).toMatchObject({
      state: "skipped",
      reasonCodes: ["source-skipped"],
    });
    expect(
      answer.retrievalActivity?.pods.find((pod) => pod.podId === indexing.capsuleId),
    ).toMatchObject({
      state: "unavailable",
      reasonCodes: ["indexing-in-progress"],
    });
    expect(
      answer.retrievalActivity?.pods.find((pod) => pod.podId === sealed.capsuleId),
    ).toMatchObject({
      state: "denied",
      reasonCodes: ["policy-denied"],
    });
    expect(JSON.stringify(answer.retrievalActivity)).not.toContain("Which set members can answer?");
  });

  it("keeps set-level policy denial on the sealed member instead of every member", async () => {
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const standard = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Standard Set Member",
        capsuleId: "cap-standard-set-member",
        sourceId: "src-standard-set-member",
      });
      const sealed = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Sealed Set Member",
        capsuleId: "cap-sealed-set-member",
        sourceId: "src-sealed-set-member",
        modelUsePolicy: sealedLocalPodModelUsePolicy(),
      });
      updateCapsuleState(knowledgeStore, standard.capsuleId, "ready");
      updateCapsuleState(knowledgeStore, sealed.capsuleId, "ready");
      const selected: SelectedLocalKnowledgeScope = {
        capsules: [
          requireCapsule(knowledgeStore, standard.capsuleId),
          requireCapsule(knowledgeStore, sealed.capsuleId),
        ],
        scopeKind: "capsule-set",
        scopeLabel: "Mixed Policy Set",
      };

      const activity = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [],
        skipped: [{ selected, reason: "policy-denied" }],
      });

      expect(activity.pods.find((pod) => pod.podId === standard.capsuleId)).toMatchObject({
        state: "skipped",
        modes: ["local-only"],
        reasonCodes: ["source-skipped"],
      });
      expect(activity.pods.find((pod) => pod.podId === sealed.capsuleId)).toMatchObject({
        state: "denied",
        modes: ["local-only", "sealed"],
        reasonCodes: ["policy-denied"],
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

  it("fails closed by omitting the activity when a projected count breaks the contract", async () => {
    const sourceId = "src-fail-closed" as KnowledgeSourceId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Fail Closed Capsule",
        capsuleId: "cap-fail-closed",
        sourceId,
      });
      const capsuleValue = requireCapsule(knowledgeStore, seeded.capsuleId);
      // A negative citation count violates the non-negative-integer contract, so the builder must
      // throw and the wrapper must omit the activity rather than emit an invalid projection.
      const input = {
        store: knowledgeStore,
        sources: [
          {
            selected: selectedActivityScope(capsuleValue),
            result: {
              references: [retrievalActivityReference(seeded.capsuleId, sourceId)],
              citationCounts: new Map([[String(seeded.capsuleId), -1]]),
              noEvidence: false,
            },
          },
        ],
      } as const;
      expect(() => buildKnowledgePodRetrievalActivity(input)).toThrow(
        "Knowledge Pod retrieval activity validation failed.",
      );
      expect(tryBuildKnowledgePodRetrievalActivity(input)).toBeUndefined();
    } finally {
      knowledgeStore.close();
    }
  });

  it("degrades pods and records reranker reason codes on reranker failures", async () => {
    const sourceId = "src-reranker" as KnowledgeSourceId;
    const knowledgeStore = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: rescueTmp }),
    });
    try {
      const seeded = await seedCapsuleWithVectors(knowledgeStore, {
        displayName: "Reranker Capsule",
        capsuleId: "cap-reranker",
        sourceId,
      });
      const capsuleValue = requireCapsule(knowledgeStore, seeded.capsuleId);
      const selected = selectedActivityScope(capsuleValue);
      const reference = retrievalActivityReference(seeded.capsuleId, sourceId);
      const citationCounts = new Map([[String(seeded.capsuleId), 1]]);

      const invalidResponse = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected,
            result: {
              references: [reference],
              citationCounts,
              noEvidence: false,
              reranker: {
                status: "invalid-response",
                candidateCount: 3,
                documentCount: 3,
                keptCount: 0,
              },
            },
          },
        ],
      });
      const policyDenied = buildKnowledgePodRetrievalActivity({
        store: knowledgeStore,
        sources: [
          {
            selected,
            result: {
              references: [reference],
              citationCounts,
              noEvidence: false,
              reranker: {
                status: "unavailable",
                candidateCount: 3,
                documentCount: 3,
                keptCount: 0,
                failureKind: "policy-denied",
              },
            },
          },
        ],
      });

      expect(invalidResponse.pods[0]?.state).toBe("degraded");
      expect(invalidResponse.pods[0]?.reasonCodes).toContain("reranker-invalid-response");
      expect(policyDenied.pods[0]?.state).toBe("degraded");
      expect(policyDenied.pods[0]?.reasonCodes).toContain("policy-denied");
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
  it("degrades a provider whose configured capability is not embedding at request time", async () => {
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

    const adapter = createEmbeddingAdapter(deps);

    expect("status" in adapter).toBe(false);
    if ("status" in adapter) throw new Error("expected embedding adapter");
    await expect(
      adapter.request({
        endpoint: adapter.endpoint,
        apiKey: adapter.apiKey,
        modelId: "text-embedding-3-small",
        input: "query",
      }),
    ).resolves.toEqual({ ok: false, kind: "unsupported-model" });
    expect(embeddingRequests).toBe(0);
  });

  it("lets fingerprinted gateway drift degrade in the affected retrieval lane", async () => {
    let embeddingRequests = 0;
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
      localKnowledgeEmbeddingRequest: () => {
        embeddingRequests += 1;
        return Promise.resolve({
          ok: true,
          value: {
            vector: new Float32Array(1536),
            modelId: "text-embedding-3-small",
          },
        });
      },
    } as unknown as UiHandlerDeps;

    const adapter = createEmbeddingAdapter(deps);

    expect("status" in adapter).toBe(false);
    if ("status" in adapter) throw new Error("expected embedding adapter");
    await expect(
      adapter.request({
        endpoint: adapter.endpoint,
        apiKey: adapter.apiKey,
        modelId: "text-embedding-3-small",
        input: "query",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(embeddingRequests).toBe(1);
  });
});
