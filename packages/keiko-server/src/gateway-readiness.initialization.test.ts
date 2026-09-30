import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import {
  awaitInitializedConversationReadiness,
  NOT_READY_REPROBE_COOLDOWN_MS,
} from "./gateway-readiness.js";
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
  expect(fetch).toHaveBeenCalledTimes(callsAfterRecovery);
  const started = sink.events.filter((event) => event.op === "gateway.readiness.automatic.started");
  expect(started.map((event) => event.extra?.backgroundAttempt)).toEqual(
    Array.from({ length: started.length }, (_, index) => index + 1),
  );
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

  // A conclusive failure ends the background retries, and a request inside the cooldown never
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

  // A ready model is never rechecked per request.
  for (let request = 0; request < 5; request += 1) {
    await awaitInitializedConversationReadiness(
      deps,
      "chat-model",
      `corr-chat-ready-${String(request)}`,
    );
  }
  await vi.advanceTimersByTimeAsync(60 * 60_000);
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
