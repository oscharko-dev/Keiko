import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  parseGatewayConfig,
  verifyEmbeddingCapability,
  type OpenAIEmbeddingAdapter,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, currentConversationReady, type UiHandlerDeps } from "./deps.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import {
  handleGatewayReadiness,
  initializeConfiguredEmbeddingReadiness,
} from "./gateway-readiness.js";
import { createEmbeddingAdapter } from "./local-knowledge-grounded-qa.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { normalizedEndpointFingerprint } from "./embedding-provider-identity.js";
import type { RouteContext } from "./routes.js";

const ENDPOINT = "https://embedding-startup.example.invalid/v1";
const EMBEDDING_MODEL = "startup-embedding";
const compositions: UiHandlerDeps[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetServerLogger();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function config(apiKey = "fixture-key") {
  return parseGatewayConfig({
    providers: ["startup-chat", EMBEDDING_MODEL].map((modelId) => ({
      modelId,
      baseUrl: ENDPOINT,
      apiKey,
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    })),
    capabilities: [
      createDefaultChatCapability("startup-chat"),
      createDefaultEmbeddingCapability(EMBEDDING_MODEL),
    ],
  });
}

function composition(qualified = false): UiHandlerDeps {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-embedding-startup-"));
  directories.push(dir);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env: {
      KEIKO_MEMORY_DIR: join(dir, "memory"),
      ...(qualified
        ? {
            [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
            [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(dir, "spend.db"),
          }
        : {}),
    },
    uiDbPath: join(dir, "ui.db"),
    evidenceDir: join(dir, "evidence"),
  });
  compositions.push(deps);
  return deps;
}

function adapterFor(deps: UiHandlerDeps): OpenAIEmbeddingAdapter {
  const adapter = createEmbeddingAdapter(deps);
  if ("status" in adapter) throw new TypeError("Embedding fixture is not configured");
  return adapter;
}

const probe = {
  modelId: EMBEDDING_MODEL,
  provider: `openai-compatible:${normalizedEndpointFingerprint(ENDPOINT)}`,
  vectorMetric: "cosine",
  includeSpaceFingerprint: true,
  expectedDimensions: 2,
} as const;

function provider() {
  let embeddingCalls = 0;
  let failed = false;
  let failureStatus = 503;
  let failureError: Error | undefined;
  let holdNext = false;
  let release: (() => void) | undefined;
  const fetch = vi.fn(async (url: unknown): Promise<Response> => {
    if (String(url).endsWith("/embeddings")) {
      embeddingCalls += 1;
      if (failed && failureError !== undefined) throw failureError;
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return failed
        ? new Response("unavailable", { status: failureStatus })
        : Response.json({
            data: [{ embedding: [3, 4] }],
            model: EMBEDDING_MODEL,
          });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    embeddingCalls: () => embeddingCalls,
    fail: (value: boolean, status = 503, error?: Error) => {
      failed = value;
      failureStatus = status;
      failureError = error;
    },
    hold: () => {
      holdNext = true;
    },
    held: () => release !== undefined,
    release: () => {
      release?.();
      release = undefined;
    },
  };
}

it("shares startup with concurrent retrieval and keeps the connection proof beyond ten minutes", async () => {
  const network = provider();
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "embedding-startup");
  const adapter = adapterFor(deps);
  const answer = await verifyEmbeddingCapability(adapter, probe, "connection");
  expect(answer.ok).toBe(true);
  await vi.waitFor(() => {
    expect(network.embeddingCalls()).toBe(4);
  });
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  try {
    expect((await verifyEmbeddingCapability(adapterFor(deps), probe, "connection")).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(4);
  } finally {
    clock.mockRestore();
  }
});

it("keeps metadata-only refinements warm and rotates the proof on a new connection generation", async () => {
  const network = provider();
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "embedding-generation-first");
  const first = adapterFor(deps);
  await verifyEmbeddingCapability(first, probe, "connection");
  const current = deps.gatewayConfig?.current();
  if (current === undefined) throw new TypeError("Missing fixture configuration");
  deps.gatewayConfig?.refine?.({
    ...current,
    capabilities: [...(current.capabilities ?? [])],
  });
  expect(adapterFor(deps)).toBe(first);
  await verifyEmbeddingCapability(first, probe, "connection");
  expect(network.embeddingCalls()).toBe(4);
  deps.gatewayConfig?.set(config("different-fixture-key"), true, "embedding-generation-second");
  const second = adapterFor(deps);
  expect(second).not.toBe(first);
  await verifyEmbeddingCapability(second, probe, "connection");
  expect(network.embeddingCalls()).toBe(8);
  expect(
    (
      await first.request({
        endpoint: ENDPOINT,
        apiKey: "fixture-key",
        modelId: EMBEDDING_MODEL,
        input: "stale request",
      })
    ).ok,
  ).toBe(false);
  expect(network.embeddingCalls()).toBe(8);
});

it("invalidates a credential rejection and recovers through the existing Settings handler", async () => {
  const network = provider();
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "embedding-recovery");
  const adapter = adapterFor(deps);
  await verifyEmbeddingCapability(adapter, probe, "connection");
  network.fail(true, 401);
  expect(
    (
      await adapter.request({
        endpoint: ENDPOINT,
        apiKey: "fixture-key",
        modelId: EMBEDDING_MODEL,
        input: "ordinary user query",
      })
    ).ok,
  ).toBe(false);
  const failedCount = network.embeddingCalls();
  network.fail(false);
  expect((await verifyEmbeddingCapability(adapterFor(deps), probe, "connection")).ok).toBe(false);
  expect(network.embeddingCalls()).toBe(failedCount);
  const ctx: RouteContext = {
    correlationId: "embedding-settings-recheck",
    req: Readable.from([
      Buffer.from(JSON.stringify({ options: { probes: ["embedding"] } })),
    ]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/gateway/readiness"),
  };
  const recovered = await handleGatewayReadiness(ctx, deps);
  expect(recovered.status).toBe(200);
  expect(recovered.body).toMatchObject({
    verifiedCapabilities: { embedding: true, embeddingDimensions: 2 },
  });
  expect(network.embeddingCalls()).toBe(failedCount + 4);
  expect((await verifyEmbeddingCapability(adapterFor(deps), probe, "connection")).ok).toBe(true);
  expect(network.embeddingCalls()).toBe(failedCount + 4);
});

it("does not turn failed startup observations into per-request retries", async () => {
  const network = provider();
  network.fail(true);
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "embedding-unavailable-startup");
  const adapter = adapterFor(deps);
  expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(false);
  const calls = network.embeddingCalls();
  network.fail(false);
  await Promise.all(
    Array.from({ length: 8 }, () => verifyEmbeddingCapability(adapter, probe, "connection")),
  );
  expect(network.embeddingCalls()).toBe(calls);
  deps.gatewayConfig?.set(config("replacement-fixture-key"), true, "embedding-recovery-config");
  expect((await verifyEmbeddingCapability(adapterFor(deps), probe, "connection")).ok).toBe(true);
  expect(network.embeddingCalls()).toBe(calls + 4);
});

it("does not charge an enabled spend ledger for warm cache hits or joined initialization", async () => {
  const network = provider();
  const deps = composition(true);
  const source = config();
  const priced = {
    ...source,
    capabilities: (source.capabilities ?? []).map((capability) => ({
      ...capability,
      ...(capability.kind === "chat" ? { maxOutputTokens: 20 } : {}),
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
    })),
  };
  deps.gatewayConfig?.set(priced, true, "embedding-spend-initial");
  await initializeConfiguredEmbeddingReadiness(deps, "embedding-spend-join");
  await vi.waitFor(() => {
    expect(currentConversationReady(deps, "startup-chat")).toBe(true);
  });
  const ledger = deps.env[QUALIFICATION_SPEND_LEDGER_PATH_ENV];
  if (ledger === undefined) throw new TypeError("Missing qualification spend ledger");
  const charged = (): number => {
    const db = new DatabaseSync(ledger, { readOnly: true });
    try {
      return Number(db.prepare("SELECT charged FROM model_spend WHERE id = 1").get()?.charged);
    } finally {
      db.close();
    }
  };
  const before = charged();
  expect(before).toBeGreaterThan(0);
  await Promise.all([
    initializeConfiguredEmbeddingReadiness(deps, "embedding-spend-cached-a"),
    initializeConfiguredEmbeddingReadiness(deps, "embedding-spend-cached-b"),
  ]);
  expect(charged()).toBe(before);
  expect(network.embeddingCalls()).toBe(4);
});

it("refuses a late successful embedding response from a replaced connection generation", async () => {
  const network = provider();
  const deps = composition();
  deps.gatewayConfig?.set(config(), true, "embedding-old-generation");
  const old = adapterFor(deps);
  await verifyEmbeddingCapability(old, probe, "connection");
  network.hold();
  const pending = old.request({
    endpoint: ENDPOINT,
    apiKey: "fixture-key",
    modelId: EMBEDDING_MODEL,
    input: "old generation query",
  });
  await vi.waitFor(() => {
    expect(network.held()).toBe(true);
  });
  deps.gatewayConfig?.set(config("new-fixture-key"), true, "embedding-new-generation");
  const current = adapterFor(deps);
  expect((await verifyEmbeddingCapability(current, probe, "connection")).ok).toBe(true);
  network.release();
  expect((await pending).ok).toBe(false);
  expect((await verifyEmbeddingCapability(old, probe, "connection")).ok).toBe(false);
  expect((await verifyEmbeddingCapability(current, probe, "connection")).ok).toBe(true);
  expect(network.embeddingCalls()).toBe(9);
});

function ordinaryQuery(correlationId: string) {
  return {
    endpoint: ENDPOINT,
    apiKey: "fixture-key",
    modelId: EMBEDDING_MODEL,
    input: "private transient query source",
    logContext: { correlationId },
  };
}

it.each([429, 500, 503, 599])(
  "retains the verified identity after HTTP %i and dispatches the next real query without probes",
  async (status) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const network = provider();
    const deps = composition();
    deps.gatewayConfig?.set(config(), true, "embedding-transient-proof");
    const adapter = adapterFor(deps);
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(4);
    network.fail(true, status);
    const failed = await adapter.request(ordinaryQuery("embedding-query-failed"));
    expect(failed).toMatchObject({ ok: false, status });
    expect(network.embeddingCalls()).toBe(5);
    network.fail(false);
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(5);
    expect((await adapter.request(ordinaryQuery("embedding-query-recovered"))).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(6);
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(6);
    const events = sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.correlationId === "embedding-query-failed")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "embedding.request.dispatch" }),
        expect.objectContaining({ op: "embedding.request.failed", status }),
      ]),
    );
    expect(
      events.filter(
        (event) =>
          event.correlationId === "embedding-query-recovered" &&
          event.op === "embedding.request.dispatch",
      ),
    ).toHaveLength(1);
    const lines = sink.lines().join("\n");
    for (const privateValue of ["private transient query source", "fixture-key", ENDPOINT])
      expect(lines).not.toContain(privateValue);
  },
);

