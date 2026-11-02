import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  withWorkProjectLock,
  workProjectLockHeld,
} from "../testing/jira-chat-lab/requirements/work-project-lock.mjs";

const directories = [];
function directory() {
  const created = mkdtempSync(join(tmpdir(), "work-lock-"));
  directories.push(created);
  return created;
}
afterEach(() => {
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true });
});

describe("withWorkProjectLock", () => {
  it("runs two work-project journeys one after the other and releases the lock", async () => {
    const dir = directory();
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = withWorkProjectLock(dir, "S05", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return "one";
    });
    const lines = [];
    const second = withWorkProjectLock(
      dir,
      "S06",
      async () => {
        order.push("second");
        return "two";
      },
      { pollMs: 5, log: (line) => lines.push(line) },
    );
    await delay(30);
    expect(order).toEqual(["first-start"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(lines.map((line) => line.state)).toEqual(["waiting", "acquired"]);
    expect(workProjectLockHeld(dir)).toBe(false);
  });

  it("keeps the waiting lane's session alive on every poll and survives a failed keep-alive", async () => {
    const dir = directory();
    const lock = join(dir, "work-project.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, id: "S05" }));
    const lines = [];
    let polls = 0;
    const waiting = withWorkProjectLock(dir, "S06", () => Promise.resolve("ran"), {
      pollMs: 5,
      log: (line) => lines.push(line),
      onWait: () => {
        polls += 1;
        if (polls === 2) rmSync(lock, { recursive: true, force: true });
        return polls === 1 ? Promise.reject(new Error("session gone")) : Promise.resolve();
      },
    });
    await expect(waiting).resolves.toBe("ran");
    expect(polls).toBe(2);
    expect(lines.map((line) => line.state)).toEqual(["waiting", "keepalive-failed", "acquired"]);
  });

  it("serves waiting lanes first come, first served, so a busy lane cannot starve another", async () => {
    // 2026-11-01: the Gemma lane released the lock and took it again for its next journey before
    // the Qwen lane's next poll, nine times in a row; Qwen waited 50 minutes for its first journey.
    const dir = directory();
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const busyLane = (async () => {
      await withWorkProjectLock(dir, "S05", async () => {
        order.push("busy-S05");
        await gate;
      });
      await withWorkProjectLock(
        dir,
        "S06",
        () => {
          order.push("busy-S06");
          return Promise.resolve();
        },
        { pollMs: 5 },
      );
    })();
    const waitingLane = withWorkProjectLock(
      dir,
      "S07",
      () => {
        order.push("waiting-S07");
        return Promise.resolve();
      },
      { pollMs: 40 },
    );
    await delay(20);
    release();
    await Promise.all([busyLane, waitingLane]);
    expect(order).toEqual(["busy-S05", "waiting-S07", "busy-S06"]);
    expect(workProjectLockHeld(dir)).toBe(false);
  });

  it("releases the lock when the journey throws", async () => {
    const dir = directory();
    await expect(
      withWorkProjectLock(dir, "S07", () => Promise.reject(new Error("journey failed"))),
    ).rejects.toThrow("journey failed");
    expect(workProjectLockHeld(dir)).toBe(false);
  });

  it("takes over a lock whose holder is no longer running", async () => {
    const dir = directory();
    const lock = join(dir, "work-project.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, id: "S05" }));
    await expect(withWorkProjectLock(dir, "S08", () => Promise.resolve("ran"))).resolves.toBe(
      "ran",
    );
  });

  it("prepares a work-project journey only once it holds the lock, before it runs", async () => {
    const dir = directory();
    const order = [];
    await expect(
      withWorkProjectLock(
        dir,
        "S09",
        () => {
          order.push("run");
          return Promise.resolve("ran");
        },
        {
          prepare: () => {
            order.push(workProjectLockHeld(dir) ? "prepare-locked" : "prepare");
            return Promise.resolve();
          },
        },
      ),
    ).resolves.toBe("ran");
    expect(order).toEqual(["prepare-locked", "run"]);
  });

  it("does not run the journey and releases the lock when preparing fails", async () => {
    const dir = directory();
    let ran = false;
    await expect(
      withWorkProjectLock(
        dir,
        "S05",
        () => {
          ran = true;
          return Promise.resolve();
        },
        { prepare: () => Promise.reject(new Error("reset failed")) },
      ),
    ).rejects.toThrow("reset failed");
    expect(ran).toBe(false);
    expect(workProjectLockHeld(dir)).toBe(false);
  });

  it("never prepares a journey that reads only the report project", async () => {
    let prepared = false;
    await expect(
      withWorkProjectLock(directory(), "S12", () => Promise.resolve("read"), {
        prepare: () => {
          prepared = true;
          return Promise.resolve();
        },
      }),
    ).resolves.toBe("read");
    expect(prepared).toBe(false);
  });

  it.each(["S02", "S03", "S04"])(
    "runs %s, which writes no shared issue, beside a lane that holds the lock",
    async (id) => {
      const dir = directory();
      const lock = join(dir, "work-project.lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, id: "S05" }));
      await expect(withWorkProjectLock(dir, id, () => Promise.resolve("ran"))).resolves.toBe("ran");
    },
  );

  it.each(["S15", "S16"])(
    "serializes %s, which creates epics or test cases in REQ, and prepares REQ first",
    async (id) => {
      const dir = directory();
      let prepared = false;
      let lockedDuringRun = false;
      await withWorkProjectLock(
        dir,
        id,
        () => {
          lockedDuringRun = workProjectLockHeld(dir);
          return Promise.resolve();
        },
        {
          prepare: () => {
            prepared = true;
            return Promise.resolve();
          },
        },
      );
      expect(lockedDuringRun).toBe(true);
      expect(prepared).toBe(true);
    },
  );

  it("serializes S13, which comments on the shared RPT-1, without emptying REQ", async () => {
    const dir = directory();
    let prepared = false;
    let lockedDuringRun = false;
    await withWorkProjectLock(
      dir,
      "S13",
      () => {
        lockedDuringRun = workProjectLockHeld(dir);
        return Promise.resolve();
      },
      {
        prepare: () => {
          prepared = true;
          return Promise.resolve();
        },
      },
    );
    expect(lockedDuringRun).toBe(true);
    expect(prepared).toBe(false);
  });

  it("never holds the lock for a journey that reads only the report project", async () => {
    const dir = directory();
    const lock = join(dir, "work-project.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, id: "S05" }));
    await expect(withWorkProjectLock(dir, "S11", () => Promise.resolve("read"))).resolves.toBe(
      "read",
    );
    expect(existsSync(lock)).toBe(true);
  });
});

// Two real lane processes. The lock module is the production one; the fixture only pauses a lane at
// named points of the protocol so the schedules that lost a live lane's lock are reproduced exactly.
const LANE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/work-lock-lane/lane.mjs");

describe("withWorkProjectLock across processes", () => {
  const children = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  function startLane(config) {
    const child = spawn(process.execPath, [LANE, JSON.stringify(config)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    children.push(child);
    return exited;
  }

  async function until(markers, ...files) {
    for (let waited = 0; waited < 20_000; waited += 10) {
      const found = files.find((file) => existsSync(join(markers, file)));
      if (found) return found;
      await delay(10); // NOSONAR typescript:S9382 -- polling a child process's marker
    }
    throw new Error(`timed out waiting for ${files.join(" or ")}`);
  }

  const touch = (markers, file) => writeFileSync(join(markers, file), "");
  const events = (markers) => readFileSync(join(markers, "events.log"), "utf8").trim().split("\n");

  function setup() {
    const dir = directory();
    const markers = join(dir, "markers");
    mkdirSync(markers);
    const config = (name, extra = {}) => ({ name, directory: dir, markers, ...extra });
    return { dir, markers, config };
  }

  it("keeps a live lane's lock and its issues when two lanes recover the same dead holder", async () => {
    // A lane died holding the lock. Lane B computes its queue ticket first but publishes it late;
    // lane A, whose ticket is later, inspects the dead owner and enters. B then resumes with the
    // same stale observation. Removing the observed lock deleted A's live lock and, through the
    // reset, A's issues: both lanes ran at once (#4174).
    const { markers, config } = setup();
    const crashed = await startLane(config("dead", { role: "crash" }));
    expect(crashed.signal).toBe("SIGKILL");
    const laneB = startLane(config("b", { pauses: ["ticket", "commit"] }));
    await until(markers, "b-paused-ticket");
    const laneA = startLane(config("a", { pauses: ["commit"] }));
    await until(markers, "a-paused-commit");
    touch(markers, "go-b-ticket");
    await until(markers, "b-paused-commit");
    touch(markers, "go-a-commit");
    await until(markers, "a-inside");
    touch(markers, "go-b-commit");
    await until(markers, "b-resumed-commit");
    const outcome = await until(markers, "b-polled", "b-inside");
    expect(outcome).toBe("b-polled");
    expect(existsSync(join(markers, "req-1"))).toBe(true);
    expect(events(markers)).toEqual(["dead-prepare", "dead-enter", "a-prepare", "a-enter"]);
    touch(markers, "release-a");
    await until(markers, "b-inside");
    touch(markers, "release-b");
    await expect(Promise.all([laneA, laneB])).resolves.toMatchObject([{ code: 0 }, { code: 0 }]);
    expect(events(markers)).toEqual([
      "dead-prepare",
      "dead-enter",
      "a-prepare",
      "a-enter",
      "a-exit",
      "b-prepare",
      "b-enter",
      "b-exit",
    ]);
  });

  it("serves a fresh lock the same way: the second lane waits and then runs alone", async () => {
    const { markers, config } = setup();
    const laneA = startLane(config("a"));
    await until(markers, "a-inside");
    const laneB = startLane(config("b"));
    await until(markers, "b-polled");
    expect(existsSync(join(markers, "b-inside"))).toBe(false);
    expect(existsSync(join(markers, "req-1"))).toBe(true);
    touch(markers, "release-a");
    await until(markers, "b-inside");
    touch(markers, "release-b");
    await expect(Promise.all([laneA, laneB])).resolves.toMatchObject([{ code: 0 }, { code: 0 }]);
    expect(events(markers)).toEqual([
      "a-prepare",
      "a-enter",
      "a-exit",
      "b-prepare",
      "b-enter",
      "b-exit",
    ]);
  });
});
