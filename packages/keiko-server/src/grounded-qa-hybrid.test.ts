// Tests for the hybrid grounded path (Epic #189 Slice 2). Drives `handleGroundedAsk` with
// injected seams (no real embeddings, no real workspace) while keeping a REAL KnowledgeStore so
// `selectedCapsulesForScope` resolves actual capsule rows and `scopeStateFailure` detects not-ready
// states. Every test is mutation-robust: a single-line change in the source — a swapped count, a
// missing `.source` tag, a dropped skip-uncertainty — must make at least one assertion fail.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  GroundedAnswer,
  HybridGroundedAnswer,
  LocalKnowledgeGroundedAnswer,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgePodModelUsePolicy,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  standardPodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";

import {
  openKnowledgeStore,
  persistHtmlManualSourceMetadata,
  resolveKnowledgeStorePath,
  updateCapsuleState,
  type RetrievalResult,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  scriptedAdapter,
  seedCapsuleWithVectors,
} from "@oscharko-dev/keiko-local-knowledge/testing";

import { handleGroundedAsk, type GroundedRunner, type HybridSeam } from "./grounded-qa.js";
import { ClarificationNeededError } from "./grounded-orchestrator.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { RerankOutcome } from "@oscharko-dev/keiko-model-gateway";
import type { GroundedRetriever } from "./grounded-qa-multi-source.js";
import { EmbeddingAdapterError, type ConnectorRetrieve } from "./grounded-qa-hybrid.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import type { OrchestratorInput, RetrievalOnlyOutput } from "./grounded-orchestrator.js";
import { mockRequest, mockResponse } from "./_support.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";
const HYBRID_ANSWER_SENTINEL = "Hybrid answer from injected seam.";

// ─── Store + temp-dir lifecycle ───────────────────────────────────────────────

let store: UiStore;
let tmp: string;

beforeEach(() => {
  store = createInMemoryUiStore();
  tmp = mkdtempSync(join(tmpdir(), "keiko-grounded-hybrid-"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function tempRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  return root;
}

// ─── Request / route helpers ──────────────────────────────────────────────────

function fakeReq(body: string): RouteContext["req"] {
  return mockRequest({ body });
}

// mockResponse() is a genuine PassThrough: it is an EventEmitter (so `res.emit("close")` in the
// disconnect test works) with a real `writableEnded` getter (false until end), which is exactly what
// the disconnect guard `res.on("close", () => { if (!res.writableEnded) abort(); })` reads.
function fakeRes(): RouteContext["res"] {
  return mockResponse().res;
}

function routeCtx(body: string, res: RouteContext["res"] = fakeRes()): RouteContext {
  return {
    req: fakeReq(body),
    res,
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

// ─── Deps builder ─────────────────────────────────────────────────────────────
// No real model port — the hybrid.answer seam replaces the model call.
// uiDbPath points to the temp dir so openStoreForDeps can open the REAL on-disk KnowledgeStore.

function hybridDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  const env: Record<string, string> = {};
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, undefined),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    uiDbPath: join(tmp, "keiko-ui.db"),
    ...overrides,
  };
}

// ─── Capsule seeding helpers ──────────────────────────────────────────────────
// Seeds a REAL capsule into the on-disk KnowledgeStore (same path openStoreForDeps opens),
// marks it ready, closes the store. Mirrors how grounded-qa.test.ts seeds capsules.

// Unique per-capsule ids derived from the (unique) display name so multiple seeds into the same
// on-disk store never collide on capsules.id (UNIQUE constraint).
function seedIds(displayName: string): { capsuleId: string; sourceId: string } {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { capsuleId: `cap-${base}`, sourceId: `src-${base}` };
}

async function seedReadyCapsule(
  displayName: string,
  options: { readonly modelUsePolicy?: KnowledgePodModelUsePolicy } = {},
): Promise<{ capsuleId: KnowledgeCapsuleId; label: string }> {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName,
    ...seedIds(displayName),
    ...(options.modelUsePolicy !== undefined ? { modelUsePolicy: options.modelUsePolicy } : {}),
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  knowledgeStore.close();
  return { capsuleId: seeded.capsuleId, label: displayName };
}

// Seeds a ready capsule whose single source is tagged as an `html-manual-http` source (mirrors
// the single-connector manual fixture in local-knowledge-grounded-qa.rescue.test.ts). Returns the
// seeded chunk/document ids so the caller can build a RetrievalReference whose citation carries
// the anchor/section metadata `projectHtmlManualCitationMetadata` projects.
async function seedReadyManualCapsule(displayName: string): Promise<{
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
  readonly label: string;
}> {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const { capsuleId, sourceId } = seedIds(displayName);
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName,
    capsuleId,
    sourceId,
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
    sourceFingerprint: `fp-${capsuleId}`,
    proposedPodName: displayName,
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  knowledgeStore.close();
  const chunkId = seeded.chunkIds[0];
  if (chunkId === undefined) throw new Error(`seeded manual capsule ${capsuleId} has no chunk`);
  return {
    capsuleId: seeded.capsuleId,
    sourceId: seeded.sourceId,
    documentId: seeded.documentId,
    chunkId,
    label: displayName,
  };
}

function modelUsePolicyDenying(
  operation: keyof KnowledgePodModelUsePolicy["operations"],
): KnowledgePodModelUsePolicy {
  return {
    schemaVersion: KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
    mode: "custom",
    operations: {
      ...standardPodModelUsePolicy().operations,
      [operation]: "deny",
    },
  };
}

// Seeds a NOT-READY capsule (indexing state). scopeStateFailure detects it and skips retrieval.
async function seedIndexingCapsule(displayName: string): Promise<KnowledgeCapsuleId> {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName,
    ...seedIds(displayName),
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "indexing");
  knowledgeStore.close();
  return seeded.capsuleId;
}

function auditKindsFor(capsuleId: KnowledgeCapsuleId): readonly string[] {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  try {
    const rows = knowledgeStore._internal.db
      .prepare(
        "SELECT kind FROM capsule_audit_events WHERE capsule_id = :capsuleId ORDER BY occurred_at ASC, kind ASC",
      )
      .all({ capsuleId: String(capsuleId) }) as unknown as readonly {
      readonly kind: string;
    }[];
    return rows.map((row) => row.kind);
  } finally {
    knowledgeStore.close();
  }
}

// ─── Chat builders ────────────────────────────────────────────────────────────

function makeHybridChat(
  folderScopes: readonly ChatConnectedScope[],
  connectorScopes: readonly ChatLocalKnowledgeScope[],
): string {
  const project = store.createProject(tmp, "hybrid-test");
  const chat = store.createChat(project.path, "Hybrid test", CHAT_MODEL);
  if (folderScopes.length > 0) {
    store.updateChat(chat.id, { connectedScopes: [...folderScopes] });
  }
  if (connectorScopes.length > 0) {
    store.updateChat(chat.id, { localKnowledgeScopes: [...connectorScopes] });
  }
  return chat.id;
}

// ─── Pack factory ─────────────────────────────────────────────────────────────
// Returns a minimal valid ConnectedContextPack with one citation for the FolderRetriever seam.

function folderPack(
  scopePath: string,
  score: number,
  stableId: string,
  workspaceRoot = "/repo",
): ConnectedContextPack {
  const content = `evidence for ${scopePath}`;
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `pack-${stableId}`,
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: `cs-${stableId}`,
      workspaceRoot,
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "How does it work?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: content.length,
      modelInputTokens: 5,
      modelOutputTokens: 2,
      elapsedMs: 7,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath,
        role: "read-only",
        selectionReason: "ranked",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId,
              scopePath,
              lineRange: { startLine: 1, endLine: 5 },
              score,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content,
            contentBytes: new TextEncoder().encode(content).length,
          },
        ],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

// ─── Seam factories ───────────────────────────────────────────────────────────

// FolderRetriever: maps scope.relativePaths[0] → pack. Mirrors grounded-qa-multi-source.test.ts.
function folderRetrieverFor(packs: ReadonlyMap<string, ConnectedContextPack>): GroundedRetriever {
  return (input: OrchestratorInput): Promise<RetrievalOnlyOutput> => {
    const key = input.scope.relativePaths[0] ?? "";
    const pack = packs.get(key);
    if (pack === undefined) throw new Error(`No fixture pack for path: ${key}`);
    return Promise.resolve({ pack, elapsedMs: 11, plan: { state: "ready" } as never });
  };
}

// Builds a fully-typed RetrievalReference whose citation carries every field the hybrid excerpt
// reader binds (documentId, capsuleId, sourceId, chunkId). The synthetic documentId need not match
// a seeded document_texts row — readCitationExcerpt returns "" when absent, which is fine here.
function connectorReference(
  capsuleId: KnowledgeCapsuleId,
  n: number,
  safeDisplayName: string,
): RetrievalReference {
  const chunkId = `chunk-${String(n)}` as ChunkId;
  const sourceId = String(capsuleId).startsWith("cap-")
    ? (`src-${String(capsuleId).slice(4)}` as KnowledgeSourceId)
    : (`src-${String(n)}` as KnowledgeSourceId);
  return {
    chunkId,
    capsuleId,
    score: 0.85,
    citation: {
      documentId: `doc-${String(n)}` as DocumentId,
      capsuleId,
      sourceId,
      chunkId,
      safeDisplayName,
    },
  };
}

