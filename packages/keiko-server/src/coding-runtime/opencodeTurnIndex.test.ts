import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { processServerLogSink } from "../process-log-sink.js";

import { withGitIndexTransaction } from "@oscharko-dev/keiko-workspace/internal/git-index";

import type { GitProcessRunner } from "@oscharko-dev/keiko-git";

// Counts every Git process the turn index starts, through the production runner.
const gitProcesses = vi.hoisted(() => ({ count: 0, widestArgv: 0 }));
vi.mock("../gitProcessActivity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitProcessActivity.js")>();
  return {
    ...actual,
    observedGitRunner: (...args: Parameters<typeof actual.observedGitRunner>): GitProcessRunner => {
      const run = actual.observedGitRunner(...args);
      return async (gitArgs, options) => {
        gitProcesses.count += 1;
        gitProcesses.widestArgv = Math.max(gitProcesses.widestArgv, gitArgs.join(" ").length);
        return await run(gitArgs, options);
      };
    },
  };
});

// A sharing violation on the private index copy's removal, injected through the removal seam of the
// production transaction while a test asks for it: the cleanup line is the only thing it changes.
const cleanupFault = vi.hoisted(() => ({ on: false }));
vi.mock("@oscharko-dev/keiko-workspace/internal/git-index", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-workspace/internal/git-index")>();
  const removePath: Parameters<typeof actual.withGitIndexTransaction>[4] = {
    removePath: (path, kind) => {
      if (kind === "file" && path.includes(".keiko-index-"))
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      if (kind === "directory") rmdirSync(path);
      else rmSync(path, { recursive: kind === "tree", force: true });
    },
  };
  return {
    ...actual,
    withGitIndexTransaction: ((root, work, accepted, fs, options) =>
      actual.withGitIndexTransaction(
        root,
        work,
        accepted,
        fs,
        cleanupFault.on ? { ...options, ...removePath } : options,
      )) as typeof actual.withGitIndexTransaction,
  };
});

import {
  AT_HEAD,
  type GovernedIndexRecord,
  governedIndexRecord,
  noteGovernedIndexTransitions,
  resetGovernedIndexPaths,
} from "./governedIndexPaths.js";
import {
  awaitTurnIndexStart,
  beginTurnIndex,
  type IndexRead,
  type TurnIndexRecord,
  captureTurnIndex,
  countRestorableTurnIndexPaths,
  readGovernedTransitions,
  reapplyTurnIndexMoves,
  reopenTurnIndex,
  restoreTurnIndex,
  type TurnIndexMoves,
  settleTurnIndex,
} from "./opencodeTurnIndex.js";

const roots: string[] = [];
/** The paths the turn's governed staging names unless a test says otherwise. */
const GOVERNED_NAMES = ["a.txt", "b.txt", "p.txt", "new.txt"];
const governedByRecord = new WeakMap<TurnIndexRecord, GovernedIndexRecord>();

/**
 * What governed staging records after its mutation: the entry the index holds for each path right
 * now, read through the production index reader.
 */
async function governedNow(root: string, paths: readonly string[]): Promise<GovernedIndexRecord> {
  const image = await captureTurnIndex(root);
  const written = new Map<string, string>();
  if (typeof image === "object")
    for (const path of paths) written.set(path, image.staged.get(path) ?? AT_HEAD);
  return { paths: [...written.keys()], written, previous: new Map(), truncated: false };
}

