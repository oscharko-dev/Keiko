import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  deterministicVector,
  seedCapsuleWithVectors,
} from "@oscharko-dev/keiko-local-knowledge/testing";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  verifyEmbeddingCapability,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  buildRedactor,
  buildUiHandlerDeps,
  type UiHandlerDeps,
  type RuntimeGatewayConfig,
} from "./deps.js";
import { installKnowledgeChatCatalogRuntime } from "./knowledge-chat-catalog.js";
import { createEmbeddingAdapter } from "./local-knowledge-grounded-qa.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";

const MODEL = "pod-embedding-log-chat";
const EMBEDDING_MODEL = "text-embedding-3-small";
const QUESTION = "alpha validation policy";
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  resetServerLogger();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function model(): ModelPort {
  return {
    call: (request) =>
      Promise.resolve({
        modelId: MODEL,
        content: request.messages[0]?.content.startsWith("Rewrite broad retrieval questions")
          ? '{"queries":[]}'
          : "The alpha validation policy is documented. [1]",
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "pod-embedding-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "medium",
        },
      }),
  };
}

function fixtureConfig(): GatewayConfig {
  const providers = [MODEL, EMBEDDING_MODEL].map((modelId) => ({
    modelId,
    baseUrl: "https://pod-embedding.example.invalid/v1",
    apiKey: "fixture-secret",
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  }));
  const provider = providers[0];
  if (provider === undefined) throw new TypeError("Missing chat provider fixture");
  return parseGatewayConfig({
    providers,
    capabilities: [
      {
        ...createDefaultChatCapability(MODEL),
        contextWindow: 32768,
        maxOutputTokens: 1024,
        toolCalling: true,
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date().toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: toolCallingConfigurationFingerprint(provider),
        },
      },
      createDefaultEmbeddingCapability(EMBEDDING_MODEL),
    ],
    groundedAnswers: { ownAssessment: "disabled" },
  });
}

// Use the existing observation-owned runtime fixture shape without launching unrelated startup work.
function readyGateway(config: GatewayConfig): RuntimeGatewayConfig {
  let current = config;
  let generation = 0;
  const observations = new Map<string, ReturnType<RuntimeGatewayConfig["verifiedCapability"]>>();
  const holder: RuntimeGatewayConfig = {
    storagePath: "synthetic-gateway.json",
    current: () => current,
    present: () => true,
    set(next): void {
      if (next === undefined) throw new TypeError("Fixture config must stay configured");
      current = next;
      generation += 1;
      observations.clear();
    },
    generation: () => generation,
    verification: () => UNVERIFIED_GATEWAY,
    recordVerification: () => undefined,
    verifiedCapability: (modelId) => observations.get(modelId),
    recordVerifiedCapability(modelId, fields, checkedAt, observedGeneration): void {
      if (observedGeneration !== undefined && observedGeneration !== generation) return;
      observations.set(modelId, {
        modelId,
        generation,
        checkedAt,
        fields: { ...fields },
      });
    },
    clearVerifiedCapability(modelId, observedGeneration): boolean {
      if (observedGeneration !== undefined && observedGeneration !== generation) return false;
      return observations.delete(modelId);
    },
  };
  holder.recordVerifiedCapability(MODEL, { conversationReady: true }, new Date().toISOString());
  return holder;
}

