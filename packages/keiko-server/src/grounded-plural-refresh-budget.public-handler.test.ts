import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createDefaultParserRegistry,
  createRepositoryPodShell,
  openKnowledgeStore,
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
  type GatewayCallRequest,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk, modelWindowAwareBudget } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const CHAT = "refresh-budget-chat";
const EMBEDDING = "refresh-budget-embedding";
const QUESTION = "Explain the session renewal implementation.";
const DIRECTORY = Array.from(
  { length: 50 },
  (_, index) => `section-${String(index).padStart(2, "0")}`,
).join("/");
const FILE = `${DIRECTORY}/renew.ts`;
let root = "";
let stateDir = "";
const disposals: UiHandlerDeps[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-plural-refresh-")));
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-refresh-state-")));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  for (const source of ["alpha", "beta"]) {
    const path = join(root, source, FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export const renewSession = 'old';\n");
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

function embeddingTransport(request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> {
  return Promise.resolve({
    ok: true,
    value: { vector: new Float32Array([1, 0]), modelId: request.modelId },
  });
}

function configuredRuntime(refresh: boolean, maxInputTokens?: number): UiHandlerDeps {
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: {
      KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX: refresh ? "1" : "0",
      [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
      [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.db"),
    },
  });
  disposals.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [CHAT, EMBEDDING].map((modelId) => ({
        modelId,
        baseUrl: "https://refresh-budget.example.invalid/v1",
        apiKey: "fixture",
        maxRetries: 0,
      })),
      capabilities: [
        {
          ...createDefaultChatCapability(CHAT),
          contextWindow: 8192,
          maxOutputTokens: 512,
          ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
        },
        {
          ...createDefaultEmbeddingCapability(EMBEDDING),
          contextWindow: 8192,
          maxOutputTokens: 0,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 0 },
        },
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
  // Only the embedding transport is scripted; lease, refresh governor and spend are production.
  return { ...deps, localKnowledgeEmbeddingRequest: embeddingTransport };
}

async function persistRepositoryPods(): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: stateDir }),
  });
  const adapter: OpenAIEmbeddingAdapter = {
    endpoint: "https://refresh-budget.example.invalid/v1",
    apiKey: "fixture",
    request: embeddingTransport,
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
      const capsuleId = `refresh-${source}` as KnowledgeCapsuleId;
      const sourceId = `source-${source}` as KnowledgeSourceId;
      createRepositoryPodShell(
        { store, capsuleId, sourceId },
        {
          displayName: `Refresh ${source}`,
          repositoryRoot: join(root, source),
          embeddingModelIdentity: verified.identity,
        },
      );
      await refreshRepositoryPod(
        {
          store,
          capsuleId,
          sourceId,
          parserRegistry: createDefaultParserRegistry(),
          embeddingAdapter: adapter,
          workspaceFs: nodeWorkspaceFs,
          trackedPaths: new Set([FILE]),
          discoveryOptions: { maxDepth: 64, maxFiles: 4 },
        },
        { runId: `refresh-seed-${source}` },
      );
    }
  } finally {
    store.close();
  }
  const live = Array.from(
    { length: 27 },
    (_, index) => `export function renewSession${String(index)}() { return 'session renewal'; }\n`,
  ).join("");
  for (const source of ["alpha", "beta"]) writeFileSync(join(root, source, FILE), live);
}

