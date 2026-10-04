import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
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
