import { describe, expect, it } from "vitest";
import { CircuitOpenError, ProviderError } from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { GATEWAY_CODING_OUTAGE_WINDOW_MS } from "./resilience.js";
import type { Clock, GatewayConfig, NormalizedResponse, ProviderAdapter } from "./types.js";
import type { ModelGatewayLogEvent } from "./observability.js";

// #3873: at peak load a customer's LiteLLM gateway sheds load for minutes. A coding-workbench call
// keeps retrying a transiently unavailable provider and waits through an open breaker for an
// outage-length window; every other surface keeps its fail-fast attempt count.

const MODEL = "coding-outage-model";

function request(profile: GatewayCallRequest["latencyProfile"]): GatewayCallRequest {
  return {
    modelId: MODEL,
    messages: [{ role: "user", content: "Synthetic outage probe" }],
    ...(profile === undefined ? {} : { latencyProfile: profile }),
  };
}

function config(
  breaker = { failureThreshold: 1_000, cooldownMs: 30_000, halfOpenProbes: 1 },
): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-test-token",
        timeoutMs: 30_000,
        maxRetries: 2,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: breaker,
  };
}

function answer(): NormalizedResponse {
  return {
    modelId: MODEL,
    content: "Synthetic answer",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

/** A clock whose sleeps advance simulated time at once, so minutes of backoff run in microseconds. */
function simulatedClock(): Clock & { readonly elapsed: () => number } {
  let now = 1_000_000;
  const start = now;
  return {
    now: (): number => now,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted === true) return Promise.reject(new Error("aborted"));
      now += ms;
      return Promise.resolve();
    },
    elapsed: (): number => now - start,
  };
}

/** A provider that answers 503 for its first `failures` calls, then succeeds. */
function recoveringProvider(failures: number): {
  call: ProviderAdapter["call"];
  calls: () => number;
} {
  let calls = 0;
  return {
    call: (): Promise<NormalizedResponse> => {
      calls += 1;
      return calls <= failures
        ? Promise.reject(new ProviderError("Synthetic 503", 503))
        : Promise.resolve(answer());
    },
    calls: (): number => calls,
  };
}

function gatewayFor(
  provider: ProviderAdapter["call"],
  clock: Clock,
  gatewayConfig: GatewayConfig = config(),
  events: ModelGatewayLogEvent[] = [],
): Gateway {
  return new Gateway(gatewayConfig, {
    adapter: { call: provider },
    clock,
    random: () => 0.5,
    log: { write: (event): void => void events.push(event) },
  });
}

describe("coding-workbench outage tolerance", () => {
  it("keeps retrying a provider that recovers after more failures than its attempt count", async () => {
    const provider = recoveringProvider(8);

    const result = await gatewayFor(provider.call, simulatedClock()).chat(
      request("coding-workbench"),
    );

    expect(result.content).toBe("Synthetic answer");
    expect(provider.calls()).toBe(9);
  });

  it("keeps the configured attempt count for every other surface", async () => {
    const provider = recoveringProvider(8);

    await expect(
      gatewayFor(provider.call, simulatedClock()).chat(request(undefined)),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(provider.calls()).toBe(3);
  });

  it("stops once the outage window cannot hold another retry", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringProvider(Number.POSITIVE_INFINITY);

    await expect(
      gatewayFor(provider.call, clock, config(), events).chat(request("coding-workbench")),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(clock.elapsed()).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    expect(clock.elapsed()).toBeGreaterThan(GATEWAY_CODING_OUTAGE_WINDOW_MS - 30_000);
    const exhausted = events.filter((event) => event.op === "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget" });
  });

  it("waits through an open breaker instead of refusing the call", async () => {
    const clock = simulatedClock();
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);

    const result = await gatewayFor(provider.call, clock, config(breaker)).chat(
      request("coding-workbench"),
    );

    expect(result.content).toBe("Synthetic answer");
    expect(provider.calls()).toBe(4);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(clock.elapsed()).toBeLessThan(GATEWAY_CODING_OUTAGE_WINDOW_MS);
  });

  it("bounds a wait on a saturated probe slot by the outage window", async () => {
    const clock = simulatedClock();
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    let calls = 0;
    let releaseProbe: (() => void) | undefined;
    let probeStarted: (() => void) | undefined;
    const probing = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    // Two 503s open the breaker; the half-open probe then hangs, so the slot stays saturated.
    const provider: ProviderAdapter["call"] = () => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new ProviderError("Synthetic 503", 503));
      probeStarted?.();
      return new Promise<NormalizedResponse>((resolve) => {
        releaseProbe = (): void => {
          resolve(answer());
        };
      });
    };
    const gateway = gatewayFor(provider, clock, config(breaker));
    const holder = gateway.chat(request("coding-workbench"));
    await probing;
    const waitingSince = clock.elapsed();

    await expect(gateway.chat(request("coding-workbench"))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    expect(clock.elapsed() - waitingSince).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    releaseProbe?.();
    await expect(holder).resolves.toMatchObject({ content: "Synthetic answer" });
  });

  it("bounds the retries by a configured window", async () => {
    const clock = simulatedClock();
    const provider = recoveringProvider(Number.POSITIVE_INFINITY);

    await expect(
      gatewayFor(provider.call, clock, { ...config(), codingOutageWindowMs: 60_000 }).chat(
        request("coding-workbench"),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(clock.elapsed()).toBeLessThanOrEqual(60_000);
    expect(clock.elapsed()).toBeGreaterThan(30_000);
  });

  it("keeps the attempt count for a coding call when the window is switched off", async () => {
    const provider = recoveringProvider(8);

    await expect(
      gatewayFor(provider.call, simulatedClock(), { ...config(), codingOutageWindowMs: 0 }).chat(
        request("coding-workbench"),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(provider.calls()).toBe(3);
  });

  it("refuses a coding call at once on an open breaker when the window is switched off", async () => {
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);
    const gateway = gatewayFor(provider.call, simulatedClock(), {
      ...config(breaker),
      codingOutageWindowMs: 0,
    });

    await expect(gateway.chat(request("coding-workbench"))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(provider.calls()).toBe(2);
  });

  it("still refuses at once on an open breaker outside the coding profile", async () => {
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);
    const gateway = gatewayFor(provider.call, simulatedClock(), config(breaker));

    await expect(gateway.chat(request(undefined))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls()).toBe(2);
  });
});