function governedOf(record: TurnIndexRecord | undefined): GovernedIndexRecord {
  return (
    (record === undefined ? undefined : governedByRecord.get(record)) ?? {
      paths: [],
      written: new Map(),
      previous: new Map(),
      truncated: false,
    }
  );
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
async function turn(
  root: string,
  work: () => void,
  governedNames: readonly string[] = GOVERNED_NAMES,
): Promise<ReturnType<typeof beginTurnIndex>> {
  const record = beginTurnIndex(root);
  await record.start;
  work();
  governedByRecord.set(record, await governedNow(root, governedNames));
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

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toMatchObject({
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

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
      outcome: "changed-after-turn",
      restoredCount: 0,
    });

    expect(git(root, "ls-files", "-s")).toBe(before);
  });

  // Every settled run asks for this count before it reaches `succeeded`, so a turn without
  // governed staging must not pay a Git process for it (coding perf budget, PR #4573).
  it("reads no index for a turn without governed staging", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed by the person\n");
      git(root, "add", "a.txt");
    });
    const before = gitProcesses.count;

    await expect(countRestorableTurnIndexPaths(root, record, governedOf(undefined))).resolves.toBe(
      0,
    );
    expect(gitProcesses.count).toBe(before);
  });

  it("offers no undo for a turn whose restore would refuse because a person restaged one of its paths", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      writeFileSync(join(root, "b.txt"), "b changed\n");
      git(root, "add", "a.txt", "b.txt");
    });
    await expect(countRestorableTurnIndexPaths(root, record, governedOf(record))).resolves.toBe(2);

    writeFileSync(join(root, "a.txt"), "a changed again by the person\n");
    git(root, "add", "a.txt");

    const refused = await restoreTurnIndex(root, record, governedOf(record));
    expect(refused).toEqual({ outcome: "changed-after-turn", restoredCount: 0 });
    await expect(countRestorableTurnIndexPaths(root, record, governedOf(record))).resolves.toBe(0);
  });

  it("leaves a path the person staged after the turn alone", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    writeFileSync(join(root, "p.txt"), "staged later\n");
    git(root, "add", "p.txt");

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toMatchObject({
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

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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
    governedByRecord.set(record, await governedNow(root, ["a.txt"]));

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toMatchObject({
      outcome: "restored",
    });

    expect(staged(root)).toEqual([]);
  });

  it("does nothing for a turn that staged nothing, and for a folder that is not a repository", async () => {
    const root = repository();
    const idle = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "edited only\n");
    });
    await expect(restoreTurnIndex(root, idle, governedOf(idle))).resolves.toEqual({
      outcome: undefined,
      restoredCount: 0,
    });
    await expect(restoreTurnIndex(root, undefined, governedOf(undefined))).resolves.toMatchObject({
      outcome: undefined,
    });

    const plain = realpathSync(mkdtempSync(join(tmpdir(), "keiko-turn-index-plain-")));
    roots.push(plain);
    mkdirSync(join(plain, "src"));
    expect(await captureTurnIndex(plain)).toBeUndefined();
    const record = await turn(plain, () => undefined);
    await expect(restoreTurnIndex(plain, record, governedOf(record))).resolves.toMatchObject({
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
    }, ["a.txt"]);

    // The unrecorded path stays, and the outcome says staged changes may remain.
    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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
    }, []);

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
      outcome: "partial",
      restoredCount: 0,
    });
    // A record the per-run cap cut is known to be incomplete: the index is reported unavailable.
    await expect(
      restoreTurnIndex(root, record, { ...governedOf(record), truncated: true }),
    ).resolves.toEqual({
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
    governedByRecord.set(record, await governedNow(root, ["a.txt", "b.txt"]));

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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
    await restoreTurnIndex(root, record, governedOf(record));

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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

    await expect(restoreTurnIndex(root, record, governedOf(record))).resolves.toEqual({
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
    const record = await turn(
      root,
      () => {
        for (const name of names) writeFileSync(join(root, name), "turn staged\n");
        git(root, "add", ...names);
      },
      names,
    );

    const result = await restoreTurnIndex(root, record, governedOf(record));

    expect(result).toEqual({ outcome: "partial", restoredCount: 64 });
    expect(staged(root)).toHaveLength(70);
  });

  it("never takes back the bytes a person staged for the same path before the turn settled", async () => {
    const root = repository();
    const record = beginTurnIndex(root);
    await record.start;
    // Keiko's governed staging writes one entry for a.txt and records it ...
    writeFileSync(join(root, "a.txt"), "staged by Keiko\n");
    git(root, "add", "a.txt");
    const recorded = await governedNow(root, ["a.txt"]);
    // ... and the person stages other bytes for the same path before the turn settles.
    writeFileSync(join(root, "a.txt"), "staged by the person\n");
    git(root, "add", "a.txt");
    settleTurnIndex(root, record);
    await record.settled;
    const before = git(root, "ls-files", "-s", "a.txt");

    await expect(restoreTurnIndex(root, record, recorded)).resolves.toEqual({
      outcome: "changed-after-turn",
      restoredCount: 0,
    });

    expect(git(root, "ls-files", "-s", "a.txt")).toBe(before);
  });

  it("restores what the turn staged in a repository whose branch has no commit yet", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-turn-index-unborn-")));
    roots.push(root);
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "turn staged\n");
    const record = beginTurnIndex(root);
    await record.start;
    git(root, "add", "a.txt");
    const recorded = await governedNow(root, ["a.txt"]);
    settleTurnIndex(root, record);
    await record.settled;
    expect(staged(root)).toEqual(["a.txt"]);

    await expect(restoreTurnIndex(root, record, recorded)).resolves.toEqual({
      outcome: "restored",
      restoredCount: 1,
    });

    expect(staged(root)).toEqual([]);
  });

  it("writes the cleanup line of an Undo's index transaction on the run's correlation", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    const write = vi.spyOn(processServerLogSink(), "write");
    cleanupFault.on = true;
    try {
      await expect(
        restoreTurnIndex(root, record, governedOf(record), undefined, "run-correlation-1"),
      ).resolves.toEqual({ outcome: "restored", restoredCount: 1 });
      const lines = write.mock.calls
        .map(([event]) => event)
        .filter((event) => event.op === "git.index-transaction.cleanup-incomplete");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        correlationId: "run-correlation-1",
        extra: { caller: "turn-index-restore", temporaryIndexLeft: true },
      });
    } finally {
      cleanupFault.on = false;
      write.mockRestore();
    }
  });

  it("changes nothing and throws when Git's index lock is held", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "a.txt"), "a changed\n");
      git(root, "add", "a.txt");
    });
    writeFileSync(join(root, ".git", "index.lock"), "");
    const before = readFileSync(join(root, ".git", "index"));

    await expect(restoreTurnIndex(root, record, governedOf(record))).rejects.toThrow();

    expect(readFileSync(join(root, ".git", "index")).equals(before)).toBe(true);
  });
});

