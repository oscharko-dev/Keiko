import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  parseGatewayConfig,
  type GatewayConfig,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, currentConversationReady, type UiHandlerDeps } from "./deps.js";
import {
  awaitAnyInitializedConversationReadyChatModel,
  awaitInitializedConversationReadiness,
  checkSelectedConversationModel,
  handleGatewayReadiness,
  handleGatewaySelectionCheck,
  initializeConfiguredConversationReadiness,
} from "./gateway-readiness.js";
import { handleCodingSidecarGatewayProfile } from "./coding-sidecar-gateway.js";
import {
  codingWorkbenchProbesSettledForTests,
  resetCodingWorkbenchContextWindowProbesForTests,
} from "./gateway-readiness.js";
import {
  configuredEmbeddingProviders,
  resolveNewCapsuleEmbeddingIdentity,
  selectEmbeddingModelId,
} from "./local-knowledge-handlers.js";
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
  // The Workbench's proofs are process-wide: no test inherits another's settled proof.
  resetCodingWorkbenchContextWindowProbesForTests();
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServerLogger();
});

function toolCapableChat(modelId: string, toolCapable: boolean): ModelCapability {
  const base = createDefaultChatCapability(modelId);
  return toolCapable
    ? {
        ...base,
        toolCalling: true,
        workflowEligible: true,
        contextWindow: 131_072,
        contextWindowAssumed: false,
      }
    : base;
}

