import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CancelledError,
  CircuitOpenError,
  ProviderError,
  RateLimitError,
  TimeoutError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { CircuitBreaker, executeWithRetry, systemClock } from "./resilience.js";
import type { Clock } from "./types.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

function fixture(
  failureThreshold = 10,
  halfOpenProbes = 1,
  clock: Clock = systemClock,
): {
  breaker: CircuitBreaker;
  events: ModelGatewayLogEvent[];
} {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    breaker: new CircuitBreaker(
      "admission-test-model",
      { failureThreshold, cooldownMs: 200, halfOpenProbes },
      clock,
      {
        write: (event): void => {
          events.push(event);
        },
      },
    ),
  };
}

function retryEvents(events: ModelGatewayLogEvent[]): ModelGatewayLogEvent[] {
  return events.filter((event) => event.op.startsWith("gateway.retry."));
}

function waitEvents(events: ModelGatewayLogEvent[]): ModelGatewayLogEvent[] {
  return events.filter((event) => event.op === "gateway.circuit.wait");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider admission decisions", () => {
  it("refuses a fresh short-budget caller without provider attempts or phantom retries", async () => {
    vi.useFakeTimers();
    const { breaker, events } = fixture();
    breaker.assertAllowed().settle("failure", new ProviderError("Synthetic outage", 503, [], 100));
    const provider = vi.fn();
    const result = executeWithRetry(
      async (_timeout, remainingMs, previousError) => {
        await breaker.waitForAdmission({
          remainingMs: remainingMs ?? 0,
          previousError,
          jitterMs: 1,
        });
        provider();
      },
      { maxRetries: 3, retryBaseDelayMs: 1, timeoutMs: 50 },
      systemClock,
      undefined,
      () => 0,
      {
        sink: {
          write: (event): void => {
            events.push(event);
          },
        },
      },
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(CircuitOpenError);
    expect(provider).not.toHaveBeenCalled();
    expect(retryEvents(events)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports exhausted admission as a timeout when the circuit is healthy", async () => {
    const { breaker, events } = fixture();
    await expect(breaker.waitForAdmission({ remainingMs: 0, jitterMs: 1 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(waitEvents(events)).toEqual([]);
    expect(breaker.status("admission-test-model").state).toBe("closed");
  });

  it("does not retry exhausted healthy admission or invent circuit-blocked events", async () => {
    const { breaker, events } = fixture();
    const provider = vi.fn();
    await expect(
      executeWithRetry(
        async () => {
          await breaker.waitForAdmission({ remainingMs: 0, jitterMs: 1 });
          provider();
        },
        { maxRetries: 3, retryBaseDelayMs: 1, timeoutMs: 100 },
        systemClock,
        undefined,
        () => 0,
        {
          sink: {
            write: (event): void => {
              events.push(event);
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(provider).not.toHaveBeenCalled();
    expect(retryEvents(events)).toEqual([]);
    expect(waitEvents(events)).toEqual([]);
  });

  it("records a body-free budget refusal even when no wait can begin", async () => {
    vi.useFakeTimers();
    const { breaker, events } = fixture();
    breaker.assertAllowed().settle("failure", new ProviderError("Synthetic outage", 503, [], 100));
    await expect(breaker.waitForAdmission({ remainingMs: 50, jitterMs: 1 })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(waitEvents(events)).toMatchObject([
      {
        extra: {
          reason: "provider-cooldown",
          outcome: "budget-refused",
          remainingMs: 50,
        },
      },
    ]);
    const line = formatActivityLogProofLine(waitEvents(events)[0] ?? {});
    expect(expectActivityLogProof("gateway.circuit.wait.emitted-line", line)).toMatchObject({
      reason: "provider-cooldown",
      outcome: "budget-refused",
      remainingMs: 50,
      completeness: "complete",
      loss: "none",
    });
    expect(JSON.stringify(waitEvents(events))).not.toContain("Synthetic outage");
  });

  it("preserves the actual provider error without counting admission refusals as failed attempts", async () => {
    vi.useFakeTimers();
    const { breaker, events } = fixture(1);
    const cause = new ProviderError("Synthetic outage", 503, [], 1);
    const provider = vi.fn(() => {
      throw cause;
    });
    const result = executeWithRetry(
      async (_timeout, remainingMs, previousError) => {
        const { admission } = await breaker.waitForAdmission({
          remainingMs: remainingMs ?? 0,
          previousError,
          jitterMs: 1,
        });
        try {
          provider();
        } catch (error) {
          admission.settle("failure", error);
          throw error;
        }
      },
      { maxRetries: 3, retryBaseDelayMs: 1, timeoutMs: 50 },
      systemClock,
      undefined,
      () => 0,
      {
        sink: {
          write: (event): void => {
            events.push(event);
          },
        },
      },
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBe(cause);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(retryEvents(events).map((event) => event.op)).toEqual(["gateway.retry.scheduled"]);
    expect(waitEvents(events)).toMatchObject([
      { extra: { reason: "circuit-cooldown", outcome: "budget-refused" } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a later parallel Retry-After while the same outage remains open", async () => {
    vi.useFakeTimers();
    const { breaker } = fixture(1);
    const first = breaker.assertAllowed();
    const parallel = breaker.assertAllowed();
    first.settle("failure", new ProviderError("Synthetic outage", 503, [], 100));
    parallel.settle("failure", new ProviderError("Synthetic longer outage", 503, [], 500));
    const admitted = vi.fn();
    const controller = new AbortController();
    const result = breaker
      .waitForAdmission({ remainingMs: 1_000, signal: controller.signal, jitterMs: 1 })
      .then(admitted)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(201);
    expect(admitted).not.toHaveBeenCalled();
    controller.abort();
    expect(await result).toBeInstanceOf(CancelledError);
    expect(breaker.status("admission-test-model").state).toBe("open");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 404, 413, 501])(
    "does not announce shared recovery for terminal HTTP %i",
    async (status) => {
      const { breaker, events } = fixture();
      breaker
        .assertAllowed()
        .settle("failure", new ProviderError("Synthetic caller fault", status, [], 100));
      const allowed = await breaker.waitForAdmission({ remainingMs: 50, jitterMs: 1 });
      expect(allowed.admission.halfOpen).toBe(false);
      expect(waitEvents(events)).toEqual([]);
    },
  );

  it("does not wake cooldown waiters for unrelated closed-state success or caller fault", async () => {
    vi.useFakeTimers();
    const { breaker, events } = fixture();
    const failure = breaker.assertAllowed();
    const successful = breaker.assertAllowed();
    const cancelled = breaker.assertAllowed();
    failure.settle("failure", new ProviderError("Synthetic outage", 503, [], 500));
    const controller = new AbortController();
    const result = breaker
      .waitForAdmission({ remainingMs: 1_000, signal: controller.signal, jitterMs: 1 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    successful.settle("success");
    cancelled.settle("non-provider-fault");
    await vi.advanceTimersByTimeAsync(0);
    expect(waitEvents(events).map((event) => event.extra?.outcome)).toEqual(["started"]);
    controller.abort();
    expect(await result).toBeInstanceOf(CancelledError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records saturated-probe budget expiry and disposes its subscription and timer", async () => {
    vi.useFakeTimers();
    const { breaker, events } = fixture(1);
    const cause = new ProviderError("Synthetic outage", 503, [], 1);
    breaker.assertAllowed().settle("failure", cause);
    await vi.advanceTimersByTimeAsync(201);
    const probe = breaker.assertAllowed();
    const result = breaker
      .waitForAdmission({ remainingMs: 50, previousError: cause, jitterMs: 1 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(CircuitOpenError);
    expect(waitEvents(events).map((event) => event.extra?.outcome)).toEqual([
      "started",
      "timer",
      "budget-refused",
    ]);
    expect(waitEvents(events).at(-1)?.extra).toMatchObject({
      reason: "probe-saturated",
      remainingMs: 0,
      delayMs: 0,
    });
    expect(
      expectActivityLogProof(
        "gateway.circuit.wait.emitted-line",
        formatActivityLogProofLine(waitEvents(events).at(-1) ?? {}),
      ),
    ).toMatchObject({ reason: "probe-saturated", delayMs: 0, remainingMs: 0 });
    const before = waitEvents(events).length;
    probe.settle("success");
    await vi.advanceTimersByTimeAsync(0);
    expect(waitEvents(events)).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a sibling probe extend the outage reopened by another probe", async () => {
    vi.useFakeTimers();
    const { breaker } = fixture(1, 2);
    breaker.assertAllowed().settle("failure", new ProviderError("First outage", 503, [], 1));
    await vi.advanceTimersByTimeAsync(201);
    const first = breaker.assertAllowed();
    const sibling = breaker.assertAllowed();
    first.settle("failure", new ProviderError("Reopened outage", 503, [], 1));
    sibling.settle("failure", new ProviderError("Stale probe", 503, [], 50_000));
    await vi.advanceTimersByTimeAsync(201);
    const admitted = await breaker.waitForAdmission({ remainingMs: 10, jitterMs: 1 });
    expect(admitted.admission.halfOpen).toBe(true);
    admitted.admission.settle("success");
    breaker.assertAllowed().settle("success");
    expect(breaker.status("admission-test-model").state).toBe("closed");
  });

  it("ignores a closed-generation cooldown while probes own the half-open generation", async () => {
    vi.useFakeTimers();
    const { breaker } = fixture(1, 2);
    const old = breaker.assertAllowed();
    breaker.assertAllowed().settle("failure", new ProviderError("First outage", 503, [], 1));
    await vi.advanceTimersByTimeAsync(201);
    const first = breaker.assertAllowed();
    old.settle("failure", new ProviderError("Old response", 503, [], 50_000));
    const second = await breaker.waitForAdmission({ remainingMs: 10, jitterMs: 1 });
    expect(second.admission.halfOpen).toBe(true);
    first.settle("success");
    second.admission.settle("success");
    expect(breaker.status("admission-test-model").state).toBe("closed");
  });

  it.each(["provider", "rate-limit"] as const)(
    "shares a %s recovery minimum while closed",
    async (kind) => {
      vi.useFakeTimers();
      const { breaker, events } = fixture();
      const error =
        kind === "provider"
          ? new ProviderError("Synthetic unavailable", 503, [], 100)
          : new RateLimitError("Synthetic rate limit", 100);
      breaker.assertAllowed().settle("failure", error);
      const settled = vi.fn();
      const pending = breaker.waitForAdmission({ remainingMs: 200, jitterMs: 1 }).then(settled);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toHaveBeenCalledTimes(1);
      expect(waitEvents(events).map((event) => event.extra?.outcome)).toEqual(["started", "timer"]);
      for (const event of waitEvents(events))
        expect(
          expectActivityLogProof(
            "gateway.circuit.wait.emitted-line",
            formatActivityLogProofLine(event),
          ),
        ).toMatchObject({ reason: "provider-cooldown", delayMs: 101 });
      expect(breaker.status("admission-test-model").state).toBe("closed");
    },
  );

  it("records a non-cancellation clock failure and disposes the wait subscription", async () => {
    const failure = new TypeError("private-clock-failure-canary");
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let sleepSignal: AbortSignal | undefined;
    const clock: Clock = {
      now: (): number => 0,
      sleep: (_delay, signal): Promise<void> => {
        sleepSignal = signal;
        return Promise.reject(failure);
      },
    };
    const { breaker, events } = fixture(10, 1, clock);
    breaker.assertAllowed().settle("failure", new RateLimitError("Rate limit", 100));
    await expect(
      breaker.waitForAdmission({ remainingMs: 200, jitterMs: 1, signal: controller.signal }),
    ).rejects.toBe(failure);
    expect(waitEvents(events).map((event) => event.extra?.outcome)).toEqual(["started", "failed"]);
    for (const event of waitEvents(events))
      expectActivityLogProof(
        "gateway.circuit.wait.emitted-line",
        formatActivityLogProofLine(event),
      );
    expect(JSON.stringify(events)).not.toContain("private-clock-failure-canary");
    expect(sleepSignal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not import a stale Retry-After from an earlier recovered outage", async () => {
    vi.useFakeTimers();
    const { breaker } = fixture(1);
    const old = breaker.assertAllowed();
    breaker.assertAllowed().settle("failure", new ProviderError("First outage", 503, [], 1));
    await vi.advanceTimersByTimeAsync(201);
    breaker.assertAllowed().settle("success");
    breaker.assertAllowed().settle("failure", new ProviderError("New outage", 503, [], 1));
    old.settle("failure", new ProviderError("Stale outage", 503, [], 50_000));
    await vi.advanceTimersByTimeAsync(201);
    const allowed = await breaker.waitForAdmission({ remainingMs: 10, jitterMs: 1 });
    expect(allowed.admission.halfOpen).toBe(true);
    allowed.admission.settle("success");
    expect(breaker.status("admission-test-model").state).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves genuine hours-long Retry-After without imposing a shorter product cap", async () => {
    vi.useFakeTimers();
    const { breaker } = fixture();
    breaker
      .assertAllowed()
      .settle("failure", new ProviderError("Long recovery", 503, [], 7_200_000));
    const admitted = vi.fn();
    const result = breaker.waitForAdmission({ remainingMs: 7_300_000, jitterMs: 1 }).then(admitted);
    await vi.advanceTimersByTimeAsync(7_199_999);
    expect(admitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await result;
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes existing waiters when a parallel response extends the ongoing outage", async () => {
    vi.useFakeTimers();
    const { breaker, events } = fixture(1);
    const first = breaker.assertAllowed();
    const parallel = breaker.assertAllowed();
    first.settle("failure", new ProviderError("Synthetic outage", 503, [], 100));
    const controller = new AbortController();
    const result = breaker
      .waitForAdmission({ remainingMs: 1_000, signal: controller.signal, jitterMs: 1 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    parallel.settle("failure", new ProviderError("Synthetic longer outage", 503, [], 500));
    await vi.advanceTimersByTimeAsync(0);
    expect(waitEvents(events).map((event) => event.extra?.outcome)).toEqual([
      "started",
      "changed",
      "started",
    ]);
    controller.abort();
    expect(await result).toBeInstanceOf(CancelledError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