it.each(["transport", "timeout"] as const)(
  "retains the verified identity after a transient %s failure",
  async (kind) => {
    const network = provider();
    const deps = composition();
    deps.gatewayConfig?.set(config(), true, "embedding-transient-transport");
    const adapter = adapterFor(deps);
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    const error =
      kind === "timeout"
        ? new DOMException("fixture timeout", "TimeoutError")
        : new TypeError("fixture transport");
    network.fail(true, 503, error);
    expect(await adapter.request(ordinaryQuery("embedding-transport-failed"))).toEqual({
      ok: false,
      kind,
    });
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(5);
    network.fail(false);
    expect((await adapter.request(ordinaryQuery("embedding-transport-recovered"))).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(6);
  },
);

it.each(["cancelled", "budget"] as const)(
  "does not poison the verified identity after a local %s refusal without network",
  async (kind) => {
    const network = provider();
    const deps = composition();
    deps.gatewayConfig?.set(config(), true, "embedding-local-refusal");
    const adapter = adapterFor(deps);
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    Object.assign(deps, {
      localKnowledgeEmbeddingRequest: async () => {
        if (kind === "budget") throw new ConfigInvalidError("spend-budget-exceeded");
        return { ok: false as const, kind: "cancelled" as const };
      },
    });
    const request = adapter.request(ordinaryQuery("embedding-local-refused"));
    if (kind === "budget") await expect(request).rejects.toBeInstanceOf(ConfigInvalidError);
    else expect(await request).toEqual({ ok: false, kind: "cancelled" });
    expect((await verifyEmbeddingCapability(adapter, probe, "connection")).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(4);
    Object.assign(deps, { localKnowledgeEmbeddingRequest: undefined });
    expect((await adapter.request(ordinaryQuery("embedding-local-recovered"))).ok).toBe(true);
    expect(network.embeddingCalls()).toBe(5);
  },
);
