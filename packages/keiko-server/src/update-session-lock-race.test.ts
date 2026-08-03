import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const replacementRace = vi.hoisted(() => ({
  lockPath: undefined as string | undefined,
  replacementPath: undefined as string | undefined,
}));

vi.mock("./publish-file-without-replacement.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./publish-file-without-replacement.js")>();
  const { renameSync } = await import("node:fs");
  return {
    publishFileWithoutReplacement: (source: string, destination: string): void => {
      if (source === replacementRace.lockPath && replacementRace.replacementPath !== undefined) {
        renameSync(replacementRace.replacementPath, source);
        replacementRace.replacementPath = undefined;
      }
      original.publishFileWithoutReplacement(source, destination);
    },
  };
});

import {
  createFileUpdateSessionLock,
  type UpdateSessionLockRecord,
} from "./update-session-lock.js";

const roots: string[] = [];
const NOW = Date.parse("2026-06-30T00:10:00.000Z");

function record(sessionId: string, pid: number, startedAt: string): UpdateSessionLockRecord {
  return { sessionId, targetVersion: "0.2.12", startedAt, pid };
}

async function writeRecord(path: string, value: UpdateSessionLockRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function armReplacement(lockPath: string, replacementPath: string): void {
  replacementRace.lockPath = lockPath;
  replacementRace.replacementPath = replacementPath;
}

afterEach(async () => {
  replacementRace.lockPath = undefined;
  replacementRace.replacementPath = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("update-session lock ownership claims", () => {
  it("does not vacate a replacement owner published after stale-lock inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-update-claim-race-"));
    roots.push(root);
    const lockPath = join(root, "update.lock");
    const replacementPath = join(root, "replacement.lock");
    const stale = record("stale", 111, "2026-06-30T00:00:00.000Z");
    const replacement = record("live-replacement", 222, "2026-06-30T00:09:59.000Z");
    await writeRecord(lockPath, stale);
    await writeRecord(replacementPath, replacement);
    armReplacement(lockPath, replacementPath);
    const lock = createFileUpdateSessionLock(lockPath, {
      staleMs: 1_000,
      now: () => NOW,
      pidAlive: () => false,
    });

    expect(lock.acquire(record("contender", 333, new Date(NOW).toISOString()))).toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject(replacement);
    expect((await readdir(root)).filter((name) => name.includes(".claim."))).toEqual([]);
  });

  it("does not release a replacement owner published after ownership inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-update-release-race-"));
    roots.push(root);
    const lockPath = join(root, "update.lock");
    const replacementPath = join(root, "replacement.lock");
    const owned = record("owned", 111, "2026-06-30T00:00:00.000Z");
    const replacement = record("replacement", 222, "2026-06-30T00:09:59.000Z");
    const lock = createFileUpdateSessionLock(lockPath);
    expect(lock.acquire(owned)).toBe(true);
    await writeRecord(replacementPath, replacement);
    armReplacement(lockPath, replacementPath);

    lock.release(owned.sessionId);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject(replacement);
    expect((await readdir(root)).filter((name) => name.includes(".claim."))).toEqual([]);
  });
});
