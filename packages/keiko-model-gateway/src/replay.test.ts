// Coverage for the replay doubles (ADR-0173 D5, §7.3): the shared deterministic Clock, the
// scripted fetch that replays at the transport seam, and — the point of the whole exercise — a
// real `Gateway` wired with both, proving the real retry path executes during replay rather than
// being simulated by a hand-authored error.

import { describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";
import {
  createScriptedGatewayClock,
  createScriptedGatewayFetch,
  type GatewayReplayScriptEntry,
} from "./replay.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import type { GatewayConfig, GatewayRequest, ModelProviderConfig } from "./types.js";
import type { GatewayCallRequest } from "./gateway.js";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: ["sk-", "replay-secret-key-1234567890ab"].join(""),
    timeoutMs: 30_000,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function config(providers: ModelProviderConfig[]): GatewayConfig {
  return {
    providers,
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "hello" }],
};

interface Recorder {
  readonly sink: ModelGatewayLogSink;
  readonly events: ModelGatewayLogEvent[];
}

function recorder(): Recorder {
  const events: ModelGatewayLogEvent[] = [];
  return { events, sink: { write: (event): void => void events.push(event) } };
}

function eventFor(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent {
  const found = events.find((event) => event.op === op);
  if (found === undefined) {
    throw new Error(
      `expected an event with op '${op}', saw: ${events.map((e) => e.op).join(", ")}`,
    );
  }
  return found;
}

function okChatBody(content: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  };
}