// ConnectorRetrieve: returns one reference per capsuleId. The scope carries a capsuleId for
// capsule-kind scopes; we use it to distinguish two connectors in the dual-connector case.
function singleConnectorRetrieve(capsuleId: KnowledgeCapsuleId): ConnectorRetrieve {
  return (_store, _scope): Promise<RetrievalResult> =>
    Promise.resolve({
      references: [connectorReference(capsuleId, 1, `doc-from-${String(capsuleId)}`)],
      noEvidence: false,
    });
}

// Builds a RetrievalReference that matches a seeded HTML-manual capsule's actual lineage
// (chunk/document/source ids), carrying the section/anchor metadata that
// projectHtmlManualCitationMetadata reads. Unlike connectorReference, the ids must line up with a
// real seeded row so resolveHtmlManualCitationTarget's lineage lookup succeeds.
function manualConnectorReference(
  seeded: Awaited<ReturnType<typeof seedReadyManualCapsule>>,
): RetrievalReference {
  return {
    chunkId: seeded.chunkId,
    capsuleId: seeded.capsuleId,
    score: 0.93,
    citation: {
      documentId: seeded.documentId,
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      chunkId: seeded.chunkId,
      safeDisplayName: "device-handbook.html",
      sectionPath: ["Troubleshooting", "Timeouts"],
      anchorId: "timeouts",
    },
  };
}

// ConnectorRetrieve returning exactly the manual capsule's own reference.
function singleManualConnectorRetrieve(
  seeded: Awaited<ReturnType<typeof seedReadyManualCapsule>>,
): ConnectorRetrieve {
  return (_store, _scope): Promise<RetrievalResult> =>
    Promise.resolve({
      references: [manualConnectorReference(seeded)],
      noEvidence: false,
    });
}

// ConnectorRetrieve for two capsules: each capsuleId gets its own distinct reference so the
// knowledgeCitations list carries BOTH connector labels.
function dualConnectorRetrieve(
  capA: KnowledgeCapsuleId,
  _capB: KnowledgeCapsuleId,
): ConnectorRetrieve {
  return (_store, scope): Promise<RetrievalResult> => {
    const cid = scope.kind === "capsule" ? scope.capsuleId : capA;
    const n = cid === capA ? 10 : 20;
    return Promise.resolve({
      references: [connectorReference(cid, n, `doc-from-${String(cid)}`)],
      noEvidence: false,
    });
  };
}

// HybridAnswerer: returns a sentinel string; tracks invocation count for mutation detection.
function sentinelAnswerer(
  response = HYBRID_ANSWER_SENTINEL,
  seen: { count: number } = { count: 0 },
) {
  return (_system: string, _user: string): Promise<string> => {
    seen.count += 1;
    return Promise.resolve(response);
  };
}

// HybridAnswerer that throws — proves a branch does NOT reach the hybrid answerer.
function throwingHybridAnswerer() {
  return (_system: string, _user: string): Promise<string> =>
    Promise.reject(new Error("hybrid.answer must NOT be called on this path"));
}

function rerankerGatewayConfig(): NonNullable<UiHandlerDeps["config"]> {
  return {
    providers: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    reranker: {
      modelId: "qwen3-reranker",
      baseUrl: "https://litellm.local/v1",
      apiKey: "reranker-test-key",
      timeoutMs: 30_000,
    },
  };
}

function successfulRerank(indices: readonly number[]): RerankOutcome {
  return {
    ok: true,
    value: {
      modelId: "qwen3-reranker",
      results: indices.map((index, offset) => ({
        index,
        relevanceScore: 1 - offset / 10,
      })),
    },
  };
}

// ─── Type narrowing helpers ───────────────────────────────────────────────────

function asHybrid(answer: GroundedAnswer): HybridGroundedAnswer {
  expect(answer.groundingKind, "expected hybrid answer").toBe("hybrid");
  return answer as HybridGroundedAnswer;
}

function asLocalKnowledge(answer: GroundedAnswer): LocalKnowledgeGroundedAnswer {
  expect(answer.groundingKind, "expected local-knowledge answer").toBe("local-knowledge");
  return answer as LocalKnowledgeGroundedAnswer;
}

// ─── Case 1: Mixed — 1 folder + 1 connector ──────────────────────────────────

describe("hybrid grounded ask — 1 folder + 1 connector", () => {
  it("returns groundingKind 'hybrid' with source-tagged citations, correct contextPack counts, and the answerer's content", async () => {
    // Arrange
    const { capsuleId: capId, label: connectorLabel } = await seedReadyCapsule("Alpha Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/alpha.ts"],
      connectedAtMs: NOW,
      root: tempRoot("alpha-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);

    const packMap = new Map([["src/alpha.ts", folderPack("src/alpha.ts", 0.7, "alpha-atom")]]);
    const answererSeen = { count: 0 };
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: sentinelAnswerer(HYBRID_ANSWER_SENTINEL, answererSeen),
    };
    const evidenceRunIds: string[] = [];

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is alpha?" })),
      hybridDeps({
        evidenceStore: {
          put: (runId: string): string => {
            evidenceRunIds.push(runId);
            return runId;
          },
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
      }),
      undefined,
      undefined,
      hybrid,
    );

    // Assert
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);

    // groundingKind must be exactly "hybrid"
    // mutation: changing to "connected-context" fails groundingKind assertion
    expect(answer.groundingKind).toBe("hybrid");

    // content equals the injected answerer's string
    // mutation: dropping redactString in assembleHybridAnswer → content mismatch
    expect(answer.content).toBe(HYBRID_ANSWER_SENTINEL);

    // Folder citations: non-empty; EVERY citation carries the folder's source label AND a marker.
    // mutation: removing `.source` tag from selectedFolderCitations → forEach fails
    // mutation: removing marker from selectedFolderCitations → marker check fails
    expect(answer.citations.length).toBeGreaterThan(0);
    for (const citation of answer.citations) {
      expect(citation.source).toBe("alpha-repo");
      expect(typeof citation.marker).toBe("number");
      expect(Number(citation.marker) >= 1).toBe(true);
    }

    // Connector citations: non-empty; EVERY citation carries the connector's source label.
    // mutation: removing `.source` tag from selectedConnectorCitations → forEach fails
    expect(answer.knowledgeCitations.length).toBeGreaterThan(0);
    for (const kc of answer.knowledgeCitations) {
      expect(kc.source?.startsWith(`${connectorLabel} / `)).toBe(true);
    }

    // Global [n] marker sequence: all markers across both citation arrays are distinct positive
    // integers. Folder and connector markers come from the SAME sequence (no resets per kind).
    // mutation: using per-kind index resets → markers clash between kinds
    const folderMarkers = answer.citations.map((c) => Number(c.marker));
    const connectorMarkers = answer.knowledgeCitations.map((kc) =>
      parseInt(kc.marker.replace(/^\[(\d+)\]$/, "$1"), 10),
    );
    const allMarkers = [...folderMarkers, ...connectorMarkers];
    expect(new Set(allMarkers).size).toBe(allMarkers.length);

    // contextPack: kind === "hybrid" with correct folderSourceCount and connectorSourceCount
    // mutation: swapping the two counts → at least one count assertion fails
    expect(answer.contextPack.kind).toBe("hybrid");
    expect(answer.contextPack.folderSourceCount).toBe(1);
    expect(answer.contextPack.connectorSourceCount).toBe(1);
    expect(answer.evidenceRunId).toBe(evidenceRunIds[0]);
    expect(answer.evidenceRunIds).toEqual(evidenceRunIds);

    // referencesUsed ≤ referenceBudget (hybridMaxCandidates) — invariant from ADR-0036
    // mutation: using pre-RRF sum instead of selected count → violates invariant when budget shrinks
    expect(answer.contextPack.knowledge.referencesUsed).toBeLessThanOrEqual(
      answer.contextPack.knowledge.referenceBudget,
    );
    expect(answer.contextPack.reranker).toMatchObject({
      status: "disabled",
      mode: "none",
      candidateCount: 2,
      documentCount: 0,
      keptCount: 2,
      failureKind: "not-configured",
    });
    expect(answer.contextPack.knowledge.reranker?.status).toBe("disabled");

    // Messages persisted in the UiStore
    const messages = store.listMessages(chatId);
    expect(messages.map((m) => m.id)).toContain(answer.userMessageId);
    expect(messages.map((m) => m.id)).toContain(answer.assistantMessageId);

    // Answerer invoked exactly once
    expect(answererSeen.count).toBe(1);
    expect([...auditKindsFor(capId)].sort()).toEqual([
      "answer-context-assembled",
      "model-context-sent",
      "retrieval-performed",
    ]);
  });

  it("omits connector audit evidence when connector evidence persistence is denied", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("No Evidence Persist Docs", {
      modelUsePolicy: modelUsePolicyDenying("evidencePersistence"),
    });
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/no-evidence-persist.ts"],
      connectedAtMs: NOW,
      root: tempRoot("no-evidence-persist-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([
      [
        "src/no-evidence-persist.ts",
        folderPack("src/no-evidence-persist.ts", 0.7, "no-evidence-persist-atom"),
      ],
    ]);

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What evidence is available?" })),
      hybridDeps(),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer("Hybrid answer from selected evidence [1] [2]."),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.knowledgeCitations).toHaveLength(1);
    expect(auditKindsFor(capId)).toEqual([]);
  });

  it("does not persist a hybrid answer when the client disconnects after answering", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Disconnect Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/disconnect.ts"],
      connectedAtMs: NOW,
      root: tempRoot("disconnect-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([
      ["src/disconnect.ts", folderPack("src/disconnect.ts", 0.7, "disconnect-atom")],
    ]);
    const res = fakeRes();
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: () => {
        res.emit("close");
        return Promise.resolve("late hybrid answer");
      },
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What changed?" }), res),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    expect(result.status).toBe(499);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("strips planner scaffolding from hybrid answers and carries final model usage", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Alpha Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/alpha.ts"],
      connectedAtMs: NOW,
      root: tempRoot("alpha-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is alpha?" })),
      hybridDeps(),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(
          new Map([["src/alpha.ts", folderPack("src/alpha.ts", 0.7, "alpha-atom")]]),
        ),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: () =>
          Promise.resolve({
            content: [
              "Searching for alpha context",
              '{ "query": "alpha", "tool": "repo.searchText" }',
              "Hybrid grounded answer.",
            ].join("\n"),
            usage: { promptTokens: 9, completionTokens: 3 },
          }),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.content).toBe("Hybrid grounded answer.");
    expect(answer.contextPack.folder.usage.modelInputTokens).toBe(14);
    expect(answer.contextPack.folder.usage.modelOutputTokens).toBe(5);
    const assistant = store
      .listMessages(chatId)
      .find((message) => message.id === answer.assistantMessageId);
    expect(assistant?.content).toBe("Hybrid grounded answer.");
  });
});

