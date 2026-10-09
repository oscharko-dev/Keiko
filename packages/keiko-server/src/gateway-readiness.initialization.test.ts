import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { validateRegisteredActivityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  buildUiHandlerDeps,
  CONVERSATION_READINESS_MAX_AGE_MS,
  currentConversationReady,
  type UiHandlerDeps,
} from "./deps.js";
import {
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
    env: {},
    uiDbPath: join(dir, "keiko-ui.db"),
    evidenceDir: join(dir, "evidence"),
  });
  compositions.push(deps);
  return deps;
}

function configure(deps: UiHandlerDeps, correlationId: string): void {
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "chat-model",
          baseUrl: "https://provider.example.invalid/v1",
          apiKey: "throwaway-key",
          timeoutMs: 1000,
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

it("bounds recovery traffic during a long outage and heals within five minutes", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const deps = composition();
  vi.useFakeTimers();
  let available = false;
  const fetch = vi.fn().mockImplementation(() =>
    Promise.resolve(
      available
        ? new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
            headers: { "content-type": "application/json" },
          })
        : new Response("", { status: 503 }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-prolonged-outage");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2 * NOT_READY_REPROBE_COOLDOWN_MS + 1);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(4 * NOT_READY_REPROBE_COOLDOWN_MS + 1);
  expect(fetch).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
  expect(fetch.mock.calls.length).toBeGreaterThan(4);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(60);
  available = true;
  const callsBeforeRecovery = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  expect(fetch.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);
  expect(deps.gatewayConfig?.verifiedCapability("chat-model")?.fields.conversationReady).toBe(true);
  const callsAfterRecovery = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
  expect(fetch.mock.calls.length).toBeGreaterThan(callsAfterRecovery);
  expect(fetch.mock.calls.length - callsAfterRecovery).toBeLessThanOrEqual(61);
  const started = sink.events.filter((event) => event.op === "gateway.readiness.automatic.started");
  expect(
    started.slice(0, callsBeforeRecovery + 1).map((event) => event.extra?.backgroundAttempt),
  ).toEqual(Array.from({ length: callsBeforeRecovery + 1 }, (_, index) => index + 1));
  expect(
    started.slice(callsBeforeRecovery + 1).every((event) => event.extra?.backgroundAttempt === 1),
  ).toBe(true);
  expect(new Set(started.map((event) => event.correlationId)).size).toBe(started.length);
  expect(started.every((event) => event.parentCorrelationId === "corr-prolonged-outage")).toBe(
    true,
  );
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

it("recovers an answered startup rejection in the background without a Settings or chat request", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const gateway = { status: 404 };
  const fetch = startingGateway(gateway);
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-rejection");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(chatModelReady(deps)).toBe(false);
  gateway.status = 200;
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  expect(chatModelReady(deps)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("re-probes a conclusively failed model on the first conversation request after the cooldown", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const deps = composition();
  vi.useFakeTimers();
  const gateway = { status: 404 };
  const fetch = startingGateway(gateway);
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-4xx");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(chatModelReady(deps)).toBe(false);

  // An answered rejection retains slow background recovery; a request inside the cooldown never
  // adds a readiness request.
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-chat-early");
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS - 1_000);
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-chat-early");
  expect(fetch).toHaveBeenCalledTimes(1);

  // The gateway has finished starting; the first request after the cooldown heals the model.
  gateway.status = 200;
  await vi.advanceTimersByTimeAsync(2_000);
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-chat-send");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(chatModelReady(deps)).toBe(true);

  // The recovery is reconstructable from the existing readiness lines, under the request's own
  // correlation id and without the background marker.
  const started = sink.events.filter((event) => event.op === "gateway.readiness.automatic.started");
  expect(started.map((event) => event.correlationId)).toEqual([
    expect.any(String),
    "corr-chat-send",
  ]);
  expect(started[0]?.extra?.backgroundAttempt).toBe(1);
  expect(started[1]?.extra?.backgroundAttempt).toBeUndefined();
  const completed = sink.events.filter(
    (event) => event.op === "gateway.readiness.automatic.completed",
  );
  expect(completed.at(-1)?.correlationId).toBe("corr-chat-send");
  expect(completed.at(-1)?.extra?.overallStatus).toBe("ready");

  // Fresh readiness avoids one probe per interactive request; background renewal remains bounded.
  for (let request = 0; request < 5; request += 1) {
    await awaitInitializedConversationReadiness(
      deps,
      "chat-model",
      `corr-chat-ready-${String(request)}`,
    );
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2 * 60_000 - 1000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("shares one re-probe between concurrent requests and refreshes the cooldown when it fails", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const deps = composition();
  vi.useFakeTimers();
  const gateway = { status: 404 };
  const fetch = startingGateway(gateway);
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-startup-4xx");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled();
  });
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1_000);

  await Promise.all(
    Array.from({ length: 5 }, (_, request) =>
      awaitInitializedConversationReadiness(deps, "chat-model", `corr-burst-${String(request)}`),
    ),
  );
  // One probe for the whole burst: the first request started it, the other four joined it.
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(chatModelReady(deps)).toBe(false);
  expect(
    sink.events.filter((event) => event.op === "gateway.readiness.automatic.joined"),
  ).toHaveLength(4);

  // The failed re-probe refreshed the observation, so the next request waits out a new cooldown.
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-after-burst");
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(NOT_READY_REPROBE_COOLDOWN_MS + 1_000);
  await awaitInitializedConversationReadiness(deps, "chat-model", "corr-next-window");
  expect(fetch).toHaveBeenCalledTimes(3);
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

it("renews a healthy model proactively through the existing background queue", async () => {
  const deps = composition();
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, "setTimeout");
  const fetch = vi.fn(() =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-healthy-renewal");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  await vi.advanceTimersByTimeAsync(0);
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(fetch).toHaveBeenCalledOnce();
  expect(chatModelReady(deps)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(timers.mock.calls.some(([, delay]) => Number.isNaN(delay))).toBe(false);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await awaitInitializedConversationReadiness(deps, "chat-model");
  await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("refreshes expired readiness on the same generation and shares the selected model join", async () => {
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
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("returns local models immediately and joins one held renewal across repeated reloads", async () => {
  const deps = composition();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
  let hold = false;
  let release: ((value: Response) => void) | undefined;
  const fetch = vi.fn(() =>
    hold
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(chatProbeAnswer()),
  );
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-reload-initial");
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledOnce();
  });
  await vi.advanceTimersByTimeAsync(0);
  hold = true;
  vi.setSystemTime(new Date("2026-10-08T12:06:00.000Z"));
  const context = { url: new URL("http://127.0.0.1/api/models?refresh=1") } as RouteContext;
  const response = handleModels(context, deps);
  expect(response).toMatchObject({ status: 200, body: { models: [{ id: "chat-model" }] } });
  expect(response.body).not.toMatchObject({ models: [{ conversationReady: true }] });
  handleModels(context, deps);
  const selected = awaitInitializedConversationReadiness(
    deps,
    "chat-model",
    "corr-selected-renewal",
  );
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  release?.(chatProbeAnswer());
  await selected;
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(chatModelReady(deps)).toBe(true);
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

function slowHealthyRenewal(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(chatProbeAnswer());
    }, 119_000);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Synthetic renewal cancelled", "AbortError"));
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

it("renews early enough for the existing two-minute provider floor before readiness expires", async () => {
  const deps = composition();
  vi.useFakeTimers();
  let calls = 0;
  const fetch = vi.fn((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls += 1;
    return calls === 1 ? Promise.resolve(chatProbeAnswer()) : slowHealthyRenewal(init?.signal);
  });
  vi.stubGlobal("fetch", fetch);
  configure(deps, "corr-slow-healthy-renewal");
  await vi.advanceTimersByTimeAsync(0);
  await awaitInitializedConversationReadiness(deps, "chat-model");
  expect(currentConversationReady(deps, "chat-model")).toBe(true);
  await vi.advanceTimersByTimeAsync(CONVERSATION_READINESS_MAX_AGE_MS + 1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(currentConversationReady(deps, "chat-model")).toBe(true);
});
