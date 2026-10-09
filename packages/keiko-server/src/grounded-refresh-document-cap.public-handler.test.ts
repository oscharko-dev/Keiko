import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createRepositoryPodShell,
  openKnowledgeStore,
  readRepositoryFileFingerprints,
  refreshRepositoryPod,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  EMBEDDING_INSTRUCTION_VERSION,
  parseGatewayConfig,
  verifyEmbeddingCapability,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { configuredGroundedSemanticRequest } from "./grounded-semantic-request.js";
import type { GroundedSemanticRequest } from "./grounded-semantic-request.js";

const CHAT = "refresh-document-chat";
const EMBEDDING = "refresh-document-embedding";
const DIRECTORY = Array.from({ length: 50 }, (_, index) => `section-${String(index)}`).join("/");
const PATHS = Array.from({ length: 8 }, (_, index) => `${DIRECTORY}/renew-${String(index)}.ts`);
let root = "";
let stateDir = "";
const disposals: UiHandlerDeps[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-refresh-document-cap-")));
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-refresh-document-state-")));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  for (const source of ["alpha", "beta"]) {
    for (const path of PATHS) {
      mkdirSync(dirname(join(root, source, path)), { recursive: true });
      writeFileSync(join(root, source, path), "export const renewal = 'old';\n");
    }
  }
});

afterEach(async () => {
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function embedding(request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> {
  return Promise.resolve({
    ok: true,
    value: { vector: new Float32Array([1, 0]), modelId: request.modelId },
  });
}

function runtime(cap: number, transport: typeof embedding): UiHandlerDeps {
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: { KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX: String(cap) },
  });
  disposals.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [CHAT, EMBEDDING].map((modelId) => ({
        modelId,
        baseUrl: "https://refresh-document.example.invalid/v1",
        apiKey: "fixture",
        maxRetries: 0,
      })),
      capabilities: [
        { ...createDefaultChatCapability(CHAT), contextWindow: 65_536, maxOutputTokens: 512 },
        createDefaultEmbeddingCapability(EMBEDDING),
      ],
    }),
    true,
  );
  deps.gatewayConfig?.recordVerifiedCapability(
    CHAT,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
  return { ...deps, localKnowledgeEmbeddingRequest: transport };
}

async function seedPod(
  store: ReturnType<typeof openKnowledgeStore>,
  source: string,
  identity: Parameters<typeof createRepositoryPodShell>[1]["embeddingModelIdentity"],
): Promise<void> {
  const capsuleId = `refresh-${source}` as KnowledgeCapsuleId;
  const sourceId = `source-${source}` as KnowledgeSourceId;
  createRepositoryPodShell(
    { store, capsuleId, sourceId },
    {
      displayName: `Refresh ${source}`,
      repositoryRoot: join(root, source),
      embeddingModelIdentity: identity,
    },
  );
  await refreshRepositoryPod(
    {
      store,
      capsuleId,
      sourceId,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter: {
        endpoint: "https://refresh-document.example.invalid/v1",
        apiKey: "fixture",
        request: embedding,
      },
      workspaceFs: nodeWorkspaceFs,
      trackedPaths: new Set(PATHS),
      discoveryOptions: { maxDepth: 64, maxFiles: 32 },
    },
    { runId: `seed-${source}` },
  );
}

async function persistPods(): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: stateDir }),
  });
  const adapter = {
    endpoint: "https://refresh-document.example.invalid/v1",
    apiKey: "fixture",
    request: embedding,
  };
  const verified = await verifyEmbeddingCapability(adapter, {
    modelId: EMBEDDING,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: 2,
    normalization: "l2",
    instructionVersion: EMBEDDING_INSTRUCTION_VERSION,
    includeSpaceFingerprint: true,
  });
  if (!verified.ok) throw new TypeError("Expected verified fixture embedding identity");
  try {
    for (const source of ["alpha", "beta"]) {
      await seedPod(store, source, verified.identity);
    }
  } finally {
    store.close();
  }
  for (const source of ["alpha", "beta"]) {
    for (const path of PATHS) {
      writeFileSync(
        join(root, source, path),
        "export const renewal = 'session renewal changed';\n",
      );
    }
  }
}

function fingerprints(
  deps: UiHandlerDeps,
): readonly ReturnType<typeof readRepositoryFileFingerprints>[] {
  const { store } = openKnowledgeStoreForDeps(deps);
  try {
    return ["alpha", "beta"].map((source) =>
      readRepositoryFileFingerprints(
        store,
        `refresh-${source}` as KnowledgeCapsuleId,
        `source-${source}` as KnowledgeSourceId,
      ),
    );
  } finally {
    store.close();
  }
}