// ─── Case 1b: HTML-manual-tagged connector projects htmlManual metadata (Epic #1854) ──
//
// grounded-qa-hybrid.ts threads a `store` parameter through selectedConnectorCitations so that
// projectLocalKnowledgeCitation can call projectHtmlManualCitationMetadata for connector citations
// selected on the HYBRID (multi-connector) path, not just the single-connector local-knowledge
// path. Before that threading, selectedConnectorCitations called projectLocalKnowledgeCitation
// without a store, so `htmlManual` was always undefined here even for a manual-tagged capsule.

describe("hybrid grounded ask — HTML-manual citation metadata projection", () => {
  it("populates knowledgeCitations[].htmlManual for a manual-tagged connector merged with a folder", async () => {
    // Arrange: one folder + one HTML-manual-tagged connector, mirroring Case 1's 1-folder +
    // 1-connector hybrid shape so the citation flows through the SAME rerank/select/assemble path
    // as every other hybrid citation.
    const manualCapsule = await seedReadyManualCapsule("Device Handbook");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/handbook.ts"],
      connectedAtMs: NOW,
      root: tempRoot("handbook-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: manualCapsule.capsuleId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([
      ["src/handbook.ts", folderPack("src/handbook.ts", 0.7, "handbook-atom")],
    ]);
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve: singleManualConnectorRetrieve(manualCapsule),
      answer: sentinelAnswerer(),
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "How do I fix a timeout?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // Assert
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.knowledgeCitations.length).toBeGreaterThan(0);
    const manualCitation = answer.knowledgeCitations.find((kc) =>
      kc.source?.startsWith(`${manualCapsule.label} / `),
    );
    expect(manualCitation).toBeDefined();

    // htmlManual must be POPULATED, not undefined — this is the exact field the `store` threading
    // through selectedConnectorCitations exists to project on the hybrid path.
    // mutation: reverting the `store` parameter (calling projectLocalKnowledgeCitation without it)
    // makes projectHtmlManualCitationMetadata short-circuit on `store === undefined` → htmlManual
    // stays undefined and this assertion fails.
    expect(manualCitation?.htmlManual).toBeDefined();
    expect(manualCitation?.htmlManual).toMatchObject({
      sourceKind: "html-manual-http",
      pageTitle: "device-handbook.html",
      sectionPath: ["Troubleshooting", "Timeouts"],
      anchorId: "timeouts",
      open: { state: "available" },
    });

    // The opaque `open.target` handle is a base64 lineage-id token — it must never embed the raw
    // manual origin/path in plaintext, unlike `targetSummary.originSummary`, which is a SEPARATE,
    // intentionally safe field that legitimately carries the bare origin for citation-label display
    // (see docs-browser.test.ts:346, where the same origin string is an expected wire value).
    // mutation: dropping the classification/redaction step would leak the raw origin into `target`.
    const open = manualCitation?.htmlManual?.open;
    const target = open?.state === "available" ? open.target : "";
    expect(target).toMatch(/^keiko-html-manual-citation:/u);
    expect(target).not.toContain("https://manual.internal");
  });
});

// ─── Case 2: ≥2 connectors, 0 folders ────────────────────────────────────────

