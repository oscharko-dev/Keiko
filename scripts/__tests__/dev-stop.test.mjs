import { describe, expect, it, vi } from "vitest";

import {
  DEV_STOP_GRACE_MS,
  main,
  stopLiveRunner,
  stopOrphanedChildren,
  stopStaleRunner,
  trackedChildPids,
  trackedListeningPorts,
  waitForPidsToExit,
} from "../dev-stop.mjs";

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

  it("uses the production liveness seams when no tracked process needs polling", async () => {
    await expect(waitForPidsToExit([], 0)).resolves.toEqual([]);
  });

  it("allows more time than the BFF runtime-disposal timeout", () => {
    expect(DEV_STOP_GRACE_MS).toBeGreaterThan(30_000);
  });

  it.each([
    { force: false, signal: "SIGTERM", timeout: DEV_STOP_GRACE_MS },
    { force: true, signal: "SIGKILL", timeout: 5_000 },
  ])(
    "stops orphaned children with the bounded $signal path",
    async ({ force, signal, timeout }) => {
      const killPid = vi.fn();
      const wait = vi.fn().mockResolvedValue([]);

      await expect(
        stopOrphanedChildren([11, 12], force, { killPid, waitForPidsToExit: wait }),
      ).resolves.toEqual([]);
      expect(killPid.mock.calls).toEqual([
        [11, signal],
        [12, signal],
      ]);
      expect(wait).toHaveBeenCalledWith([11, 12], timeout);
    },
  );

  it("removes a stale PID file only after every tracked child stops", async () => {
    const removePidFile = vi.fn();
    const log = vi.fn();
    const stopChildren = vi.fn().mockResolvedValue([]);

    await expect(
      stopStaleRunner({ children: [11, 12] }, false, {
        stopOrphanedChildren: stopChildren,
        removePidFile,
        log,
      }),
    ).resolves.toBe(0);
    expect(stopChildren).toHaveBeenCalledWith([11, 12], false);
    expect(removePidFile).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "Removed stale Keiko dev UI PID file after tracked processes stopped.",
    );
  });

  it("keeps stale state when a tracked child survives", async () => {
    const removePidFile = vi.fn();
    const error = vi.fn();

    await expect(
      stopStaleRunner({ children: [11] }, true, {
        stopOrphanedChildren: vi.fn().mockResolvedValue([11]),
        removePidFile,
        error,
      }),
    ).resolves.toBe(1);
    expect(removePidFile).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("1 tracked process"));
  });

  it.each([
    { force: false, expectedSignal: "SIGTERM", expectedMessage: "stopped cleanly" },
    { force: true, expectedSignal: "SIGKILL", expectedMessage: "force-stopped" },
  ])(
    "stops a live runner and its children through the force=$force path",
    async ({ force, expectedSignal, expectedMessage }) => {
      const killPid = vi.fn();
      const wait = vi.fn().mockResolvedValue([]);
      const removePidFile = vi.fn();
      const log = vi.fn();

      await expect(
        stopLiveRunner({ runnerPid: 10, children: [11, 12] }, force, {
          killPid,
          waitForPidsToExit: wait,
          removePidFile,
          log,
        }),
      ).resolves.toBe(0);
      expect(killPid).toHaveBeenCalledWith(10, expectedSignal);
      expect(killPid).toHaveBeenCalledTimes(force ? 3 : 1);
      expect(wait).toHaveBeenCalledWith([10, 11, 12], force ? 5_000 : DEV_STOP_GRACE_MS);
      expect(removePidFile).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(expectedMessage));
    },
  );

  it("keeps live-runner state when the bounded stop expires", async () => {
    const removePidFile = vi.fn();
    const error = vi.fn();

    await expect(
      stopLiveRunner({ runnerPid: 10, children: [11] }, false, {
        killPid: vi.fn(),
        waitForPidsToExit: vi.fn().mockResolvedValue([11]),
        removePidFile,
        log: vi.fn(),
        error,
      }),
    ).resolves.toBe(1);
    expect(removePidFile).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("within 40s"));
  });

  it("routes no-state, live, and stale launcher states through the owning stop path", async () => {
    const log = vi.fn();
    await expect(main([], { readState: () => undefined, log })).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith("Keiko dev UI is not running.");

    const stopLive = vi.fn().mockResolvedValue(3);
    const liveState = { runnerPid: 10 };
    await expect(
      main(["--force"], {
        readState: () => liveState,
        isAlive: () => true,
        stopLiveRunner: stopLive,
      }),
    ).resolves.toBe(3);
    expect(stopLive).toHaveBeenCalledWith(liveState, true);

    const stopStale = vi.fn().mockResolvedValue(4);
    const staleState = { runnerPid: 20 };
    await expect(
      main([], {
        readState: () => staleState,
        isAlive: () => false,
        stopStaleRunner: stopStale,
      }),
    ).resolves.toBe(4);
    expect(stopStale).toHaveBeenCalledWith(staleState, false);
  });

  it.each([
    { runnerPid: "10", expectedAlive: false },
    { runnerPid: 1.5, expectedAlive: false },
    { runnerPid: 0, expectedAlive: false },
    { runnerPid: 2_147_483_647, expectedAlive: false },
    { runnerPid: process.pid, expectedAlive: true },
  ])("validates production runner PID $runnerPid safely", async ({ runnerPid, expectedAlive }) => {
    const stopLive = vi.fn().mockResolvedValue(0);
    const stopStale = vi.fn().mockResolvedValue(0);
    const state = { runnerPid };

    await expect(
      main([], {
        readState: () => state,
        stopLiveRunner: stopLive,
        stopStaleRunner: stopStale,
      }),
    ).resolves.toBe(0);
    expect(stopLive).toHaveBeenCalledTimes(expectedAlive ? 1 : 0);
    expect(stopStale).toHaveBeenCalledTimes(expectedAlive ? 0 : 1);
  });
});


