import { describe, expect, it } from "vitest";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import {
  DEFAULT_FIGMA_RETRY_POLICY,
  fetchWithBackoff,
  type FigmaRetrySleep,
} from "../figmaRetry.js";

// A synchronous sleep recorder: records every requested delay and resolves immediately, so the
// deterministic backoff schedule is asserted without any real waiting.
const recordingSleep = (): { readonly sleep: FigmaRetrySleep; readonly delays: number[] } => {
  const delays: number[] = [];
  const sleep: FigmaRetrySleep = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
};

const POLICY = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000 } as const;

interface Attempt {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

// Drives the operation through a fixed script of responses, one per attempt, recording the count.
const scriptedOperation = (
  script: readonly Attempt[],
): { readonly run: () => Promise<Attempt>; readonly calls: () => number } => {
  let index = 0;
  const run = (): Promise<Attempt> => {
    const attempt = script[index] ?? script[script.length - 1];
    index += 1;
    if (attempt === undefined) throw new Error("empty script");
    return Promise.resolve(attempt);
  };
  return { run, calls: () => index };
};

describe("fetchWithBackoff", () => {
  it("returns the first non-429 response without sleeping", async () => {
    const op = scriptedOperation([{ status: 200 }]);
    const { sleep, delays } = recordingSleep();

    const result = await fetchWithBackoff(op.run, POLICY, sleep);

    expect(result.status).toBe(200);
    expect(op.calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries a 429 then succeeds, sleeping the deterministic exponential schedule", async () => {
    const op = scriptedOperation([{ status: 429 }, { status: 429 }, { status: 200 }]);
    const { sleep, delays } = recordingSleep();

    const result = await fetchWithBackoff(op.run, POLICY, sleep);

    expect(result.status).toBe(200);
    expect(op.calls()).toBe(3);
    // base * 2^attempt: 100, 200 — deterministic, no jitter.
    expect(delays).toEqual([100, 200]);
  });

  it("throws FIGMA_RATE_LIMITED when 429s exhaust the bounded retry count", async () => {
    const op = scriptedOperation([{ status: 429 }]);
    const { sleep, delays } = recordingSleep();

    await expect(fetchWithBackoff(op.run, POLICY, sleep)).rejects.toMatchObject({
      code: "FIGMA_RATE_LIMITED",
    });
    // 1 initial + maxRetries attempts, each followed by a sleep except no sleep is needed after the
    // final exhausted attempt.
    expect(op.calls()).toBe(POLICY.maxRetries + 1);
    expect(delays).toEqual([100, 200, 400]);
  });

  it("rejects with a FigmaConnectorError instance on exhaustion", async () => {
    const op = scriptedOperation([{ status: 429 }]);
    const { sleep } = recordingSleep();

    await expect(fetchWithBackoff(op.run, POLICY, sleep)).rejects.toBeInstanceOf(
      FigmaConnectorError,
    );
  });

  it("honours a numeric Retry-After header (seconds) over the computed delay", async () => {
    const op = scriptedOperation([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200 },
    ]);
    const { sleep, delays } = recordingSleep();

    await fetchWithBackoff(op.run, POLICY, sleep);

    // 2 seconds → 2000ms, overriding the computed 100ms.
    expect(delays).toEqual([2000]);
  });

  it("ignores a non-numeric Retry-After and falls back to the computed delay", async () => {
    const op = scriptedOperation([
      { status: 429, headers: { "retry-after": "soon" } },
      { status: 200 },
    ]);
    const { sleep, delays } = recordingSleep();

    await fetchWithBackoff(op.run, POLICY, sleep);

    expect(delays).toEqual([100]);
  });

  it("caps the computed exponential delay at maxDelayMs", async () => {
    const op = scriptedOperation([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 200 },
    ]);
    const { sleep, delays } = recordingSleep();

    await fetchWithBackoff(op.run, { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 2500 }, sleep);

    // 1000, 2000, then 4000 capped to 2500.
    expect(delays).toEqual([1000, 2000, 2500]);
  });

  it("caps a Retry-After delay at maxDelayMs (no unbounded wait)", async () => {
    const op = scriptedOperation([
      { status: 429, headers: { "retry-after": "999999" } },
      { status: 200 },
    ]);
    const { sleep, delays } = recordingSleep();

    await fetchWithBackoff(op.run, POLICY, sleep);

    expect(delays).toEqual([POLICY.maxDelayMs]);
  });

  it("does not retry a 5xx — only 429 is rate-limit-retryable here", async () => {
    const op = scriptedOperation([{ status: 503 }]);
    const { sleep, delays } = recordingSleep();

    const result = await fetchWithBackoff(op.run, POLICY, sleep);

    expect(result.status).toBe(503);
    expect(op.calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("exposes a bounded default policy", () => {
    expect(DEFAULT_FIGMA_RETRY_POLICY.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_FIGMA_RETRY_POLICY.maxRetries).toBeLessThanOrEqual(8);
    expect(DEFAULT_FIGMA_RETRY_POLICY.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_FIGMA_RETRY_POLICY.maxDelayMs).toBeGreaterThanOrEqual(
      DEFAULT_FIGMA_RETRY_POLICY.baseDelayMs,
    );
  });
});