describe("hybrid grounded ask — 2 connectors, 0 folders", () => {
  it("routes to hybrid, carries folderSourceCount=0 and connectorSourceCount=2, both connector labels in knowledgeCitations", async () => {
    // Arrange
    const { capsuleId: capA, label: labelA } = await seedReadyCapsule("Beta Docs");
    const { capsuleId: capB, label: labelB } = await seedReadyCapsule("Gamma Docs");

    const chatId = makeHybridChat(
      [],
      [
        { kind: "capsule", capsuleId: capA, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: capB, connectedAtMs: NOW },
      ],
    );

    const hybrid: HybridSeam = {
      connectorRetrieve: dualConnectorRetrieve(capA, capB),
      answer: sentinelAnswerer(),
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is beta and gamma?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // Assert
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.groundingKind).toBe("hybrid");

    // Folder citations must be empty (no folder scopes — zero folder evidence)
    // mutation: if folder retrieval runs anyway, citations would be non-empty
    expect(answer.citations).toHaveLength(0);

    // contextPack counts: folderSourceCount=0, connectorSourceCount=2
    // mutation: swapping or hardcoding either count fails both count assertions
    expect(answer.contextPack.kind).toBe("hybrid");
    expect(answer.contextPack.folderSourceCount).toBe(0);
    expect(answer.contextPack.connectorSourceCount).toBe(2);

    // Both connector labels must appear in knowledgeCitations
    // mutation: dropping one connector's retrieval → one label absent
    const kciLabels = answer.knowledgeCitations.map((kc) => kc.source);
    expect(kciLabels.some((label) => label?.startsWith(`${labelA} / `))).toBe(true);
    expect(kciLabels.some((label) => label?.startsWith(`${labelB} / `))).toBe(true);

    // Both labels must be DISTINCT (disambiguated by connectorLabels())
    // mutation: returning the same label for both → uniqueLabels.size === 1
    const uniqueLabels = new Set(kciLabels);
    expect(uniqueLabels.size).toBe(2);
  });

  it("redacts an unsafe connector display name from the hybrid knowledge scope label", async () => {
    // The joined multi-connector scopeLabel previously had NO redaction or safe-text gate at
    // all — worse than the single-connector local-knowledge path, which at least ran the
    // audit/secret redactor. A pod display name containing a filesystem path or PII reached this
    // client-facing field verbatim.
    const unsafeName = "owner@example.com /Users/alice/private/plan.pdf";
    const { capsuleId: capA } = await seedReadyCapsule(unsafeName);
    const { capsuleId: capB } = await seedReadyCapsule("Gamma Docs");

    const chatId = makeHybridChat(
      [],
      [
        { kind: "capsule", capsuleId: capA, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: capB, connectedAtMs: NOW },
      ],
    );

    const hybrid: HybridSeam = {
      connectorRetrieve: dualConnectorRetrieve(capA, capB),
      answer: sentinelAnswerer(),
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is in the private plan?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    // Scoped to the field this fix owns: knowledgeCitations[].source carries its own,
    // pre-existing (not #1816) redaction path and is out of scope for this regression test.
    expect(answer.contextPack.knowledge.scopeLabel).not.toContain("owner@example.com");
    expect(answer.contextPack.knowledge.scopeLabel).not.toContain("/Users/alice/private");
    expect(answer.contextPack.knowledge.scopeLabel).toContain("Knowledge Pod");
    expect(answer.contextPack.knowledge.scopeLabel).toContain("Gamma Docs");
  });

  it("maps a planner ClarificationNeededError to an actionable 400, not a 500 (GRD-016)", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Clarify Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/alpha.ts"],
      connectedAtMs: NOW,
      root: tempRoot("alpha-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const hybrid: HybridSeam = {
      folderRetriever: () =>
        Promise.reject(
          new ClarificationNeededError({
            reason: "no-anchors",
            suggestedQuestions: ["What does parseConfig do?"],
            minimumAnchorCount: 1,
          }),
        ),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: throwingHybridAnswerer(),
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "tell me everything" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // GRD-016: a vague/no-anchor question is client-actionable → 400, not an opaque 500.
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CLARIFICATION_NEEDED");
    expect(body.error.message).toContain("mehr Kontext");
    expect(body.error.message).not.toContain("clarification needed:");
  });

  it("returns no evidence without calling the model when connector retrieval returns zero references", async () => {
    const { capsuleId: capA } = await seedReadyCapsule("Empty A Docs");
    const { capsuleId: capB } = await seedReadyCapsule("Empty B Docs");
    const chatId = makeHybridChat(
      [],
      [
        { kind: "capsule", capsuleId: capA, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: capB, connectedAtMs: NOW },
      ],
    );
    const connectorRetrieve: ConnectorRetrieve = () =>
      Promise.resolve({ references: [], noEvidence: true, reason: "no-vectors" });

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What evidence exists?" })),
      hybridDeps(),
      undefined,
      undefined,
      { connectorRetrieve, answer: throwingHybridAnswerer() },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.content).toBe("No evidence found in the selected connected sources.");
    expect(answer.citations).toHaveLength(0);
    expect(answer.knowledgeCitations).toHaveLength(0);
    expect(answer.uncertainty.some((u) => u.kind === "no-evidence")).toBe(true);
    expect(answer.retrievalActivity?.summary.unavailableCount).toBe(2);
    expect(answer.retrievalActivity?.summary.referenceCount).toBe(0);
    expect(answer.retrievalActivity?.summary.citationCount).toBe(0);
    expect(answer.retrievalActivity?.pods).toHaveLength(2);
    expect(answer.retrievalActivity?.pods.map((pod) => pod.state)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    for (const pod of answer.retrievalActivity?.pods ?? []) {
      expect(pod.reasonCodes).toContain("no-vectors");
      expect(pod.counts.referenceCount).toBe(0);
      expect(pod.counts.citationCount).toBe(0);
    }
    expect(auditKindsFor(capA)).toEqual(["retrieval-performed"]);
    expect(auditKindsFor(capB)).toEqual(["retrieval-performed"]);
  });
});

// ─── Case 3: Not-ready connector skipped, others answer ──────────────────────

describe("hybrid grounded ask — not-ready connector is skipped", () => {
  it("skips the indexing connector, surfaces uncertainty naming it, and the ready connector's citations are present", async () => {
    // Arrange: one ready connector + one indexing (not-ready) connector.
    // scopeStateFailure detects the indexing state and pushes to `skipped` instead of retrieving.
    const { capsuleId: readyCap, label: readyLabel } = await seedReadyCapsule("Ready Docs");
    const indexingCap = await seedIndexingCapsule("Indexing Docs");

    // Two connectors, no folders → hybrid dispatch (folderScopes.length === 0 + connectorCount === 2)
    const chatId = makeHybridChat(
      [],
      [
        { kind: "capsule", capsuleId: readyCap, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: indexingCap, connectedAtMs: NOW },
      ],
    );

    // Count retrievals: the indexing connector must be skipped, so count must be 1
    let retrievalCallCount = 0;
    const connectorRetrieve: ConnectorRetrieve = (_store, _scope): Promise<RetrievalResult> => {
      retrievalCallCount += 1;
      return Promise.resolve({
        references: [connectorReference(readyCap, 99, `doc-from-${readyLabel}`)],
        noEvidence: false,
      });
    };

    const hybrid: HybridSeam = {
      connectorRetrieve,
      answer: sentinelAnswerer(),
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What do you know?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // Assert
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.groundingKind).toBe("hybrid");

    // Ready connector's knowledge citations must be present
    // mutation: if the ready connector is also skipped, no citations appear
    expect(answer.knowledgeCitations.length).toBeGreaterThan(0);
    const readyCitations = answer.knowledgeCitations.filter((kc) =>
      kc.source?.startsWith(`${readyLabel} / `),
    );
    expect(readyCitations.length).toBeGreaterThan(0);

    // The skipped connector must produce an uncertainty entry containing its label
    // mutation: removing skippedUncertainty() call from assembleHybridAnswer → this fails
    const skippedUncertainties = answer.uncertainty.filter((u) =>
      u.claim.includes("Indexing Docs"),
    );
    expect(skippedUncertainties.length).toBeGreaterThan(0);

    // The indexing capsule must NOT appear in knowledgeCitations
    // mutation: removing scopeStateFailure skip guard → indexing connector retrieves and appears
    const indexingCitations = answer.knowledgeCitations.filter((kc) =>
      kc.source?.startsWith("Indexing Docs / "),
    );
    expect(indexingCitations).toHaveLength(0);
    const readyActivity = answer.retrievalActivity?.pods.find((pod) => pod.podId === readyCap);
    const indexingActivity = answer.retrievalActivity?.pods.find(
      (pod) => pod.podId === indexingCap,
    );
    expect(readyActivity).toMatchObject({
      displayName: "Ready Docs",
      state: "searched",
      counts: { referenceCount: 1, citationCount: 1 },
    });
    expect(readyActivity?.reasonCodes).toContain("searched");
    expect(indexingActivity).toMatchObject({
      displayName: "Indexing Docs",
      state: "unavailable",
      reasonCodes: ["indexing-in-progress"],
      counts: { referenceCount: 0, citationCount: 0 },
    });
    expect(answer.retrievalActivity?.privacy.privatePathsExposed).toBe(false);

    // Retrieval was called exactly once (only the ready connector)
    // mutation: removing the skip check → retrievalCallCount would be 2
    expect(retrievalCallCount).toBe(1);
  });

  it("returns no evidence without calling the model when every connector is skipped", async () => {
    const indexingA = await seedIndexingCapsule("Indexing A Docs");
    const indexingB = await seedIndexingCapsule("Indexing B Docs");
    const chatId = makeHybridChat(
      [],
      [
        { kind: "capsule", capsuleId: indexingA, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: indexingB, connectedAtMs: NOW },
      ],
    );
    let retrievalCallCount = 0;
    const connectorRetrieve: ConnectorRetrieve = () => {
      retrievalCallCount += 1;
      return Promise.resolve({ references: [], noEvidence: true });
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What do the skipped sources say?" })),
      hybridDeps(),
      undefined,
      undefined,
      { connectorRetrieve, answer: throwingHybridAnswerer() },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.content).toBe("No evidence found in the selected connected sources.");
    expect(answer.citations).toHaveLength(0);
    expect(answer.knowledgeCitations).toHaveLength(0);
    expect(answer.uncertainty.some((u) => u.kind === "no-evidence")).toBe(true);
    expect(answer.uncertainty.filter((u) => u.claim.includes("Indexing")).length).toBe(2);
    expect(retrievalCallCount).toBe(0);
    expect(auditKindsFor(indexingA)).toEqual([]);
    expect(auditKindsFor(indexingB)).toEqual([]);
  });
});

// ─── Case 3b: EmbeddingAdapterError is skipped, not aborted (Fix 2) ──────────
//
// When one connector's embedding adapter is unavailable, retrieveConnectors()
// must skip that connector and continue — not abort the whole hybrid run.
// Before the fix, the RouteResult from retrieveOneConnector was returned
// immediately, discarding all folder packs and any already-retrieved connectors.

describe("hybrid grounded ask — EmbeddingAdapterError is skipped, not aborted", () => {
  it("1 bad-embedding connector + 1 ready connector + 1 folder → 200 with folder and ready-connector citations, skip in uncertainty", async () => {
    // Arrange
    const { capsuleId: readyCap, label: readyLabel } = await seedReadyCapsule("Ready Embed Docs");
    const { capsuleId: badCap } = await seedReadyCapsule("Bad Embed Docs");

    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/fe.ts"],
      connectedAtMs: NOW,
      root: tempRoot("fe-repo"),
    };
    const chatId = makeHybridChat(
      [folderScope],
      [
        { kind: "capsule", capsuleId: badCap, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: readyCap, connectedAtMs: NOW },
      ],
    );

    const packMap = new Map([["src/fe.ts", folderPack("src/fe.ts", 0.6, "fe-atom")]]);

    // ConnectorRetrieve: throws EmbeddingAdapterError for badCap, succeeds for readyCap.
    const connectorRetrieve: ConnectorRetrieve = (_store, scope): Promise<RetrievalResult> => {
      if (scope.kind === "capsule" && scope.capsuleId === badCap) {
        throw new EmbeddingAdapterError({
          status: 409,
          body: { error: { code: "NO_EMBEDDING", message: "no embedding" } },
        });
      }
      return Promise.resolve({
        references: [connectorReference(readyCap, 77, `doc-from-${readyLabel}`)],
        noEvidence: false,
      });
    };

    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve,
      answer: sentinelAnswerer(),
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is here?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // Assert — must be 200 (skip, not abort)
    // mutation: reverting Fix 2 makes this 409 instead of 200
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);

    // Folder citations must be present (folder packs must not be discarded)
    // mutation: if Fix 2 reverted, folderPacks are discarded along with the abort
    expect(answer.citations.length).toBeGreaterThan(0);

    // Ready connector citations must be present
    // mutation: if remaining connectors are skipped instead of retrieved, length === 0
    expect(answer.knowledgeCitations.some((kc) => kc.source?.startsWith(`${readyLabel} / `))).toBe(
      true,
    );

    // Skip surfaced in uncertainty for the bad connector
    // mutation: removing the skipped.push() call → no skip uncertainty appears
    const skipEntries = answer.uncertainty.filter((u) => u.kind === "embedding-unavailable");
    expect(skipEntries.length).toBeGreaterThan(0);
  });

  it("all connectors have bad embedding → skip all connectors, still answer from folders", async () => {
    const { capsuleId: badCap1 } = await seedReadyCapsule("Bad Embed 1");
    const { capsuleId: badCap2 } = await seedReadyCapsule("Bad Embed 2");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/fe2.ts"],
      connectedAtMs: NOW,
      root: tempRoot("fe2-repo"),
    };
    const chatId = makeHybridChat(
      [folderScope],
      [
        { kind: "capsule", capsuleId: badCap1, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: badCap2, connectedAtMs: NOW },
      ],
    );
    const packMap = new Map([["src/fe2.ts", folderPack("src/fe2.ts", 0.6, "fe2-atom")]]);
    const connectorRetrieve: ConnectorRetrieve = (): Promise<RetrievalResult> => {
      throw new EmbeddingAdapterError({ status: 409, body: {} });
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Folder only?" })),
      hybridDeps(),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve,
        answer: sentinelAnswerer(),
      },
    );

    // Folder still answers even when all connectors are skipped
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.knowledgeCitations).toHaveLength(0);
    expect(answer.uncertainty.filter((u) => u.kind === "embedding-unavailable").length).toBe(2);
  });
});

