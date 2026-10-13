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
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createEmbeddingAdapter } from "./local-knowledge-grounded-qa.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

const MODEL = "pod-embedding-log-chat";
const EMBEDDING_MODEL = "text-embedding-3-small";
const QUESTION = "alpha validation policy";
const cleanups: (() => void)[] = [];

afterEach(() => {
  resetServerLogger();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
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

async function fixture(hybrid = false): Promise<{
  readonly deps: UiHandlerDeps;
  readonly chatIds: readonly [string, string];
}> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-pod-embedding-log-")));
  const root = join(directory, "repository");
  mkdirSync(root);
  writeFileSync(join(root, "validation.ts"), "export const alphaValidationPolicy = true;\n");
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  const config = parseGatewayConfig({
    providers: [MODEL, EMBEDDING_MODEL].map((modelId) => ({
      modelId,
      baseUrl: "https://pod-embedding.example.invalid/v1",
      apiKey: "fixture-secret",
      maxRetries: 0,
    })),
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 1024 },
      createDefaultEmbeddingCapability(EMBEDDING_MODEL),
    ],
    groundedAnswers: { ownAssessment: "disabled" },
  });
  const store = createInMemoryUiStore();
  store.createProject(root, "Embedding logging");
  const chats = [store.createChat(root, "Alpha", MODEL), store.createChat(root, "Beta", MODEL)];
  const deps: UiHandlerDeps = {
    config,
    configPresent: true,
    env: {},
    store,
    uiDbPath: join(directory, "state/ui.db"),
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: model,
  };
  cleanups.push(() => {
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
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: join(deps.uiDbPath ?? "", "..") }),
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
                { kind: "workspace-root", root: folderRoot, relativePaths: [], connectedAtMs: 1 },
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
      expect(dispatches).toBe(10);
      const events = sink.events.filter((event) => event.op === "embedding.request.dispatch");
      expect(events).toHaveLength(dispatches);
      for (const correlationId of ["pod-embedding-alpha", "pod-embedding-beta"])
        expect(events.filter((event) => event.correlationId === correlationId)).toHaveLength(5);
      expect(createEmbeddingAdapter(deps)).toBe(adapter);
      expect((await ask(deps, chatIds[0], "pod-embedding-warm")).status).toBe(200);
      expect(dispatches).toBe(10);
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

  it("records a native preflight failure and retries it with a new request context", async () => {
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
    expect((await ask(deps, chatIds[0], "pod-embedding-recovered")).status).toBe(200);
    expect(
      sink.events.filter(
        (event) =>
          event.op === "embedding.request.dispatch" &&
          event.correlationId === "pod-embedding-recovered",
      ),
    ).toHaveLength(5);
  });

  it("records caller cancellation without poisoning the shared adapter cache", async () => {
    const { deps, chatIds } = await fixture(true);
    const sink = capture();
    let started: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit | undefined): Promise<Response> => {
      started?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Fixture request aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const pending = startAsk(deps, chatIds[0], "pod-embedding-cancelled");
    await dispatched;
    pending.response.res.emit("close");
    expect((await pending.promise).status).toBe(499);
    await vi.waitFor(() => {
      expect(sink.events.find((event) => event.op === "embedding.request.failed")).toMatchObject({
        correlationId: "pod-embedding-cancelled",
        errorKind: "cancelled",
      });
    });
    expect(sink.events.find((event) => event.op === "http.gateway.fetch.failed")).toMatchObject({
      correlationId: "pod-embedding-cancelled",
      errorKind: "cancelled",
    });
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit | undefined): Promise<Response> => {
      const input = dispatchedInput(init);
      return Promise.resolve(embeddingResponse(input));
    });
    expect((await ask(deps, chatIds[1], "pod-embedding-after-cancel")).status).toBe(200);
    expect(
      sink.events.filter(
        (event) =>
          event.op === "embedding.request.dispatch" &&
          event.correlationId === "pod-embedding-after-cancel",
      ),
    ).toHaveLength(5);
  });
});
