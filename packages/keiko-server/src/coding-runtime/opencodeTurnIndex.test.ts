import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GovernedIndexRecord } from "./governedIndexPaths.js";
import {
  awaitTurnIndexStart,
  beginTurnIndex,
  type IndexRead,
  type TurnIndexRecord,
  captureTurnIndex,
  reopenTurnIndex,
  restoreTurnIndex,
  settleTurnIndex,
} from "./opencodeTurnIndex.js";

const roots: string[] = [];
/** What the turn's governed staging named; the run's record is the production source of it. */
const GOVERNED = governedOf(["a.txt", "b.txt", "p.txt", "new.txt"]);

function governedOf(paths: readonly string[], truncated = false): GovernedIndexRecord {
  return { paths, truncated };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const run = spawnSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    },
  );
  if (run.status !== 0) throw new Error(`fixture git ${args[0] ?? ""} failed: ${run.stderr}`);
  return run.stdout;
}

/** A committed repository holding `a.txt`, `b.txt` and `p.txt`. */
function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-turn-index-")));
  roots.push(root);
  git(root, "init", "-q");
  for (const name of ["a.txt", "b.txt", "p.txt"]) writeFileSync(join(root, name), `${name}\n`);
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  return root;
}

function staged(root: string): readonly string[] {
  return git(root, "diff", "--cached", "--name-only")
    .split("\n")
    .filter((line) => line !== "");
}

/** The turn's worktree edits and governed staging, then the turn settles. */
async function turn(root: string, work: () => void): Promise<ReturnType<typeof beginTurnIndex>> {
  const record = beginTurnIndex(root);
  await record.start;
  work();
  settleTurnIndex(root, record);
  await record.settled;
  return record;
}