// ─── Case 3c: Folder pack-validation failure is skipped, not aborted (Fix 3) ──
//
// When one folder's retrieved pack fails isValidGroundedPack, retrieveFolderPacks()
// must skip that folder and continue — not abort the whole hybrid run.
// Before the fix, return internalError() terminated the entire run.

describe("hybrid grounded ask — folder pack-validation failure is skipped, not aborted", () => {
  it("1 bad-pack folder + 1 healthy folder + 1 connector → 200 with healthy-folder and connector citations, skip in uncertainty", async () => {
    const { capsuleId: capId, label: connLabel } = await seedReadyCapsule("Fix3 Connector");

    const goodFolderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/good.ts"],
      connectedAtMs: NOW,
      root: tempRoot("good-repo"),
    };
    const badFolderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/bad.ts"],
      connectedAtMs: NOW,
      root: tempRoot("bad-repo"),
    };
    const chatId = makeHybridChat(
      [goodFolderScope, badFolderScope],
      [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }],
    );

    // Good pack for "src/good.ts"; invalid pack (empty stableId) for "src/bad.ts".
    const goodPackMap = new Map<string, ConnectedContextPack>([
      ["src/good.ts", folderPack("src/good.ts", 0.8, "good-atom")],
      ["src/bad.ts", { ...folderPack("src/bad.ts", 0.3, "bad-atom"), stableId: "" }],
    ]);

    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(goodPackMap),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: sentinelAnswerer(),
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What works?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // Must be 200, not 500
    // mutation: reverting Fix 3 (return internalError) makes this 500
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);

    // Good folder citations must be present
    // mutation: if good folder is also dropped, no citations
    expect(answer.citations.some((c) => c.source === "good-repo")).toBe(true);

    // Bad folder must NOT appear in citations
    expect(answer.citations.some((c) => c.source === "bad-repo")).toBe(false);

    // Connector citations must be present
    expect(answer.knowledgeCitations.some((kc) => kc.source?.startsWith(`${connLabel} / `))).toBe(
      true,
    );

    // Skipped folder surfaced in uncertainty
    // mutation: removing skippedFolders from assembleHybridAnswer → no skip uncertainty
    const skipEntries = answer.uncertainty.filter(
      (u) => u.kind === "pack-validation-failed" && u.claim.includes("bad-repo"),
    );
    expect(skipEntries.length).toBeGreaterThan(0);
  });

  it("all folders bad + 1 connector → 200 from connector alone, skips in uncertainty", async () => {
    const { capsuleId: capId, label: connLabel } = await seedReadyCapsule("Fix3 Only Connector");
    const badFolder1: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b1.ts"],
      connectedAtMs: NOW,
      root: tempRoot("bad1-repo"),
    };
    const badFolder2: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b2.ts"],
      connectedAtMs: NOW,
      root: tempRoot("bad2-repo"),
    };
    const chatId = makeHybridChat(
      [badFolder1, badFolder2],
      [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }],
    );

    const badPackMap = new Map<string, ConnectedContextPack>([
      ["src/b1.ts", { ...folderPack("src/b1.ts", 0.5, "b1-atom"), stableId: "" }],
      ["src/b2.ts", { ...folderPack("src/b2.ts", 0.5, "b2-atom"), stableId: "" }],
    ]);

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Connector only?" })),
      hybridDeps(),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(badPackMap),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer(),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.citations).toHaveLength(0);
    expect(answer.knowledgeCitations.some((kc) => kc.source?.startsWith(`${connLabel} / `))).toBe(
      true,
    );
    expect(answer.uncertainty.filter((u) => u.kind === "pack-validation-failed").length).toBe(2);
  });
});

// ─── Case 3d: a per-folder EmbeddingAdapterError is skipped (graceful), other errors propagate ──
//
// Mirrors the connector path (Case 3b / retrieveOneConnector): a folder whose embedding adapter is
// unavailable is skipped (reason "embedding-unavailable") so the remaining folders + connectors
// still answer. EVERY OTHER folder error propagates to the boundary for map+redact — ProviderError
// -> 502, generic -> 500, ClarificationNeededError -> 400 — covered by grounded-qa.error-redaction
// .test.ts and the GRD-016 test above. (Silently dropping a folder on a hard error would return a
// misleadingly "complete" answer, so only the recoverable embedding outage is skipped.)

describe("hybrid grounded ask — folder EmbeddingAdapterError is skipped, not aborted", () => {
  it("1 embedding-unavailable folder + 1 healthy folder + 1 connector → 200 with healthy-folder and connector citations, embedding-unavailable in uncertainty", async () => {
    const { capsuleId: capId, label: connLabel } = await seedReadyCapsule("ThrowSkip Connector");

    const goodFolderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/healthy.ts"],
      connectedAtMs: NOW,
      root: tempRoot("healthy-repo"),
    };
    const throwFolderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/throwing.ts"],
      connectedAtMs: NOW,
      root: tempRoot("throwing-repo"),
    };
    const chatId = makeHybridChat(
      [goodFolderScope, throwFolderScope],
      [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }],
    );

    const packMap = new Map<string, ConnectedContextPack>([
      ["src/healthy.ts", folderPack("src/healthy.ts", 0.8, "healthy-atom")],
    ]);
    // Retriever: succeeds for "src/healthy.ts", throws for "src/throwing.ts".
    const throwingFolderRetriever: GroundedRetriever = (
      input: OrchestratorInput,
    ): Promise<RetrievalOnlyOutput> => {
      const key = input.scope.relativePaths[0] ?? "";
      if (key === "src/throwing.ts") {
        return Promise.reject(
          new EmbeddingAdapterError({
            status: 503,
            body: { error: { code: "EMBEDDING_UNAVAILABLE", message: "embedding adapter down" } },
          }),
        );
      }
      const pack = packMap.get(key);
      if (pack === undefined) return Promise.reject(new Error(`No fixture pack for path: ${key}`));
      return Promise.resolve({ pack, elapsedMs: 9, plan: { state: "ready" } as never });
    };

    const hybrid: HybridSeam = {
      folderRetriever: throwingFolderRetriever,
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: sentinelAnswerer(),
    };

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is healthy?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    // Must be 200 — the throwing folder is skipped, not propagated.
    // mutation: removing the try/catch in retrieveFolderPacks → the throw escapes → 500
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);

    // Healthy folder citations must be present (retrieval for that folder succeeded).
    // mutation: if the catch also drops the healthy folder, citations would be empty
    expect(answer.citations.some((c) => c.source === "healthy-repo")).toBe(true);

    // Throwing folder must NOT appear in citations.
    expect(answer.citations.some((c) => c.source === "throwing-repo")).toBe(false);

    // Connector citations must be present (connectors are unaffected by folder errors).
    expect(answer.knowledgeCitations.some((kc) => kc.source?.startsWith(`${connLabel} / `))).toBe(
      true,
    );

    // Skipped folder surfaces in uncertainty as "embedding-unavailable" (same as the connector path).
    // mutation: rethrowing EmbeddingAdapterError instead of skipping → 502/500, no skip entry.
    const skipEntries = answer.uncertainty.filter((u) => u.kind === "embedding-unavailable");
    expect(skipEntries.length).toBeGreaterThan(0);
  });

  it("all folders embedding-unavailable + 1 connector → 200 from connector alone with embedding-unavailable skips", async () => {
    const { capsuleId: capId, label: connLabel } = await seedReadyCapsule(
      "ThrowSkip Only Connector",
    );
    const throwFolder1: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/err1.ts"],
      connectedAtMs: NOW,
      root: tempRoot("err1-repo"),
    };
    const throwFolder2: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/err2.ts"],
      connectedAtMs: NOW,
      root: tempRoot("err2-repo"),
    };
    const chatId = makeHybridChat(
      [throwFolder1, throwFolder2],
      [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }],
    );

    const alwaysThrowRetriever: GroundedRetriever = (): Promise<RetrievalOnlyOutput> =>
      Promise.reject(
        new EmbeddingAdapterError({
          status: 503,
          body: { error: { code: "EMBEDDING_UNAVAILABLE", message: "embedding adapter down" } },
        }),
      );

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Connector only from throw?" })),
      hybridDeps(),
      undefined,
      undefined,
      {
        folderRetriever: alwaysThrowRetriever,
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer(),
      },
    );

    // mutation: reverting the try/catch makes this 500
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.citations).toHaveLength(0);
    expect(answer.knowledgeCitations.some((kc) => kc.source?.startsWith(`${connLabel} / `))).toBe(
      true,
    );
    expect(answer.uncertainty.filter((u) => u.kind === "embedding-unavailable").length).toBe(2);
  });
});

// ─── Case 4a: Folders-only must NOT reach the hybrid branch ──────────────────

