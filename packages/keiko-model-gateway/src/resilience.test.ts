import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CancelledError,
  CircuitOpenError,
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
});