describe("turn index restore", () => {
  it("unstages the paths the turn staged, back to their turn-start state", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      writeFileSync(join(root, "new.txt"), "new\n");
      git(root, "add", "a.txt", "new.txt");
    });
    expect(staged(root)).toEqual(["a.txt", "new.txt"]);

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: "restored",
      restoredCount: 2,
    });

    expect(staged(root)).toEqual([]);
    // Only the index moved: the worktree is the runtime's to restore.
    expect(git(root, "status", "--porcelain")).toContain(" M a.txt");
    expect(git(root, "ls-files", "new.txt")).toBe("");
  });

  it("keeps the staging a person made before the turn and restores a path the turn re-staged", async () => {
    const root = repository();
    writeFileSync(join(root, "p.txt"), "person staged\n");
    writeFileSync(join(root, "b.txt"), "person staged b\n");
    git(root, "add", "p.txt", "b.txt");
    const personBlob = git(root, "ls-files", "-s", "b.txt");

    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      writeFileSync(join(root, "b.txt"), "turn changed b\n");
      git(root, "add", "a.txt", "b.txt");
    });

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: "restored",
      restoredCount: 2,
    });

    expect(staged(root)).toEqual(["b.txt", "p.txt"]);
    expect(git(root, "ls-files", "-s", "b.txt")).toBe(personBlob);
  });

  it("restores a path the turn unstaged that the person had staged", async () => {
    const root = repository();
    writeFileSync(join(root, "p.txt"), "person staged\n");
    git(root, "add", "p.txt");
    const record = await turn(root, () => {
      git(root, "restore", "--staged", "p.txt");
    });
    expect(staged(root)).toEqual([]);

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toMatchObject({
      outcome: "restored",
    });

    expect(staged(root)).toEqual(["p.txt"]);
  });

  it("fails closed and changes nothing when a touched path changed after the turn", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    writeFileSync(join(root, "a.txt"), "a changed again by the person\n");
    git(root, "add", "a.txt");
    const before = git(root, "ls-files", "-s");

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: "changed-after-turn",
      restoredCount: 0,
    });

    expect(git(root, "ls-files", "-s")).toBe(before);
  });

  it("leaves a path the person staged after the turn alone", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    writeFileSync(join(root, "p.txt"), "staged later\n");
    git(root, "add", "p.txt");

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toMatchObject({
      outcome: "restored",
    });

    expect(staged(root)).toEqual(["p.txt"]);
  });

  it("leaves the index alone when the turn committed", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
      git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "turn commit");
    });
    writeFileSync(join(root, "b.txt"), "b staged later\n");
    git(root, "add", "b.txt");

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: "head-moved",
      restoredCount: 0,
    });

    expect(staged(root)).toEqual(["b.txt"]);
  });

  it("restores from the live index when the turn was undone before it settled", async () => {
    const root = repository();
    const record = beginTurnIndex(root);
    await record.start;
    writeFileSync(join(root, "a.txt"), "a changed\n");
    git(root, "add", "a.txt");

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toMatchObject({
      outcome: "restored",
    });

    expect(staged(root)).toEqual([]);
  });

  it("does nothing for a turn that staged nothing, and for a folder that is not a repository", async () => {
    const root = repository();
    const idle = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "edited only\n");
    });
    await expect(restoreTurnIndex(root, idle, GOVERNED)).resolves.toEqual({
      outcome: undefined,
      restoredCount: 0,
    });
    await expect(restoreTurnIndex(root, undefined, GOVERNED)).resolves.toMatchObject({
      outcome: undefined,
    });

    const plain = realpathSync(mkdtempSync(join(tmpdir(), "keiko-turn-index-plain-")));
    roots.push(plain);
    mkdirSync(join(plain, "src"));
    expect(await captureTurnIndex(plain)).toBeUndefined();
    const record = await turn(plain, () => undefined);
    await expect(restoreTurnIndex(plain, record, GOVERNED)).resolves.toMatchObject({
      outcome: undefined,
    });
  });

  it("leaves what the person staged in the Git window while the turn ran", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
      writeFileSync(join(root, "p.txt"), "person staged during the turn\n");
      git(root, "add", "p.txt");
    });

    // The unrecorded path stays, and the outcome says staged changes may remain.
    await expect(restoreTurnIndex(root, record, governedOf(["a.txt"]))).resolves.toEqual({
      outcome: "partial",
      restoredCount: 1,
    });

    expect(staged(root)).toEqual(["p.txt"]);
  });

  it("never claims a restore for a record that names nothing the turn changed", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });

    await expect(restoreTurnIndex(root, record, governedOf([]))).resolves.toEqual({
      outcome: "partial",
      restoredCount: 0,
    });
    // A record the per-run cap cut is known to be incomplete: the index is reported unavailable.
    await expect(restoreTurnIndex(root, record, governedOf([], true))).resolves.toEqual({
      outcome: "unavailable",
      restoredCount: 0,
    });

    expect(staged(root)).toEqual(["a.txt"]);
  });

  it("uses the live index for a step that began after the turn last settled", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    // A continuation step begins and stages another path before the person presses undo.
    reopenTurnIndex(record);
    writeFileSync(join(root, "b.txt"), "b changed by step two\n");
    git(root, "add", "b.txt");

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: "restored",
      restoredCount: 2,
    });

    expect(staged(root)).toEqual([]);
  });

  it("is an honest no-op when the index is already at the turn start", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    await restoreTurnIndex(root, record, GOVERNED);

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: undefined,
      restoredCount: 0,
    });
  });

  it("refuses to guess at an intent-to-add entry", async () => {
    const root = repository();
    writeFileSync(join(root, "new.txt"), "new\n");
    git(root, "add", "-N", "new.txt");
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });

    await expect(restoreTurnIndex(root, record, GOVERNED)).resolves.toEqual({
      outcome: "unavailable",
      restoredCount: 0,
    });

    expect(staged(root)).toEqual(["a.txt"]);
  });

  it("restores the paths within its bound and reports the rest as partial", async () => {
    const root = repository();
    const names = Array.from({ length: 70 }, (_unused, index) => `person-${String(index)}.txt`);
    for (const name of names) writeFileSync(join(root, name), "committed\n");
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "more files");
    for (const name of names) writeFileSync(join(root, name), "person staged\n");
    git(root, "add", ...names);
    const record = await turn(root, () => {
      for (const name of names) writeFileSync(join(root, name), "turn staged\n");
      git(root, "add", ...names);
    });

    const result = await restoreTurnIndex(root, record, governedOf(names));

    expect(result).toEqual({ outcome: "partial", restoredCount: 64 });
    expect(staged(root)).toHaveLength(70);
  });

  it("changes nothing and throws when Git's index lock is held", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    writeFileSync(join(root, ".git", "index.lock"), "");
    const before = readFileSync(join(root, ".git", "index"));

    await expect(restoreTurnIndex(root, record, GOVERNED)).rejects.toThrow();

    expect(readFileSync(join(root, ".git", "index")).equals(before)).toBe(true);
  });
});

describe("the wait for a turn's index start", () => {
  function hungRecord(): TurnIndexRecord {
    // A capture that never answers: a huge index or a hung filesystem monitor.
    return { start: new Promise<IndexRead>(() => undefined) };
  }

  it("is cut at the bound and the undo then reports the index unavailable", async () => {
    vi.useFakeTimers();
    try {
      const record = hungRecord();
      const waiting = awaitTurnIndexStart(record, new AbortController().signal, 5_000);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(waiting).resolves.toBe("capture-timed-out");
      await expect(record.start).resolves.toBe("unreadable");
      expect((record.failure as Error).message).toBe("capture-timed-out");
      await expect(restoreTurnIndex(repository(), record, GOVERNED)).resolves.toEqual({
        outcome: "unavailable",
        restoredCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is cut at once by Stop, before the bound", async () => {
    const record = hungRecord();
    const stop = new AbortController();
    const waiting = awaitTurnIndexStart(record, stop.signal, 600_000);
    stop.abort();

    await expect(waiting).resolves.toBe("capture-aborted");
    await expect(record.start).resolves.toBe("unreadable");
  });

  it("leaves a capture that answered in time untouched", async () => {
    const root = repository();
    const record = beginTurnIndex(root);

    await expect(awaitTurnIndexStart(record, new AbortController().signal)).resolves.toBe(
      undefined,
    );
    await expect(record.start).resolves.toMatchObject({ staged: new Map() });
    expect(record.failure).toBeUndefined();
  });
});
