// KEIKO-0812 regression coverage for the corrupt-lock quarantine prune.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileUpdateSessionLock, pruneCorruptLockQuarantine } from "./update-session-lock.js";

const roots: string[] = [];

function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "keiko-update-lock-prune-")));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeQuarantineFile(dir: string, base: string, isoStamp: string, ageMs: number): string {
  const path = join(dir, `${base}.corrupt.${isoStamp}`);
  writeFileSync(path, "corrupt-contents", "utf8");
  const timeMs = Date.now() - ageMs;
  const secs = timeMs / 1_000;
  utimesSync(path, secs, secs);
  return path;
}

describe("pruneCorruptLockQuarantine (KEIKO-0812)", () => {
  it("removes corrupt-lock quarantine files older than the retention window and keeps recent ones", () => {
    const root = temporary();
    const lockPath = join(root, "update-session.lock");
    // Older than the default 7-day window (8 days).
    const oldPath = makeQuarantineFile(
      root,
      "update-session.lock",
      "2026-01-01T00-00-00-000Z",
      8 * 24 * 60 * 60_000,
    );
    // Within the window (1 hour ago).
    const recentPath = makeQuarantineFile(
      root,
      "update-session.lock",
      "2026-08-25T12-00-00-000Z",
      60 * 60_000,
    );
    // An unrelated file that must NOT be touched.
    const unrelated = join(root, "readme.txt");
    writeFileSync(unrelated, "keep", "utf8");

    const removed = pruneCorruptLockQuarantine(lockPath);

    expect(removed).toBe(1);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(recentPath)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("runs opportunistically inside acquire() so a long-running deployment does not accumulate quarantines", () => {
    const root = temporary();
    const lockDir = join(root, "updates");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "update-session.lock");
    const stale = makeQuarantineFile(
      lockDir,
      "update-session.lock",
      "2026-01-02T00-00-00-000Z",
      10 * 24 * 60 * 60_000,
    );
    expect(existsSync(stale)).toBe(true);

    const lock = createFileUpdateSessionLock(lockPath);
    const acquired = lock.acquire({
      sessionId: "s1",
      targetVersion: "0.2.13",
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    expect(acquired).toBe(true);
    expect(existsSync(stale)).toBe(false);
    // The remaining directory holds only the live lock, not the stale quarantine.
    expect(readdirSync(lockDir).filter((name) => name.includes(".corrupt."))).toEqual([]);
    lock.release("s1");
  });

  it("is a no-op when the lock's parent directory does not exist", () => {
    const root = temporary();
    const lockPath = join(root, "nonexistent", "update-session.lock");
    expect(pruneCorruptLockQuarantine(lockPath)).toBe(0);
  });

  it("keeps a file that lies inside the retention window even when its ISO-stamped name is old", () => {
    // Uses file mtime, not the stamp in the name, so a clock skew between the quarantine event and
    // today does not evict a file the operating system considers recent.
    const root = temporary();
    const lockPath = join(root, "update-session.lock");
    // Very old-looking name, but touched to right now.
    const path = makeQuarantineFile(root, "update-session.lock", "2020-01-01T00-00-00-000Z", 0);
    expect(pruneCorruptLockQuarantine(lockPath)).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});