async function fixture(hybrid = false): Promise<{
  readonly deps: UiHandlerDeps;
  readonly chatIds: readonly [string, string];
}> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-pod-embedding-log-")));
  const root = join(directory, "repository");
  mkdirSync(root);
  writeFileSync(join(root, "validation.ts"), "export const alphaValidationPolicy = true;\n");
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  const config = fixtureConfig();
  const store = createInMemoryUiStore();
  store.createProject(root, "Embedding logging");
  const chats = [store.createChat(root, "Alpha", MODEL), store.createChat(root, "Beta", MODEL)];
  const base = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(directory, "evidence"),
    uiDbPath: join(directory, "state/runtime-ui.db"),
    env: { KEIKO_STATE_DIR: join(directory, "state") },
  });
  const deps = installKnowledgeChatCatalogRuntime(
    Object.assign(base, {
      config,
      gatewayConfig: readyGateway(config),
      configPresent: true,
      env: {},
      store,
      uiDbPath: join(directory, "state/ui.db"),
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      evidenceStore: createInMemoryEvidenceStore(),
      modelPortFactory: model,
    }),
    {
      primary: createBufferedServerLogSink(),
      diagnostics: { record: () => undefined },
    },
  );
  cleanups.push(async () => {
    await deps.dispose?.();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await connectPods(
    deps,
    chats.map((chat) => chat.id),
    hybrid ? root : undefined,
  );
  const first = chats[0];
  const second = chats[1];
  if (first === undefined || second === undefined) throw new TypeError("Missing fixture chats");
  return { deps, chatIds: [first.id, second.id] };
}

async function connectPods(
  deps: UiHandlerDeps,
  chatIds: readonly string[],
  folderRoot: string | undefined,
): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({
      runtimeStateDir: join(deps.uiDbPath ?? "", ".."),
    }),
  });
  try {
    const pod = await seedCapsuleWithVectors(store, {
      text: "The alpha validation policy is documented.",
    });
    updateCapsuleState(store, pod.capsuleId, "ready");
    for (const chatId of chatIds)
      deps.store.updateChat(chatId, {
        localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
        ...(folderRoot === undefined
          ? {}
          : {
              connectedScopes: [
                {
                  kind: "workspace-root",
                  root: folderRoot,
                  relativePaths: [],
                  connectedAtMs: 1,
                },
              ],
            }),
      });
  } finally {
    store.close();
  }
}

function ask(
  deps: UiHandlerDeps,
  chatId: string,
  correlationId: string,
): ReturnType<typeof handleGroundedAsk> {
  return startAsk(deps, chatId, correlationId).promise;
}

function startAsk(
  deps: UiHandlerDeps,
  chatId: string,
  correlationId: string,
): {
  readonly response: ReturnType<typeof mockResponse>;
  readonly promise: ReturnType<typeof handleGroundedAsk>;
} {
  const response = mockResponse();
  const promise = handleGroundedAsk(
    {
      params: {},
      correlationId,
      url: new URL("http://localhost/api/chats/messages/grounded"),
      req: mockRequest({ body: JSON.stringify({ chatId, content: QUESTION }) }),
      res: response.res,
    },
    deps,
  );
  return { response, promise };
}

function dispatchedInput(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new TypeError("Expected native embedding JSON body");
  const body: unknown = JSON.parse(init.body);
  if (
    body === null ||
    typeof body !== "object" ||
    !("input" in body) ||
    typeof body.input !== "string"
  )
    throw new TypeError("Expected native scalar embedding input");
  return body.input;
}

function embeddingResponse(input: string): Response {
  return Response.json({
    model: EMBEDDING_MODEL,
    data: [{ index: 0, embedding: [...deterministicVector(input, 1536)] }],
  });
}

