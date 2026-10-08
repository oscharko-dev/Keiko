import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleModels } from "./read-handlers.js";
import {
  refreshLiteLlmGatewayCatalog,
  parseModelDiscovery,
  rawConfigFromCurrent,
} from "./gateway-setup.js";
import { handleCodingSidecarGatewayProfile } from "./coding-sidecar-gateway.js";
import {
  isLiteLlmCodingReadinessPending,
  WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS,
  ensureCodingWorkbenchContextWindows,
  resetCodingWorkbenchContextWindowProbesForTests,
  withReadinessParentCorrelation,
} from "./gateway-readiness.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import type { ServerLogEvent } from "./observability/index.js";
import { createFileServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  executeLocalSupportQuery,
  DEFAULT_SUPPORT_QUERY_LIMITS,
} from "@oscharko-dev/keiko-activity-log/reader";
import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { RouteContext } from "./routes.js";

import { openProviderCredentialVault, providerSecretRef } from "./credentialVault.js";

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
  discovery: Parameters<typeof buildUiHandlerDeps>[0]["gatewayModelDiscovery"],
  events?: ServerLogEvent[],
  env: Record<string, string> = {},
): UiHandlerDeps {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-startup-catalog-"));
  directories.push(dir);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env,
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

function catalogCompletions(events: readonly ServerLogEvent[]): readonly ServerLogEvent[] {
  return events.filter(
    (event) =>
      event.op === "gateway.catalog.automatic.completed" && event.extra?.phase !== "retry-decision",
  );
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

it.each(["explicit", undefined] as const)(
  "enriches an existing %s hidden deployment without requiring public catalog visibility",
  async (origin) => {
    const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0]) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith("/model/info"))
        return Promise.resolve(
          Response.json({
            data: [
              { model_name: "chat-model", model_info: { mode: "chat", max_model_len: 32_768 } },
            ],
          }),
        );
      if (path.endsWith("/models")) return Promise.resolve(new Response("", { status: 403 }));
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const events: ServerLogEvent[] = [];
    const deps = startupDeps(undefined, events);
    const config = managedStartupConfig(origin);
    deps.gatewayConfig?.set(config, true);
    await vi.waitFor(() => {
      expect(startupModels(deps)[0]?.contextWindow).toBe(32_768);
    });
    expect(startupProviderIds(deps)).toEqual(["chat-model"]);
    expect(
      fetch.mock.calls.some(([input]) =>
        new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/models"),
      ),
    ).toBe(false);
    expect(catalogCompletions(events)[0]).toMatchObject({ extra: { outcome: "applied" } });
  },
);

it("retries a real discovery response-body transport rejection instead of pinning malformed JSON", async () => {
  vi.stubGlobal("fetch", (input: Parameters<typeof globalThis.fetch>[0]) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.endsWith("/model/info") || path.endsWith("/models")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.error(new TypeError("terminated synthetic private diagnostic"));
        },
      });
      return Promise.resolve(new Response(body));
    }
    return Promise.resolve(
      Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
    );
  });
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(undefined, events);
  deps.gatewayConfig?.set(startupConfig(), true);
  await vi.waitFor(() => {
    expect(catalogCompletions(events)[0]).toMatchObject({
      extra: { outcome: "failed", retryable: true },
    });
  });
  expect(catalogCompletions(events)[0]?.errorKind).toBe("unavailable");
  expect(JSON.stringify(events)).not.toContain("terminated synthetic private diagnostic");
});

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
  const config = {
    ...startupConfig(32_000),
    providers: startupConfig(32_000).providers.map((provider) => ({
      ...provider,
      catalogOrigin: "explicit" as const,
    })),
  };
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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
  expect(isLiteLlmCodingReadinessPending(deps)).toBe(true);
  await vi.advanceTimersByTimeAsync(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1);
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
    expect(catalogCompletions(events).length > 0).toBe(true);
  });
  const completion = catalogCompletions(events)[0];
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

function managedStartupConfig(
  catalogOrigin: "discovered" | "explicit" | undefined,
): ReturnType<typeof parseGatewayConfig> {
  const config = startupConfig();
  return parseGatewayConfig({
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      ...(catalogOrigin === undefined ? {} : { catalogOrigin }),
    })),
  });
}

function requiredStartupProvider(
  config: ReturnType<typeof parseGatewayConfig>,
): ReturnType<typeof parseGatewayConfig>["providers"][number] {
  const provider = config.providers[0];
  if (provider === undefined) throw new TypeError("Expected configured provider.");
  return provider;
}

async function explicitlyRefreshStartupCatalog(
  deps: UiHandlerDeps,
  provider: ReturnType<typeof parseGatewayConfig>["providers"][number],
): Promise<void> {
  await refreshLiteLlmGatewayCatalog(
    deps,
    provider,
    new AbortController().signal,
    "corr-inventory",
  );
}

function configuredStartupWindow(deps: UiHandlerDeps): number | undefined {
  return deps.gatewayConfig?.configured?.()?.capabilities?.[0]?.contextWindow;
}

function manualCatalogConfig(
  changes: Partial<ReturnType<typeof createDefaultChatCapability>> = {},
): ReturnType<typeof parseGatewayConfig> {
  const config = startupConfig();
  return {
    ...config,
    providers: config.providers.map(({ tokenCounter: _counter, ...provider }) => provider),
    capabilities: (config.capabilities ?? []).map((model) => ({ ...model, ...changes })),
  };
}