describe("AC5 routing — folders-only must not invoke hybrid.answer", () => {
  it("routes a single-folder chat through the connected-context path and never calls hybrid.answer", async () => {
    // Arrange: 1 connectedScope, 0 localKnowledgeScopes.
    // The dispatch at handleGroundedAsk takes the folder branch (connectorCount === 0).
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/app.ts"],
      connectedAtMs: NOW,
      root: tempRoot("myapp"),
    };
    const chatId = makeHybridChat([folderScope], []);

    // A throwing hybrid.answer proves the hybrid branch is never entered.
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(new Map()),
      answer: throwingHybridAnswerer(),
    };

    // A real runner for the single-folder path — injected via the `runner` param.
    const singlePack = folderPack("src/app.ts", 0.6, "app-atom");
    let singleRunnerInvoked = false;
    const singleRunner: GroundedRunner = (_input: OrchestratorInput) => {
      singleRunnerInvoked = true;
      return Promise.resolve({
        pack: singlePack,
        assistantContent: "folder-only answer",
        elapsedMs: 5,
      });
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What is in app.ts?" })),
      hybridDeps(),
      singleRunner,
      undefined,
      hybrid,
    );

    // Assert: 200 from the connected-context path (hybrid path would throw)
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    // Single-source runner was invoked — confirms the folder path was taken
    // mutation: if the dispatch condition is inverted, singleRunnerInvoked stays false
    expect(singleRunnerInvoked).toBe(true);

    // Result must NOT be a hybrid answer
    // mutation: if hybrid dispatch runs instead, groundingKind would be "hybrid"
    const answer = result.body as GroundedAnswer;
    expect(answer.groundingKind).toBe("connected-context");
  });
});

// ─── Case 4b: Single connector (no folders) routes to local-knowledge, not hybrid ──

describe("AC5 routing — single connector must route to handleLocalKnowledgeGroundedAsk", () => {
  it("routes a single-localKnowledgeScope chat to local-knowledge groundingKind, not hybrid", async () => {
    // Arrange: exactly 1 connector, 0 folders.
    // handleGroundedAsk dispatches to handleLocalKnowledgeGroundedAsk (folderScopes.length===0 + connectorCount===1).
    const { capsuleId: capId } = await seedReadyCapsule("Solo Docs");
    const chatId = makeHybridChat([], [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }]);

    // A throwing hybrid.answer proves the hybrid branch is never entered.
    const hybrid: HybridSeam = {
      answer: throwingHybridAnswerer(),
    };

    // The single-connector path requires a real model port (not injected as a hybrid seam).
    // We provide a full config with the chat model + embedding model so capability resolution passes.
    const embeddingModelId = "text-embedding-3-small"; // matches seedCapsuleWithVectors default
    const adapter = scriptedAdapter();
    const fakeModelPort: ModelPort = {
      call: () =>
        Promise.resolve({
          modelId: CHAT_MODEL,
          content: "Local knowledge answer [1].",
          finishReason: "stop" as const,
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "lk-test",
            promptTokens: 10,
            completionTokens: 5,
            latencyMs: 5,
            costClass: "medium" as const,
          },
        }),
    };
    const configuredDeps: UiHandlerDeps = {
      ...hybridDeps({ localKnowledgeEmbeddingRequest: adapter.request }),
      config: {
        providers: [
          {
            modelId: CHAT_MODEL,
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
            id: CHAT_MODEL,
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
      modelPortFactory: () => fakeModelPort,
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Solo question", modelId: CHAT_MODEL })),
      configuredDeps,
      undefined,
      undefined,
      hybrid,
    );

    // Assert: local-knowledge path returns 200 with groundingKind "local-knowledge"
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as GroundedAnswer;

    // mutation: if the dispatch condition (folderScopes.length===0 && connectorCount===1) is
    // removed or inverted, the hybrid path is taken and groundingKind would be "hybrid"
    expect(answer.groundingKind).toBe("local-knowledge");

    // Type narrowing confirms we got the right answer shape (throws if wrong groundingKind)
    const lkAnswer = asLocalKnowledge(answer);
    expect(lkAnswer.contextPack.kind).toBe("local-knowledge");
  });
});

// ─── Case 4c: Configured model reranker over hybrid candidates ────────────────

describe("hybrid model reranker", () => {
  it("reorders the preliminary candidate pool before prompt and citation assembly", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Rerank Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/rerank.ts"],
      connectedAtMs: NOW,
      root: tempRoot("rerank-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([["src/rerank.ts", folderPack("src/rerank.ts", 0.5, "rerank-atom")]]);
    const seenUsers: string[] = [];

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Rerank the evidence?" })),
      hybridDeps({
        config: rerankerGatewayConfig(),
        configPresent: true,
        rerankRequest: (request) => {
          expect(request.modelId).toBe("qwen3-reranker");
          expect(request.topN).toBe(16);
          expect(request.documents).toHaveLength(2);
          return Promise.resolve(successfulRerank([1, 0]));
        },
      }),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: (_system, user) => {
          seenUsers.push(user);
          return Promise.resolve("Reranked hybrid answer [1] [2].");
        },
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.citations[0]?.marker).toBe(1);
    expect(answer.knowledgeCitations[0]?.marker).toBe("[2]");
    expect((seenUsers[0] ?? "").indexOf("[1] ### Folder source")).toBeLessThan(
      (seenUsers[0] ?? "").indexOf("[2] ### Connector source"),
    );
    expect(answer.contextPack.reranker).toMatchObject({
      status: "applied",
      candidateCount: 2,
      documentCount: 2,
      keptCount: 2,
    });
    expect(answer.retrievalActivity?.pods[0]?.modes).toContain("reranked");
  });

  it("does not call the configured reranker when connector policy denies external reranking", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Denied Rerank Docs", {
      modelUsePolicy: modelUsePolicyDenying("externalReranking"),
    });
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/rerank-denied.ts"],
      connectedAtMs: NOW,
      root: tempRoot("rerank-denied-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([
      ["src/rerank-denied.ts", folderPack("src/rerank-denied.ts", 0.5, "rerank-denied-atom")],
    ]);
    let rerankCalls = 0;

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Should rerank run?" })),
      hybridDeps({
        config: rerankerGatewayConfig(),
        configPresent: true,
        rerankRequest: () => {
          rerankCalls += 1;
          return Promise.resolve(successfulRerank([1, 0]));
        },
      }),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer("Policy-denied rerank fallback answer [1] [2]."),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(rerankCalls).toBe(0);
    expect(answer.contextPack.reranker).toMatchObject({
      status: "denied",
      mode: "local-only",
      failureKind: "policy-denied",
      candidateCount: 2,
      keptCount: 2,
    });
    expect(answer.retrievalActivity?.pods[0]?.reasonCodes).toContain("policy-denied");
  });

  it("falls back to the preliminary order when the configured reranker times out", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Timeout Rerank Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/rerank-timeout.ts"],
      connectedAtMs: NOW,
      root: tempRoot("rerank-timeout-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([
      ["src/rerank-timeout.ts", folderPack("src/rerank-timeout.ts", 0.5, "rerank-timeout-atom")],
    ]);

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Timeout fallback?" })),
      hybridDeps({
        config: rerankerGatewayConfig(),
        configPresent: true,
        rerankRequest: () => Promise.resolve({ ok: false, kind: "timeout" }),
      }),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer("Fallback answer [1] [2]."),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.knowledgeCitations[0]?.marker).toBe("[1]");
    expect(answer.contextPack.reranker).toMatchObject({
      status: "unavailable",
      mode: "provider-backed",
      failureKind: "timeout",
      candidateCount: 2,
      documentCount: 2,
      keptCount: 2,
    });
    expect(answer.retrievalActivity?.pods[0]).toMatchObject({
      state: "degraded",
      reasonCodes: ["searched", "reranker-unavailable"],
    });
  });

  it("falls back with invalid-response diagnostics when reranker response is unusable", async () => {
    const { capsuleId: capId } = await seedReadyCapsule("Invalid Rerank Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/rerank-invalid.ts"],
      connectedAtMs: NOW,
      root: tempRoot("rerank-invalid-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);
    const packMap = new Map([
      ["src/rerank-invalid.ts", folderPack("src/rerank-invalid.ts", 0.5, "rerank-invalid-atom")],
    ]);

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Invalid fallback?" })),
      hybridDeps({
        config: rerankerGatewayConfig(),
        configPresent: true,
        rerankRequest: () => Promise.resolve({ ok: false, kind: "invalid-response" }),
      }),
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer("Invalid fallback answer [1] [2]."),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);
    expect(answer.contextPack.reranker).toMatchObject({
      status: "invalid-response",
      mode: "provider-backed",
      failureKind: "invalid-response",
      keptCount: 2,
    });
  });
});

// ─── Case 5: RRF anti-dominance — high-rank connector beats low-rank folder ───
//
// A connector ranked 1st among connectors receives the same RRF score as a folder ranked 1st
// among folders: 1/(60+1). Tie-break rule: connector wins. So when both engines produce exactly
// one candidate each, the connector must get marker=1 and the folder must get marker=2.
// Dropping the tiebreak rule would swap them and fail the marker assertions.