function config(
  options: {
    readonly declaredChat?: string;
    readonly litellm?: boolean;
    /** Chat models that claim tool calling without a proof: the Workbench has to prove them. */
    readonly toolCapable?: boolean;
  } = {},
): GatewayConfig {
  return parseGatewayConfig({
    providers: [CHAT_A, CHAT_B, CHAT_C, EMBEDDING_A, EMBEDDING_B].map((modelId) => ({
      modelId,
      baseUrl: ENDPOINT,
      apiKey: "throwaway-key",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      ...(options.litellm === true ? { tokenCounter: "litellm" } : {}),
    })),
    capabilities: [
      toolCapableChat(CHAT_A, options.toolCapable === true),
      {
        ...toolCapableChat(CHAT_B, options.toolCapable === true),
        ...(options.declaredChat === CHAT_B ? { chatModeDeclared: true } : {}),
      },
      toolCapableChat(CHAT_C, options.toolCapable === true),
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
  /** Models whose chat requests answer another status: 503 is no verdict, 401 a refused credential. */
  readonly chatStatus: Map<string, number>;
  /** Embedding aliases that cannot embed. */
  readonly rejectEmbedding: Set<string>;
}

function gatewayDouble(): GatewayDouble {
  const requests: string[] = [];
  const rejectChat = new Set<string>();
  const chatStatus = new Map<string, number>();
  const rejectEmbedding = new Set<string>();
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
        return Promise.resolve(
          rejectEmbedding.has(model)
            ? new Response("cannot embed", { status: 400 })
            : Response.json({ data: [{ embedding: [3, 4] }], model }),
        );
      const status = chatStatus.get(model);
      if (status !== undefined) return Promise.resolve(new Response("", { status }));
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
    chatStatus,
    rejectEmbedding,
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
  expect(gateway.requests).toHaveLength(before);
});

it("adds no request when a person sends to or regenerates with an unselected, unchecked model", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const before = gateway.requests.length;
  await awaitInitializedConversationReadiness(deps, CHAT_B, "corr-send-b");
  await awaitInitializedConversationReadiness(deps, CHAT_B, "corr-regenerate-b");
  await awaitAnyInitializedConversationReadyChatModel(deps, CHAT_B, "corr-create-b");
  expect(gateway.requests).toHaveLength(before);
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
  expect(gateway.requests).toHaveLength(before);
});

// ---------------------------------------------------------------------------
// Follow-up of the audit: what the log says, which model is elected, no dead ends, no sweeps.
// ---------------------------------------------------------------------------

function loggedSink(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

function linesOf(
  sink: ReturnType<typeof createBufferedServerLogSink>,
  op: string,
): readonly ServerLogEvent[] {
  return sink.events.filter((event) => event.op === op);
}

function profileRequest(search: string): RouteContext {
  return {
    correlationId: "corr-profile",
    req: Readable.from([]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL(`http://127.0.0.1/api/coding-sidecar/gateway/profile?${search}`),
  };
}

async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

it("writes a scope line only for a check that sent a request", async () => {
  const sink = loggedSink();
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const selectionScopes = (): number =>
    linesOf(sink, "gateway.readiness.scope").filter((line) => line.extra?.reason === "selection")
      .length;
  await Promise.all([
    checkSelectedConversationModel(deps, CHAT_B, "corr-pick-1"),
    checkSelectedConversationModel(deps, CHAT_B, "corr-pick-2"),
  ]);
  expect(gateway.requestsFor(CHAT_B)).toBe(1);
  // The second pick joined the first: it sent nothing, so it wrote no scope line.
  expect(selectionScopes()).toBe(1);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-pick-3");
  // A settled model sends nothing either.
  expect(selectionScopes()).toBe(1);
  // The proof of a model that is not due (nothing queued, nothing to prove) writes none either.
  const before = linesOf(sink, "gateway.readiness.scope").length;
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-b&check=use"), deps);
  expect(linesOf(sink, "gateway.readiness.scope")).toHaveLength(before);
});

it("records every selection outcome under the pick's own correlation id, with closed values", async () => {
  const sink = loggedSink();
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const first = handleGatewaySelectionCheck(selectionRequest({ modelId: CHAT_B }), deps);
  const joined = handleGatewaySelectionCheck(
    { ...selectionRequest({ modelId: CHAT_B }), correlationId: "corr-selection-joined" },
    deps,
  );
  await Promise.all([first, joined]);
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_B)).toBe(true);
  });
  await handleGatewaySelectionCheck(
    { ...selectionRequest({ modelId: CHAT_B }), correlationId: "corr-selection-answered" },
    deps,
  );
  await handleGatewaySelectionCheck(
    { ...selectionRequest({ modelId: "not-listed" }), correlationId: "corr-selection-unknown" },
    deps,
  );
  await handleGatewaySelectionCheck(
    { ...selectionRequest({}), correlationId: "corr-selection-bad" },
    deps,
  );
  const outcomes = new Map(
    linesOf(sink, "gateway.readiness.selection").map((line) => [
      line.correlationId,
      line.extra?.outcome,
    ]),
  );
  expect(outcomes.get("corr-selection-route")).toBe("started");
  expect(outcomes.get("corr-selection-joined")).toBe("joined");
  expect(outcomes.get("corr-selection-answered")).toBe("already-answered");
  expect(outcomes.get("corr-selection-unknown")).toBe("unknown-model");
  expect(outcomes.get("corr-selection-bad")).toBe("bad-request");
  const line = linesOf(sink, "gateway.readiness.selection")[0];
  if (line === undefined) throw new TypeError("No selection line was recorded");
  expectActivityLogProof("gateway.readiness.selection.line", formatActivityLogProofLine(line));
});

it("reports a failed selection check instead of leaving an unhandled rejection", async () => {
  const sink = loggedSink();
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    // A sink that cannot record the check's completed line makes the check itself fail.
    const failing = {
      ...deps,
      activityLog: {
        write: (event: { readonly op: string }): void => {
          if (event.op === "gateway.readiness.automatic.completed")
            throw new TypeError("sink unavailable");
          sink.write(event as never);
        },
      },
    } as UiHandlerDeps;
    const answered = await handleGatewaySelectionCheck(
      { ...selectionRequest({ modelId: CHAT_B }), correlationId: "corr-selection-failing" },
      failing,
    );
    expect(answered.status).toBe(200);
    await vi.waitFor(() => {
      expect(
        linesOf(sink, "gateway.readiness.selection").some(
          (line) =>
            line.correlationId === "corr-selection-failing" && line.extra?.outcome === "failed",
        ),
      ).toBe(true);
    });
    await settle();
    expect(unhandled).not.toHaveBeenCalled();
    // The Workbench read does not turn the same failure into a 500.
    const read = await handleCodingSidecarGatewayProfile(
      profileRequest("modelId=chat-c&check=1"),
      failing,
    );
    expect(read.status).toBe(200);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

it("elects the startup model like Chat: a mode-declared model ahead of listed order", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  deps.gatewayConfig?.set(config({ declaredChat: CHAT_B }), true, "corr-election");
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_B)).toBe(true);
  });
  await settle();
  expect(gateway.requestsFor(CHAT_A)).toBe(0);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
});

