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
