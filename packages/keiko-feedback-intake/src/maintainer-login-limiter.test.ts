import { describe, expect, it } from "vitest";
import { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";

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

  it("throttles a late-window source for its full first-admission-anchored window", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 2, windowMs: 10, concurrency: 2 },
      () => now,
    );
    release(limiter.begin(new Uint8Array([1])));
    now = 9;
    release(limiter.begin(new Uint8Array([2])));
    now = 12;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(false);
    now = 20;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(true);
  });

  it("does not reset a prior source counter at global rollover", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 2, global: 3, windowMs: 10, concurrency: 2 },
      () => now,
    );
    release(limiter.begin(new Uint8Array([1])));
    now = 8;
    release(limiter.begin(new Uint8Array([2])));
    now = 9;
    release(limiter.begin(new Uint8Array([2])));
    now = 12;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(false);
    now = 19;
    expect(limiter.begin(new Uint8Array([2])).ok).toBe(true);
  });

  it("retains two global windows of exact state while admitting legitimate new sources", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 3, windowMs: 10, concurrency: 2 },
      () => now,
    );
    release(limiter.begin(new Uint8Array([0])));
    now = 9;
    release(limiter.begin(new Uint8Array([1])));
    release(limiter.begin(new Uint8Array([2])));
    now = 12;
    for (const source of [3, 4, 5]) {
      const admission = limiter.begin(new Uint8Array([source]));
      expect(admission.ok).toBe(true);
      release(admission);
    }
  });

  it("keeps long-lived active sources within the additional concurrency bound", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 10, global: 2, windowMs: 10, concurrency: 2 },
      () => now,
    );
    const first = limiter.begin(new Uint8Array([1]));
    const second = limiter.begin(new Uint8Array([2]));
    now = 12;
    expect(limiter.begin(new Uint8Array([3])).ok).toBe(false);
    release(first);
    const third = limiter.begin(new Uint8Array([3]));
    expect(third.ok).toBe(true);
    release(third);
    release(second);
    expect(limiter.begin(new Uint8Array([4])).ok).toBe(true);
  });

  it("keeps global and concurrency caps authoritative", () => {
    const concurrent = new MaintainerLoginLimiter(
      { perSource: 10, global: 10, windowMs: 60_000, concurrency: 1 },
      () => 1,
    );
    const active = concurrent.begin(new Uint8Array([1]));
    expect(concurrent.begin(new Uint8Array([2])).ok).toBe(false);
    release(active);
    expect(concurrent.begin(new Uint8Array([2])).ok).toBe(true);

    const global = new MaintainerLoginLimiter(
      { perSource: 10, global: 1, windowMs: 60_000, concurrency: 10 },
      () => 1,
    );
    release(global.begin(new Uint8Array([1])));
    expect(global.begin(new Uint8Array([2])).ok).toBe(false);
  });
});
