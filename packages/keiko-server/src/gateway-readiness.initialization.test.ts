import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseGatewayConfig, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { validateRegisteredActivityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { buildUiHandlerDeps, currentConversationReady, type UiHandlerDeps } from "./deps.js";
import {
  CHAT_MODEL_WALK_BUDGET_MS,
  awaitAnyInitializedConversationReadyChatModel,
  awaitInitializedConversationReadiness,
  initializeConfiguredConversationReadiness,
  NOT_READY_REPROBE_COOLDOWN_MS,
} from "./gateway-readiness.js";
import { handleModels } from "./read-handlers.js";
import type { RouteContext } from "./routes.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const compositions: UiHandlerDeps[] = [];
const directories: string[] = [];

it.each([
  ["selected", awaitInitializedConversationReadiness],
  ["default", awaitAnyInitializedConversationReadyChatModel],
] as const)(
  "keeps %s Chat admission pending through a three-minute shared probe",
  async (_name, join) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const deps = composition();
    vi.useFakeTimers();
    let release: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    configure(deps, "corr-slow-initialization");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    let settled = false;
    const admission = join(deps, "chat-model", "corr-slow-admission").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(180_000);
    const settledBeforeAnswer = settled;
    release?.(chatProbeAnswer());
    await admission;
    await vi.advanceTimersByTimeAsync(0);
    expect(settledBeforeAnswer).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(currentConversationReady(deps, "chat-model")).toBe(true);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.readiness.automatic.joined",
        correlationId: "corr-slow-admission",
      }),
    );
  },
);

it.each([
  ["selected", awaitInitializedConversationReadiness],
  ["default", awaitAnyInitializedConversationReadyChatModel],
] as const)("keeps a shared probe alive after one %s waiter expires", async (_name, join) => {
  const deps = composition();
  vi.useFakeTimers();
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-long-probe", CHAT_MODEL_WALK_BUDGET_MS * 2);
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  let firstSettled = false;
  const first = join(deps, "chat-model", "corr-first-waiter").then(() => {
    firstSettled = true;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  let laterSettled = false;
  const later = join(deps, "chat-model", "corr-later-waiter").then(() => {
    laterSettled = true;
  });
  await vi.advanceTimersByTimeAsync(CHAT_MODEL_WALK_BUDGET_MS - 60_001);
  expect(firstSettled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await first;
  expect(firstSettled).toBe(true);
  expect(laterSettled).toBe(false);
  expect(currentConversationReady(deps, "chat-model")).toBe(false);
  release?.(chatProbeAnswer());
  await later;
  expect(laterSettled).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(currentConversationReady(deps, "chat-model")).toBe(true);
});

afterEach(async (): Promise<void> => {
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetServerLogger();
});

function composition(): UiHandlerDeps {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-readiness-initialization-"));
  directories.push(dir);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env: { KEIKO_MEMORY_DIR: join(dir, "memory") },
    uiDbPath: join(dir, "keiko-ui.db"),
    evidenceDir: join(dir, "evidence"),
  });
  compositions.push(deps);
  return deps;
}

function configure(deps: UiHandlerDeps, correlationId: string, timeoutMs = 1000): void {
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "chat-model",
          baseUrl: "https://provider.example.invalid/v1",
          apiKey: "throwaway-key",
          timeoutMs,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
    }),
    true,
    correlationId,
  );
}

it("isolates throwing subscribers and retains the configuration request's causal correlation", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const deps = composition();
  const listener = vi.fn();
  deps.gatewayConfig?.subscribe?.((): void => {
    throw new TypeError("private subscriber detail");
  });
  deps.gatewayConfig?.subscribe?.(listener);
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  expect(() => {
    configure(deps, "corr-config-subscription");
  }).not.toThrow();
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-chat-join");
  expect(listener).toHaveBeenCalledWith("corr-config-subscription");
  expect(deps.gatewayConfig?.generation()).toBe(1);
  const started = sink.events.find((event) => event.op === "gateway.readiness.automatic.started");
  expect(started?.parentCorrelationId).toBe("corr-config-subscription");
  expect(started?.correlationId).not.toBe(deps.gatewayConfig?.initializationCorrelationId);
  expect(JSON.stringify(sink.events)).not.toContain("private subscriber detail");
  // PR #3678: the parent correlation used to be added with a plain spread, which dropped the
  // registration marker, so the file writer discarded every startup probe line as unregistered.
  const probeLines = sink.events.filter(
    (event) =>
      event.op === "gateway.readiness.automatic.started" ||
      event.op === "gateway.readiness.automatic.completed" ||
      event.op.startsWith("http.gateway.fetch."),
  );
  expect(probeLines.length).toBeGreaterThanOrEqual(3);
  for (const line of probeLines) {
    expect(() => validateRegisteredActivityLogEvent(line)).not.toThrow();
  }
});