describe("RRF anti-dominance — connector selected above folder at equal fused score", () => {
  it("assigns marker=1 to the connector and marker=2 to the folder when both rank 1st in their engine", async () => {
    // Arrange: folder score=0.5 (rank 1 among folders); connector score=0.5 (rank 1 among connectors).
    // Both get RRF score 1/(60+1). Tie-break: connector wins → connector marker=1, folder marker=2.
    const { capsuleId: capId, label: connectorLabel } = await seedReadyCapsule("Tie Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/tie.ts"],
      connectedAtMs: NOW,
      root: tempRoot("tie-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);

    const packMap = new Map([["src/tie.ts", folderPack("src/tie.ts", 0.5, "tie-atom")]]);
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: sentinelAnswerer(),
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Tie question?" })),
      hybridDeps(),
      undefined,
      undefined,
      hybrid,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);

    // Connector citation uses marker [1] (wins the tiebreak)
    // mutation: swapping connector/folder tiebreak → connector gets [2] and this fails
    expect(answer.knowledgeCitations.length).toBeGreaterThan(0);
    expect(answer.knowledgeCitations[0]?.marker).toBe("[1]");

    // Folder citation uses marker 2 (loses the tiebreak)
    // mutation: swapping connector/folder tiebreak → folder gets marker=1 and this fails
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations[0]?.marker).toBe(2);

    // Both citation arrays still non-empty and source-tagged — the shared budget keeps both
    expect(answer.citations[0]?.source).toBe("tie-repo");
    expect(answer.knowledgeCitations[0]?.source?.startsWith(`${connectorLabel} / `)).toBe(true);
  });
});

// ─── Case 6: Shared byte budget excludes oversized evidence ───────────────────
//
// When hybridMaxExcerptBytes is smaller than every candidate's redacted excerpt, every candidate is
// excluded and the route returns a deterministic no-evidence answer without calling the model. This
// proves the shared byte budget governs BOTH engines and has no single-candidate floor.

describe("shared byte budget — oversized evidence fails closed", () => {
  it("returns no evidence when every candidate exceeds the shared byte budget", async () => {
    // Arrange: folder excerpt = "evidence for src/big.ts" (23 bytes).
    // Set hybridMaxExcerptBytes=10 via config.grounding so neither the folder excerpt nor the
    // connector excerpt fits. hybridMaxCandidates=2 so the byte budget alone gates both out.
    const { capsuleId: capId } = await seedReadyCapsule("Budget Docs");
    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/big.ts"],
      connectedAtMs: NOW,
      root: tempRoot("budget-repo"),
    };
    const connectorScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: capId,
      connectedAtMs: NOW,
    };
    const chatId = makeHybridChat([folderScope], [connectorScope]);

    const packMap = new Map([["src/big.ts", folderPack("src/big.ts", 0.5, "big-atom")]]);
    // Config with a tight byte budget: connector (0 bytes) fits; folder (23 bytes) does not.
    const budgetDeps = hybridDeps({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        grounding: {
          maxConnectedSources: 16,
          maxLocalKnowledgeSources: 16,
          maxPromptReferences: 8,
          maxExcerptChars: 900,
          referenceBudget: 10,
          hybridMaxCandidates: 2,
          hybridMaxExcerptBytes: 10,
        },
      },
      configPresent: true,
    });
    const answererCalls = { count: 0 };
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: sentinelAnswerer(undefined, answererCalls),
    };

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Budget question?" })),
      budgetDeps,
      undefined,
      undefined,
      hybrid,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = asHybrid(result.body as GroundedAnswer);

    expect(answer.content).toBe("No evidence found in the selected connected sources.");
    expect(answer.citations).toHaveLength(0);
    expect(answer.knowledgeCitations).toHaveLength(0);
    expect(answer.uncertainty.some((u) => u.kind === "no-evidence")).toBe(true);
    expect(answererCalls.count).toBe(0);

    // referencesUsed ≤ referenceBudget invariant holds even under a tight budget
    expect(answer.contextPack.knowledge.referencesUsed).toBeLessThanOrEqual(
      answer.contextPack.knowledge.referenceBudget,
    );
  });
});

// ─── Case 7: Ask-path source cap (defense-in-depth, #963) ────────────────────
//
// A chat row with more sources than maxConnectedSources / maxLocalKnowledgeSources (e.g. legacy
// Altbestand after operator lowered the limit, or a direct DB edit) must be capped in the ask path
// before any retrieval loop. These tests verify:
//   (a) Folder scopes beyond maxConnectedSources are never explored.
//   (b) Connector scopes beyond maxLocalKnowledgeSources are never retrieved.
//   (c) At-limit counts pass through unmodified (no regression for normal chats).
//   (d) Over-cap sources produce "source-skipped" uncertainty entries.

describe("ask-path source cap — folders capped at maxConnectedSources", () => {
  it("explores only limit-many folder scopes when the chat carries more than maxConnectedSources", async () => {
    // Arrange: limit=2 folders; chat carries 3. Only the first 2 should be retrieved.
    const { capsuleId: capId } = await seedReadyCapsule("Cap Folder Connector");

    const folderA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("cap-a"),
    };
    const folderB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("cap-b"),
    };
    const folderC: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/c.ts"],
      connectedAtMs: NOW,
      root: tempRoot("cap-c"),
    };
    const chatId = makeHybridChat(
      [folderA, folderB, folderC],
      [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }],
    );

    // Track which pack keys the retriever was asked for
    const retrievedKeys: string[] = [];
    const packMap = new Map([
      ["src/a.ts", folderPack("src/a.ts", 0.9, "a-atom")],
      ["src/b.ts", folderPack("src/b.ts", 0.8, "b-atom")],
      ["src/c.ts", folderPack("src/c.ts", 0.7, "c-atom")],
    ]);
    const trackingRetriever: GroundedRetriever = (input: OrchestratorInput) => {
      const key = input.scope.relativePaths[0] ?? "";
      retrievedKeys.push(key);
      const pack = packMap.get(key);
      if (pack === undefined) throw new Error(`No fixture pack for path: ${key}`);
      return Promise.resolve({ pack, elapsedMs: 5, plan: { state: "ready" } as never });
    };

    // Set maxConnectedSources=2 via config.grounding
    const capDeps = hybridDeps({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        grounding: {
          maxConnectedSources: 2,
          maxLocalKnowledgeSources: 16,
          maxPromptReferences: 8,
          maxExcerptChars: 900,
          referenceBudget: 10,
          hybridMaxCandidates: 20,
          hybridMaxExcerptBytes: 100_000,
        },
      },
      configPresent: true,
    });

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What are a, b, c?" })),
      capDeps,
      undefined,
      undefined,
      {
        folderRetriever: trackingRetriever,
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer(),
      },
    );

    // Assert
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    // Only folder A and B were explored — folder C is beyond the cap of 2
    // mutation: removing the slice → retrievedKeys would contain "src/c.ts"
    expect(retrievedKeys).toEqual(["src/a.ts", "src/b.ts"]);
    expect(retrievedKeys).not.toContain("src/c.ts");

    // The over-cap folder must appear as a "source-skipped" uncertainty entry
    // mutation: removing overCapFolderSkipped merging → no source-skipped entry for cap-c
    const answer = result.body as { uncertainty?: readonly { kind: string }[] };
    const skipped = (answer.uncertainty ?? []).filter((u) => u.kind === "source-skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });

  it("passes through exactly limit-many folder scopes unmodified (no regression at limit)", async () => {
    // Arrange: limit=2 folders; chat carries exactly 2. Both should be retrieved.
    const { capsuleId: capId } = await seedReadyCapsule("At Limit Connector");

    const folderA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/at-a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("at-limit-a"),
    };
    const folderB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/at-b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("at-limit-b"),
    };
    const chatId = makeHybridChat(
      [folderA, folderB],
      [{ kind: "capsule", capsuleId: capId, connectedAtMs: NOW }],
    );

    const retrievedKeys: string[] = [];
    const packMap = new Map([
      ["src/at-a.ts", folderPack("src/at-a.ts", 0.9, "at-a-atom")],
      ["src/at-b.ts", folderPack("src/at-b.ts", 0.8, "at-b-atom")],
    ]);
    const trackingRetriever: GroundedRetriever = (input: OrchestratorInput) => {
      const key = input.scope.relativePaths[0] ?? "";
      retrievedKeys.push(key);
      const pack = packMap.get(key);
      if (pack === undefined) throw new Error(`No fixture pack for path: ${key}`);
      return Promise.resolve({ pack, elapsedMs: 5, plan: { state: "ready" } as never });
    };

    const capDeps = hybridDeps({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        grounding: {
          maxConnectedSources: 2,
          maxLocalKnowledgeSources: 16,
          maxPromptReferences: 8,
          maxExcerptChars: 900,
          referenceBudget: 10,
          hybridMaxCandidates: 20,
          hybridMaxExcerptBytes: 100_000,
        },
      },
      configPresent: true,
    });

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "At limit?" })),
      capDeps,
      undefined,
      undefined,
      {
        folderRetriever: trackingRetriever,
        connectorRetrieve: singleConnectorRetrieve(capId),
        answer: sentinelAnswerer(),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);

    // Both folders retrieved — no over-cap pruning at exactly the limit
    // mutation: off-by-one in the slice → one folder would be dropped
    expect(retrievedKeys).toEqual(["src/at-a.ts", "src/at-b.ts"]);
  });
});