/** What governed staging does: one index transaction that stages `path` from the worktree. */
async function keikoStages(root: string, path: string): Promise<boolean> {
  return await withGitIndexTransaction(
    root,
    (transaction) => {
      const run = spawnSync("git", ["add", "--", path], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_INDEX_FILE: transaction.temporaryIndexPath,
        },
      });
      return Promise.resolve(run.status === 0);
    },
    (staged) => staged,
  );
}

describe("Restore makes the recorded index moves again", () => {
  const commit = (root: string): void => {
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "more");
  };

  /** Undoes the turn through the production restore and hands back the moves it recorded. */
  async function undone(
    root: string,
    record: TurnIndexRecord,
  ): Promise<{ moves: TurnIndexMoves; count: number }> {
    let recorded: TurnIndexMoves | undefined;
    const result = await restoreTurnIndex(root, record, governedOf(record), (moves) => {
      recorded = moves;
    });
    if (recorded === undefined) throw new Error(`nothing was undone: ${String(result.outcome)}`);
    return { moves: recorded, count: result.restoredCount };
  }

  it("removes the entries a replacing file conflicts with before it writes the file", async () => {
    const root = repository();
    mkdirSync(join(root, "shape"));
    writeFileSync(join(root, "shape", "child.txt"), "child\n");
    commit(root);
    const record = await turn(root, () => {
      git(root, "rm", "-q", "--", "shape/child.txt");
      writeFileSync(join(root, "shape"), "now a file\n");
      git(root, "add", "shape");
    }, ["shape", "shape/child.txt"]);
    const turnEnd = git(root, "ls-files", "-s");
    const { moves, count } = await undone(root, record);
    expect(count).toBe(2);
    expect(git(root, "ls-files", "-s", "shape/child.txt")).not.toBe("");

    await expect(reapplyTurnIndexMoves(root, moves)).resolves.toBe("restored");

    expect(git(root, "ls-files", "-s")).toBe(turnEnd);
  });

  // Windows limits a whole path to 260 characters, which these paths exceed on purpose.
  it.skipIf(process.platform === "win32")(
    "bounds a batch by the whole command line when the paths are long",
    async () => {
      const root = repository();
      const directory = join("long", "d".repeat(100));
      mkdirSync(join(root, directory), { recursive: true });
      const names = Array.from({ length: 150 }, (_unused, index) =>
        join(directory, `${"f".repeat(100)}-${String(index)}.txt`),
      );
      for (const name of names) writeFileSync(join(root, name), "one\n");
      commit(root);
      const record = await turn(
        root,
        () => {
          for (const name of names) writeFileSync(join(root, name), "two\n");
          git(root, "add", "long");
        },
        names,
      );
      const { moves } = await undone(root, record);

      gitProcesses.widestArgv = 0;
      await expect(reapplyTurnIndexMoves(root, moves)).resolves.toBe("restored");

      // 150 paths of about 270 characters each with their `--cacheinfo` token: one batch by count,
      // several by the command line.
      expect(gitProcesses.widestArgv).toBeLessThan(16_500);
    },
  );

  it("writes many paths in a few bounded Git runs and still refuses one a person restaged", async () => {
    const root = repository();
    const names = Array.from({ length: 450 }, (_unused, index) => `bulk/file-${String(index)}.txt`);
    mkdirSync(join(root, "bulk"));
    for (const name of names) writeFileSync(join(root, name), "one\n");
    commit(root);
    const record = await turn(
      root,
      () => {
        for (const name of names) writeFileSync(join(root, name), "two\n");
        git(root, "add", "bulk");
      },
      names,
    );
    const turnEnd = git(root, "ls-files", "-s");
    const { moves, count } = await undone(root, record);
    expect(count).toBe(names.length);
    expect(staged(root)).toEqual([]);

    const before = gitProcesses.count;
    gitProcesses.widestArgv = 0;
    await expect(reapplyTurnIndexMoves(root, moves)).resolves.toBe("restored");

    expect(gitProcesses.count - before).toBeLessThanOrEqual(12);
    expect(gitProcesses.widestArgv).toBeLessThan(16_500);
    expect(git(root, "ls-files", "-s")).toBe(turnEnd);

    // The index is put back to the undone state, then a person restages one path.
    git(root, "restore", "--staged", "--", "bulk");
    writeFileSync(join(root, names[7] ?? ""), "three\n");
    git(root, "add", names[7] ?? "");
    await expect(reapplyTurnIndexMoves(root, moves)).resolves.toBe("changed-after-turn");
  });
});