it("disposal cancels recovery timers and ignores subsequent configuration changes", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response("", { status: 503 })));
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-outage");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  const calls = fetch.mock.calls.length;
  await deps.dispose?.();
  compositions.splice(compositions.indexOf(deps), 1);
  configure(deps, "corr-after-disposal");
  await vi.advanceTimersByTimeAsync(3 * NOT_READY_REPROBE_COOLDOWN_MS);
  expect(fetch).toHaveBeenCalledTimes(calls);
});

// Owner decision 2026-11-05: cache startup failure until explicit verification, including after
// a long outage; Chat requests do not become hidden health checks.
it("retains a failed startup check until an explicit recheck, without probing on Chat requests", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const gateway = { status: 404 };
  const fetch = startingGateway(gateway);
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-failed");
  await vi.waitFor(() => {
    expect(chatModelReady(deps)).toBe(false);
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(chatModelReady(deps)).toBe(false);
  await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
  gateway.status = 200;
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(fetch).toHaveBeenCalledOnce();
  expect(chatModelReady(deps)).toBe(false);
  initializeConfiguredConversationReadiness(deps, "corr-explicit-recheck", true);
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(chatModelReady(deps)).toBe(true);
});

function chatProbeAnswer(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
    { headers: { "content-type": "application/json" } },
  );
}

// A gateway that answers a definitive 4xx while it starts and a healthy answer afterwards: the
// customer's 1.1.13 incident. `state.status` is what the next provider request receives.
function startingGateway(state: { status: number }): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        state.status === 200 ? chatProbeAnswer() : new Response("", { status: state.status }),
      ),
    );
}

function chatModelReady(deps: UiHandlerDeps): boolean | undefined {
  return deps.gatewayConfig?.verifiedCapability("chat-model")?.fields.conversationReady;
}

// A browser reload refreshes discovery, but does not retry a rejected startup chat check.
it("does not repeat a failed startup check on page reload", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const gateway = { status: 404 };
  const fetch = startingGateway(gateway);
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-rejection");
  await vi.waitFor(() => {
    expect(chatModelReady(deps)).toBe(false);
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  gateway.status = 200;
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  handleModels({ url: new URL("http://127.0.0.1/api/models?refresh=1") } as RouteContext, deps);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
  expect(chatModelReady(deps)).toBe(false);
});

// Owner decision 2026-11-05: an old success remains usable, so a page load does
// not re-probe it; on a large gateway every reload after five idle minutes probed every model.
it("does not re-check an old success on a page load", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const gateway = { status: 200 };
  const fetch = startingGateway(gateway);
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-success");
  await vi.waitFor(() => {
    expect(chatModelReady(deps)).toBe(true);
  });
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  handleModels({ url: new URL("http://127.0.0.1/api/models?refresh=1") } as RouteContext, deps);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetch).toHaveBeenCalledOnce();
});

it("never adds provider traffic from repeated Chat sends after a failed startup check", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = startingGateway({ status: 404 });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-failed");
  await awaitInitializedConversationReadiness(deps, "chat-model");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1);
    await awaitInitializedConversationReadiness(deps, "chat-model");
  }
  expect(fetch).toHaveBeenCalledOnce();
  expect(chatModelReady(deps)).toBe(false);
});

it("adds no probe for a concurrent Chat burst after the startup result settled", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = startingGateway({ status: 404 });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-failed");
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1);
  await Promise.all(
    Array.from({ length: 5 }, () => awaitInitializedConversationReadiness(deps, "chat-model")),
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(chatModelReady(deps)).toBe(false);
});

it("never lets a conversation request probe after the configuration was disposed", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = startingGateway({ status: 404 });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-4xx");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await deps.dispose?.();
  compositions.splice(compositions.indexOf(deps), 1);
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1_000);

  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-after-disposal");

  expect(fetch).toHaveBeenCalledTimes(1);
});

it("answers a request whose re-probe cannot reach the gateway instead of throwing", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = startingGateway({ status: 404 });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-4xx");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1_000);
  fetch.mockRejectedValue(new TypeError("fetch failed"));

  await expect(
    awaitInitializedConversationReadiness(deps, "chat-model", "corr-unreachable"),
  ).resolves.toBeUndefined();

  expect(chatModelReady(deps)).toBe(false);
});

