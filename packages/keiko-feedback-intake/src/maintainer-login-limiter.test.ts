import { describe, expect, it } from "vitest";
import { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";

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

  it("evicts the least-recently-seen inactive source at capacity", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => now,
      2,
    );
    const first = limiter.begin(new Uint8Array([1]));
    expect(first.ok).toBe(true);
    if (first.ok) first.release();
    now += 1;
    const second = limiter.begin(new Uint8Array([2]));
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
    now += 1;
    expect(limiter.begin(new Uint8Array([1])).ok).toBe(false);
    now += 1;
    const third = limiter.begin(new Uint8Array([3]));
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
    now += 1;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(true);
  });

  it("never evicts an active source", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 100, windowMs: 60_000, concurrency: 10 },
      () => now,
      2,
    );
    const active = limiter.begin(new Uint8Array([1]));
    now += 1;
    const inactive = limiter.begin(new Uint8Array([2]));
    if (inactive.ok) inactive.release();
    now += 1;
    expect(limiter.begin(new Uint8Array([3])).ok).toBe(true);
    now += 1;
    expect(limiter.begin(new Uint8Array([1])).ok).toBe(false);
    if (active.ok) active.release();
  });

  it("fails closed when every tracked source is active", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 10, global: 100, windowMs: 60_000, concurrency: 10 },
      () => 1,
      1,
    );
    const active = limiter.begin(new Uint8Array([1]));
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(false);
    if (active.ok) active.release();
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(true);
  });
});
