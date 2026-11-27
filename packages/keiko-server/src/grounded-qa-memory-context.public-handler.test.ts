import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { MemoryUserId } from "@oscharko-dev/keiko-contracts";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
  type NormalizedResponse,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import {
  CONVERSATION_REMEMBER_MEMORY_OFF_NOTICE,
  CONVERSATION_REMEMBER_MEMORY_UNAVAILABLE_NOTICE,
  CONVERSATION_REMEMBER_REFUSED_NOTICE,
} from "./conversation-prompt.js";
import type { RouteContext } from "./routes.js";
import * as multiSourceQa from "./grounded-qa-multi-source.js";
import { mockRequest, mockResponse } from "./_support.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { memoryEmbeddingProviderIdentity } from "./memory-embedding.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

const MODEL = "memory-source-fixture";
const MEMORY = "Use pnpm for package installs.";
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await setImmediate();
  vi.restoreAllMocks();
  resetServerLogger();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function seedMemory(vault: MemoryVaultStore): void {
  const now = Date.now();
  vault.insertMemory({
    id: "memory-source-preference" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "local-operator" as MemoryUserId },
    // A fact, not a preference: preferences reach every answer through the standing profile
    // (#4228), and this fixture proves retrieval by the question.
    type: "semantic-fact",
    body: MEMORY,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 1,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
}

function answerModel(calls: GatewayCallRequest[]): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content: MEMORY,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "memory-with-zero-sent-source",
          promptTokens: 30,
          completionTokens: 7,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

function fixture(calls: GatewayCallRequest[]): {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly chatId: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-public-memory-source-")));
  const store = createInMemoryUiStore();
  const memoryDir = join(root, "memory");
  mkdirSync(memoryDir);
  const vault = createMemoryVault({
    memoryDir,
    vaultKey: Buffer.alloc(32, 29),
    redactString: (text) => text,
  });
  cleanups.push(() => {
    vault.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  seedMemory(vault);
  store.createProject(root, "Memory source exception");
  const chat = store.createChat(root, "Memory source exception", MODEL);
  const scopes = ["first", "second"].map((name) => {
    const workspaceRoot = join(root, name);
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    return {
      kind: "directory" as const,
      root: workspaceRoot,
      relativePaths: ["src"],
      connectedAtMs: 1,
    };
  });
  store.updateChat(chat.id, { connectedScopes: scopes });
  return { root, chatId: chat.id, deps: runtimeDeps(store, vault, calls) };
}

function runtimeDeps(
  store: UiHandlerDeps["store"],
  memoryVault: MemoryVaultStore,
  calls: GatewayCallRequest[],
): UiHandlerDeps {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://memory.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [createDefaultChatCapability(MODEL)],
  });
  return {
    config,
    configPresent: true,
    env: {},
    store,
    memoryVault,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => answerModel(calls),
  };
}

function memoryRoute(
  root: string,
  chatId: string,
  content: string,
  memory: "on" | "off" | "absent" = "on",
): RouteContext {
  return {
    correlationId: "public-memory-zero-sent-source",
    req: mockRequest({
      body: JSON.stringify({
        chatId,
        content,
        ...memoryRouteField(root, chatId, memory),
      }),
    }),
    res: mockResponse().res,
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function memoryRouteField(
  root: string,
  chatId: string,
  memory: "on" | "off" | "absent",
): Record<string, unknown> {
  if (memory === "absent") return {};
  return {
    memory: {
      enabled: memory === "on",
      budgetTokens: 1200,
      mode: "governed-assist",
      context: {
        userId: "local-operator",
        workspaceId: root,
        projectId: root,
        conversationId: chatId,
      },
    },
  };
}

it.each([true, false] as const)(
  "handles grounded query lifetime with disconnect=%s",
  async (disconnect) => {
    const calls: GatewayCallRequest[] = [];
    const { deps, root, chatId } = fixture(calls);
    if (deps.config === undefined || deps.memoryVault === undefined) {
      throw new Error("missing memory runtime fixture");
    }
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const modelId = "text-embedding-3-small";
    const provider = { modelId, baseUrl: "http://127.0.0.1:11434/v1", apiKey: "fixture" };
    const config = parseGatewayConfig({
      providers: [...deps.config.providers, provider],
      capabilities: [createDefaultChatCapability(MODEL), createDefaultEmbeddingCapability(modelId)],
    });
    const configured = config.providers.find((entry) => entry.modelId === modelId);
    if (configured === undefined) throw new Error("missing embedding fixture");
    deps.memoryVault.upsertEmbedding("memory-source-preference" as MemoryId, {
      provider: memoryEmbeddingProviderIdentity(configured),
      modelId,
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    let finish!: (outcome: OpenAIEmbeddingOutcome) => void;
    const pending = new Promise<OpenAIEmbeddingOutcome>((resolve) => {
      finish = resolve;
    });
    let queryStarted = false;
    const cancelled = vi.fn(() => {
      finish({ ok: false, kind: "cancelled" });
    });
    const request = memoryRoute(root, chatId, "Which package manager should I use for installs?");
    const diagnostics: ServerDiagnosticRecord[] = [];
    const outcome = handleGroundedAsk(request, {
      ...deps,
      config,
      diagnostics: { record: (record) => diagnostics.push(record) },
      localKnowledgeEmbeddingRequest: (embedding: OpenAIEmbeddingRequest) => {
        queryStarted = true;
        embedding.signal?.addEventListener("abort", cancelled, { once: true });
        return pending;
      },
    });
    try {
      await vi.waitFor(() => {
        expect(queryStarted).toBe(true);
      });
      if (disconnect) request.req.emit("aborted");
      else finish({ ok: true, value: { vector: Float32Array.from([1, 0]), modelId } });
      // Release an unfixed adapter separately, without counting cleanup as cancellation.
      finish({ ok: false, kind: "transport" });
      await expect(outcome).resolves.toMatchObject({ status: disconnect ? 499 : 200 });
      expect(cancelled).toHaveBeenCalledTimes(disconnect ? 1 : 0);
      expect(diagnostics.filter(({ operation }) => operation === "grounded.memory")).toEqual([]);
      expect(calls).toHaveLength(disconnect ? 0 : 1);
      expect(sink.events.filter(({ op }) => op === "embedding.memory.failed")).toMatchObject(
        disconnect ? [{ errorKind: "cancelled", extra: { failureKind: "cancelled" } }] : [],
      );
    } finally {
      finish({ ok: false, kind: "transport" });
      await outcome.catch(() => undefined);
      sink.close?.();
    }
  },
);

it("forwards actual governed memory authority through the public plural handler with zero fitted folder evidence", async () => {
  const calls: GatewayCallRequest[] = [];
  const { deps, root, chatId } = fixture(calls);
  const factory = vi.spyOn(multiSourceQa, "createMultiSourceAnswerer");
  const content = "Which package manager should I use for installs?";
  const result = await handleGroundedAsk(memoryRoute(root, chatId, content), deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const synthesis = calls.filter(
    (request) => request.logContext?.correlationId === "public-memory-zero-sent-source",
  );
  expect(synthesis).toHaveLength(1);
  expect(factory.mock.calls[0]?.[5]).toEqual({
    currentQuestion: content,
    answerOnlyContextAvailable: true,
    userMessageId: deps.store.listMessages(chatId).find((message) => message.role === "user")?.id,
  });

  expect(synthesis[0]?.messages.map((message) => message.content).join("\n")).toContain(MEMORY);
  const answer = result.body as GroundedAnswer;
  if (answer.groundingKind !== "connected-context")
    throw new TypeError("Expected connected answer");
  expect(answer.content).toBe(MEMORY);
  expect(answer.promptContext?.sentReferenceCount).toBe(0);
  expect(answer.contextPack.filesInPrompt).toBe(0);
  expect(answer.citations).toEqual([]);
  expect(answer.evidenceRunIds).toEqual([]);
  expect(answer.uncertainty.map((marker) => marker.kind)).toContain("uncited-memory-context");
  for (const runId of deps.evidenceStore.list())
    expect(JSON.parse(deps.evidenceStore.get(runId) ?? "null")).not.toHaveProperty(
      "connectedContext",
    );
});

it("tells a grounded answer that a remember request was not stored while memory is off", async () => {
  const sentFor = async (content: string, memory: "on" | "off" | "absent"): Promise<string> => {
    const calls: GatewayCallRequest[] = [];
    const { deps, root, chatId } = fixture(calls);
    const result = await handleGroundedAsk(memoryRoute(root, chatId, content, memory), deps);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return calls
      .flatMap((request) => request.messages.map((message) => message.content))
      .join("\n");
  };
  const remember = "Merke dir: Ich bevorzuge kurze Antworten.";
  expect(await sentFor(remember, "absent")).toContain(CONVERSATION_REMEMBER_MEMORY_OFF_NOTICE);
  expect(await sentFor(remember, "off")).toContain(CONVERSATION_REMEMBER_MEMORY_OFF_NOTICE);
  expect(await sentFor(remember, "on")).not.toContain(CONVERSATION_REMEMBER_MEMORY_OFF_NOTICE);
  expect(await sentFor("Which package manager should I use for installs?", "absent")).not.toContain(
    CONVERSATION_REMEMBER_MEMORY_OFF_NOTICE,
  );
});

// PR #4568 review: memory switched on without a vault stores nothing either, and switching it on
// would not help, so the answer learns that without being told to ask for the switch.
it("tells a grounded answer with memory on but no vault that nothing was stored, without the switch", async () => {
  const calls: GatewayCallRequest[] = [];
  const { deps, root, chatId } = fixture(calls);
  const remember = "Merke dir: Ich bevorzuge kurze Antworten.";
  const result = await handleGroundedAsk(memoryRoute(root, chatId, remember, "on"), {
    ...deps,
    memoryVault: undefined,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const sent = calls.flatMap((request) => request.messages.map((message) => message.content));
  expect(sent.join("\n")).toContain(CONVERSATION_REMEMBER_MEMORY_UNAVAILABLE_NOTICE);
  expect(sent.join("\n")).not.toContain(CONVERSATION_REMEMBER_MEMORY_OFF_NOTICE);
});

it("tells a grounded answer that a refused remember request was not stored (#4213)", async () => {
  const sentFor = async (content: string): Promise<string> => {
    const calls: GatewayCallRequest[] = [];
    const { deps, root, chatId } = fixture(calls);
    const result = await handleGroundedAsk(memoryRoute(root, chatId, content), deps);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return calls
      .flatMap((request) => request.messages.map((message) => message.content))
      .join("\n");
  };
  expect(await sentFor("Merke dir: Meine Telefonnummer ist 0171 2345678.")).toContain(
    CONVERSATION_REMEMBER_REFUSED_NOTICE,
  );
  expect(await sentFor("Merke dir: Ich bevorzuge kurze Antworten.")).not.toContain(
    CONVERSATION_REMEMBER_REFUSED_NOTICE,
  );
  expect(await sentFor("Which package manager should I use for installs?")).not.toContain(
    CONVERSATION_REMEMBER_REFUSED_NOTICE,
  );
});