describe("createScriptedGatewayClock", () => {
  it("never advances now() merely by being read", () => {
    const clock = createScriptedGatewayClock();
    const first = clock.now();
    const second = clock.now();
    const third = clock.now();
    expect([first, second, third]).toEqual([0, 0, 0]);
  });

  it("advances now() by exactly the ms sleep() is asked to wait", async () => {
    const clock = createScriptedGatewayClock();
    const before = clock.now();
    await clock.sleep(250);
    expect(clock.now() - before).toBe(250);
    await clock.sleep(10);
    expect(clock.now() - before).toBe(260);
  });

  it("rejects with an AbortError-shaped error when the signal is already aborted", async () => {
    const clock = createScriptedGatewayClock();
    const controller = new AbortController();
    controller.abort();
    await expect(clock.sleep(100, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // An aborted sleep must not have advanced the clock — the wait never happened.
    expect(clock.now()).toBe(0);
  });

  it("honours a scripted sleepMs override, call-index with repeat-last-entry", async () => {
    const clock = createScriptedGatewayClock({ sleepMs: [10, 20] });
    await clock.sleep(999);
    expect(clock.now()).toBe(10);
    await clock.sleep(999);
    expect(clock.now()).toBe(30);
    // Script exhausted: the last entry repeats, exactly like createScriptedModelPort.
    await clock.sleep(999);
    expect(clock.now()).toBe(50);
  });
});

describe("createScriptedGatewayFetch", () => {
  const clock = (): ReturnType<typeof createScriptedGatewayClock> => createScriptedGatewayClock();

  it("replays entries by call index and repeats the last entry once exhausted", async () => {
    const script: GatewayReplayScriptEntry[] = [
      { status: 200, bodyJson: { call: 1 }, latencyMs: 0 },
      { status: 200, bodyJson: { call: 2 }, latencyMs: 0 },
    ];
    const fetchImpl = createScriptedGatewayFetch(script, clock());
    const first = await fetchImpl("https://example.test");
    const second = await fetchImpl("https://example.test");
    const third = await fetchImpl("https://example.test");
    await expect(first.json()).resolves.toEqual({ call: 1 });
    await expect(second.json()).resolves.toEqual({ call: 2 });
    // Script exhausted after 2 calls: the third call repeats the last entry.
    await expect(third.json()).resolves.toEqual({ call: 2 });
  });

  it("advances the shared clock by entry.latencyMs before resolving", async () => {
    const sharedClock = clock();
    const fetchImpl = createScriptedGatewayFetch(
      [{ status: 200, bodyJson: {}, latencyMs: 42 }],
      sharedClock,
    );
    expect(sharedClock.now()).toBe(0);
    await fetchImpl("https://example.test");
    expect(sharedClock.now()).toBe(42);
  });

  it("passes scripted headers through onto the real Response, including retry-after", async () => {
    const fetchImpl = createScriptedGatewayFetch(
      [
        {
          status: 429,
          headers: { "retry-after": "2" },
          bodyJson: { error: "slow down" },
          latencyMs: 0,
        },
      ],
      clock(),
    );
    const response = await fetchImpl("https://example.test");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("rejects with a network-error-shaped failure for a networkError entry", async () => {
    const fetchImpl = createScriptedGatewayFetch([{ networkError: true }], clock());
    await expect(fetchImpl("https://example.test")).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects immediately when the request signal is already aborted", async () => {
    const fetchImpl = createScriptedGatewayFetch(
      [{ status: 200, bodyJson: {}, latencyMs: 1_000 }],
      clock(),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchImpl("https://example.test", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError, not TypeError, when the signal is already aborted and the scripted entry is a networkError", async () => {
    // Regression: the abort check must run BEFORE the script entry is selected/executed. A real
    // `fetch` rejects an aborted request with AbortError before it ever starts transport work, so
    // an aborted signal must win even when the entry it would have hit is `{ networkError: true }`
    // (which otherwise throws a network-error-shaped TypeError).
    const fetchImpl = createScriptedGatewayFetch([{ networkError: true }], clock());
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchImpl("https://example.test", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects descriptively for an empty script", async () => {
    const fetchImpl = createScriptedGatewayFetch([], clock());
    await expect(fetchImpl("https://example.test")).rejects.toThrow(/empty script/);
  });
});

describe("Gateway replay integration (ADR-0173 §7.3)", () => {
  it("threads GatewayDeps.fetchImpl into the adapter it constructs instead of always using the real network", async () => {
    const sharedClock = createScriptedGatewayClock();
    const fetchImpl = createScriptedGatewayFetch(
      [{ status: 200, bodyJson: okChatBody("wired"), latencyMs: 0 }],
      sharedClock,
    );
    // No `adapter:` override here — this exercises the real `adapterFor` branch that constructs an
    // `OpenAiAdapter`, which is the only place `GatewayDeps.fetchImpl` has anywhere to go.
    const gateway = new Gateway(config([provider()]), { clock: sharedClock, fetchImpl });
    const result = await gateway.chat(REQUEST);
    expect(result.content).toBe("wired");
  });

  it("runs the real retry path for a 500-then-200 script: one correlationId end to end, httpStatus on the retry line", async () => {
    const sharedClock = createScriptedGatewayClock();
    const script: GatewayReplayScriptEntry[] = [
      { status: 500, bodyJson: { error: { message: "upstream overloaded" } }, latencyMs: 0 },
      { status: 200, bodyJson: okChatBody("recovered"), latencyMs: 0 },
    ];
    const fetchImpl = createScriptedGatewayFetch(script, sharedClock);
    const log = recorder();
    const gateway = new Gateway(config([provider({ maxRetries: 1, retryBaseDelayMs: 1 })]), {
      clock: sharedClock,
      fetchImpl,
      log: log.sink,
      random: (): number => 0.5,
    });
    const request: GatewayCallRequest = {
      ...REQUEST,
      logContext: { correlationId: "replay-correlation-1" },
    };

    const result = await gateway.chat(request);

    expect(result.content).toBe("recovered");
    const transportEvents = log.events.filter(
      (event) => event.op === "chat.request.dispatch" || event.op.startsWith("http.gateway.fetch."),
    );
    expect(transportEvents.map((event) => event.op)).toEqual([
      "chat.request.dispatch",
      "http.gateway.fetch.started",
      "http.gateway.fetch.completed",
      "chat.request.dispatch",
      "http.gateway.fetch.started",
      "http.gateway.fetch.completed",
    ]);
    expect(transportEvents.map((event) => event.correlationId)).toEqual(
      transportEvents.map(() => "replay-correlation-1"),
    );
    expect(
      transportEvents
        .filter((event) => event.op === "http.gateway.fetch.completed")
        .map((event) => event.status),
    ).toEqual([500, 200]);
    const scheduled = eventFor(log.events, "gateway.retry.scheduled");
    expect(scheduled.correlationId).toBe("replay-correlation-1");
    expect(scheduled.extra?.httpStatus).toBe(500);
    const completed = eventFor(log.events, "gateway.chat.completed");
    expect(completed.correlationId).toBe("replay-correlation-1");
  });
});
