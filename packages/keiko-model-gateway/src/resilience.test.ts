import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CancelledError,
  CircuitOpenError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { CircuitBreaker, executeWithRetry } from "./resilience.js";
import type { Clock } from "./types.js";

function stubClock(): { clock: Clock; sleeps: number[]; advance: (ms: number) => void } {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number): void => {
      current += ms;
    },
    clock: {
      now: (): number => current,
      sleep: (ms: number): Promise<void> => {
        sleeps.push(ms);
        current += ms;
        return Promise.resolve();
      },
    },
  };
}

const RETRY_CONFIG = { maxRetries: 3, retryBaseDelayMs: 500 } as const;

describe("executeWithRetry", () => {
  it("returns immediately on first success without sleeping", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    const result = await executeWithRetry(
      () => {
        calls += 1;
        return Promise.resolve("ok");
      },
      RETRY_CONFIG,
      clock,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries transient failures then succeeds, with exponential backoff", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    const result = await executeWithRetry(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(new TransportError("boom"));
        }
        return Promise.resolve("ok");
      },
      RETRY_CONFIG,
      clock,
      undefined,
      // Equal jitter scales each capped delay by [0.5, 1.0]; pin the top of the
      // band so this test keeps asserting the exact exponential ladder.
      () => 1,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("throws the last error after exhausting maxRetries (N+1 total calls)", async () => {
    const { clock } = stubClock();
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls += 1;
          return Promise.reject(new TransportError(`fail ${String(calls)}`));
        },
        RETRY_CONFIG,
        clock,
      ),
    ).rejects.toBeInstanceOf(TransportError);
    expect(calls).toBe(4);
  });

  it("does not retry a non-retryable error", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls += 1;
          return Promise.reject(new AuthenticationError("nope"));
        },
        RETRY_CONFIG,
        clock,
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("caps backoff delay at 30 seconds", async () => {
    const { clock, sleeps } = stubClock();
    await expect(
      executeWithRetry(
        () => Promise.reject(new TransportError("x")),
        { maxRetries: 8, retryBaseDelayMs: 500 },
        clock,
        undefined,
        () => 1, // top of the jitter band exposes the raw 30s cap
      ),
    ).rejects.toBeInstanceOf(TransportError);
    expect(Math.max(...sleeps)).toBe(30_000);
  });

  it("honours RateLimitError.retryAfterMs instead of exponential backoff when set", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls += 1;
          // First call throws RateLimitError with retryAfterMs; second succeeds.
          if (calls === 1) {
            return Promise.reject(new RateLimitError("rate limited", 2000));
          }
          return Promise.resolve("ok");
        },
        { maxRetries: 1, retryBaseDelayMs: 500 },
        clock,
      ),
    ).resolves.toBe("ok");
    // The retry delay must be 2000 (retryAfterMs), not 500 (exponential-backoff base).
    expect(sleeps).toEqual([2000]);
  });

  it("caps RateLimitError.retryAfterMs at 30 seconds", async () => {
    const { clock, sleeps } = stubClock();
    await expect(
      executeWithRetry(
        () => Promise.reject(new RateLimitError("rate limited", 120_000)),
        { maxRetries: 1, retryBaseDelayMs: 500 },
        clock,
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(sleeps).toEqual([30_000]);
  });

  it("does not sleep or retry after the end-to-end timeout budget is exhausted", async () => {
    const { clock, sleeps, advance } = stubClock();
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls += 1;
          advance(30_000);
          return Promise.reject(new TimeoutError("timed out"));
        },
        { maxRetries: 3, retryBaseDelayMs: 500, timeoutMs: 30_000 },
        clock,
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("propagates cancellation while sleeping between retries", async () => {
    const controller = new AbortController();
    const clock: Clock = {
      now: () => 0,
      sleep: (_ms, signal) => {
        controller.abort();
        return signal?.aborted === true
          ? Promise.reject(new DOMException("cancelled", "AbortError"))
          : Promise.resolve();
      },
    };
    await expect(
      executeWithRetry(
        () => Promise.reject(new TransportError("retry me")),
        { maxRetries: 1, retryBaseDelayMs: 500 },
        clock,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("CircuitBreaker", () => {
  const cbConfig = { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 } as const;

  it("starts closed", () => {
    const { clock } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    expect(cb.status("m").state).toBe("closed");
    expect(cb.status("m").consecutiveFailures).toBe(0);
  });

  it("opens after the configured number of consecutive failures", () => {
    const { clock } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    expect(cb.status("m").state).toBe("open");
    expect(cb.status("m").openedAt).toBe(0);
  });

  it("stays closed after failureThreshold - 1 consecutive failures (off-by-one guard)", () => {
    const { clock } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    for (let i = 0; i < cbConfig.failureThreshold - 1; i += 1) {
      cb.recordFailure();
    }
    expect(cb.status("m").state).toBe("closed");
    expect(cb.status("m").consecutiveFailures).toBe(cbConfig.failureThreshold - 1);
  });

  it("blocks calls while open by signalling not-allowed", () => {
    const { clock } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    expect(() => {
      cb.assertAllowed();
    }).toThrow(CircuitOpenError);
  });

  it("a single success resets the failure counter while closed", () => {
    const { clock } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.status("m").consecutiveFailures).toBe(0);
    expect(cb.status("m").state).toBe("closed");
  });

  it("transitions to half-open after cooldown and closes once probes succeed", () => {
    const { clock, advance } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    advance(30_000);
    cb.assertAllowed();
    expect(cb.status("m").state).toBe("half-open");
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.status("m").state).toBe("closed");
  });

  it("reopens immediately if a half-open probe fails", () => {
    const { clock, advance } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    advance(30_000);
    cb.assertAllowed();
    expect(cb.status("m").state).toBe("half-open");
    cb.recordFailure();
    expect(cb.status("m").state).toBe("open");
    expect(cb.status("m").openedAt).toBe(30_000);
  });

  it("does not transition to half-open before cooldown elapses", () => {
    const { clock, advance } = stubClock();
    const cb = new CircuitBreaker("m", cbConfig, clock);
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    advance(29_999);
    expect(() => {
      cb.assertAllowed();
    }).toThrow(CircuitOpenError);
  });

  it("in half-open with halfOpenProbes=1, a second concurrent assertAllowed() throws CircuitOpenError", () => {
    // RED reasoning: before the fix assertAllowed() did not track in-flight probes,
    // so a second concurrent call was admitted regardless, allowing unlimited concurrent probes.
    const { clock, advance } = stubClock();
    const cb = new CircuitBreaker(
      "m",
      { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
      clock,
    );
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    advance(30_000);
    // First call enters half-open and claims the single probe slot.
    cb.assertAllowed();
    expect(cb.status("m").state).toBe("half-open");
    // Second concurrent call must be rejected — slot is full.
    expect(() => {
      cb.assertAllowed();
    }).toThrow(CircuitOpenError);
  });

  it("half-open probe slot is freed after recordSuccess, allowing the next probe", () => {
    // RED reasoning: the slot was never decremented on success before the fix.
    const { clock, advance } = stubClock();
    const cb = new CircuitBreaker(
      "m",
      { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      clock,
    );
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    advance(30_000);
    cb.assertAllowed(); // claims slot 1
    cb.assertAllowed(); // claims slot 2 (max)
    // Third call while 2 in-flight must be rejected.
    expect(() => {
      cb.assertAllowed();
    }).toThrow(CircuitOpenError);
    // After one success the slot is freed, so the next call is admitted.
    cb.recordSuccess();
    expect(() => {
      cb.assertAllowed();
    }).not.toThrow();
  });

  it("half-open probe slot is freed after recordFailure (re-opens immediately)", () => {
    // After a half-open probe fails the circuit re-opens; subsequent assertAllowed()
    // must throw CircuitOpenError (not pass through a stale in-flight slot).
    const { clock, advance } = stubClock();
    const cb = new CircuitBreaker(
      "m",
      { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
      clock,
    );
    for (let i = 0; i < 5; i += 1) {
      cb.recordFailure();
    }
    advance(30_000);
    cb.assertAllowed();
    cb.recordFailure(); // probe fails → re-opens
    expect(cb.status("m").state).toBe("open");
    expect(() => {
      cb.assertAllowed();
    }).toThrow(CircuitOpenError);
  });
});

describe("executeWithRetry — backoff jitter (thundering-herd)", () => {
  it("scales each capped exponential delay into the equal-jitter band [0.5d, d]", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    await executeWithRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new TransportError("boom")) : Promise.resolve("ok");
      },
      { maxRetries: 3, retryBaseDelayMs: 500 },
      clock,
      undefined,
      () => 0, // bottom of the band: exactly half of each unjittered delay
    );
    expect(sleeps).toEqual([250, 500]);
  });

  it("spreads concurrent retries: different randomness yields different delays", async () => {
    const run = async (random: () => number): Promise<number[]> => {
      const { clock, sleeps } = stubClock();
      let calls = 0;
      await executeWithRetry(
        () => {
          calls += 1;
          return calls < 2 ? Promise.reject(new TransportError("boom")) : Promise.resolve("ok");
        },
        { maxRetries: 2, retryBaseDelayMs: 1_000 },
        clock,
        undefined,
        random,
      );
      return sleeps;
    };
    const low = await run(() => 0.1);
    const high = await run(() => 0.9);
    expect(low).toEqual([550]); // 1000 * (0.5 + 0.05)
    expect(high).toEqual([950]); // 1000 * (0.5 + 0.45)
    expect(low[0]).not.toBe(high[0]);
  });

  it("keeps an explicit RateLimitError.retryAfterMs verbatim (no jitter applied)", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    await executeWithRetry(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new RateLimitError("rl", 2_000))
          : Promise.resolve("ok");
      },
      { maxRetries: 1, retryBaseDelayMs: 500 },
      clock,
      undefined,
      () => 0, // would halve an exponential delay — must not touch retryAfterMs
    );
    expect(sleeps).toEqual([2_000]);
  });
});

describe("executeWithRetry — provider 5xx classification (buffered path)", () => {
  it("retries a ProviderError carrying a retryable 5xx status", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    const result = await executeWithRetry(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ProviderError("upstream overloaded", 503))
          : Promise.resolve("ok");
      },
      { maxRetries: 2, retryBaseDelayMs: 500 },
      clock,
      undefined,
      () => 1,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it("still fails fast on a terminal 4xx ProviderError", async () => {
    const { clock, sleeps } = stubClock();
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls += 1;
          return Promise.reject(new ProviderError("bad request", 400));
        },
        { maxRetries: 3, retryBaseDelayMs: 500 },
        clock,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