it("stops the startup walk at a refused credential instead of sweeping the catalog", async () => {
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 401);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "corr-credential");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await settle(150);
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
});

it("moves no further on a check without a verdict, until an explicit verification answers definitively", async () => {
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 503);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "corr-busy");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await settle(150);
  initializeConfiguredConversationReadiness(deps, "corr-busy-again");
  await settle(100);
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  // Settings verifies the default and the gateway now refuses it definitively: the pause ends.
  gateway.chatStatus.delete(CHAT_A);
  gateway.rejectChat.add(CHAT_A);
  const settings = await handleGatewayReadiness(
    {
      ...selectionRequest({ modelId: CHAT_A }),
      url: new URL("http://127.0.0.1/api/gateway/readiness"),
    },
    deps,
  );
  expect(settings.status).toBe(200);
  initializeConfiguredConversationReadiness(deps, "corr-after-settings");
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_B)).toBe(true);
  });
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
});

it("lets a pick check a model again after a no-verdict result, but never after a refusal", async () => {
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 503);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "corr-no-dead-end");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await settle(150);
  const base = Date.now();
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => base + offset);
  const early = gateway.requestsFor(CHAT_A);
  await checkSelectedConversationModel(deps, CHAT_A, "corr-pick-early");
  // Inside the existing not-ready cooldown nothing is sent.
  expect(gateway.requestsFor(CHAT_A)).toBe(early);
  offset = 31_000;
  gateway.chatStatus.delete(CHAT_A);
  await checkSelectedConversationModel(deps, CHAT_A, "corr-pick-later");
  expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(early);
  expect(currentConversationReady(deps, CHAT_A)).toBe(true);
  // A definitive refusal stays refused: a pick never repeats it.
  await checkSelectedConversationModel(deps, CHAT_C, "corr-pick-refused");
  gateway.rejectChat.add(CHAT_B);
  await checkSelectedConversationModel(deps, CHAT_B, "corr-pick-b");
  expect(currentConversationReady(deps, CHAT_B)).toBe(false);
  const refused = gateway.requestsFor(CHAT_B);
  offset = 120_000;
  await checkSelectedConversationModel(deps, CHAT_B, "corr-pick-b-again");
  expect(gateway.requestsFor(CHAT_B)).toBe(refused);
});

it("sends no tool-calling request to a model nobody picked when the default ends without a verdict", async () => {
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 503);
  const deps = composition();
  deps.gatewayConfig?.set(config({ litellm: true }), true, "corr-startup-no-verdict");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await deps.waitForStartupGatewayCatalog?.();
  await settle(400);
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
});

it("reads the Workbench profile of a restored selection passively, and of an explicit pick actively", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  await started(deps, gateway);
  const before = gateway.requestsFor(CHAT_B);
  // A window opening names its restored selection with `check=use`: not the model in use, no request.
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-b&check=use"), deps);
  await settle();
  expect(gateway.requestsFor(CHAT_B)).toBe(before);
  // A passive read, with or without a model, sends nothing.
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-b"), deps);
  expect(gateway.requestsFor(CHAT_B)).toBe(before);
  // A window opening asks for no check at all, of the model in use or of anyone else.
  await handleCodingSidecarGatewayProfile(profileRequest("check=use"), deps);
  expect(gateway.requestsFor(CHAT_B)).toBe(before);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
  // An explicit pick checks exactly that model.
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-b&check=1"), deps);
  expect(gateway.requestsFor(CHAT_B)).toBeGreaterThan(before);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
});