it("ends an assumed window with the same declared catalog provenance as setup", async () => {
  stubReadyChat();
  const deps = startupDeps(() =>
    Promise.resolve({
      ...discoveredCatalog(),
      modelMetadata: { "chat-model": { contextWindow: 32_768 } },
    }),
  );
  const config = manualCatalogConfig({ contextWindow: 4096, contextWindowAssumed: true });
  deps.gatewayConfig?.set(config, true);
  await explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
  expect(startupModels(deps)[0]).toMatchObject({ contextWindow: 32_768 });
  expect(startupModels(deps)[0]?.contextWindowAssumed).not.toBe(true);
  expect(startupModels(deps)[0]?.contextWindowReported).not.toBe(true);
});

it("applies independent declared input and output limits at catalog refresh", async () => {
  stubReadyChat();
  const deps = startupDeps(() =>
    Promise.resolve({
      ...discoveredCatalog(),
      modelMetadata: {
        "chat-model": {
          contextWindow: 32_768,
          maxInputTokens: 16_000,
          maxOutputTokens: 4096,
        },
      },
    }),
  );
  const config = manualCatalogConfig({
    contextWindow: 4096,
    contextWindowAssumed: true,
    maxOutputTokens: 0,
  });
  deps.gatewayConfig?.set(config, true);
  await explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
  expect(startupModels(deps)[0]).toMatchObject({
    contextWindow: 32_768,
    maxInputTokens: 16_000,
    maxOutputTokens: 4096,
  });
});

it("keeps a smaller live provider refinement when declared metadata arrives later", async () => {
  stubReadyChat();
  const pending = deferredValue<ReturnType<typeof parseModelDiscovery>>();
  const deps = startupDeps(() => pending.promise);
  const config = manualCatalogConfig({ contextWindow: 4096, contextWindowAssumed: true });
  deps.gatewayConfig?.set(config, true);
  const refresh = explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
  const holder = deps.gatewayConfig;
  holder?.refine?.({
    ...config,
    capabilities: (config.capabilities ?? []).map((model) => ({
      ...model,
      contextWindow: 32_768,
      contextWindowAssumed: false,
      contextWindowReported: true,
    })),
  });
  pending.resolve(
    parseModelDiscovery({
      data: [{ model_name: "chat-model", model_info: { mode: "chat", max_model_len: 131_072 } }],
    }),
  );
  await refresh;
  expect(startupModels(deps)[0]?.contextWindow).toBe(32_768);
});

it("retains the accepted declared ceiling after disappearance and recovery", async () => {
  stubReadyChat();
  const discovery = vi
    .fn()
    .mockResolvedValue({ modelIds: [], chatModelIds: [], embeddingModelIds: [] });
  const deps = startupDeps(discovery);
  const manual = manualCatalogConfig({ contextWindow: 32_000 });
  const config = {
    ...manual,
    providers: manual.providers.map((provider) => ({
      ...provider,
      catalogOrigin: "discovered" as const,
    })),
  };
  deps.gatewayConfig?.set(config, true);
  const provider = requiredStartupProvider(config);
  await explicitlyRefreshStartupCatalog(deps, provider);
  expect(startupProviderIds(deps)).toEqual([]);
  expect(configuredStartupWindow(deps)).toBe(32_000);
  discovery.mockResolvedValue({
    ...discoveredCatalog(),
    modelMetadata: { "chat-model": { contextWindow: 128_000 } },
  });
  await explicitlyRefreshStartupCatalog(deps, provider);
  expect(startupModels(deps)[0]?.contextWindow).toBe(32_000);
  expect(configuredStartupWindow(deps)).toBe(32_000);
});

it("refuses to report a catalog refinement as applied without its owner facet", async () => {
  stubReadyChat();
  const deps = startupDeps(() =>
    Promise.resolve({
      ...discoveredCatalog(),
      modelMetadata: { "chat-model": { contextWindow: 32_000 } },
    }),
  );
  const config = manualCatalogConfig();
  deps.gatewayConfig?.set(config, true);
  const holder = deps.gatewayConfig;
  if (holder === undefined) throw new TypeError("Expected gateway owner.");
  const result = await refreshLiteLlmGatewayCatalog(
    { ...deps, gatewayConfig: { ...holder, refine: undefined } },
    requiredStartupProvider(config),
    new AbortController().signal,
    "corr-missing-refine",
  );
  expect(result).toEqual({ succeeded: false, retryable: true });
  expect(holder.current()?.capabilities?.[0]?.contextWindow).toBe(64_000);
});

it("reconciles discovered model additions and removals using the current connection", async () => {
  stubReadyChat();
  const discovery = vi.fn().mockResolvedValue({
    modelIds: ["replacement-chat"],
    chatModelIds: ["replacement-chat"],
    embeddingModelIds: [],
  });
  const deps = startupDeps(discovery);
  const config = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(config, true);
  await explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
  expect(startupProviderIds(deps)).toEqual(["replacement-chat"]);
  expect(
    handleModels({ url: new URL("http://127.0.0.1/api/models") } as RouteContext, deps).body,
  ).toMatchObject({ models: [{ id: "replacement-chat" }] });
});