async function actualRefreshTurn(
  folderCount: number,
  refresh: boolean,
  hybrid = false,
  maxInputTokens?: number,
  expectedStatus = 200,
): Promise<{
  readonly answer: GroundedAnswer;
  readonly calls: readonly GatewayCallRequest[];
  readonly refreshInput: readonly number[];
  readonly originalInputMax: number;
}> {
  const deps = configuredRuntime(refresh, maxInputTokens);
  await persistRepositoryPods();
  deps.store.createProject(root, "Refresh budget");
  const chat = deps.store.createChat(root, "Refresh budget", CHAT);
  deps.store.updateChat(chat.id, {
    connectedScopes: ["alpha", "beta"].slice(0, folderCount).map((source, index) => ({
      root: join(root, source),
      kind: "directory",
      relativePaths: [DIRECTORY],
      connectedAtMs: index,
    })),
  });
  if (hybrid) await connectReadyKnowledge(deps, chat.id);
  const calls: GatewayCallRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const request = JSON.parse(
        typeof init?.body === "string" ? init.body : "",
      ) as GatewayCallRequest;
      calls.push(request);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "refresh-budget-proof",
            model: CHAT,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "No evidence found." },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: countGatewayPromptTokens(request),
              completion_tokens: 1,
              total_tokens: countGatewayPromptTokens(request) + 1,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const result = await handleGroundedAsk(
    {
      params: {},
      correlationId: "refresh-budget-public-proof",
      url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
      req: mockRequest({ body: JSON.stringify({ chatId: chat.id, content: QUESTION }) }),
      res: mockResponse().res,
    },
    deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(expectedStatus);
  const refreshInput = sink.events
    .filter((event) => event.op === "search.connected-context.selection-details")
    .map((event) =>
      expectActivityLogProof(
        "search.connected-context.selection-details.line",
        formatActivityLogProofLine(event),
      ),
    )
    .map((event) =>
      typeof event.semanticRefreshInputTokenUpperBound === "number"
        ? event.semanticRefreshInputTokenUpperBound
        : 0,
    );
  return {
    answer: result.body as GroundedAnswer,
    calls,
    refreshInput,
    originalInputMax: modelWindowAwareBudget(deps, CHAT).modelInputTokensMax,
  };
}

function folderInputUsage(answer: GroundedAnswer): number {
  if (answer.groundingKind === "hybrid") return answer.contextPack.folder.usage.modelInputTokens;
  if (answer.groundingKind !== "connected-context") throw new TypeError("Expected folder answer");
  return answer.contextPack.usage.modelInputTokens;
}

async function connectReadyKnowledge(deps: UiHandlerDeps, chatId: string): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: stateDir }),
  });
  try {
    const capsule = await seedCapsuleWithVectors(store, { displayName: "Refresh companions" });
    updateCapsuleState(store, capsule.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: capsule.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

describe("public configured plural semantic refresh and initial synthesis budget", () => {
  it.each([false, true])(
    "refuses an exhausted initial input grant before dispatch (hybrid: %s)",
    async (hybrid) => {
      const turn = await actualRefreshTurn(2, true, hybrid, 512, 502);
      expect(turn.calls).toHaveLength(0);
      expect(turn.answer).toMatchObject({ error: { code: "GATEWAY_CONTEXT_OVERFLOW" } });
    },
  );
  it.each([
    { folderCount: 1, refresh: true, hybrid: false },
    { folderCount: 2, refresh: false, hybrid: false },
    { folderCount: 2, refresh: true, hybrid: false },
    { folderCount: 2, refresh: true, hybrid: true },
  ])(
    "shares the original first-synthesis grant with refresh (%j)",
    async ({ folderCount, refresh, hybrid }) => {
      const turn = await actualRefreshTurn(folderCount, refresh, hybrid);
      expect(turn.calls).toHaveLength(1);
      const refreshInput = turn.refreshInput.reduce((sum, input) => sum + input, 0);
      expect(refreshInput > 0).toBe(refresh);
      const synthesisInput = turn.calls.reduce(
        (sum, call) => sum + countGatewayPromptTokens(call),
        0,
      );
      expect(folderInputUsage(turn.answer)).toBeGreaterThanOrEqual(refreshInput + synthesisInput);
      expect(
        refreshInput + synthesisInput,
        JSON.stringify({
          refreshInput: turn.refreshInput,
          synthesisInput,
          originalInputMax: turn.originalInputMax,
        }),
      ).toBeLessThanOrEqual(turn.originalInputMax);
      expect(folderInputUsage(turn.answer)).toBeLessThanOrEqual(turn.originalInputMax);
    },
  );
});
