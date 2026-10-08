import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleModels } from "./read-handlers.js";
import { handleCodingSidecarGatewayProfile } from "./coding-sidecar-gateway.js";
import {
  isLiteLlmCodingReadinessPending,
  initializeLiteLlmCodingReadiness,
  resetCodingWorkbenchContextWindowProbesForTests,
} from "./gateway-readiness.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import type { ServerLogEvent } from "./observability/index.js";
import type { RouteContext } from "./routes.js";

const compositions: UiHandlerDeps[] = [];
const directories: string[] = [];
afterEach(async (): Promise<void> => {
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetCodingWorkbenchContextWindowProbesForTests();
});

function startupConfig(contextWindow = 64_000): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig({
    providers: [
      {
        modelId: "chat-model",
        baseUrl: "https://provider.example.invalid/v1",
        apiKey: "throwaway-key",
        tokenCounter: "litellm",
        timeoutMs: 1000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability("chat-model"),
        contextWindow,
        maxOutputTokens: 2000,
      },
    ],
  });
}

function startupDeps(
  discovery: NonNullable<Parameters<typeof buildUiHandlerDeps>[0]["gatewayModelDiscovery"]>,
  events?: ServerLogEvent[],
): UiHandlerDeps {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-startup-catalog-"));
  directories.push(dir);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env: {},
    uiDbPath: join(dir, "ui.db"),
    evidenceDir: join(dir, "evidence"),
    gatewayModelDiscovery: discovery,
    ...(events === undefined
      ? {}
      : {
          activityLog: {
            write: (event: ServerLogEvent): void => {
              events.push(event);
            },
          },
        }),
  });
  compositions.push(deps);
  return deps;
}

function startupModels(
  deps: UiHandlerDeps,
): NonNullable<ReturnType<typeof parseGatewayConfig>["capabilities"]> {
  return deps.gatewayConfig?.current()?.capabilities ?? [];
}

function startupProviderIds(deps: UiHandlerDeps): readonly string[] {
  return deps.gatewayConfig?.current()?.providers.map((provider) => provider.modelId) ?? [];
}

function discoveredCatalog(): {
  readonly modelIds: string[];
  readonly chatModelIds: string[];
  readonly embeddingModelIds: string[];
} {
  return { modelIds: ["chat-model"], chatModelIds: ["chat-model"], embeddingModelIds: [] };
}

function deferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = (): void => undefined;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function stubReadyChat(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        }),
      ),
    ),
  );
}

it("refreshes on reload without waiting and shares concurrent reload catalog discovery", async () => {
  stubReadyChat();
  const pending = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const discovery = vi
    .fn()
    .mockResolvedValueOnce(discoveredCatalog())
    .mockReturnValue(pending.promise);
  const deps = startupDeps(discovery);
  deps.gatewayConfig?.set(startupConfig(), true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledOnce();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const context = {
    correlationId: "corr-browser-reload",
    url: new URL("http://127.0.0.1/api/models?refresh=1"),
  } as RouteContext;
  try {
    const result = handleModels(context, deps);
    expect(result).toMatchObject({ status: 200, body: { models: [{ id: "chat-model" }] } });
    handleModels(context, deps);
    await vi.waitFor(() => {
      expect(discovery).toHaveBeenCalledTimes(2);
    });
    handleModels({ ...context, url: new URL("http://127.0.0.1/api/models") }, deps);
    expect(discovery).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve(discoveredCatalog());
  }
  await pending.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  handleModels(context, deps);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledTimes(3);
  });
});

it("retries a failed startup catalog in the background and stops rediscovering after recovery", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const discovery = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Synthetic catalog transport failure."))
    .mockResolvedValue(discoveredCatalog());
  const deps = startupDeps(discovery);
  deps.gatewayConfig?.set(startupConfig(), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(discovery).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(discovery).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(discovery).toHaveBeenCalledTimes(2);
});

