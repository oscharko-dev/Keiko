// Parallel scorecard lanes share one Jira laboratory (#4174): a license restart must never happen
// under a lane that uses Jira, lanes that only wait must never block each other, two lanes must
// never restart at once, and abandoned state is reclaimed.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  enterActive,
  otherActiveLanes,
  registerLane,
  withExclusiveRestart,
} from "../testing/jira-chat-lab/requirements/lab-lanes.mjs";

const directories = [];
function sessionDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-lab-lanes-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const SELF = 1001;
const OTHER = 1002;
const quiet = () => undefined;
const byNumber = (left, right) => left - right;
function liveSet(...pids) {
  const live = new Set(pids);
  return (pid) => {
    if (!live.has(pid)) throw new Error("ESRCH");
    return true;
  };
}
function laneFile(directory, pid, state) {
  mkdirSync(join(directory, "lanes"), { recursive: true });
  writeFileSync(join(directory, "lanes", String(pid)), state);
}

describe("parallel lab lanes", () => {
  it("counts only other live lanes that use Jira and removes lanes whose process is gone", () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    registerLane(directory, OTHER);
    laneFile(directory, 1003, "active\n");
    laneFile(directory, 1004, "2026-11-01T12:00:00.000Z\n");
    laneFile(directory, 1005, "active\n");
    const others = otherActiveLanes(directory, SELF, liveSet(SELF, OTHER, 1003, 1004));
    // A registered lane waits until its license check; an unknown state may be mid-turn.
    expect(others.sort(byNumber)).toEqual([1003, 1004]);
    expect(existsSync(join(directory, "lanes", "1005"))).toBe(false);
  });

  it("restarts at once when no other lane uses Jira, then lets the lane enter", async () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    let restarts = 0;
    const options = { pid: SELF, isAlive: liveSet(SELF), pollMs: 1, log: quiet };
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      () => Promise.resolve(++restarts),
      options,
    );
    await enterActive(directory, options);
    expect(result).toBe(1);
    expect(existsSync(join(directory, "license-restart.lock"))).toBe(false);
    expect(otherActiveLanes(directory, OTHER, liveSet(SELF))).toEqual([SELF]);
  });

  it("never restarts while another lane uses Jira, and restarts once it ended", async () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    await enterActive(directory, { pid: OTHER, pollMs: 1 });
    const live = new Set([SELF, OTHER]);
    const logs = [];
    let restartedWhileOtherLive = false;
    let polls = 0;
    const isAlive = (pid) => {
      polls += 1;
      if (polls > 3) live.delete(OTHER);
      if (!live.has(pid)) throw new Error("ESRCH");
      return true;
    };
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      () => {
        restartedWhileOtherLive = live.has(OTHER);
        return Promise.resolve("renewed");
      },
      { pid: SELF, isAlive, pollMs: 1, log: (line) => logs.push(line) },
    );
    expect(result).toBe("renewed");
    expect(restartedWhileOtherLive).toBe(false);
    expect(logs).toEqual([JSON.stringify({ operation: "jira-lab-license-wait", otherLanes: 1 })]);
  });

  it("lets two lanes that both need a renewal renew once and both start", async () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    registerLane(directory, OTHER);
    const isAlive = liveSet(SELF, OTHER);
    let licensed = false;
    let restarts = 0;
    const renew = async () => {
      restarts += 1;
      await delay(5);
      licensed = true;
      return "renewed";
    };
    const lane = async (pid) => {
      const options = { pid, isAlive, pollMs: 1, log: quiet };
      await withExclusiveRestart(directory, () => Promise.resolve(!licensed), renew, options);
      await enterActive(directory, options);
    };
    await Promise.all([lane(SELF), lane(OTHER)]);
    expect(restarts).toBe(1);
    expect(otherActiveLanes(directory, 9999, isAlive).sort(byNumber)).toEqual([SELF, OTHER]);
  });

  it("does not let a lane start using Jira while another lane restarts it", async () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    registerLane(directory, OTHER);
    const isAlive = liveSet(SELF, OTHER);
    const events = [];
    const restart = withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      async () => {
        events.push("restart-start");
        await delay(20);
        events.push("restart-end");
        return "renewed";
      },
      { pid: SELF, isAlive, pollMs: 1, log: quiet },
    );
    await delay(5);
    await enterActive(directory, { pid: OTHER, isAlive, pollMs: 1 });
    events.push("other-active");
    await restart;
    expect(events).toEqual(["restart-start", "restart-end", "other-active"]);
  });

  it("skips the restart when another lane renewed the license meanwhile", async () => {
    const directory = sessionDirectory();
    let restarts = 0;
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(false),
      () => Promise.resolve(++restarts),
      { pid: SELF, isAlive: liveSet(SELF), pollMs: 1, log: quiet },
    );
    expect(result).toBeUndefined();
    expect(restarts).toBe(0);
  });

  it("waits for a lock held by a live process and reclaims one left by a dead process", async () => {
    const directory = sessionDirectory();
    const lock = join(directory, "license-restart.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(OTHER));
    let polls = 0;
    const isAlive = (pid) => {
      if (pid === OTHER) {
        polls += 1;
        if (polls > 2) throw new Error("ESRCH");
      }
      return true;
    };
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      () => Promise.resolve("renewed"),
      { pid: SELF, isAlive, pollMs: 1, log: quiet },
    );
    expect(result).toBe("renewed");
    expect(polls).toBeGreaterThan(2);
  });

  it("does not reclaim a fresh lock whose owner is not written yet", async () => {
    const directory = sessionDirectory();
    const lock = join(directory, "license-restart.lock");
    mkdirSync(lock);
    let restarts = 0;
    const attempt = withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      () => Promise.resolve(++restarts),
      { pid: SELF, isAlive: liveSet(SELF), pollMs: 5, log: quiet },
    );
    await delay(30);
    expect(restarts).toBe(0);
    rmSync(lock, { recursive: true, force: true });
    await expect(attempt).resolves.toBe(1);
  });
});
