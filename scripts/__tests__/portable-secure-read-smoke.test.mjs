import { describe, expect, it } from "vitest";

import { runBounded } from "../portable-secure-read-smoke.mjs";

describe("portable secure-read bounded load runner", () => {
  it("never starts more than its bound and preserves task order", async () => {
    let active = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tasks = Array.from({ length: 9 }, (_, index) => async () => {
      active += 1;
      await gate;
      active -= 1;
      return index;
    });
    const run = runBounded(tasks, 8);
    await Promise.resolve();
    expect(active).toBe(8);
    release();
    await expect(run).resolves.toEqual({
      maxInFlight: 8,
      results: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    });
  });
});