it("proves a never-probed embedding alias when a Knowledge Pod first binds it, and never binds one that cannot embed", async () => {
  const gateway = gatewayDouble();
  gateway.rejectEmbedding.add(EMBEDDING_A);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "corr-embedding-first-use");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(EMBEDDING_A)).toBeGreaterThan(0);
  });
  await settle();
  // Startup probed the embedding in use only; the other alias is listed, never probed.
  expect(gateway.requestsFor(EMBEDDING_B)).toBe(0);
  const bound = await resolveNewCapsuleEmbeddingIdentity(deps);
  expect(bound.ok).toBe(true);
  if (bound.ok) expect(bound.identity.modelId).toBe(EMBEDDING_B);
  // Every binding preflights the alias it binds: the proof is the binding's own, never inherited.
  expect(gateway.requestsFor(EMBEDDING_B)).toBeGreaterThan(0);
  // An alias that cannot embed is refused, never bound.
  gateway.rejectEmbedding.add(EMBEDDING_B);
  const another = composition();
  another.gatewayConfig?.set(config(), true, "corr-embedding-refused");
  await settle(150);
  const refused = await resolveNewCapsuleEmbeddingIdentity(another);
  expect(refused.ok).toBe(false);
});

it("opens the Workbench after a default without a verdict without a single request to a model nobody picked", async () => {
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 503);
  const deps = composition();
  deps.gatewayConfig?.set(
    config({ litellm: true, toolCapable: true }),
    true,
    "corr-open-no-verdict",
  );
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await deps.waitForStartupGatewayCatalog?.();
  await settle(300);
  // A window opening reads with `check=use`, with or without the restored selection.
  await handleCodingSidecarGatewayProfile(profileRequest("check=use"), deps);
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-b&check=use"), deps);
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-c&check=use"), deps);
  await settle(200);
  expect(gateway.requestsFor(CHAT_B)).toBe(0);
  expect(gateway.requestsFor(CHAT_C)).toBe(0);
});

it("dispatches no tool-calling proof for a window opening, and labels a pick's proof as selection", async () => {
  const sink = loggedSink();
  gatewayDouble();
  const deps = composition();
  deps.gatewayConfig?.set(config({ toolCapable: true }), true, "corr-tool-scope");
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, CHAT_A)).toBe(true);
  });
  await settle();
  const toolScopes = (): readonly (string | undefined)[] =>
    linesOf(sink, "gateway.readiness.scope")
      .filter((line) => line.extra?.modelKind === "tool-calling")
      .map((line) => String(line.extra?.reason));
  expect(toolScopes()).toEqual([]);
  // A window opening on the model in use, which still lacks its proof, sends nothing: no scope line.
  await handleCodingSidecarGatewayProfile(profileRequest("check=use"), deps);
  await codingWorkbenchProbesSettledForTests();
  expect(toolScopes()).toEqual([]);
  // A pick of a model is the selection kind.
  await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-b&check=1"), deps);
  await codingWorkbenchProbesSettledForTests();
  expect(toolScopes()).toEqual(["selection"]);
});

it("dispatches nothing when a window opens on a model in use whose check ended without a verdict, and reports its state", async () => {
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 503);
  const deps = composition();
  deps.gatewayConfig?.set(config({ toolCapable: true }), true, "corr-window-inconclusive");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await deps.waitForStartupGatewayCatalog?.();
  await codingWorkbenchProbesSettledForTests();
  // Past every cooldown: a passive read must not take that for a reason to send a request.
  const base = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => base + 600_000);
  const chatRequests = (): number =>
    [CHAT_A, CHAT_B, CHAT_C].reduce((sum, modelId) => sum + gateway.requestsFor(modelId), 0);
  const before = chatRequests();
  const answers = [
    await handleCodingSidecarGatewayProfile(profileRequest("check=use"), deps),
    await handleCodingSidecarGatewayProfile(profileRequest("modelId=chat-a&check=use"), deps),
    await handleCodingSidecarGatewayProfile(profileRequest("check=use"), deps),
  ];
  await codingWorkbenchProbesSettledForTests();
  // Positive control: the three reads answered, with the model's own state, not a verified one.
  for (const answer of answers) {
    expect(answer.status).toBe(200);
    expect(answer.body).not.toMatchObject({ status: "available", verification: "verified" });
  }
  expect(chatRequests()).toBe(before);
});

