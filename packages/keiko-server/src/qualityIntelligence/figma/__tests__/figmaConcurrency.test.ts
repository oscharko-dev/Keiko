import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../figmaConcurrency.js";

// A deferred promise so a test can hold tasks "in flight" and observe the live concurrency.
const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("mapWithConcurrency", () => {
  it("preserves input order in the results regardless of completion order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, (n) => Promise.resolve(n * 10));
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("returns an empty array for an empty input without invoking the worker", async () => {
    let invoked = 0;
    const out = await mapWithConcurrency<number, number>([], 4, (n) => {
      invoked += 1;
      return Promise.resolve(n);
    });
    expect(out).toEqual([]);
    expect(invoked).toBe(0);
  });

  it("never runs more than `limit` workers at once", async () => {
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;

    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = gates[i];
      if (gate === undefined) throw new Error("missing gate");
      await gate.promise;
      active -= 1;
      return i;
    });

    // Let the pool fill, then release tasks one at a time.
    await Promise.resolve();
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    const out = await run;

    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("runs sequentially when the limit is 1", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("clamps a limit larger than the input to the input length (no idle workers throwing)", async () => {
    const out = await mapWithConcurrency([1, 2], 99, (n) => Promise.resolve(n));
    expect(out).toEqual([1, 2]);
  });

  it("rejects if any worker rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) =>
        n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n),
      ),
    ).rejects.toThrow("boom");
  });
});