it("keeps the accepted credential source after the last discovered model disappears", async () => {
  stubReadyChat();
  const discovery = vi
    .fn()
    .mockResolvedValue({ modelIds: [], chatModelIds: [], embeddingModelIds: [] });
  const deps = startupDeps(discovery);
  const config = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(config, true);
  await vi.waitFor(() => {
    expect(startupProviderIds(deps)).toEqual([]);
  });
  const holder = deps.gatewayConfig;
  expect(holder?.configured?.()?.providers).toEqual(config.providers);
  await new Promise<void>((resolve) => setImmediate(resolve));
  discovery.mockResolvedValue({
    modelIds: ["new-chat"],
    chatModelIds: ["new-chat"],
    embeddingModelIds: [],
  });
  deps.refreshGatewayCatalog?.("corr-after-empty");
  await vi.waitFor(() => {
    expect(startupProviderIds(deps)).toEqual(["new-chat"]);
  });
});

it.each(["explicit", undefined] as const)(
  "preserves a configured hidden alias without inventing %s origin",
  async (origin) => {
    stubReadyChat();
    const deps = startupDeps(() =>
      Promise.resolve({
        modelIds: [],
        chatModelIds: [],
        embeddingModelIds: [],
      }),
    );
    const config = managedStartupConfig(origin);
    deps.gatewayConfig?.set(config, true);
    await explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
    expect(startupProviderIds(deps)).toEqual(["chat-model"]);
    expect(deps.gatewayConfig?.current()?.providers[0]).toEqual(config.providers[0]);
  },
);

it("does not remove omitted discovered models from a truncated catalog", async () => {
  stubReadyChat();
  const deps = startupDeps(() =>
    Promise.resolve({
      modelIds: ["new-chat"],
      chatModelIds: ["new-chat"],
      embeddingModelIds: [],
      truncated: true,
    }),
  );
  const config = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(config, true);
  await explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
  expect(startupProviderIds(deps)).toEqual(["chat-model", "new-chat"]);
});

it("accepts a complete empty runtime snapshot while keeping setup discovery strict", () => {
  const payload = { data: [] };
  expect(() => parseModelDiscovery(payload)).toThrow();
  expect(() => parseModelDiscovery(payload, undefined, { allowEmpty: true })).not.toThrow();
});

it("drops late observations for a removed model even without a supplied generation", async () => {
  stubReadyChat();
  const deps = startupDeps(() =>
    Promise.resolve({ modelIds: [], chatModelIds: [], embeddingModelIds: [] }),
  );
  const config = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(config, true);
  await explicitlyRefreshStartupCatalog(deps, requiredStartupProvider(config));
  deps.gatewayConfig?.recordVerifiedCapability(
    "chat-model",
    { conversationReady: true },
    new Date().toISOString(),
  );
  expect(deps.gatewayConfig?.verifiedCapability("chat-model")).toBeUndefined();
});

it("invalidates completed discovery on credential rotation at the same endpoint", async () => {
  stubReadyChat();
  const discovery = vi.fn().mockResolvedValue(discoveredCatalog());
  const deps = startupDeps(discovery);
  const first = startupConfig();
  deps.gatewayConfig?.set(first, true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledOnce();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rotated = {
    ...first,
    providers: first.providers.map((provider) => ({
      ...provider,
      apiKey: "rotated-synthetic-credential",
    })),
  };
  deps.gatewayConfig?.set(rotated, true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledTimes(2);
  });
  expect(discovery.mock.calls[1]?.[1]).toBe("rotated-synthetic-credential");
});

it("rejects a late inventory response after rotation of the same endpoint credential", async () => {
  stubReadyChat();
  const old = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const discovery = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(discoveredCatalog());
  const deps = startupDeps(discovery);
  const first = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(first, true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledOnce();
  });
  deps.gatewayConfig?.set(
    {
      ...first,
      providers: first.providers.map((provider) => ({
        ...provider,
        apiKey: "rotated-synthetic-credential",
      })),
    },
    true,
  );
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledTimes(2);
  });
  old.resolve({ modelIds: ["stale-chat"], chatModelIds: ["stale-chat"], embeddingModelIds: [] });
  await old.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(startupProviderIds(deps)).toEqual(["chat-model"]);
  expect(deps.gatewayConfig?.configured?.()?.providers[0]?.apiKey).toBe(
    "rotated-synthetic-credential",
  );
});

it("rejects incomplete raw runtime listings instead of deleting omitted models", () => {
  expect(() =>
    parseModelDiscovery({ data: [{ id: "new-chat" }, {}] }, undefined, { allowEmpty: true }),
  ).toThrow("invalid entry");
  expect(() => parseModelDiscovery({ data: [null] }, undefined, { allowEmpty: true })).toThrow(
    "invalid entry",
  );
  expect(
    parseModelDiscovery(
      { data: [{ id: "only-rerank", model_info: { mode: "rerank" } }] },
      undefined,
      { allowEmpty: true },
    ).modelIds,
  ).toEqual([]);
});