it("retains a healthy model through a long idle without timer or Chat probes", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = vi.fn(() => Promise.resolve(chatProbeAnswer()));
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-healthy-model");
  await vi.waitFor(() => {
    expect(chatModelReady(deps)).toBe(true);
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(currentConversationReady(deps, "chat-model")).toBe(true);
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-after-expiry");
  expect(fetch).toHaveBeenCalledOnce();
  expect(currentConversationReady(deps, "chat-model")).toBe(true);
});

it("reuses the same generation after repeated initialization and Chat requests", async () => {
  const deps = composition();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
  const fetch = vi.fn(() =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-same-generation-renewal");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  await vi.advanceTimersByTimeAsync(0);
  await awaitInitializedConversationReadiness(deps, "chat-model");
  const generation = deps.gatewayConfig?.generation();
  vi.setSystemTime(new Date("2026-10-08T12:06:00.000Z"));
  initializeConfiguredConversationReadiness(deps, "corr-reload-one");
  initializeConfiguredConversationReadiness(deps, "corr-reload-two");
  await Promise.all([
    awaitInitializedConversationReadiness(deps, "chat-model", "corr-selected-one"),
    awaitInitializedConversationReadiness(deps, "chat-model", "corr-selected-two"),
  ]);
  expect(deps.gatewayConfig?.generation()).toBe(generation);
  expect(fetch).toHaveBeenCalledOnce();
});

it("returns cached local models synchronously after a long idle and repeated reloads", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = startingGateway({ status: 200 });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-success");
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  for (let reload = 0; reload < 3; reload += 1) {
    const result = handleModels(
      { url: new URL("http://127.0.0.1/api/models?refresh=1") } as RouteContext,
      deps,
    );
    expect(result).toMatchObject({
      status: 200,
      body: { models: [expect.objectContaining({ conversationReady: true })] },
    });
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps the existing two-slot ceiling while background and selected requests share queued work", async () => {
  const deps = composition();
  vi.useFakeTimers();
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        active++;
        maximum = Math.max(maximum, active);
        releases.push(() => {
          active--;
          resolve(chatProbeAnswer());
        });
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const config = parseGatewayConfig({
    providers: ["first-chat", "second-chat", "third-chat", "fourth-chat"].map((modelId) => ({
      modelId,
      baseUrl: "https://provider.example.invalid/v1",
      apiKey: "throwaway-key",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    })),
  });
  deps.gatewayConfig?.set(config, true, "corr-two-slot-source");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  initializeConfiguredConversationReadiness(deps, "corr-two-slot-reload");
  const selected = awaitInitializedConversationReadiness(
    deps,
    "third-chat",
    "corr-queued-selection",
  );
  releases.splice(0).forEach((release) => {
    release();
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(maximum).toBe(2);
  releases.splice(0).forEach((release) => {
    release();
  });
  await selected;
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(maximum).toBe(2);
});

it("rejects a late removed-model chat success through the same current generation owner", async () => {
  const deps = composition();
  vi.useFakeTimers();
  let release: ((value: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-removed-chat-source");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  const holder = deps.gatewayConfig;
  const config = holder?.current();
  if (config === undefined || holder?.replaceCatalog === undefined)
    throw new TypeError("Expected catalog owner.");
  holder.replaceCatalog({ ...config, providers: [], capabilities: [] }, holder.generation());
  release?.(chatProbeAnswer());
  await vi.advanceTimersByTimeAsync(0);
  expect(holder.verifiedCapability("chat-model")).toBeUndefined();
  expect(fetch).toHaveBeenCalledOnce();
});

it("retains the rotated connection result when an older chat failure finally arrives", async () => {
  const deps = composition();
  vi.useFakeTimers();
  let release: ((value: Response) => void) | undefined;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(() => Promise.resolve(chatProbeAnswer()));
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-old-chat-connection");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  const holder = deps.gatewayConfig;
  const config = holder?.current();
  if (config === undefined || holder === undefined) throw new TypeError("Expected gateway owner.");
  holder.set(
    {
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        apiKey: "rotated-synthetic-key",
      })),
    },
    true,
  );
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  await vi.advanceTimersByTimeAsync(0);
  const observation = holder.verifiedCapability("chat-model");
  expect(observation?.fields.conversationReady).toBe(true);
  release?.(Response.json({ choices: [] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(holder.verifiedCapability("chat-model")).toEqual(observation);
  expect(fetch).toHaveBeenCalledTimes(2);
});

// Customer 1.3.4: every proof another model's check persisted advanced the configuration
// generation, and startup checked a busy model again for each one, a burst of probes nobody asked
// for. A model is checked once per connection; a page load still asks again.
it("does not repeat a startup check when only the generation advanced", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const fetch = vi.fn(() => Promise.resolve(new Response("", { status: 503 })));
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-busy-startup");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  await vi.advanceTimersByTimeAsync(0);
  const holder = deps.gatewayConfig;
  const config = holder?.current();
  if (config === undefined || holder === undefined) throw new TypeError("Expected gateway owner.");
  const generation = holder.generation();
  holder.set({ ...config }, true, "corr-proof-persisted");
  expect(holder.generation()).toBe(generation + 1);
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS);
  expect(fetch).toHaveBeenCalledOnce();
  initializeConfiguredConversationReadiness(deps, "corr-page-load", true);
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// Lab run 2026-11-08: startup discovery added a model the endpoint served while the configured
// model's startup check was still answering. The late answer belonged to the replaced generation
// and was dropped, and the unchanged connection was never checked again, so every Chat turn was
// refused as not ready until someone verified the model by hand. The check answers for that same
// connection, so its answer counts in the new generation, without a second provider call.
it("keeps an unchanged model's startup check when discovery replaces the generation during it", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const deps = composition();
  const holder = deps.gatewayConfig;
  if (holder?.replaceCatalog === undefined) throw new TypeError("Expected catalog owner.");
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn((_url: unknown, init?: { body?: unknown }) => {
    const first = release === undefined && String(init?.body).includes('"chat-model"');
    if (!first) return Promise.resolve(chatProbeAnswer());
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-race");
  await vi.waitFor(() => {
    expect(release).toBeDefined();
  });
  const current = holder.current();
  if (current === undefined) throw new TypeError("Expected a configuration.");
  const replaced = holder.replaceCatalog(
    withDiscoveredModel(current),
    holder.generation(),
    "corr-discovery",
  );
  expect(replaced).toBe(true);
  const generation = holder.generation();
  try {
    // The replaced generation joins the running check instead of seeing none: a first turn waits.
    await vi.waitFor(() => {
      const joined = sink.events.filter(
        (event) =>
          event.op === "gateway.readiness.automatic.joined" &&
          event.extra?.generation === generation,
      );
      expect(joined).toHaveLength(1);
    });
    const turn = awaitInitializedConversationReadiness(deps, "chat-model", "corr-first-turn");
    release?.(chatProbeAnswer());
    await turn;
  } finally {
    release?.(chatProbeAnswer());
  }
  expect(currentConversationReady(deps, "chat-model")).toBe(true);
  expect(runningChatProbes(fetch)).toBe(1);
});

// The late answer counts only while the new generation has none: it never overwrites a newer one,
// such as an explicit verification recorded meanwhile.
it("never lets a late startup answer overwrite a newer observation of the replaced generation", async () => {
  const deps = composition();
  const holder = deps.gatewayConfig;
  if (holder?.replaceCatalog === undefined) throw new TypeError("Expected catalog owner.");
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn((_url: unknown, init?: { body?: unknown }) => {
    const first = release === undefined && String(init?.body).includes('"chat-model"');
    if (!first) return Promise.resolve(chatProbeAnswer());
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-overtaken");
  await vi.waitFor(() => {
    expect(release).toBeDefined();
  });
  const current = holder.current();
  if (current === undefined) throw new TypeError("Expected a configuration.");
  expect(holder.replaceCatalog(withDiscoveredModel(current), holder.generation())).toBe(true);
  const generation = holder.generation();
  const newer = new Date().toISOString();
  holder.recordVerifiedCapability("chat-model", { conversationReady: false }, newer, generation);
  release?.(chatProbeAnswer());
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await vi.waitFor(() => {
    expect(runningChatProbes(fetch)).toBe(1);
  });
  expect(holder.verifiedCapability("chat-model")).toMatchObject({
    generation,
    checkedAt: newer,
    fields: { conversationReady: false },
  });
});

function runningChatProbes(fetch: ReturnType<typeof vi.fn>): number {
  return fetch.mock.calls.filter(([, init]) =>
    String((init as { body?: unknown } | undefined)?.body).includes('"chat-model"'),
  ).length;
}

// What startup discovery does when the endpoint serves one more model: the configured connection
// stays byte-identical and the generation advances.
function withDiscoveredModel(current: GatewayConfig): GatewayConfig {
  const added = parseGatewayConfig({
    providers: [
      {
        modelId: "added-model",
        baseUrl: "https://provider.example.invalid/v1",
        apiKey: "throwaway-key",
        timeoutMs: 1000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
  });
  return {
    ...current,
    providers: [...current.providers, ...added.providers],
    capabilities: [...(current.capabilities ?? []), ...(added.capabilities ?? [])],
  };
}
