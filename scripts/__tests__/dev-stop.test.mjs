import { describe, expect, it } from "vitest";

import { DEV_STOP_GRACE_MS, trackedChildPids, waitForPidsToExit } from "../dev-stop.mjs";

describe("dev-stop tracked process cleanup", () => {
  it("normalizes tracked child pids without accepting malformed values", () => {
    expect(trackedChildPids({ children: [11, 12, 11, "13", 1.5, 0, -1, null] })).toEqual([11, 12]);
    expect(trackedChildPids({ children: "not-an-array" })).toEqual([]);
    expect(trackedChildPids(undefined)).toEqual([]);
  });

  it("waits for every tracked process instead of reporting success after only the runner exits", async () => {
    const checks = new Map([
      [11, 0],
      [12, 2],
    ]);
    const isAlive = (pid) => {
      const remaining = checks.get(pid) ?? 0;
      checks.set(pid, Math.max(0, remaining - 1));
      return remaining > 0;
    };

    await expect(
      waitForPidsToExit([11, 12], 1_000, {
        isAlive,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toEqual([]);
  });

  it("allows more time than the BFF runtime-disposal timeout", () => {
    expect(DEV_STOP_GRACE_MS).toBeGreaterThan(30_000);
  });
});