it("discards an old catalog when the connection changes while discovery is in flight", async () => {
  stubReadyChat();
  const old = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const discovery = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(discoveredCatalog());
  const deps = startupDeps(discovery);
  const first = startupConfig();
  deps.gatewayConfig?.set(first, true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledOnce();
  });
  const replacement = {
    ...first,
    providers: first.providers.map((provider) => ({
      ...provider,
      baseUrl: "https://replacement.example.invalid/v1",
    })),
  };
  deps.gatewayConfig?.set(replacement, true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledTimes(2);
  });
  old.resolve({ modelIds: ["stale-chat"], chatModelIds: ["stale-chat"], embeddingModelIds: [] });
  await old.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(startupProviderIds(deps)).not.toContain("stale-chat");
  expect(deps.gatewayConfig?.current()?.providers[0]?.baseUrl).toBe(
    replacement.providers[0]?.baseUrl,
  );
});

it("cancels pending catalog discovery at disposal and rejects its late result", async () => {
  stubReadyChat();
  const pending = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const discovery = vi.fn().mockReturnValue(pending.promise);
  const deps = startupDeps(discovery);
  deps.gatewayConfig?.set(startupConfig(), true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledOnce();
  });
  compositions.splice(compositions.indexOf(deps), 1);
  await deps.dispose?.();
  const before = deps.gatewayConfig?.current();
  pending.resolve({ modelIds: ["late-chat"], chatModelIds: ["late-chat"], embeddingModelIds: [] });
  await pending.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(deps.gatewayConfig?.current()).toBe(before);
  expect(before?.providers.map((provider) => provider.modelId)).not.toContain("late-chat");
});

it("reports background verification as pending while a fresh model has not proved tool calling", async () => {
  const response = deferredValue<boolean>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await response.promise;
      return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    }),
  );
  const deps = startupDeps(() => Promise.resolve(discoveredCatalog()));
  deps.gatewayConfig?.set(startupConfig(), true);
  try {
    await vi.waitFor(() => {
      expect(isLiteLlmCodingReadinessPending(deps)).toBe(true);
    });
    const result = await handleCodingSidecarGatewayProfile(
      { correlationId: "corr-startup-pending" } as RouteContext,
      deps,
    );
    expect(result.body).toMatchObject({
      status: "unavailable",
      reason: "model-verification-pending",
    });
  } finally {
    response.resolve(true);
  }
});

