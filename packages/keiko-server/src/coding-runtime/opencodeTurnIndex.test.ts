import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withGitIndexTransaction } from "@oscharko-dev/keiko-workspace/internal/git-index";

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
  reopenTurnIndex,
  restoreTurnIndex,
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
    ).resolves.toEqual({ value: true, transitions: undefined });
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
