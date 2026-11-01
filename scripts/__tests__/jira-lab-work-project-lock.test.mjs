import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { withWorkProjectLock } from "../testing/jira-chat-lab/requirements/work-project-lock.mjs";

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
    expect(existsSync(join(dir, "work-project.lock"))).toBe(false);
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

  it("releases the lock when the journey throws", async () => {
    const dir = directory();
    await expect(
      withWorkProjectLock(dir, "S07", () => Promise.reject(new Error("journey failed"))),
    ).rejects.toThrow("journey failed");
    expect(existsSync(join(dir, "work-project.lock"))).toBe(false);
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
            order.push(existsSync(join(dir, "work-project.lock")) ? "prepare-locked" : "prepare");
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
    expect(existsSync(join(dir, "work-project.lock"))).toBe(false);
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
