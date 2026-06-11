// Tests for the hybrid grounded path (Epic #189 Slice 2). Drives `handleGroundedAsk` with
// injected seams (no real embeddings, no real workspace) while keeping a REAL KnowledgeStore so
// `selectedCapsulesForScope` resolves actual capsule rows and `scopeStateFailure` detects not-ready
// states. Every test is mutation-robust: a single-line change in the source — a swapped count, a
// missing `.source` tag, a dropped skip-uncertainty — must make at least one assertion fail.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

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
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
  type RetrievalResult,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  scriptedAdapter,
  seedCapsuleWithVectors,
} from "@oscharko-dev/keiko-local-knowledge/testing";

import { handleGroundedAsk, type GroundedRunner, type HybridSeam } from "./grounded-qa.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GroundedRetriever } from "./grounded-qa-multi-source.js";
import { EmbeddingAdapterError, type ConnectorRetrieve } from "./grounded-qa-hybrid.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import type { OrchestratorInput, RetrievalOnlyOutput } from "./grounded-orchestrator.js";

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

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
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
): Promise<{ capsuleId: KnowledgeCapsuleId; label: string }> {
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName,
    ...seedIds(displayName),
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  knowledgeStore.close();
  return { capsuleId: seeded.capsuleId, label: displayName };
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

// ─── Case 6: Shared byte budget excludes oversized folder excerpt ─────────────
//
// When hybridMaxExcerptBytes is set just below the folder excerpt's byte size, the folder
// candidate is excluded from the selected set while the connector candidate (empty excerpt = 0
// bytes, always fits first) is kept. This proves the shared budget governs BOTH engines and
// that a large folder excerpt cannot crowd out a smaller connector excerpt.

describe("shared byte budget — oversized folder excerpt excluded in favour of connector", () => {
  it("excludes a folder excerpt that exceeds the per-budget cap when a connector excerpt fits", async () => {
    // Arrange: folder excerpt = "evidence for src/big.ts" (23 bytes).
    // Set hybridMaxExcerptBytes=10 via config.grounding so the folder excerpt doesn't fit after
    // the connector. Connector excerpt is "" (no real doc in store) = 0 bytes → selected first
    // (anti-dominance tiebreak). hybridMaxCandidates=2 so both are eligible; the byte budget alone
    // gates the folder out.
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
    const hybrid: HybridSeam = {
      folderRetriever: folderRetrieverFor(packMap),
      connectorRetrieve: singleConnectorRetrieve(capId),
      answer: sentinelAnswerer(),
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

    // Connector citation present (0-byte excerpt fits within 10-byte budget)
    // mutation: removing byte budget enforcement → folder would also appear
    expect(answer.knowledgeCitations.length).toBeGreaterThan(0);

    // Folder citation absent (23-byte excerpt exceeds remaining budget after connector)
    // mutation: removing byte budget enforcement → folder citation appears and length > 0
    expect(answer.citations).toHaveLength(0);

    // referencesUsed ≤ referenceBudget invariant holds even under a tight budget
    expect(answer.contextPack.knowledge.referencesUsed).toBeLessThanOrEqual(
      answer.contextPack.knowledge.referenceBudget,
    );
  });
});