it("reconciles the actual models route including complete empty and later new catalog", async () => {
  let listed: unknown[] = [];
  const events: ServerLogEvent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/model/info"))
        return Promise.resolve(
          Response.json({
            data: [
              {
                model_name: "chat-model",
                model_info: { mode: "chat" },
              },
            ],
          }),
        );
      if (url.pathname.endsWith("/models")) return Promise.resolve(Response.json({ data: listed }));
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      );
    }),
  );
  const deps = startupDeps(undefined, events);
  const configured = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(configured, true);
  await vi.waitFor(() => {
    expect(startupProviderIds(deps)).toEqual([]);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(deps.gatewayConfig?.configured?.()?.providers).toEqual(configured.providers);
  listed = [{ id: "new-chat" }];
  const response = handleModels(
    { url: new URL("http://127.0.0.1/api/models?refresh=1") } as RouteContext,
    deps,
  );
  expect(response).toMatchObject({ status: 200, body: { models: [] } });
  await vi.waitFor(() => {
    expect(startupProviderIds(deps)).toEqual(["new-chat"]);
  });
  expect(requiredStartupProvider(deps.gatewayConfig?.current() ?? configured)).toMatchObject({
    catalogOrigin: "discovered",
    tokenCounter: "litellm",
    apiKey: requiredStartupProvider(configured).apiKey,
    timeoutMs: requiredStartupProvider(configured).timeoutMs,
  });
  const completion = catalogCompletions(events).at(-1);
  if (completion === undefined) throw new TypeError("Expected catalog completion.");
  expectActivityLogProof(
    "gateway.catalog.automatic.completed.line",
    formatActivityLogProofLine(completion),
  );
  expect(JSON.parse(formatActivityLogProofLine(completion)) as unknown).toMatchObject({
    outcome: "applied",
    configuredModelCount: 1,
    updatedModelCount: 1,
  });
  expect(JSON.stringify(events)).not.toContain("throwaway-key");
  expect(JSON.stringify(events)).not.toContain("provider.example.invalid");
});

it("does not delete active inventory on an incomplete actual models response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/model/info"))
        return Promise.resolve(Response.json({ data: [{ model_name: "chat-model" }] }));
      if (url.pathname.endsWith("/models"))
        return Promise.resolve(Response.json({ data: [{ id: "new-chat" }, {}] }));
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      );
    }),
  );
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(undefined, events);
  deps.gatewayConfig?.set(managedStartupConfig("discovered"), true);
  await vi.waitFor(() => {
    expect(catalogCompletions(events).length > 0).toBe(true);
  });
  expect(startupProviderIds(deps)).toEqual(["chat-model"]);
  const completion = catalogCompletions(events)[0];
  if (completion === undefined) throw new TypeError("Expected catalog completion.");
  expect(JSON.parse(formatActivityLogProofLine(completion)) as unknown).toMatchObject({
    outcome: "failed",
  });
});

it("refuses inventory mutation when the source-retaining catalog facet is unavailable", async () => {
  stubReadyChat();
  const deps = startupDeps(() =>
    Promise.resolve({ modelIds: [], chatModelIds: [], embeddingModelIds: [] }),
  );
  const config = {
    ...managedStartupConfig("discovered"),
    providers: managedStartupConfig("discovered").providers.map((provider) => {
      const { tokenCounter: _counter, ...withoutAutomaticStartup } = provider;
      return withoutAutomaticStartup;
    }),
  };
  deps.gatewayConfig?.set(config, true);
  const holder = deps.gatewayConfig;
  if (holder === undefined) throw new TypeError("Expected gateway owner.");
  const refine = vi.fn();
  await refreshLiteLlmGatewayCatalog(
    { ...deps, gatewayConfig: { ...holder, replaceCatalog: undefined, refine } },
    requiredStartupProvider(config),
    new AbortController().signal,
    "corr-unavailable-catalog-facet",
  );
  expect(refine).not.toHaveBeenCalled();
  expect(holder.current()?.providers).toEqual(config.providers);
});