describe("a staged entry outside the plan is never taken out of the index", () => {
  const commit = (root: string): void => {
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "shape");
  };
  const child = "shape/child.txt";
  const blobId = (root: string): string => git(root, "hash-object", "-w", "a.txt").trim();

  function replaceWithDirectory(root: string): void {
    rmSync(join(root, "shape"), { force: true });
    mkdirSync(join(root, "shape"));
    writeFileSync(join(root, child), "person\n");
    git(root, "add", child);
  }

  function replaceWithFile(root: string): void {
    rmSync(join(root, "shape"), { recursive: true, force: true });
    writeFileSync(join(root, "shape"), "person\n");
    git(root, "add", "shape");
  }

  it("refuses an Undo that would restore a file over the person's staged child", async () => {
    const root = repository();
    writeFileSync(join(root, "shape"), "head\n");
    commit(root);
    const record = await turn(root, () => git(root, "rm", "-q", "--", "shape"), ["shape"]);
    replaceWithDirectory(root);
    const before = git(root, "ls-files", "-s");

    const result = await restoreTurnIndex(root, record, governedOf(record));

    expect(result).toEqual({ outcome: "changed-after-turn", restoredCount: 0 });
    expect(git(root, "ls-files", "-s")).toBe(before);
  });

  it("refuses an Undo that would restore a child under the person's staged file", async () => {
    const root = repository();
    mkdirSync(join(root, "shape"));
    writeFileSync(join(root, child), "head\n");
    commit(root);
    const record = await turn(root, () => git(root, "rm", "-q", "--", child), [child]);
    replaceWithFile(root);
    const before = git(root, "ls-files", "-s");

    const result = await restoreTurnIndex(root, record, governedOf(record));

    expect(result.outcome).not.toBe("restored");
    expect(result.restoredCount).toBe(0);
    expect(git(root, "ls-files", "-s")).toBe(before);
  });

  // Git itself refuses to write a file over a staged directory of the same name, and a child under a
  // staged file (the `toThrow` lines). The plan check reaches the collision first and answers
  // `changed-after-turn`, as for Undo; were it absent, `update-index --add` would still refuse
  // (`unavailable`) and the person's entry would still stay.
  it("refuses (changed-after-turn) a Restore that would put a file over the person's staged child", async () => {
    const root = repository();
    const record = await turn(root, () => {
      writeFileSync(join(root, "shape"), "turn\n");
      git(root, "add", "shape");
    }, ["shape"]);
    let moves: TurnIndexMoves | undefined;
    await restoreTurnIndex(root, record, governedOf(record), (made) => {
      moves = made;
    });
    if (moves === undefined) throw new Error("nothing was undone");
    replaceWithDirectory(root);
    const before = git(root, "ls-files", "-s");

    const result = await reapplyTurnIndexMoves(root, moves);

    expect(() =>
      git(root, "update-index", "--add", "--cacheinfo", `100644,${blobId(root)},shape`),
    ).toThrow();
    expect(result).toBe("changed-after-turn");
    expect(git(root, "ls-files", "-s")).toBe(before);
  });

  it("refuses (changed-after-turn) a Restore that would put a child under the person's staged file", async () => {
    const root = repository();
    const record = await turn(root, () => {
      mkdirSync(join(root, "shape"));
      writeFileSync(join(root, child), "turn\n");
      git(root, "add", child);
    }, [child]);
    let moves: TurnIndexMoves | undefined;
    await restoreTurnIndex(root, record, governedOf(record), (made) => {
      moves = made;
    });
    if (moves === undefined) throw new Error("nothing was undone");
    replaceWithFile(root);
    const before = git(root, "ls-files", "-s");

    const result = await reapplyTurnIndexMoves(root, moves);

    expect(() =>
      git(root, "update-index", "--add", "--cacheinfo", `100644,${blobId(root)},${child}`),
    ).toThrow();
    expect(result).toBe("changed-after-turn");
    expect(git(root, "ls-files", "-s")).toBe(before);
  });

  it("restores a file over a former child that is part of the same plan", async () => {
    const root = repository();
    writeFileSync(join(root, "shape"), "head\n");
    commit(root);
    const record = await turn(root, () => {
      git(root, "rm", "-q", "--", "shape");
      mkdirSync(join(root, "shape"));
      writeFileSync(join(root, child), "turn\n");
      git(root, "add", child);
    }, ["shape", child]);

    const result = await restoreTurnIndex(root, record, governedOf(record));

    expect(result).toEqual({ outcome: "restored", restoredCount: 2 });
    expect(staged(root)).toEqual([]);
    expect(git(root, "ls-files", "-s", "shape")).toContain("shape");
  });
});