it("names a recheck the cooldown withheld with its own closed outcome", async () => {
  const sink = loggedSink();
  const gateway = gatewayDouble();
  gateway.chatStatus.set(CHAT_A, 503);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "corr-cooldown-outcome");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(CHAT_A)).toBeGreaterThan(0);
  });
  await settle(150);
  const answer = await handleGatewaySelectionCheck(
    { ...selectionRequest({ modelId: CHAT_A }), correlationId: "corr-pick-cooldown" },
    deps,
  );
  const outcome = linesOf(sink, "gateway.readiness.selection").find(
    (line) => line.correlationId === "corr-pick-cooldown",
  );
  expect(outcome?.extra?.outcome).toBe("cooldown");
  // The state that comes with a cooldown is the model's last answer, never "checking": the browser
  // reads the outcome first and shows the cooldown reason at once.
  expect(answer.body).toMatchObject({ modelId: CHAT_A, outcome: "cooldown", state: "not-ready" });
});

it("reports a failing startup walk under the configuration request's correlation id", async () => {
  const sink = loggedSink();
  const records: { readonly source?: unknown; readonly parentCorrelationId?: unknown }[] = [];
  gatewayDouble();
  const deps = composition();
  const failing = {
    ...deps,
    diagnostics: { record: (record: (typeof records)[number]): void => void records.push(record) },
    activityLog: {
      write: (event: { readonly op: string }): void => {
        if (event.op === "gateway.readiness.automatic.completed")
          throw new TypeError("sink unavailable");
        sink.write(event as never);
      },
    },
  } as UiHandlerDeps;
  initializeConfiguredConversationReadiness(
    ((): UiHandlerDeps => {
      deps.gatewayConfig?.set(config(), false);
      return failing;
    })(),
    "corr-walk-parent",
  );
  await vi.waitFor(() => {
    expect(records.some((record) => record.source === "gateway-readiness.startup-walk")).toBe(true);
  });
  const walk = records.find((record) => record.source === "gateway-readiness.startup-walk");
  expect(walk?.parentCorrelationId).toBe("corr-walk-parent");
});

// The consumers that bind or query "the" embedding alias (repository semantic search, the memory
// embedder, the first pod of a new capsule) all take the first of `configuredEmbeddingProviders`. Startup
// proves the alias `chooseEmbeddingProvider` selects. If the two ever named different aliases, a consumer
// would use an alias nobody proved: this pins that they name the same one, also when the aliases differ
// in cost class and the cheaper one is listed second.
it("proves at startup exactly the embedding alias every consumer binds first", async () => {
  const gateway = gatewayDouble();
  const deps = composition();
  const cheapSecond = parseGatewayConfig({
    providers: [EMBEDDING_A, EMBEDDING_B, CHAT_A].map((modelId) => ({
      modelId,
      baseUrl: ENDPOINT,
      apiKey: "throwaway-key",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    })),
    capabilities: [
      { ...createDefaultEmbeddingCapability(EMBEDDING_A), costClass: "high" },
      { ...createDefaultEmbeddingCapability(EMBEDDING_B), costClass: "low" },
      createDefaultChatCapability(CHAT_A),
    ],
  });
  const first = configuredEmbeddingProviders(cheapSecond)[0]?.modelId;
  expect(selectEmbeddingModelId(cheapSecond)).toBe(first);
  deps.gatewayConfig?.set(cheapSecond, true, "corr-embedding-consumers");
  await vi.waitFor(() => {
    expect(gateway.requestsFor(first ?? "")).toBeGreaterThan(0);
  });
  await settle(100);
  const other = first === EMBEDDING_A ? EMBEDDING_B : EMBEDDING_A;
  expect(gateway.requestsFor(other)).toBe(0);
});