it("retains catalog results across a producer-derived nonconnection bounds update", async () => {
  stubReadyChat();
  const discovery = vi.fn().mockResolvedValue(discoveredCatalog());
  const deps = startupDeps(discovery);
  const initial = startupConfig();
  deps.gatewayConfig?.set(initial, true);
  await vi.waitFor(() => {
    expect(discovery).toHaveBeenCalledOnce();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const produced = parseGatewayConfig(rawConfigFromCurrent(initial, undefined, 2000));
  expect(produced.providers[0]?.timeoutMs).toBe(2000);
  deps.gatewayConfig?.set(produced, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(discovery).toHaveBeenCalledOnce();
});

it.each([
  { apiKeyHeaderName: "api-key" },
  { endpointStyle: "azure-openai-deployment" as const, apiVersion: "2026-07-01" },
])(
  "invalidates completed catalog for an actual credential header or protocol rotation: %j",
  async (change) => {
    stubReadyChat();
    const discovery = vi.fn().mockResolvedValue(discoveredCatalog());
    const deps = startupDeps(discovery);
    const initial = startupConfig();
    deps.gatewayConfig?.set(initial, true);
    await vi.waitFor(() => {
      expect(discovery).toHaveBeenCalledOnce();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const produced = parseGatewayConfig({
      ...initial,
      providers: initial.providers.map((provider) => ({ ...provider, ...change })),
    });
    deps.gatewayConfig?.set(produced, true);
    await vi.waitFor(() => {
      expect(discovery).toHaveBeenCalledTimes(2);
    });
  },
);

it("reuses the actual metadata and models transport after a producer-derived bounds refinement", async () => {
  const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/model/info"))
      return Promise.resolve(
        Response.json({
          data: [
            { model_name: "chat-model", model_info: { mode: "chat", max_model_len: 128_000 } },
          ],
        }),
      );
    if (url.pathname.endsWith("/models"))
      return Promise.resolve(Response.json({ data: [{ id: "chat-model" }] }));
    return Promise.resolve(
      Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(undefined, events);
  const initial = managedStartupConfig("discovered");
  deps.gatewayConfig?.set(initial, true);
  await vi.waitFor(() => {
    expect(catalogCompletions(events).length > 0).toBe(true);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const countModels = (): number =>
    fetch.mock.calls.filter(([input]) =>
      (input instanceof Request ? input.url : String(input)).endsWith("/models"),
    ).length;
  expect(countModels()).toBe(1);
  const current = deps.gatewayConfig?.current();
  if (current === undefined) throw new TypeError("Expected gateway configuration.");
  deps.gatewayConfig?.set(parseGatewayConfig(rawConfigFromCurrent(current, undefined, 2000)), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(countModels()).toBe(1);
});

function stubReadyToolChat(): void {
  vi.stubGlobal("fetch", (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const calls =
      typeof init?.body === "string" && init.body.includes("report_readiness")
        ? [{ function: { name: "report_readiness", arguments: '{"status":"ok"}' } }]
        : undefined;
    return Promise.resolve(
      Response.json({
        choices: [
          {
            message: {
              content: "OK",
              ...(calls === undefined ? {} : { tool_calls: calls }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
}

function envCatalogState(): { configPath: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-startup-env-source-"));
  directories.push(dir);
  const configPath = join(dir, "keiko.config.json");
  const config = managedStartupConfig("discovered");
  const raw = rawConfigFromCurrent(config, undefined);
  raw.providers = config.providers.map(({ apiKey: _key, ...provider }) => provider);
  writeFileSync(configPath, JSON.stringify(raw));
  return {
    configPath,
    env: {
      KEIKO_MODEL_CHAT_MODEL_API_KEY: "synthetic-env-only-credential",
      KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
    },
  };
}

function configuredEnvCatalog(
  configPath: string,
  env: Record<string, string>,
  modelIds: readonly string[],
): UiHandlerDeps {
  const deps = buildUiHandlerDeps({
    configPath,
    env,
    uiDbPath: `${configPath}.ui.db`,
    evidenceDir: `${configPath}.evidence`,
    gatewayModelDiscovery: () =>
      Promise.resolve({ modelIds, chatModelIds: modelIds, embeddingModelIds: [] }),
  });
  compositions.push(deps);
  return deps;
}

interface StoredCredentialProvider {
  readonly modelId: string;
  readonly apiKey?: string;
  readonly apiKeySecretRef?: string;
  readonly apiKeySourceModelId?: string;
}

function persistedCredentialProviders(configPath: string): readonly StoredCredentialProvider[] {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    providers: readonly StoredCredentialProvider[];
  };
  return raw.providers;
}

it("keeps a connection env-only credential transient on newly discovered aliases", async () => {
  stubReadyToolChat();
  const { configPath, env } = envCatalogState();
  const deps = configuredEnvCatalog(configPath, env, ["chat-model", "new-chat"]);
  await vi.waitFor(() => {
    expect(startupModels(deps).find((model) => model.id === "new-chat")?.toolCalling).toBe(true);
  });
  const persisted = persistedCredentialProviders(configPath);
  expect(persisted.find((provider) => provider.modelId === "new-chat")).toMatchObject({
    apiKeySourceModelId: "chat-model",
  });
  expect(
    persisted.find((provider) => provider.modelId === "new-chat")?.apiKeySecretRef,
  ).toBeUndefined();
  expect(persisted.every((provider) => provider.apiKey === undefined)).toBe(true);
  expect(
    openProviderCredentialVault({ configPath, env }).get(providerSecretRef("new-chat")),
  ).toBeUndefined();
});

function activeCredentialProviders(deps: UiHandlerDeps): readonly string[] {
  return deps.gatewayConfig?.current()?.providers.map((provider) => provider.modelId) ?? [];
}

function configuredAliasKey(deps: UiHandlerDeps): string | undefined {
  return deps.gatewayConfig
    ?.configured?.()
    ?.providers.find((provider) => provider.modelId === "new-chat")?.apiKey;
}

async function expectReadyAlias(deps: UiHandlerDeps): Promise<void> {
  await vi.waitFor(() => {
    expect(startupModels(deps).find((model) => model.id === "new-chat")?.toolCalling).toBe(true);
  });
}

it("retains credential sources across actual reconciliation, empty inventory, restart and rotation", async () => {
  stubReadyToolChat();
  const { configPath, env } = envCatalogState();
  const initial = configuredEnvCatalog(configPath, env, ["chat-model", "new-chat"]);
  await expectReadyAlias(initial);
  await initial.dispose?.();
  const rotatedEnv = { ...env, KEIKO_MODEL_CHAT_MODEL_API_KEY: "rotated-transient-source" };
  const empty = configuredEnvCatalog(configPath, rotatedEnv, []);
  await vi.waitFor(() => {
    expect(empty.gatewayConfig?.current()?.providers).toEqual([]);
  });
  expect(configuredAliasKey(empty)).toBe("rotated-transient-source");
  expect(persistedCredentialProviders(configPath).map((provider) => provider.modelId)).toEqual([
    "chat-model",
    "new-chat",
  ]);
  await empty.dispose?.();
  const restored = configuredEnvCatalog(configPath, rotatedEnv, ["new-chat"]);
  await vi.waitFor(() => {
    expect(activeCredentialProviders(restored)).toEqual(["new-chat"]);
  });
  await expectReadyAlias(restored);
  expect(configuredAliasKey(restored)).toBe("rotated-transient-source");
  expect(
    persistedCredentialProviders(configPath).find((provider) => provider.modelId === "chat-model"),
  ).toBeDefined();
  expect(
    openProviderCredentialVault({ configPath, env }).get(providerSecretRef("new-chat")),
  ).toBeUndefined();
});

it("preserves the actual durable source reference after transient alias reconciliation and restart", async () => {
  stubReadyToolChat();
  const { configPath, env } = envCatalogState();
  const reference = "existing-source-reference";
  const vault = openProviderCredentialVault({ configPath, env });
  vault.set(reference, "durable-source-credential");
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  raw.providers = persistedCredentialProviders(configPath).map((provider) => ({
    ...provider,
    apiKeySecretRef: reference,
  }));
  writeFileSync(configPath, JSON.stringify(raw));
  const initial = configuredEnvCatalog(configPath, env, ["chat-model", "new-chat"]);
  await expectReadyAlias(initial);
  expect(
    persistedCredentialProviders(configPath).find((provider) => provider.modelId === "chat-model")
      ?.apiKeySecretRef,
  ).toBe(reference);
  await initial.dispose?.();
  const { KEIKO_MODEL_CHAT_MODEL_API_KEY: _override, ...durableEnv } = env;
  const restored = configuredEnvCatalog(configPath, durableEnv, ["new-chat"]);
  await vi.waitFor(() => {
    expect(activeCredentialProviders(restored)).toEqual(["new-chat"]);
  });
  await expectReadyAlias(restored);
  expect(configuredAliasKey(restored)).toBe("durable-source-credential");
  expect(vault.get(reference)).toBe("durable-source-credential");
  expect(vault.get(providerSecretRef("new-chat"))).toBeUndefined();
});

function requestOwnedCodingConfig(): ReturnType<typeof parseGatewayConfig> {
  const config = startupConfig();
  const provider = requiredStartupProvider(config);
  return parseGatewayConfig({
    ...rawConfigFromCurrent(config, undefined),
    capabilities: config.capabilities?.map((model) => ({
      ...model,
      toolCalling: true,
      toolCallingVerification: {
        status: "verified",
        probe: "gateway-tool-calling-v1",
        checkedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        configurationFingerprint: toolCallingConfigurationFingerprint(provider),
      },
    })),
  });
}

it("aborts a request-owned Workbench probe joined by startup and waits for its physical settlement", async () => {
  const env = { KEIKO_CODING_SIDECAR_DISABLED: "1" };
  let aborted = false;
  let release: (() => void) | undefined;
  vi.stubGlobal("fetch", (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (typeof init?.body !== "string" || !init.body.includes("report_readiness"))
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      );
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      release = (): void => {
        if (aborted) reject(new DOMException("Synthetic physical request cancelled", "AbortError"));
        else
          resolve(
            Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
          );
      };
    });
  });
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(() => Promise.resolve(discoveredCatalog()), events, env);
  deps.gatewayConfig?.set(requestOwnedCodingConfig(), true);
  const request = ensureCodingWorkbenchContextWindows(
    deps,
    "chat-model",
    "corr-request-owned-workbench",
  );
  await vi.waitFor(() => {
    expect(release).toBeTypeOf("function");
  });
  env.KEIKO_CODING_SIDECAR_DISABLED = "0";
  deps.refreshGatewayCatalog?.("corr-reload-joins-request-owned");
  await new Promise<void>((resolve) => setImmediate(resolve));
  let disposed = false;
  const disposal = Promise.resolve(deps.dispose?.()).then(() => {
    disposed = true;
  });
  try {
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
    });
    expect(disposed).toBe(false);
  } finally {
    release?.();
    await request;
    await disposal;
  }
  expect(disposed).toBe(true);
  expect(
    events.some(
      (event) =>
        event.correlationId === "corr-request-owned-workbench" &&
        event.op === "gateway.readiness.automatic.completed",
    ),
  ).toBe(true);
});

function sharedConnectionConfig(): ReturnType<typeof parseGatewayConfig> {
  const initial = startupConfig();
  const provider = requiredStartupProvider(initial);
  return parseGatewayConfig({
    ...initial,
    providers: [provider, { ...provider, modelId: "second-chat" }],
    capabilities: [
      ...(initial.capabilities ?? []),
      {
        ...createDefaultChatCapability("second-chat"),
        contextWindow: 64_000,
        maxOutputTokens: 2000,
      },
    ],
  });
}

it("keeps completed discovery when the representative model is reordered or removed", async () => {
  stubReadyChat();
  const discovery = vi.fn().mockResolvedValue({
    modelIds: ["chat-model", "second-chat"],
    chatModelIds: ["chat-model", "second-chat"],
    embeddingModelIds: [],
  });
  const deps = startupDeps(discovery, undefined, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
  const initial = sharedConnectionConfig();
  deps.gatewayConfig?.set(initial, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(discovery).toHaveBeenCalledOnce();
  deps.gatewayConfig?.set({ ...initial, providers: [...initial.providers].reverse() }, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(discovery).toHaveBeenCalledOnce();
  deps.gatewayConfig?.set({ ...initial, providers: initial.providers.slice(1) }, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(discovery).toHaveBeenCalledOnce();
});

it("does not let an older conclusive discovery clear the current generation retry", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const old = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const discovery = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockRejectedValue(new Error("Synthetic retryable transport fault."));
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(discovery, events, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
  const initial = startupConfig();
  deps.gatewayConfig?.set(initial, true, "corr-old-config");
  await vi.advanceTimersByTimeAsync(0);
  deps.gatewayConfig?.set(
    {
      ...initial,
      providers: initial.providers.map((provider) => ({
        ...provider,
        apiKey: "rotated-throwaway-key",
      })),
    },
    true,
    "corr-current-config",
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery).toHaveBeenCalledTimes(2);
  old.resolve(discoveredCatalog());
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1);
  expect(discovery).toHaveBeenCalledTimes(3);
  const completions = catalogCompletions(events);
  expect(JSON.parse(formatActivityLogProofLine(completions.at(-1) ?? {})) as unknown).toMatchObject(
    { parentCorrelationId: "corr-current-config" },
  );
});

it("starts a changed connection with its own first retry delay and parent", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const discovery = vi.fn().mockRejectedValue(new Error("Synthetic retryable transport fault."));
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(discovery, events, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
  const initial = startupConfig();
  deps.gatewayConfig?.set(initial, true, "corr-old-config");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1);
  expect(discovery).toHaveBeenCalledTimes(2);
  deps.gatewayConfig?.set(
    {
      ...initial,
      providers: initial.providers.map((provider) => ({
        ...provider,
        apiKey: "rotated-throwaway-key",
      })),
    },
    true,
    "corr-current-config",
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1);
  expect(discovery).toHaveBeenCalledTimes(4);
  const completion = events
    .filter((event) => event.op === "gateway.catalog.automatic.completed")
    .at(-1);
  expect(JSON.parse(formatActivityLogProofLine(completion ?? {})) as unknown).toMatchObject({
    parentCorrelationId: "corr-current-config",
  });
});

it("bounds an inconclusive tool-only startup burst and allows explicit reload recovery", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let toolCalls = 0;
  let recovered = false;
  vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
    const tools = typeof init?.body === "string" && init.body.includes("report_readiness");
    if (tools) toolCalls++;
    if (tools && !recovered) return Promise.resolve(new Response("", { status: 503 }));
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
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(() => Promise.resolve(discoveredCatalog()), events);
  deps.gatewayConfig?.set(startupConfig(), true, "corr-startup-burst");
  await vi.advanceTimersByTimeAsync(0);
  expect(toolCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(toolCalls).toBe(3);
  recovered = true;
  deps.refreshGatewayCatalog?.("corr-explicit-reload");
  await vi.advanceTimersByTimeAsync(0);
  expect(toolCalls).toBe(4);
  expect(startupModels(deps)[0]?.toolCallingVerification?.status).toBe("verified");
});

it("records factual retry decisions and attempt identity without inventing catalog IO", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const events: ServerLogEvent[] = [];
  const discovery = vi.fn().mockRejectedValue(new Error("Synthetic transport outage."));
  const deps = startupDeps(discovery, events, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
  deps.gatewayConfig?.set(startupConfig(), true, "corr-retry-owner");
  await vi.advanceTimersByTimeAsync(0);
  const failed = catalogCompletions(events)[0];
  expect(failed?.extra).toMatchObject({
    outcome: "failed",
    backgroundAttempt: 1,
    configurationGeneration: deps.gatewayConfig?.generation(),
  });
  const scheduled = events.find((event) => event.extra?.retryDisposition === "scheduled");
  expect(scheduled?.extra).toMatchObject({
    phase: "retry-decision",
    backgroundAttempt: 1,
    retryDelayMs: WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1,
  });
  expect(scheduled?.extra?.retryDeadlineMs).toBe(
    Date.now() + WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1,
  );
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(discovery).toHaveBeenCalledTimes(3);
  const exhausted = events.find((event) => event.extra?.retryDisposition === "exhausted");
  expect(exhausted?.extra).toMatchObject({
    phase: "retry-decision",
    backgroundAttempt: 3,
    updatedModelCount: 0,
    retryable: false,
  });
  expectStartupRetryProofs(events, [scheduled, exhausted]);
  expect(JSON.stringify(events)).not.toContain("throwaway-key");
  expect(JSON.stringify(events)).not.toContain("provider.example.invalid");
});

type CatalogCompletionCase = "unchanged" | "stale" | "cancelled" | "failed";

async function actualCatalogCompletion(
  outcome: CatalogCompletionCase,
  parentCorrelationId?: string,
): Promise<ServerLogEvent> {
  stubReadyChat();
  const held = deferredValue<ReturnType<typeof discoveredCatalog>>();
  const discovery =
    outcome === "failed"
      ? (): Promise<ReturnType<typeof discoveredCatalog>> =>
          Promise.reject(
            Object.assign(new Error("Synthetic private failure."), { httpStatus: 503 }),
          )
      : (): Promise<ReturnType<typeof discoveredCatalog>> => held.promise;
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(discovery, events, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
  const config = manualCatalogConfig();
  deps.gatewayConfig?.set(config, true, parentCorrelationId);
  const controller = new AbortController();
  const completion = refreshLiteLlmGatewayCatalog(
    withReadinessParentCorrelation(deps, parentCorrelationId),
    requiredStartupProvider(config),
    controller.signal,
    `corr-catalog-${outcome}`,
  );
  if (outcome === "stale")
    deps.gatewayConfig?.set(
      {
        ...config,
        providers: config.providers.map((provider) => ({
          ...provider,
          apiKey: "rotated-throwaway-key",
        })),
      },
      true,
    );
  if (outcome === "cancelled") controller.abort();
  held.resolve(discoveredCatalog());
  await completion;
  const event = catalogCompletions(events)[0];
  if (event === undefined) throw new TypeError("Expected actual catalog completion.");
  return event;
}

it.each(["unchanged", "stale", "cancelled", "failed"] as const)(
  "qualifies the actual %s catalog completion with original classification and causal envelope",
  async (outcome) => {
    const event = await actualCatalogCompletion(outcome, "corr-state-parent");
    const record = expectActivityLogProof(
      "gateway.catalog.automatic.completed.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      outcome,
      configuredModelCount: 1,
      updatedModelCount: 0,
      retryable: outcome === "stale" || outcome === "failed",
      parentCorrelationId: "corr-state-parent",
      correlationId: `corr-catalog-${outcome}`,
    });
    if (outcome === "failed") expect(record.errorKind).toBe("unavailable");
    if (outcome === "cancelled") expect(record.errorKind).toBe("cancelled");
    expect(JSON.stringify(record)).not.toContain("Synthetic private failure");
    expect(JSON.stringify(record)).not.toContain("throwaway-key");
  },
);

it("retains an actual failed catalog completion in the original incident query", async () => {
  const stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-catalog-incident-"));
  directories.push(stateDir);
  const fromMs = Date.now() - 1;
  const event = await actualCatalogCompletion("failed");
  const sink = createFileServerLogSink(stateDir);
  sink.write(event);
  sink.close?.();
  const schema = activityLogOperationSchema("gateway.catalog.automatic.completed");
  expect(schema?.diagnosticWhen).toContainEqual({ field: "outcome", values: ["failed"] });
  const { result } = executeLocalSupportQuery(
    stateDir,
    {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [{ fromMs, toMs: Date.now() + 1 }],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxContextEvents: 0 },
    { trigger: "query" },
  );
  const catalog = result.events.filter(
    (selected) => selected.parsed.view.op === "gateway.catalog.automatic.completed",
  );
  expect(catalog).toHaveLength(1);
  expect(catalog[0]?.role).toBe("closure");
});

it.each(["backoff", "in-flight", "conclusive"] as const)(
  "records the actual %s catalog skip without a second discovery",
  async (disposition) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    stubReadyChat();
    const held = deferredValue<ReturnType<typeof discoveredCatalog>>();
    const events: ServerLogEvent[] = [];
    const discovery = vi.fn(() =>
      disposition === "in-flight"
        ? held.promise
        : Promise.reject(
            disposition === "conclusive"
              ? Object.assign(new Error("Synthetic credential refusal."), { httpStatus: 401 })
              : new Error("Synthetic transport fault."),
          ),
    );
    const deps = startupDeps(discovery, events, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
    const config = startupConfig();
    deps.gatewayConfig?.set(config, true, "corr-skip-owner");
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (disposition === "conclusive") deps.gatewayConfig?.set(config, true, "corr-skip-current");
      else deps.refreshGatewayCatalog?.("corr-skip-current");
      await vi.advanceTimersByTimeAsync(0);
      expect(discovery).toHaveBeenCalledOnce();
      const event = events.find((candidate) => candidate.extra?.retryDisposition === disposition);
      const record = expectActivityLogProof(
        "gateway.catalog.automatic.completed.line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(record).toMatchObject({
        phase: "retry-decision",
        retryDisposition: disposition,
        configuredModelCount: 1,
        updatedModelCount: 0,
        parentCorrelationId: "corr-skip-current",
        backgroundAttempt: disposition === "backoff" ? 2 : 1,
      });
      if (disposition === "backoff")
        expect(record.retryDeadlineMs).toBe(
          Date.now() + WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1,
        );
    } finally {
      held.resolve(discoveredCatalog());
      await vi.advanceTimersByTimeAsync(0);
    }
  },
);

function expectStartupRetryProofs(
  events: readonly ServerLogEvent[],
  decisions: readonly (ServerLogEvent | undefined)[],
): void {
  for (const event of catalogCompletions(events)) {
    const record = expectActivityLogProof(
      "gateway.catalog.automatic.completed.line",
      formatActivityLogProofLine(event),
    );
    expect(record).toMatchObject({
      phase: "catalog",
      outcome: "failed",
      errorKind: "unavailable",
      parentCorrelationId: "corr-retry-owner",
    });
  }
  expect(catalogCompletions(events).map((event) => event.extra?.backgroundAttempt)).toEqual([
    1, 2, 3,
  ]);
  expect(new Set(catalogCompletions(events).map((event) => event.correlationId)).size).toBe(3);
  for (const decision of decisions) {
    expectActivityLogProof(
      "gateway.catalog.automatic.completed.line",
      formatActivityLogProofLine(decision ?? {}),
    );
  }
}

it("lets an explicit reload recover at the existing connection backoff after a bounded burst", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  stubReadyChat();
  const discovery = vi.fn().mockRejectedValue(new Error("Synthetic transport fault."));
  const events: ServerLogEvent[] = [];
  const deps = startupDeps(discovery, events, { KEIKO_CODING_SIDECAR_DISABLED: "1" });
  deps.gatewayConfig?.set(startupConfig(), true, "corr-before-exhaustion");
  await vi.advanceTimersByTimeAsync(3 * (WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS + 1));
  expect(discovery).toHaveBeenCalledTimes(3);
  discovery.mockResolvedValue(discoveredCatalog());
  deps.refreshGatewayCatalog?.("corr-early-explicit-reload");
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery).toHaveBeenCalledTimes(3);
  const backoff = events.find((event) => event.extra?.retryDisposition === "backoff");
  const remainingDelay = backoff?.extra?.retryDelayMs;
  if (typeof remainingDelay !== "number") throw new TypeError("Expected existing backoff delay.");
  await vi.advanceTimersByTimeAsync(remainingDelay + 1);
  expect(discovery).toHaveBeenCalledTimes(4);
  expect(catalogCompletions(events).at(-1)?.extra?.outcome).toBe("unchanged");
});
