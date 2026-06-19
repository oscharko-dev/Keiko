import { describe, expect, it } from "vitest";

import {
  createInlineCompletionRateLimiter,
  DEFAULT_INLINE_RATE_LIMIT,
} from "./inlineCompletionRateLimiter.js";

describe("createInlineCompletionRateLimiter", () => {
  it("allows the first invocation for a root", () => {
    const limiter = createInlineCompletionRateLimiter();
    expect(limiter.tryAcquire("/repo", 1_000)).toBe(true);
  });

  it("enforces the per-root minimum interval (cooldown)", () => {
    const limiter = createInlineCompletionRateLimiter({
      minIntervalMs: 100,
      maxPerWindow: 100,
      windowMs: 10_000,
    });
    expect(limiter.tryAcquire("/repo", 0)).toBe(true);
    // Too soon: within the 100 ms cooldown.
    expect(limiter.tryAcquire("/repo", 50)).toBe(false);
    // After the cooldown: allowed again.
    expect(limiter.tryAcquire("/repo", 100)).toBe(true);
  });

  it("enforces the sliding-window cap and recovers as old entries age out", () => {
    const limiter = createInlineCompletionRateLimiter({
      minIntervalMs: 0,
      maxPerWindow: 2,
      windowMs: 1_000,
    });
    expect(limiter.tryAcquire("/repo", 0)).toBe(true);
    expect(limiter.tryAcquire("/repo", 10)).toBe(true);
    // Window cap reached.
    expect(limiter.tryAcquire("/repo", 20)).toBe(false);
    // Past the window: the first two entries have aged out.
    expect(limiter.tryAcquire("/repo", 1_100)).toBe(true);
  });

  it("scopes limits per root independently", () => {
    const limiter = createInlineCompletionRateLimiter({
      minIntervalMs: 100,
      maxPerWindow: 1,
      windowMs: 10_000,
    });
    expect(limiter.tryAcquire("/repo-a", 0)).toBe(true);
    expect(limiter.tryAcquire("/repo-b", 0)).toBe(true);
    expect(limiter.tryAcquire("/repo-a", 10)).toBe(false);
  });

  it("ships generous defaults that do not throttle a single steady stream", () => {
    expect(DEFAULT_INLINE_RATE_LIMIT.minIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_INLINE_RATE_LIMIT.maxPerWindow).toBeGreaterThan(0);
    const limiter = createInlineCompletionRateLimiter();
    // One request every 100 ms (above the 60 ms guard) for a few seconds stays allowed.
    let allowed = 0;
    for (let t = 0; t < 5_000; t += 100) {
      if (limiter.tryAcquire("/repo", t)) {
        allowed += 1;
      }
    }
    expect(allowed).toBe(50);
  });
});
