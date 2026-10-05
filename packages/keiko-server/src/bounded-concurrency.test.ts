import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./bounded-concurrency.js";

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

it("stops dequeuing work after a lane rejects while allowing in-flight work to finish", async () => {
  const fail = deferred();
  const pending = deferred();
  const started: number[] = [];
  const finished: number[] = [];
  const run = mapWithConcurrency(
    Array.from({ length: 40 }, (_, index) => index),
    8,
    async (item) => {
      started.push(item);
      if (item === 0) {
        await fail.promise;
        throw new Error("source read failed");
      }
      await pending.promise;
      finished.push(item);
      return item;
    },
  );

  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  fail.resolve();
  await expect(run).rejects.toThrow("source read failed");
  pending.resolve();
  await setImmediate();

  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(finished).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

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

it("invokes workers for undefined items and keeps dense output", async () => {
  const visited: number[] = [];
  const result = await mapWithConcurrency([undefined, "value", undefined], 2, (item, index) => {
    visited.push(index);
    return Promise.resolve(item ?? `empty-${String(index)}`);
  });
  expect(visited).toEqual([0, 1, 2]);
  expect(result).toEqual(["empty-0", "value", "empty-2"]);
  expect(Object.keys(result)).toEqual(["0", "1", "2"]);
});

it.each([NaN, Infinity, 0, -1, 1.5])("uses one lane for invalid limit %s", async (limit) => {
  const gate = deferred();
  const started: number[] = [];
  const result = mapWithConcurrency([0, 1], limit, async (index) => {
    started.push(index);
    await gate.promise;
    return index;
  });
  expect(started).toEqual([0]);
  gate.resolve();
  expect(await result).toEqual([0, 1]);
});

it("orders results when the last item completes first", async () => {
  const first = deferred();
  const completed: number[] = [];
  const result = mapWithConcurrency([0, 1], 2, async (index) => {
    if (index === 0) await first.promise;
    completed.push(index);
    return index;
  });
  expect(completed).toEqual([1]);
  first.resolve();
  expect(await result).toEqual([0, 1]);
  expect(completed).toEqual([1, 0]);
});
