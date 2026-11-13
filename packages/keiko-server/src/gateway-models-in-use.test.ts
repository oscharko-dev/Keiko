import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  parseGatewayConfig,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, currentConversationReady, type UiHandlerDeps } from "./deps.js";
import {
  awaitAnyInitializedConversationReadyChatModel,
  awaitInitializedConversationReadiness,
  checkSelectedConversationModel,
  handleGatewaySelectionCheck,
  initializeConfiguredConversationReadiness,
} from "./gateway-readiness.js";
import { handleModels } from "./read-handlers.js";
import type { RouteContext } from "./routes.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

// The proof of the "models in use" rule: Keiko lists every model a gateway offers, but sends an
// inference request only to a model a person actually uses (#4351). The gateway double lists two
// chat models, a third chat model for the fallback walk and two embedding aliases; it records
// which model each inference request names, so "the unselected models receive zero requests" is an
// assertion about the wire, not about a counter inside the product.
const ENDPOINT = "https://models-in-use.example.invalid/v1";
const CHAT_A = "chat-a";
const CHAT_B = "chat-b";
const CHAT_C = "chat-c";
const EMBEDDING_A = "embedding-a";
const EMBEDDING_B = "embedding-b";

const compositions: UiHandlerDeps[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServerLogger();
});

function config(): GatewayConfig {
  return parseGatewayConfig({
    providers: [CHAT_A, CHAT_B, CHAT_C, EMBEDDING_A, EMBEDDING_B].map((modelId) => ({
      modelId,
      baseUrl: ENDPOINT,
      apiKey: "throwaway-key",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    })),
    capabilities: [
      createDefaultChatCapability(CHAT_A),
      createDefaultChatCapability(CHAT_B),
      createDefaultChatCapability(CHAT_C),
      createDefaultEmbeddingCapability(EMBEDDING_A),
      createDefaultEmbeddingCapability(EMBEDDING_B),
    ],
  });
}

function composition(): UiHandlerDeps {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-models-in-use-"));
  directories.push(dir);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env: { KEIKO_MEMORY_DIR: join(dir, "memory") },
    uiDbPath: join(dir, "ui.db"),
    evidenceDir: join(dir, "evidence"),
  });
  compositions.push(deps);
  return deps;
}

interface GatewayDouble {
  /** Every inference request, in order, as `<endpoint>:<model>`. */
  readonly requests: string[];
  readonly requestsFor: (modelId: string) => number;
  /** Models whose chat requests the double rejects with a definitive 4xx. */
  readonly rejectChat: Set<string>;
}

function gatewayDouble(): GatewayDouble {
  const requests: string[] = [];
  const rejectChat = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init?: { readonly body?: unknown }): Promise<Response> => {
      const path = String(url);
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        readonly model?: string;
      };
      const model = body.model ?? "unknown";
      requests.push(`${path.slice(path.lastIndexOf("/") + 1)}:${model}`);
      if (path.endsWith("/embeddings"))
        return Promise.resolve(Response.json({ data: [{ embedding: [3, 4] }], model }));
      if (rejectChat.has(model))
        return Promise.resolve(new Response("model rejected", { status: 400 }));
      return Promise.resolve(
        Response.json({
          choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        }),
      );
    }),
  );
  return {
    requests,
    requestsFor: (modelId): number =>
      requests.filter((line) => line.endsWith(`:${modelId}`)).length,
    rejectChat,
  };
}

async function started(
  deps: UiHandlerDeps,
  gateway: GatewayDouble,
  correlationId = "corr-models-in-use",
): Promise<void> {
  deps.gatewayConfig?.set(config(), true, correlationId);
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_A) || gateway.requestsFor(CHAT_A) > 0).toBe(true);
  });
  await vi.waitFor(() => {
    expect(gateway.requestsFor(EMBEDDING_A)).toBeGreaterThan(0);
  });
  await awaitInitializedConversationReadiness(deps, CHAT_A, correlationId);
  // A late request to an unselected model would land after this settle point.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

it("sends inference requests only to the chat and embedding model in use at server start", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  expect(gateway.requestsFor(CHAT_A)).toBe(1);
  expect(gateway.requestsFor(EMBEDDING_A)).toBeGreaterThan(0);
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
  expect(gateway.requestsFor(EMBEDDING_B)).toBe(0);
  expect(currentConversationReady(deps, CHAT_A)).toBe(true);
});

it("adds no request to an unselected model through repeated starts", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const before = [...gateway.requests];
  for (let start = 0; start < 3; start += 1) {
    initializeConfiguredConversationReadiness(deps, `corr-restart-${String(start)}`);
    // The same listing, replaced again: discovery adds nothing a person uses.
    deps.gatewayConfig?.set(config(), true, `corr-replace-${String(start)}`);
  }
  await awaitInitializedConversationReadiness(deps, CHAT_A, "corr-restart-join");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
  expect(gateway.requestsFor(EMBEDDING_B)).toBe(0);
  expect(gateway.requestsFor(CHAT_A)).toBe(
    before.filter((line) => line.endsWith(`:${CHAT_A}`)).length,
  );
});