it("verifies configured LiteLLM models without adding or probing unselected discoveries", async () => {
  const discovery = vi.fn().mockResolvedValue({
    modelIds: ["chat-model", "new-chat"],
    chatModelIds: ["chat-model", "new-chat"],
    embeddingModelIds: [],
    modelMetadata: {
      "chat-model": { contextWindow: 64_000 },
      "new-chat": { contextWindow: 64_000 },
    },
  });
  const fetch = vi.fn().mockImplementation((_input: unknown, init: RequestInit) => {
    const tools = typeof init.body === "string" && init.body.includes("report_readiness");
    return Promise.resolve(
      Response.json({
        choices: [
          {
            message: {
              content: "OK",
              ...(tools
                ? {
                    tool_calls: [
                      { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
                    ],
                  }
                : {}),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const deps = startupDeps(discovery);
  const config = startupConfig(32_000);
  deps.gatewayConfig?.set(config, true, "corr-startup-catalog");
  await vi.waitFor(() => {
    expect(startupProviderIds(deps)).toEqual(["chat-model"]);
    expect(startupModels(deps).find((model) => model.id === "chat-model")?.toolCalling).toBe(true);
  });
  expect(discovery).toHaveBeenCalledTimes(1);
  expect(deps.gatewayConfig?.current()?.providers[0]?.baseUrl).toBe(config.providers[0]?.baseUrl);
  expect(deps.gatewayConfig?.verifiedCapability("chat-model")?.fields.conversationReady).toBe(true);
  expect(startupModels(deps)[0]?.contextWindow).toBe(32_000);
});

it("keeps a window refinement made while startup discovery is in flight", async () => {
  stubReadyChat();
  const pending = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const deps = startupDeps(() => pending.promise);
  deps.gatewayConfig?.set(startupConfig(4096), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const current = deps.gatewayConfig?.current();
  if (current === undefined) throw new TypeError("Expected gateway configuration.");
  deps.gatewayConfig?.refine?.({
    ...current,
    capabilities: (current.capabilities ?? []).map((model) => ({
      ...model,
      contextWindow: 32_768,
    })),
  });
  pending.resolve(discoveredCatalog());
  await pending.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(startupModels(deps)[0]?.contextWindow).toBe(32_768);
});

it("reproves an unready LiteLLM model when its successful proof became stale", async () => {
  const blocked = deferredValue<boolean>();
  let toolCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit) => {
      const tools = typeof init.body === "string" && init.body.includes("report_readiness");
      if (tools && ++toolCalls === 1) await blocked.promise;
      return Response.json({
        choices: [
          {
            message: {
              content: "OK",
              ...(tools
                ? {
                    tool_calls: [
                      { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
                    ],
                  }
                : {}),
            },
            finish_reason: "stop",
          },
        ],
      });
    }),
  );
  const deps = startupDeps(() => Promise.resolve(discoveredCatalog()));
  const config = startupConfig();
  deps.gatewayConfig?.set(config, true);
  await vi.waitFor(() => {
    expect(toolCalls).toBe(1);
  });
  const current = deps.gatewayConfig?.current();
  if (current === undefined) throw new TypeError("Expected gateway configuration.");
  deps.gatewayConfig?.set(
    {
      ...current,
      capabilities: (current.capabilities ?? []).map((model) => ({
        ...model,
        contextWindow: model.contextWindow + 1,
      })),
    },
    true,
  );
  blocked.resolve(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await initializeLiteLlmCodingReadiness(deps, "corr-stale-proof-recovery");
  expect(startupModels(deps)[0]?.toolCallingVerification?.status).toBe("verified");
  expect(toolCalls).toBe(2);
});

it("records the startup catalog disposition and counts under a child correlation", async () => {
  stubReadyChat();
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(
    () =>
      Promise.resolve({
        ...discoveredCatalog(),
        modelMetadata: { "chat-model": { contextWindow: 32_000 } },
      }),
    events,
  );
  deps.gatewayConfig?.set(startupConfig(), true, "corr-catalog-owner");
  await vi.waitFor(() => {
    expect(events.some((event) => event.op === "gateway.catalog.automatic.completed")).toBe(true);
  });
  const completion = events.find((event) => event.op === "gateway.catalog.automatic.completed");
  if (completion === undefined) throw new TypeError("Expected catalog completion.");
  expectActivityLogProof(
    "gateway.catalog.automatic.completed.line",
    formatActivityLogProofLine(completion),
  );
  expect(completion.correlationId).toEqual(expect.any(String));
  expect(completion.correlationId).not.toBe("corr-catalog-owner");
  expect(JSON.parse(formatActivityLogProofLine(completion)) as unknown).toMatchObject({
    outcome: "applied",
    configuredModelCount: 1,
    updatedModelCount: 1,
    parentCorrelationId: "corr-catalog-owner",
  });
  expect(JSON.stringify(completion)).not.toContain("throwaway-key");
  expect(JSON.stringify(completion)).not.toContain("provider.example.invalid");
});

it("backs off repeated catalog failures instead of issuing discovery every minute", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const discovery = vi.fn().mockRejectedValue(new Error("Synthetic transport outage."));
  const deps = startupDeps(discovery);
  deps.gatewayConfig?.set(startupConfig(), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_001);
  expect(discovery).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(discovery).toHaveBeenCalledTimes(2);
});

it("does not automatically rediscover a catalog that rejects the configured credential", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const discovery = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("Synthetic refusal."), { httpStatus: 401 }));
  const deps = startupDeps(discovery);
  deps.gatewayConfig?.set(startupConfig(), true);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(discovery).toHaveBeenCalledOnce();
});
