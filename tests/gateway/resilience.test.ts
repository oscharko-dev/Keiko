import { describe, expect, it } from "vitest";
import { AuthenticationError, CircuitOpenError, TransportError } from "../../src/gateway/errors.js";
import { CircuitBreaker, executeWithRetry } from "../../src/gateway/resilience.js";
import type { Clock } from "../../src/gateway/types.js";

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
