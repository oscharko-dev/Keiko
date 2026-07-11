import { describe, expect, it } from "vitest";
import {
  MAINTAINER_LOGIN_OVERFLOW_BYTES,
  MaintainerLoginLimiter,
  maintainerLoginOverflowFalsePositiveUpperBound,
} from "./maintainer-login-limiter.js";

function release(admission: ReturnType<MaintainerLoginLimiter["begin"]>): void {
  if (admission.ok) admission.release();
}

describe("maintainer login limiter", () => {
  it("bounds concurrency before work and releases the exact admission", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 10, global: 10, windowMs: 60_000, concurrency: 1 },
      () => 1,
    );
    const first = limiter.begin(new Uint8Array([192, 0, 2, 1]));
    expect(first.ok).toBe(true);
    expect(limiter.begin(new Uint8Array([192, 0, 2, 2]))).toMatchObject({ ok: false });
    if (!first.ok) throw new Error("Expected admission");
    first.release();
    first.release();
    expect(limiter.begin(new Uint8Array([192, 0, 2, 2])).ok).toBe(true);
  });

  it("keeps an exact throttled source stable when capacity is saturated", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => 1,
      1,
    );
    release(limiter.begin(new Uint8Array([1])));
    release(limiter.begin(new Uint8Array([2])));
    expect(limiter.begin(new Uint8Array([1])).ok).toBe(false);
  });

  it("caps repeated overflow admissions for the same source", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => 1,
      1,
    );
    release(limiter.begin(new Uint8Array([1])));
    const overflow = limiter.begin(new Uint8Array([2]));
    expect(overflow.ok).toBe(true);
    release(overflow);
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(false);
  });

  it("does not move an overflow source into exact storage mid-window", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => now,
      1,
    );
    const exact = limiter.begin(new Uint8Array([1]));
    now += 60_001;
    release(limiter.begin(new Uint8Array([2])));
    release(exact);
    now += 1;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(false);
  });

  it("does not globally deny a new source when exact capacity is saturated", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 10, global: 100, windowMs: 60_000, concurrency: 10 },
      () => 1,
      1,
    );
    release(limiter.begin(new Uint8Array([1])));
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(true);
  });

  it("keeps global and concurrency caps authoritative for overflow", () => {
    const concurrent = new MaintainerLoginLimiter(
      { perSource: 10, global: 10, windowMs: 60_000, concurrency: 1 },
      () => 1,
      1,
    );
    const active = concurrent.begin(new Uint8Array([1]));
    expect(concurrent.begin(new Uint8Array([2])).ok).toBe(false);
    release(active);
    expect(concurrent.begin(new Uint8Array([2])).ok).toBe(true);

    const global = new MaintainerLoginLimiter(
      { perSource: 10, global: 1, windowMs: 60_000, concurrency: 10 },
      () => 1,
      1,
    );
    release(global.begin(new Uint8Array([1])));
    expect(global.begin(new Uint8Array([2])).ok).toBe(false);
  });

  it("resets overflow counters only when the global window rolls over", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => now,
      1,
    );
    release(limiter.begin(new Uint8Array([1])));
    release(limiter.begin(new Uint8Array([2])));
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(false);
    now += 60_001;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(true);
  });

  it("fails closed on deterministic sketch collisions within the documented bound", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => 1,
      1,
      1,
    );
    release(limiter.begin(new Uint8Array([1])));
    release(limiter.begin(new Uint8Array([2])));
    expect(limiter.begin(new Uint8Array([3])).ok).toBe(false);
    expect(MAINTAINER_LOGIN_OVERFLOW_BYTES).toBe(2_097_152);
    expect(maintainerLoginOverflowFalsePositiveUpperBound(10_000)).toBeLessThan(2.2e-6);
  });
});
