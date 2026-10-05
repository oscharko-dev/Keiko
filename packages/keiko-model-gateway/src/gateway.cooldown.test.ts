import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CancelledError,
  CircuitOpenError,
  ProviderError,
  RateLimitError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway } from "./gateway.js";
import { CircuitBreaker, systemClock } from "./resilience.js";
import { createDefaultChatCapability } from "./capabilities.js";
import type {
  GatewayConfig,
  GatewayStreamChunk,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const REQUEST = {
  modelId: "cooldown-test-model",
  messages: [{ role: "user" as const, content: "Synthetic concurrency probe" }],
};

function gatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: REQUEST.modelId,
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-test-token",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function answer(): NormalizedResponse {
  return {
    modelId: REQUEST.modelId,
    content: "Synthetic answer",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "synthetic",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function gateway(
  call: ProviderAdapter["call"],
  config = gatewayConfig(),
  events: ModelGatewayLogEvent[] = [],
): Gateway {
  return new Gateway(config, {
    adapter: { call },
    clock: systemClock,
    random: (): number => 0,
    log: {
      write: (event): void => {
        events.push(event);
      },
    },
  });
}

afterEach(() => vi.useRealTimers());

async function consume(provider: Gateway): Promise<GatewayStreamChunk[]> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of provider.chatStream(REQUEST)) chunks.push(chunk);
  return chunks;
}