describe("paths are literal, never pathspec patterns", () => {
  // `:` cannot appear in a Windows file name.
  const magic = process.platform === "win32" ? [] : [":(top).txt"];
  const names = ["a[1].ts", ...magic];

  it("undoes and restores only the files named, not those a pattern in the name would match", async () => {
    const root = repository();
    for (const name of [...names, "a1.ts"]) writeFileSync(join(root, name), "one\n");
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "names");
    let recorded: TurnIndexMoves | undefined;
    const record = await turn(
      root,
      () => {
        for (const name of [...names, "a1.ts"]) writeFileSync(join(root, name), "two\n");
        git(root, "--literal-pathspecs", "add", "--", ...names, "a1.ts");
      },
      names,
    );
    const turnEnd = git(root, "ls-files", "-s");

    const result = await restoreTurnIndex(root, record, governedOf(record), (moves) => {
      recorded = moves;
    });

    expect(result.restoredCount).toBe(names.length);
    // `a1.ts` is the person's staging: the glob in `a[1].ts` must not have reached it.
    expect(staged(root)).toEqual(["a1.ts"]);
    if (recorded === undefined) throw new Error("nothing was undone");
    await expect(reapplyTurnIndexMoves(root, recorded)).resolves.toBe("restored");
    expect(git(root, "ls-files", "-s")).toBe(turnEnd);
  });
});