// KEIKO-0734: report "stopped cleanly" ONLY when the tracked BFF/Next ports are actually
// released. An orphaned dev-bff.mjs child spawned via `node --watch` can keep the BFF port
// bound even after the tracked pids are gone; the pre-fix path would then declare the runner
// stopped and let the next `npm run dev:start` immediately collide.
describe("dev-stop port release check (KEIKO-0734)", () => {
  it("collects tracked listening ports from the pid file state", () => {
    expect(trackedListeningPorts({ publicPort: 1983, bffPort: 3005, nextPort: 3006 })).toEqual([
      1983, 3005, 3006,
    ]);
    expect(trackedListeningPorts({ publicPort: "abc", bffPort: null, nextPort: -1 })).toEqual([]);
    expect(trackedListeningPorts(undefined)).toEqual([]);
  });

  it("stopLiveRunner returns 1 when a tracked port is still bound after every pid has exited", async () => {
    const alive = () => false;
    const wait = vi.fn().mockResolvedValue(undefined);
    const errors = [];
    const logs = [];
    const removePidFile = vi.fn();
    const result = await stopLiveRunner(
      { runnerPid: 10, children: [], publicPort: 1983, bffPort: 3005 },
      false,
      {
        killPid: vi.fn(),
        // waitForPidsToExit resolves empty (all pids dead).
        waitForPidsToExit: vi.fn().mockResolvedValue([]),
        // But the port check reports 3005 is still bound.
        checkPortsReleased: vi.fn().mockResolvedValue([3005]),
        removePidFile,
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
        sleep: wait,
        isAlive: alive,
      },
    );
    expect(result).toBe(1);
    expect(removePidFile).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/still bound.*3005/u);
  });

  it("stopStaleRunner returns 1 when a tracked port is still bound after tracked children have exited", async () => {
    const errors = [];
    const removePidFile = vi.fn();
    const result = await stopStaleRunner(
      { children: [11, 12], publicPort: 1983 },
      false,
      {
        killPid: vi.fn(),
        stopOrphanedChildren: vi.fn().mockResolvedValue([]),
        checkPortsReleased: vi.fn().mockResolvedValue([1983]),
        removePidFile,
        log: () => {},
        error: (message) => errors.push(message),
      },
    );
    expect(result).toBe(1);
    expect(removePidFile).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/still bound.*1983/u);
  });
});
