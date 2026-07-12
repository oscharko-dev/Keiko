import { describe, expect, it } from "vitest";
import { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";

function release(admission: ReturnType<MaintainerLoginLimiter["begin"]>): void {
  if (admission.ok) admission.release();
}

interface LimiterInternals {
  readonly sources: Map<
    string,
    { readonly startedAt: number; readonly count: number; readonly active: number }
  >;
  readonly expiries: {
    readonly size: number;
    push(record: { expiresAt: number; sourceKey: string; startedAt: number }): void;
  };
}

function internals(limiter: MaintainerLoginLimiter): LimiterInternals {
  return limiter as unknown as LimiterInternals;
}

function address(index: number): Uint8Array {
  return new Uint8Array([index >>> 8, index & 0xff]);
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

  it("does not scan a large retained Map on repeated throttled attempts", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 512, windowMs: 60_000, concurrency: 8 },
      () => 1,
    );
    for (let index = 0; index < 256; index += 1) release(limiter.begin(address(index)));
    const state = internals(limiter);
    expect(state.sources.size).toBe(256);
    Object.defineProperty(state.sources, Symbol.iterator, {
      value: (): never => {
        throw new Error("full Map scan");
      },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(limiter.begin(address(0)).ok).toBe(false);
    }
  });

  it("expires only due inactive sources from a staggered queue", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 10, windowMs: 10, concurrency: 2 },
      () => now,
    );
    release(limiter.begin(address(1)));
    now = 5;
    release(limiter.begin(address(2)));
    now = 12;
    release(limiter.begin(address(3)));
    expect(limiter.begin(address(1)).ok).toBe(true);
    expect(limiter.begin(address(2)).ok).toBe(false);
  });

  it("preserves a partial sift-up record and deletes every due source", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 10, windowMs: 100, concurrency: 2 },
      () => 50,
    );
    const state = internals(limiter);
    for (const expiresAt of [10, 20, 30, 40, 15]) {
      const sourceKey = `source-${String(expiresAt)}`;
      const startedAt = expiresAt - 100;
      state.sources.set(sourceKey, { startedAt, count: 1, active: 0 });
      state.expiries.push({ expiresAt, sourceKey, startedAt });
    }
    release(limiter.begin(address(99)));
    for (const expiresAt of [10, 15, 20, 30, 40]) {
      expect(state.sources.has(`source-${String(expiresAt)}`)).toBe(false);
    }
  });

  it("ignores a stale expiry record from a different source window", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 10, windowMs: 60_000, concurrency: 2 },
      () => 1,
    );
    release(limiter.begin(address(1)));
    const state = internals(limiter);
    const sourceKey = state.sources.keys().next().value;
    if (sourceKey === undefined) throw new Error("Expected retained source");
    state.expiries.push({ expiresAt: 1, sourceKey, startedAt: 999 });
    release(limiter.begin(address(2)));
    expect(limiter.begin(address(1)).ok).toBe(false);
  });

  it("keeps active sources past expiry and cleans them after release", () => {
    let now = 1;
    const limiter = new MaintainerLoginLimiter(
      { perSource: 1, global: 10, windowMs: 10, concurrency: 2 },
      () => now,
    );
    const active = limiter.begin(address(1));
    now = 12;
    release(limiter.begin(address(2)));
    expect(limiter.begin(address(1)).ok).toBe(false);
    release(active);
    release(limiter.begin(address(3)));
    expect(limiter.begin(address(1)).ok).toBe(true);
  });

  it("queues one bounded expiry for an idempotently repeated release", () => {
    const limits = { perSource: 10, global: 10, windowMs: 60_000, concurrency: 2 };
    const limiter = new MaintainerLoginLimiter(limits, () => 1);
    const admission = limiter.begin(address(1));
    for (let attempt = 0; attempt < 100; attempt += 1) release(admission);
    expect(internals(limiter).expiries.size).toBe(1);
    expect(internals(limiter).expiries.size).toBeLessThanOrEqual(
      2 * limits.global + limits.concurrency,
    );
  });
});