function capture(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

describe("default grounded pod embedding activity", () => {
  it.each([false, true])(
    "binds overlapping native calls and keeps the warm cache (%s hybrid)",
    async (hybrid) => {
      const { deps, chatIds } = await fixture(hybrid);
      const sink = capture();
      let dispatches = 0;
      vi.stubGlobal(
        "fetch",
        async (_url: unknown, init: RequestInit | undefined): Promise<Response> => {
          dispatches += 1;
          const input = dispatchedInput(init);
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          return embeddingResponse(input);
        },
      );
      const adapter = createEmbeddingAdapter(deps);
      const answers = await Promise.all([
        ask(deps, chatIds[0], "pod-embedding-alpha"),
        ask(deps, chatIds[1], "pod-embedding-beta"),
      ]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      expect(dispatches).toBe(6);
      const events = sink.events.filter((event) => event.op === "embedding.request.dispatch");
      expect(events).toHaveLength(dispatches);
      // Both turns share one connection-owned four-input preflight. Each retains its own query.
      expect(
        ["pod-embedding-alpha", "pod-embedding-beta"]
          .map(
            (correlationId) =>
              events.filter((event) => event.correlationId === correlationId).length,
          )
          .sort((a, b) => a - b),
      ).toEqual([1, 5]);
      expect(createEmbeddingAdapter(deps)).toBe(adapter);
      expect((await ask(deps, chatIds[0], "pod-embedding-warm")).status).toBe(200);
      expect(dispatches).toBe(6);
      expect(
        sink.events.filter(
          (event) => event.correlationId === "pod-embedding-warm" && event.category === "embedding",
        ),
      ).toHaveLength(0);
      const lines = sink.lines().join("\n");
      for (const forbidden of [QUESTION, "fixture-secret", "https://pod-embedding.example.invalid"])
        expect(lines).not.toContain(forbidden);
    },
  );

  it("records a native preflight failure and requires explicit recovery with a new request context", async () => {
    const { deps, chatIds } = await fixture();
    const sink = capture();
    let failing = true;
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit | undefined): Promise<Response> => {
      const input = dispatchedInput(init);
      return Promise.resolve(
        failing ? new Response("{}", { status: 503 }) : embeddingResponse(input),
      );
    });
    expect((await ask(deps, chatIds[0], "pod-embedding-failed")).status).toBe(200);
    expect(sink.events.find((event) => event.op === "embedding.request.failed")).toMatchObject({
      correlationId: "pod-embedding-failed",
      status: 503,
      errorKind: "unavailable",
    });
    expect(sink.events.find((event) => event.op === "http.gateway.fetch.completed")).toMatchObject({
      correlationId: "pod-embedding-failed",
      status: 503,
    });
    failing = false;
    const beforeRecovery = sink.events.filter(
      (event) => event.op === "embedding.request.dispatch",
    ).length;
    expect((await ask(deps, chatIds[0], "pod-embedding-still-unavailable")).status).toBe(200);
    expect(sink.events.filter((event) => event.op === "embedding.request.dispatch")).toHaveLength(
      beforeRecovery,
    );
    const adapter = createEmbeddingAdapter(deps);
    if ("status" in adapter) throw new TypeError("Missing embedding adapter");
    expect(
      await verifyEmbeddingCapability(
        adapter,
        {
          provider: "openai",
          modelId: EMBEDDING_MODEL,
          vectorMetric: "cosine",
          expectedDimensions: 1536,
          normalization: "l2",
          instructionVersion: "keiko-embedding-input-v1",
          includeSpaceFingerprint: true,
          logContext: { correlationId: "pod-embedding-recovered" },
        },
        "refresh",
      ),
    ).toMatchObject({ ok: true });
    expect((await ask(deps, chatIds[0], "pod-embedding-recovered")).status).toBe(200);
    expect(
      sink.events.filter(
        (event) =>
          event.op === "embedding.request.dispatch" &&
          event.correlationId === "pod-embedding-recovered",
      ),
    ).toHaveLength(5);
  });

  it("keeps caller cancellation local while a second caller completes the shared probe", async () => {
    const { deps, chatIds } = await fixture(true);
    const sink = capture();
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    let physicalSignal: AbortSignal | null | undefined;
    let dispatches = 0;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit | undefined): Promise<Response> => {
      dispatches += 1;
      const input = dispatchedInput(init);
      if (dispatches > 1) return Promise.resolve(embeddingResponse(input));
      physicalSignal = init?.signal;
      started?.();
      return new Promise<Response>((resolve, reject) => {
        release = (): void => {
          resolve(embeddingResponse(input));
        };
        physicalSignal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Fixture request aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const adapter = createEmbeddingAdapter(deps);
    const pending = startAsk(deps, chatIds[0], "pod-embedding-cancelled");
    await dispatched;
    pending.response.res.emit("close");
    expect((await pending.promise).status).toBe(499);
    // Cancelling a person's wait must not cancel the connection-owned physical preflight.
    expect(physicalSignal).toBeDefined();
    expect(physicalSignal?.aborted).toBe(false);
    expect(dispatches).toBe(1);
    const joined = ask(deps, chatIds[1], "pod-embedding-after-cancel");
    release?.();
    expect((await joined).status).toBe(200);
    expect(dispatches).toBe(5);
    expect(createEmbeddingAdapter(deps)).toBe(adapter);
    expect(sink.events.filter((event) => event.op === "embedding.request.dispatch")).toHaveLength(
      5,
    );
    expect(sink.events.filter((event) => event.op === "embedding.request.failed")).toHaveLength(0);
    expect(sink.events.filter((event) => event.op === "http.gateway.fetch.failed")).toHaveLength(0);
    expect(
      sink.events.filter(
        (event) =>
          event.op === "embedding.request.dispatch" &&
          event.correlationId === "pod-embedding-after-cancel",
      ),
    ).toHaveLength(1);
    expect((await ask(deps, chatIds[0], "pod-embedding-warm-after-cancel")).status).toBe(200);
    expect(dispatches).toBe(5);
    expect(
      sink.events.filter(
        (event) =>
          event.correlationId === "pod-embedding-warm-after-cancel" &&
          event.category === "embedding",
      ),
    ).toHaveLength(0);
  });
});