describe("transitions read inside the governed index transaction", () => {
  const RUN = "run-index-transitions";
  afterEach(() => {
    resetGovernedIndexPaths(RUN);
  });

  async function governedStage(
    root: string,
    afterTransaction: () => void = () => undefined,
  ): Promise<void> {
    const { transitions } = await readGovernedTransitions(
      root,
      ["a.txt"],
      async () => {
        const staged = await keikoStages(root, "a.txt");
        // The lock is released here: whatever happens now is not what the mutation wrote.
        afterTransaction();
        return staged;
      },
      (staged) => staged,
    );
    if (transitions === undefined) throw new Error("transitions unproven");
    noteGovernedIndexTransitions(RUN, transitions);
  }

  it("never records a person's staging that lands after the lock was released as Keiko's", async () => {
    const root = repository();
    const record = beginTurnIndex(root);
    await record.start;
    writeFileSync(join(root, "a.txt"), "staged by Keiko\n");
    await governedStage(root, () => {
      writeFileSync(join(root, "a.txt"), "staged by the person\n");
      git(root, "add", "a.txt");
    });
    settleTurnIndex(root, record);
    await record.settled;
    const before = git(root, "ls-files", "-s", "a.txt");

    await expect(restoreTurnIndex(root, record, governedIndexRecord(RUN))).resolves.toEqual({
      outcome: "changed-after-turn",
      restoredCount: 0,
    });

    expect(git(root, "ls-files", "-s", "a.txt")).toBe(before);
  });

  it("puts back the entry a person staged before Keiko's first mutation, not the turn start", async () => {
    const root = repository();
    const record = beginTurnIndex(root);
    await record.start;
    writeFileSync(join(root, "a.txt"), "staged by the person\n");
    git(root, "add", "a.txt");
    const personsEntry = git(root, "ls-files", "-s", "a.txt");
    writeFileSync(join(root, "a.txt"), "staged by Keiko\n");
    await governedStage(root);
    settleTurnIndex(root, record);
    await record.settled;
    expect(git(root, "ls-files", "-s", "a.txt")).not.toBe(personsEntry);

    await expect(restoreTurnIndex(root, record, governedIndexRecord(RUN))).resolves.toEqual({
      outcome: "restored",
      restoredCount: 1,
    });

    expect(git(root, "ls-files", "-s", "a.txt")).toBe(personsEntry);
  });

  it("proves nothing for a mutation that ran no index transaction", async () => {
    const root = repository();

    await expect(
      readGovernedTransitions(
        root,
        ["a.txt"],
        () => Promise.resolve(true),
        (ok) => ok,
      ),
    ).resolves.toEqual({ value: true, transitions: undefined, unproven: "no-transaction" });
  });
});

describe("owned paths come from the proven transitions, not from the turn images", () => {
  const RUN = "run-index-owned";
  afterEach(() => {
    resetGovernedIndexPaths(RUN);
  });

  async function personStagesThenKeikoUnstages(root: string): Promise<{
    record: TurnIndexRecord;
    personsEntry: string;
  }> {
    const record = beginTurnIndex(root);
    await record.start;
    writeFileSync(join(root, "a.txt"), "staged by the person\n");
    git(root, "add", "a.txt");
    const personsEntry = git(root, "ls-files", "-s", "a.txt");
    const { transitions } = await readGovernedTransitions(
      root,
      ["a.txt"],
      () =>
        withGitIndexTransaction(
          root,
          (transaction) => unstages(root, transaction.temporaryIndexPath),
          (ok) => ok,
        ),
      (ok) => ok,
    );
    if (transitions === undefined) throw new Error("transitions unproven");
    noteGovernedIndexTransitions(RUN, transitions);
    settleTurnIndex(root, record);
    await record.settled;
    return { record, personsEntry };
  }

  function unstages(root: string, indexFile: string): Promise<boolean> {
    const run = spawnSync("git", ["restore", "--staged", "--", "a.txt"], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_INDEX_FILE: indexFile,
      },
    });
    return Promise.resolve(run.status === 0);
  }

  it("takes back a governed unstage of the person's staging although the start and settled images are equal", async () => {
    const root = repository();
    const { record, personsEntry } = await personStagesThenKeikoUnstages(root);
    expect(staged(root)).toEqual([]);
    expect(governedIndexRecord(RUN).written.get("a.txt")).toBe(AT_HEAD);

    await expect(
      countRestorableTurnIndexPaths(root, record, governedIndexRecord(RUN)),
    ).resolves.toBe(1);
    await expect(restoreTurnIndex(root, record, governedIndexRecord(RUN))).resolves.toEqual({
      outcome: "restored",
      restoredCount: 1,
    });

    expect(git(root, "ls-files", "-s", "a.txt")).toBe(personsEntry);
  });

  it("offers exactly the bounded set of paths the restore will put back", async () => {
    const root = repository();
    const names = Array.from({ length: 70 }, (_unused, index) => `person-${String(index)}.txt`);
    for (const name of names) writeFileSync(join(root, name), "committed\n");
    git(root, "add", "-A");
    git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "more files");
    for (const name of names) writeFileSync(join(root, name), "person staged\n");
    git(root, "add", ...names);
    const record = await turn(
      root,
      () => {
        for (const name of names) writeFileSync(join(root, name), "turn staged\n");
        git(root, "add", ...names);
      },
      names,
    );
    const governed = governedOf(record);

    const offered = await countRestorableTurnIndexPaths(root, record, governed);
    const result = await restoreTurnIndex(root, record, governed);

    expect(offered).toBe(64);
    expect(result).toEqual({ outcome: "partial", restoredCount: offered });
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
      await expect(restoreTurnIndex(repository(), record, governedOf(record))).resolves.toEqual({
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