async function connectKnowledge(deps: UiHandlerDeps, chatId: string): Promise<void> {
  const { store } = openKnowledgeStoreForDeps(deps);
  try {
    const capsule = await seedCapsuleWithVectors(store, { displayName: "Refresh companion" });
    updateCapsuleState(store, capsule.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: capsule.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

function connectFolders(deps: UiHandlerDeps, roots: number): string {
  deps.store.createProject(root, "Refresh documents");
  const chat = deps.store.createChat(root, "Refresh documents", CHAT);
  deps.store.updateChat(chat.id, {
    connectedScopes: ["alpha", "beta"].slice(0, roots).map((source, index) => ({
      root: join(root, source),
      kind: "directory",
      relativePaths: [DIRECTORY],
      connectedAtMs: index,
    })),
  });
  return chat.id;
}

function synthesisTransport(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "refresh-document-proof",
            model: CHAT,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "No evidence found." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );
}

async function invokeTurn(deps: UiHandlerDeps, chatId: string): Promise<void> {
  const result = await handleGroundedAsk(
    {
      params: {},
      correlationId: "refresh-document-cap-proof",
      url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
      req: mockRequest({
        body: JSON.stringify({ chatId, content: "Explain the session renewal implementation." }),
      }),
      res: mockResponse().res,
    },
    deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function turn(
  cap: number,
  roots = 2,
  hybrid = false,
  failDocuments = false,
): Promise<number> {
  const transport = vi.fn((request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
    if (failDocuments && request.input.startsWith("Path: "))
      throw new Error("fixture embedding failure");
    return embedding(request);
  });
  const deps = runtime(cap, transport);
  await persistPods();
  const original = fingerprints(deps);
  expect(original.map((item) => item.size)).toEqual([8, 8]);
  const chatId = connectFolders(deps, roots);
  if (hybrid) await connectKnowledge(deps, chatId);
  synthesisTransport();
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  await invokeTurn(deps, chatId);
  expect(fingerprints(deps)).toEqual(original);
  const documents = transport.mock.calls.filter(([request]) => request.input.startsWith("Path: "));
  const reads = sink.events
    .filter((event) => event.op === "search.connected-context.selection-details")
    .reduce((sum, event) => sum + Number(event.extra?.semanticRefreshReadFileCount ?? 0), 0);
  expect(reads).toBe(documents.length);
  return documents.length;
}

async function repeatedSearch(mode: "healthy" | "denied" | "cancelled"): Promise<number> {
  const transport = vi.fn(embedding);
  const deps = runtime(1, transport);
  await persistPods();
  const lease = configuredGroundedSemanticRequest(deps, join(root, "alpha"));
  const controller = new AbortController();
  const request: GroundedSemanticRequest = {
    fs: nodeWorkspaceFs,
    nowMs: Date.now,
    deadlineAtMs: Date.now() + 5_000,
    correlationId: "refresh-document-repeated-proof",
    signal: controller.signal,
    tryReserveRefreshUsage: () => mode !== "denied",
    observeSemanticFreshness: () => undefined,
  };
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      if (mode === "cancelled") controller.abort();
      const provider = lease.providerFor?.(request);
      await provider?.search({
        query: {
          kind: "natural-language",
          text: "session renewal",
          caseSensitive: false,
          maxResults: 8,
          emittedAtMs: Date.now(),
        },
        documents: PATHS.map((scopePath) => ({
          scopePath,
          text: "export const renewal = 'session renewal changed';\n",
        })),
        signal: controller.signal,
      });
    }
    return transport.mock.calls.filter(([input]) => input.input.startsWith("Path: ")).length;
  } finally {
    lease.close();
  }
}

describe("configured public per-query refresh document cap", () => {
  it.each([1, 8])("shares cap %i across two connected roots", async (cap) => {
    expect(await turn(cap)).toBe(cap);
  });
  it("shares cap one across hybrid folder leases", async () => {
    expect(await turn(1, 2, true)).toBe(1);
  });
  it("keeps disabled refresh closed", async () => {
    expect(await turn(0)).toBe(0);
  });
  it("preserves the healthy single-root allowance", async () => {
    expect(await turn(8, 1)).toBe(8);
  });
  it("does not replenish a permit after failed document embedding", async () => {
    expect(await turn(1, 2, false, true)).toBe(1);
  });
  it("shares one request permit across repeated leases and searches", async () => {
    expect(await repeatedSearch("healthy")).toBe(1);
  });
  it.each(["denied", "cancelled"] as const)("keeps %s refresh closed", async (mode) => {
    expect(await repeatedSearch(mode)).toBe(0);
  });
});