describe("concurrent provider cooldown admission", () => {
  it("does not draw recovery jitter for an unblocked successful admission", async () => {
    const random = vi.fn(() => 0);
    const provider = new Gateway(gatewayConfig(), {
      adapter: { call: (): Promise<NormalizedResponse> => Promise.resolve(answer()) },
      random,
    });
    await provider.chat(REQUEST);
    expect(random).not.toHaveBeenCalled();
  });
  it.each([0, 1])("bounds fresh-caller admission jitter at random=%i", async (random) => {
    vi.useFakeTimers();
    const events: ModelGatewayLogEvent[] = [];
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError("Synthetic 429", 100))
      .mockResolvedValue(answer());
    const config = gatewayConfig();
    const provider = new Gateway(
      {
        ...config,
        providers: config.providers.map((entry) => ({
          ...entry,
          maxRetries: 0,
          retryBaseDelayMs: 20,
        })),
      },
      {
        adapter: { call },
        clock: systemClock,
        random: (): number => random,
        log: {
          write: (event): void => {
            events.push(event);
          },
        },
      },
    );
    await expect(provider.chat(REQUEST)).rejects.toBeInstanceOf(RateLimitError);
    const pending = provider.chat(REQUEST);
    await vi.advanceTimersByTimeAsync(100);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await pending;
    expect(call).toHaveBeenCalledTimes(2);
    const waiting = events.find((event) => event.op === "gateway.circuit.wait");
    expect(waiting?.extra).toMatchObject({
      reason: "provider-cooldown",
      outcome: "started",
      delayMs: random === 0 ? 101 : 120,
    });
  });

  it.each(["refused", "budget", "cancelled"] as const)(
    "closes the stream lifecycle when initial admission is %s",
    async (mode) => {
      vi.useFakeTimers();
      const events: ModelGatewayLogEvent[] = [];
      const controller = new AbortController();
      const recovery = mode === "refused" ? null : mode === "budget" ? 2_147_483_647 : 1000;
      const call = vi.fn(() =>
        Promise.reject(new ProviderError("Synthetic outage", 503, [], recovery)),
      );
      const config = gatewayConfig();
      const provider = gateway(
        call,
        {
          ...config,
          providers: config.providers.map((entry) => ({ ...entry, maxRetries: 0 })),
          circuitBreaker: { failureThreshold: 1, cooldownMs: 200, halfOpenProbes: 1 },
        },
        events,
      );
      await expect(provider.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
      const stream = provider.chatStream({
        ...REQUEST,
        cancellationSignal: controller.signal,
        logContext: { correlationId: "initial-stream-admission" },
      });
      const pending = stream.next().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      const started = events.find((event) => event.op === "gateway.stream.started");
      if (mode === "cancelled") controller.abort();
      expect(await pending).toBeInstanceOf(
        mode === "cancelled" ? CancelledError : CircuitOpenError,
      );
      const failed = events.find((event) => event.op === "gateway.stream.failed");
      expect(started).toBeDefined();
      expect(failed).toBeDefined();
      expectActivityLogProof(
        "gateway.stream.started.emitted-line",
        formatActivityLogProofLine(started ?? {}),
      );
      expect(
        expectActivityLogProof(
          "gateway.stream.failed.emitted-line",
          formatActivityLogProofLine(failed ?? {}),
        ),
      ).toMatchObject({ correlationId: "initial-stream-admission", chunkCount: 0 });
      expect(call).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([0, 1])("honors a 429 minimum plus bounded retry jitter at random=%i", async (random) => {
    vi.useFakeTimers();
    const events: ModelGatewayLogEvent[] = [];
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError("Synthetic 429", 100))
      .mockResolvedValue(answer());
    const config = gatewayConfig();
    const provider = new Gateway(
      {
        ...config,
        providers: config.providers.map((entry) => ({ ...entry, retryBaseDelayMs: 20 })),
      },
      {
        adapter: { call },
        clock: systemClock,
        random: (): number => random,
        log: {
          write: (event): void => {
            events.push(event);
          },
        },
      },
    );
    const pending = provider.chat(REQUEST);
    await vi.runAllTimersAsync();
    await pending;
    const scheduled = events.find((event) => event.op === "gateway.retry.scheduled");
    expect(scheduled?.extra?.delayMs).toBe(random === 0 ? 110 : 120);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("completes retry callers after half-open saturation clears", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let releaseProbe: ((value: NormalizedResponse) => void) | undefined;
    const provider = gateway(() => {
      calls += 1;
      if (calls <= 3)
        return Promise.reject(new ProviderError("Synthetic unavailable", 503, [], 120_000));
      if (calls === 4)
        return new Promise((resolve) => {
          releaseProbe = resolve;
        });
      return Promise.resolve(answer());
    });
    const results = Promise.allSettled(Array.from({ length: 3 }, () => provider.chat(REQUEST)));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);
    expect(provider.circuitStatus(REQUEST.modelId).state).toBe("open");
    await vi.advanceTimersByTimeAsync(120_001);
    expect(calls).toBe(4);
    expect(releaseProbe).toBeTypeOf("function");
    releaseProbe?.(answer());
    await vi.advanceTimersByTimeAsync(0);
    expect((await results).map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(calls).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits out the breaker cooldown when the announced provider minimum is shorter", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let settled = false;
    const provider = gateway(() => {
      calls += 1;
      return calls <= 3
        ? Promise.reject(new ProviderError("Synthetic unavailable", 503, [], 100))
        : Promise.resolve(answer());
    });
    const results = Promise.allSettled(Array.from({ length: 3 }, () => provider.chat(REQUEST)));
    void results.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(calls).toBe(3);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await results).every((result) => result.status === "fulfilled")).toBe(true);
  });

  it("makes a new call respect the same model's already announced cooldown", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const provider = gateway(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new ProviderError("Synthetic unavailable", 503, [], 120_000))
        : Promise.resolve(answer());
    });
    const first = provider.chat(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    const second = provider.chat(REQUEST);
    const results = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect((await results).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(calls).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await results;
    }
  });

  it("cancels a saturated probe waiter without starting an extra provider call or retaining timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: ModelGatewayLogEvent[] = [];
    let calls = 0;
    let releaseProbe: ((value: NormalizedResponse) => void) | undefined;
    const provider = gateway(
      () => {
        calls += 1;
        if (calls <= 3)
          return Promise.reject(new ProviderError("Synthetic unavailable", 503, [], 120_000));
        if (calls === 4)
          return new Promise((resolve) => {
            releaseProbe = resolve;
          });
        return Promise.resolve(answer());
      },
      gatewayConfig(),
      events,
    );
    const results = Promise.allSettled([
      provider.chat(REQUEST),
      provider.chat(REQUEST),
      provider.chat({ ...REQUEST, cancellationSignal: controller.signal }),
    ]);
    await vi.advanceTimersByTimeAsync(120_001);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    releaseProbe?.(answer());
    await vi.advanceTimersByTimeAsync(0);
    const settled = await results;
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    const cancelled = settled[2];
    expect(cancelled.status).toBe("rejected");
    if (cancelled.status === "rejected") expect(cancelled.reason).toBeInstanceOf(CancelledError);
    expect(calls).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      events.some(
        (event) => event.op === "gateway.circuit.wait" && event.extra?.outcome === "cancelled",
      ),
    ).toBe(true);
  });

  it("preserves each original provider cause when the breaker wait cannot fit the actual request budget", async () => {
    vi.useFakeTimers();
    const errors: ProviderError[] = [];
    const events: ModelGatewayLogEvent[] = [];
    const config = gatewayConfig();
    const provider = gateway(
      () => {
        const error = new ProviderError("Synthetic unavailable", 503, [], 120_000);
        errors.push(error);
        return Promise.reject(error);
      },
      {
        ...config,
        providers: config.providers.map((entry) => ({ ...entry, maxRetries: 3 })),
        circuitBreaker: {
          ...config.circuitBreaker,
          failureThreshold: 2,
          cooldownMs: 3_000_000,
          halfOpenProbes: 1,
        },
      },
      events,
    );
    const results = Promise.allSettled(Array.from({ length: 3 }, () => provider.chat(REQUEST)));
    await vi.runAllTimersAsync();
    for (const [index, result] of (await results).entries()) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(errors[index]);
    }
    expect(errors).toHaveLength(3);
    expect(
      events.filter((event) => event.op.startsWith("gateway.retry.")).map((event) => event.op),
    ).toEqual(Array.from({ length: 3 }, () => "gateway.retry.scheduled"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a fresh buffered request refused before any provider attempt", async () => {
    vi.useFakeTimers();
    const events: ModelGatewayLogEvent[] = [];
    const config = gatewayConfig();
    const call = vi.fn(() =>
      Promise.reject(new ProviderError("Synthetic outage", 503, [], 3_000_000)),
    );
    const provider = gateway(
      call,
      {
        ...config,
        providers: config.providers.map((entry) => ({ ...entry, maxRetries: 3 })),
      },
      events,
    );
    await expect(provider.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
    events.length = 0;
    const result = provider.chat(REQUEST).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(CircuitOpenError);
    expect(call).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.op.startsWith("gateway.retry."))).toEqual([]);
    expect(events.find((event) => event.op === "gateway.circuit.wait")).toMatchObject({
      extra: { outcome: "budget-refused" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an unannounced outage fail-fast for a fresh caller", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const base = gatewayConfig();
    const provider = gateway(
      () => {
        calls += 1;
        return Promise.reject(new ProviderError("Synthetic unavailable", 503));
      },
      {
        ...base,
        providers: base.providers.map((entry) => ({ ...entry, maxRetries: 0 })),
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1 },
      },
    );
    await expect(provider.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.chat(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers concurrent native streams before any delivered content without replaying an answer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let releaseProbe: (() => void) | undefined;
    const provider = new Gateway(
      {
        ...gatewayConfig(),
        capabilities: [{ ...createDefaultChatCapability(REQUEST.modelId), streaming: true }],
      },
      {
        clock: systemClock,
        random: (): number => 0,
        adapter: {
          call: (): Promise<NormalizedResponse> =>
            Promise.reject(new TypeError("Unexpected buffered transport")),
          callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
            calls += 1;
            if (calls <= 3) throw new ProviderError("Synthetic unavailable", 503, [], 120_000);
            if (calls === 4)
              await new Promise<void>((resolve) => {
                releaseProbe = resolve;
              });
            yield { type: "delta", token: "Synthetic answer" };
            yield { type: "done", response: answer() };
          },
        },
      },
    );
    const results = Promise.allSettled(Array.from({ length: 3 }, () => consume(provider)));
    await vi.advanceTimersByTimeAsync(120_001);
    expect(calls).toBe(4);
    releaseProbe?.();
    await vi.advanceTimersByTimeAsync(0);
    const settled = await results;
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    for (const result of settled) {
      if (result.status === "fulfilled")
        expect(result.value.map((chunk) => chunk.type)).toEqual(["delta", "done"]);
    }
    expect(calls).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a stale admission impose a cooldown on a recovered breaker generation", async () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker(
      REQUEST.modelId,
      { failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1 },
      systemClock,
    );
    const stale = breaker.assertAllowed();
    breaker.assertAllowed().settle("failure");
    await vi.advanceTimersByTimeAsync(1_000);
    const probe = breaker.assertAllowed();
    stale.settle("failure", new ProviderError("Stale unavailable", 503, [], 120_000));
    probe.settle("success");
    const admitted = await breaker.waitForAdmission({ remainingMs: 1, jitterMs: 1 });
    admitted.admission.settle("success");
    expect(breaker.status(REQUEST.modelId).state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits a body-free canonical wait outcome without classifying cancellation as provider failure", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const events: ModelGatewayLogEvent[] = [];
    const provider = gateway(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ProviderError("Synthetic unavailable", 503, [], 120_000))
          : Promise.resolve(answer());
      },
      gatewayConfig(),
      events,
    );
    const first = provider.chat(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const second = provider.chat({ ...REQUEST, cancellationSignal: controller.signal });
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(120_001);
    await outcomes;
    const cancelled = events.find(
      (event) => event.op === "gateway.circuit.wait" && event.extra?.outcome === "cancelled",
    );
    const line = formatActivityLogProofLine(cancelled ?? {});
    expect(expectActivityLogProof("gateway.circuit.wait.emitted-line", line)).toMatchObject({
      reason: "provider-cooldown",
      outcome: "cancelled",
      completeness: "complete",
      loss: "none",
    });
    expect(cancelled?.errorKind).toBeUndefined();
    expect(provider.circuitStatus(REQUEST.modelId).consecutiveFailures).toBe(0);
  });
});
