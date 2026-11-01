// Parallel scorecard lanes share one Jira laboratory (#4174): a license restart must never happen
// under another live lane, two lanes must never restart at once, and abandoned state is reclaimed.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  otherLiveLanes,
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
function liveSet(...pids) {
  const live = new Set(pids);
  return (pid) => {
    if (!live.has(pid)) throw new Error("ESRCH");
    return true;
  };
}

describe("parallel lab lanes", () => {
  it("lists other live lanes and removes lanes whose process is gone", () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    registerLane(directory, OTHER);
    registerLane(directory, 1003);
    expect(otherLiveLanes(directory, SELF, liveSet(SELF, OTHER))).toEqual([OTHER]);
    expect(existsSync(join(directory, "lanes", "1003"))).toBe(false);
  });

  it("restarts at once when it is the only live lane", async () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    let restarts = 0;
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      () => Promise.resolve(++restarts),
      { pid: SELF, isAlive: liveSet(SELF), pollMs: 1, log: () => undefined },
    );
    expect(result).toBe(1);
    expect(existsSync(join(directory, "license-restart.lock"))).toBe(false);
  });

  it("waits while another lane is live and restarts after it ended", async () => {
    const directory = sessionDirectory();
    registerLane(directory, SELF);
    registerLane(directory, OTHER);
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

  it("skips the restart when another lane renewed the license meanwhile", async () => {
    const directory = sessionDirectory();
    let restarts = 0;
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(false),
      () => Promise.resolve(++restarts),
      { pid: SELF, isAlive: liveSet(SELF), pollMs: 1, log: () => undefined },
    );
    expect(result).toBeUndefined();
    expect(restarts).toBe(0);
  });

  it("waits for a lock held by a live process and reclaims one left by a dead process", async () => {
    const directory = sessionDirectory();
    const lock = join(directory, "license-restart.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(OTHER));
    let ownerAlive = true;
    let polls = 0;
    const isAlive = (pid) => {
      if (pid === OTHER) {
        polls += 1;
        if (polls > 2) ownerAlive = false;
        if (!ownerAlive) throw new Error("ESRCH");
      }
      return true;
    };
    const result = await withExclusiveRestart(
      directory,
      () => Promise.resolve(true),
      () => Promise.resolve("renewed"),
      { pid: SELF, isAlive, pollMs: 1, log: () => undefined },
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
      { pid: SELF, isAlive: liveSet(SELF), pollMs: 5, log: () => undefined },
    );
    await delay(30);
    expect(restarts).toBe(0);
    rmSync(lock, { recursive: true, force: true });
    await expect(attempt).resolves.toBe(1);
  });
});