describe("ask-path source cap — connectors capped at maxLocalKnowledgeSources", () => {
  it("retrieves only limit-many connectors when the chat carries more than maxLocalKnowledgeSources", async () => {
    // Arrange: limit=2 connectors; chat carries 3. Only the first 2 should be retrieved.
    const { capsuleId: capA, label: labelA } = await seedReadyCapsule("Cap Con A");
    const { capsuleId: capB, label: labelB } = await seedReadyCapsule("Cap Con B");
    const { capsuleId: capC } = await seedReadyCapsule("Cap Con C");

    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/cap-con.ts"],
      connectedAtMs: NOW,
      root: tempRoot("cap-con-repo"),
    };
    const chatId = makeHybridChat(
      [folderScope],
      [
        { kind: "capsule", capsuleId: capA, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: capB, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: capC, connectedAtMs: NOW },
      ],
    );

    const packMap = new Map([
      ["src/cap-con.ts", folderPack("src/cap-con.ts", 0.5, "cap-con-atom")],
    ]);

    // Track which capsules were retrieved
    const retrievedCapsules: string[] = [];
    const trackingConnectorRetrieve: ConnectorRetrieve = (
      _store,
      scope,
    ): Promise<RetrievalResult> => {
      const cid = scope.kind === "capsule" ? String(scope.capsuleId) : "?";
      retrievedCapsules.push(cid);
      return Promise.resolve({
        references: [
          connectorReference(
            scope.kind === "capsule" ? scope.capsuleId : capA,
            1,
            `doc-from-${cid}`,
          ),
        ],
        noEvidence: false,
      });
    };

    const capDeps = hybridDeps({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        grounding: {
          maxConnectedSources: 16,
          maxLocalKnowledgeSources: 2,
          maxPromptReferences: 8,
          maxExcerptChars: 900,
          referenceBudget: 10,
          hybridMaxCandidates: 20,
          hybridMaxExcerptBytes: 100_000,
        },
      },
      configPresent: true,
    });

    // Act
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "What do A, B, C say?" })),
      capDeps,
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: trackingConnectorRetrieve,
        answer: sentinelAnswerer(),
      },
    );

    // Assert
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    // Capsule C must NOT have been retrieved — it is beyond the connector cap of 2
    // mutation: removing the connector slice → capC would appear in retrievedCapsules
    expect(retrievedCapsules).not.toContain(String(capC));
    expect(retrievedCapsules).toHaveLength(2);

    // Both A and B citations present; C must not appear
    const answer = result.body as HybridGroundedAnswer;
    const kciLabels = answer.knowledgeCitations.map((kc) => kc.source ?? "");
    expect(kciLabels.some((l) => l.startsWith(`${labelA} / `))).toBe(true);
    expect(kciLabels.some((l) => l.startsWith(`${labelB} / `))).toBe(true);
    expect(kciLabels.some((l) => l.includes("Cap Con C"))).toBe(false);

    // Over-cap connector must appear as a "source-skipped" uncertainty entry
    // mutation: removing overCapConnectorSkipped merging → no source-skipped entry for connector-2
    const skipped = answer.uncertainty.filter((u) => u.kind === "source-skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });

  it("passes through exactly limit-many connectors unmodified (no regression at limit)", async () => {
    // Arrange: limit=2 connectors; chat carries exactly 2. Both should be retrieved.
    const { capsuleId: capA, label: labelA } = await seedReadyCapsule("At Lim Con A");
    const { capsuleId: capB, label: labelB } = await seedReadyCapsule("At Lim Con B");

    const folderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/at-lim.ts"],
      connectedAtMs: NOW,
      root: tempRoot("at-lim-repo"),
    };
    const chatId = makeHybridChat(
      [folderScope],
      [
        { kind: "capsule", capsuleId: capA, connectedAtMs: NOW },
        { kind: "capsule", capsuleId: capB, connectedAtMs: NOW },
      ],
    );

    const packMap = new Map([["src/at-lim.ts", folderPack("src/at-lim.ts", 0.5, "at-lim-atom")]]);
    const retrievedCapsules: string[] = [];
    const trackingConnectorRetrieve: ConnectorRetrieve = (
      _store,
      scope,
    ): Promise<RetrievalResult> => {
      const cid = scope.kind === "capsule" ? String(scope.capsuleId) : "?";
      retrievedCapsules.push(cid);
      return Promise.resolve({
        references: [
          connectorReference(
            scope.kind === "capsule" ? scope.capsuleId : capA,
            1,
            `doc-from-${cid}`,
          ),
        ],
        noEvidence: false,
      });
    };

    const capDeps = hybridDeps({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        grounding: {
          maxConnectedSources: 16,
          maxLocalKnowledgeSources: 2,
          maxPromptReferences: 8,
          maxExcerptChars: 900,
          referenceBudget: 10,
          hybridMaxCandidates: 20,
          hybridMaxExcerptBytes: 100_000,
        },
      },
      configPresent: true,
    });

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "At connector limit?" })),
      capDeps,
      undefined,
      undefined,
      {
        folderRetriever: folderRetrieverFor(packMap),
        connectorRetrieve: trackingConnectorRetrieve,
        answer: sentinelAnswerer(),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);

    // Both connectors retrieved — no over-cap pruning at exactly the limit
    // mutation: off-by-one in the slice → one connector dropped
    expect(retrievedCapsules).toHaveLength(2);
    const answer = result.body as HybridGroundedAnswer;
    const kciLabels = answer.knowledgeCitations.map((kc) => kc.source ?? "");
    expect(kciLabels.some((l) => l.startsWith(`${labelA} / `))).toBe(true);
    expect(kciLabels.some((l) => l.startsWith(`${labelB} / `))).toBe(true);
  });
});

describe("ask-path source cap — combined folder and connector total", () => {
  it("retrieves only the combined cap when a persisted chat carries 10 folders and 10 connectors", async () => {
    const seededCapsules: { readonly capsuleId: KnowledgeCapsuleId; readonly label: string }[] = [];
    for (let index = 0; index < 10; index += 1) {
      seededCapsules.push(await seedReadyCapsule(`Combined Cap ${String(index)}`));
    }
    const folders: ChatConnectedScope[] = Array.from({ length: 10 }, (_unused, index) => ({
      kind: "directory",
      relativePaths: [`src/combined-${String(index)}.ts`],
      connectedAtMs: NOW + index,
      root: tempRoot(`combined-folder-${String(index)}`),
    }));
    const connectors: ChatLocalKnowledgeScope[] = seededCapsules.map((seeded, index) => ({
      kind: "capsule",
      capsuleId: seeded.capsuleId,
      connectedAtMs: NOW + 10 + index,
    }));
    const project = store.createProject(tmp, "combined-cap-legacy");
    const chat = store.createChat(project.path, "Combined cap legacy", CHAT_MODEL);
    const legacyLimits = { maxConnectedSources: 20, maxLocalKnowledgeSources: 20 };
    store.updateChat(chat.id, { connectedScopes: folders }, legacyLimits);
    store.updateChat(chat.id, { localKnowledgeScopes: connectors }, legacyLimits);
    const chatId = chat.id;

    const retrievedFolders: string[] = [];
    const packMap = new Map(
      folders.map((folder, index) => [
        folder.relativePaths[0] ?? "",
        folderPack(folder.relativePaths[0] ?? "", 0.9 - index / 100, `combined-${String(index)}`),
      ]),
    );
    const trackingRetriever: GroundedRetriever = (input: OrchestratorInput) => {
      const key = input.scope.relativePaths[0] ?? "";
      retrievedFolders.push(key);
      const pack = packMap.get(key);
      if (pack === undefined) throw new Error(`No fixture pack for path: ${key}`);
      return Promise.resolve({ pack, elapsedMs: 5, plan: { state: "ready" } as never });
    };

    const retrievedConnectors: string[] = [];
    const trackingConnectorRetrieve: ConnectorRetrieve = (
      _store,
      scope,
    ): Promise<RetrievalResult> => {
      if (scope.kind !== "capsule") {
        return Promise.resolve({ references: [], noEvidence: true, reason: "no-scope" });
      }
      retrievedConnectors.push(String(scope.capsuleId));
      return Promise.resolve({
        references: [connectorReference(scope.capsuleId, 1, `doc-${String(scope.capsuleId)}`)],
        noEvidence: false,
      });
    };

    const capDeps = hybridDeps({
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        grounding: {
          maxConnectedSources: 16,
          maxLocalKnowledgeSources: 16,
          maxPromptReferences: 8,
          maxExcerptChars: 900,
          referenceBudget: 10,
          hybridMaxCandidates: 24,
          hybridMaxExcerptBytes: 100_000,
        },
      },
      configPresent: true,
    });

    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "Combined cap?" })),
      capDeps,
      undefined,
      undefined,
      {
        folderRetriever: trackingRetriever,
        connectorRetrieve: trackingConnectorRetrieve,
        answer: sentinelAnswerer(),
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(retrievedFolders).toHaveLength(10);
    expect(retrievedConnectors).toHaveLength(6);
    expect(retrievedFolders.length + retrievedConnectors.length).toBe(16);
    expect(retrievedConnectors).not.toContain(String(seededCapsules[6]?.capsuleId));

    const answer = asHybrid(result.body as GroundedAnswer);
    const skipped = answer.uncertainty.filter((u) => u.kind === "source-skipped");
    expect(skipped).toHaveLength(4);
    expect(answer.contextPack.folderSourceCount).toBe(10);
    expect(answer.contextPack.connectorSourceCount).toBe(10);
  });
});