it("adds no request on a page load or a model list read", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const before = gateway.requests.length;
  for (let reload = 0; reload < 3; reload += 1) {
    const result = handleModels(
      { url: new URL("http://127.0.0.1/api/models?refresh=1") } as RouteContext,
      deps,
    );
    expect(result).toMatchObject({ status: 200 });
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(gateway.requests.length).toBe(before);
});

it("adds no request when a person sends to or regenerates with an unselected, unchecked model", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const before = gateway.requests.length;
  await awaitInitializedConversationReadiness(deps, CHAT_B, "corr-send-b");
  await awaitInitializedConversationReadiness(deps, CHAT_B, "corr-regenerate-b");
  await awaitAnyInitializedConversationReadyChatModel(deps, CHAT_B, "corr-create-b");
  expect(gateway.requests.length).toBe(before);
  expect(currentConversationReady(deps, CHAT_B)).toBe(false);
});

it("checks exactly one model when a person first selects it, and none when it is selected again", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-select-b");
  expect(gateway.requestsFor(CHAT_B)).toBe(1);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
  expect(gateway.requestsFor(CHAT_A)).toBe(1);
  expect(currentConversationReady(deps, CHAT_B)).toBe(true);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-select-b-again");
  expect(gateway.requestsFor(CHAT_B)).toBe(1);
});

it("keeps a failed selection refused without a second request", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  gateway.rejectChat.add(CHAT_B);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-select-b-fails");
  expect(currentConversationReady(deps, CHAT_B)).toBe(false);
  const failedRequests = gateway.requestsFor(CHAT_B);
  expect(failedRequests).toBeGreaterThan(0);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-select-b-again");
  await awaitInitializedConversationReadiness(deps, CHAT_B, "corr-send-b");
  expect(gateway.requestsFor(CHAT_B)).toBe(failedRequests);
});

it("walks the election order one model at a time when the default fails, and stops at the first ready model", async () => {
  const gateway = gatewayDouble();
  gateway.rejectChat.add(CHAT_A);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "corr-fallback");
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_B)).toBe(true);
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  expect(gateway.requestsFor(CHAT_B)).toBe(1);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
  expect(currentConversationReady(deps, CHAT_A)).toBe(false);
});

it("records why each check started and how many models were listed, with closed values and counts", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-select-b-log");
  const started_ = sink.events.filter(
    (event) => event.op === "gateway.readiness.automatic.started",
  );
  const reasons = started_.map((event) => event.extra?.checkReason);
  expect(reasons).toContain("startup");
  expect(reasons).toContain("selection");
  const scopes = sink.events
    .filter((event) => event.op === "gateway.readiness.scope")
    .map((event) => event.extra);
  expect(scopes).toContainEqual(
    expect.objectContaining({
      reason: "startup",
      modelKind: "chat",
      listedModelCount: 3,
      checkedModelCount: 1,
    }),
  );
  expect(scopes).toContainEqual(
    expect.objectContaining({
      reason: "startup",
      modelKind: "embedding",
      listedModelCount: 2,
      checkedModelCount: 1,
    }),
  );
  expect(scopes).toContainEqual(
    expect.objectContaining({
      reason: "selection",
      modelKind: "chat",
      listedModelCount: 3,
      checkedModelCount: 1,
    }),
  );
  const scopeLine = sink.events.find((event) => event.op === "gateway.readiness.scope");
  if (scopeLine === undefined) throw new TypeError("The scope line was not recorded");
  expectActivityLogProof("gateway.readiness.scope.line", formatActivityLogProofLine(scopeLine));
  expect(JSON.stringify(sink.events)).not.toContain(CHAT_B);
});

function selectionRequest(body: unknown): RouteContext {
  return {
    correlationId: "corr-selection-route",
    req: Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/gateway/readiness/selection"),
  };
}

it("starts the one selection check through the route and shows it pending until it settles", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const answered = await handleGatewaySelectionCheck(selectionRequest({ modelId: CHAT_B }), deps);
  expect(answered).toMatchObject({ status: 200, body: { modelId: CHAT_B, state: "checking" } });
  const listed = handleModels(
    { url: new URL("http://127.0.0.1/api/models") } as RouteContext,
    deps,
  );
  expect(listed).toMatchObject({ body: { startupReadinessPending: true } });
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_B)).toBe(true);
  });
  expect(gateway.requestsFor(CHAT_B)).toBe(1);
  const again = await handleGatewaySelectionCheck(selectionRequest({ modelId: CHAT_B }), deps);
  expect(again).toMatchObject({ body: { state: "ready" } });
  expect(gateway.requestsFor(CHAT_B)).toBe(1);
});

it("refuses a selection without a model id and ignores a model the gateway does not list", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const before = gateway.requests.length;
  expect(await handleGatewaySelectionCheck(selectionRequest({}), deps)).toMatchObject({
    status: 400,
  });
  expect(
    await handleGatewaySelectionCheck(selectionRequest({ modelId: "not-listed" }), deps),
  ).toMatchObject({ status: 200, body: { state: "unchecked" } });
  expect(gateway.requests.length).toBe(before);
});
