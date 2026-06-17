// #189 citation rescue: a connector answer that uses retrieved references but whose model did
// NOT emit [n] markers (some models emit fullwidth 【n】 or no markers at all) is still grounded —
// it must surface the references it was given, not be discarded as "no evidence". Proven live with
// gpt-oss-120b (which emitted 【1】 not [1]); these unit tests pin the behaviour.
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
import {
  buildLocalKnowledgeCitations,
  createEmbeddingAdapter,
  enforcedNoEvidenceReason,
  handleLocalKnowledgeGroundedAsk,
  LOCAL_KNOWLEDGE_NO_EVIDENCE_ANSWER,
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
    expect(citations[0]?.lineage).toEqual({
      capsuleId: "cap-1",
      sourceId: "src-1",
      documentId: "doc-1",
      chunkId: "chunk-1",
    });
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
      result({ references: [reference], citations: [] }),
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

  it("still recognizes the legacy English no-evidence sentence", () => {
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
