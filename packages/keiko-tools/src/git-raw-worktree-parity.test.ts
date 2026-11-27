// Parity of the raw worktree reader with `git status --porcelain` for the repository shapes a real
// customer checkout contains but a plain fixture does not (#4491): nested repositories, submodules,
// out-of-workspace symlinks, line-ending conversion, `core.fileMode=false` and an unborn HEAD. Every
// case runs against a real throwaway repository.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GitRawWorktreeReadError,
  readGitRawChanges,
  readGitRawChangesAtHead,
  readGitRawWorktreeSnapshot,
  readGitRawWorktreeSnapshotAtHead,
} from "./git-raw-worktree-node.js";
import { nodeSpawnFn } from "./exec.js";
import { readGitHeadState } from "./git-worktree-snapshot-node.js";

const dirs: string[] = [];
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", env }).trim();
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-parity-")));
  dirs.push(dir);
  return dir;
}
function repository(commit = true): string {
  const root = tempDir();
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.name", "Keiko Test"]);
  git(root, ["config", "user.email", "keiko@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  if (commit) {
    writeFileSync(join(root, "code.txt"), "base\n");
    git(root, ["add", "code.txt"]);
    git(root, ["commit", "-qm", "base"]);
  }
  return root;
}
const deps = (root: string): Parameters<typeof readGitRawChanges>[0] => ({
  workspace: {
    root,
    selectedRoot: root,
    name: "test",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  } satisfies WorkspaceInfo,
  processEnv: { PATH: process.env.PATH },
});
// The tracked-path part of `git status --porcelain`, one `XY path` line per change.
function gitStatusTracked(root: string): readonly string[] {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
    env,
  })
    .split("\n")
    .filter((line) => line.length > 0);
}
async function readerStatus(root: string): Promise<readonly string[]> {
  const raw = await readGitRawChanges(deps(root));
  return raw.changes
    .filter((change) => !change.untracked)
    .map((change) => `${change.indexStatus}${change.worktreeStatus} ${change.path}`);
}
const porcelain = (lines: readonly string[]): readonly string[] =>
  lines.map((line) => line.replaceAll(" ", "."));

beforeEach(() => {
  dirs.length = 0;
});
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("an untracked nested repository", () => {
  it("is an opaque untracked entry, never read into and never a blocking read failure", async () => {
    const root = repository();
    mkdirSync(join(root, "vendor-clone"));
    git(join(root, "vendor-clone"), ["init", "-q"]);
    writeFileSync(join(root, "vendor-clone", "inner.txt"), "inner\n");
    expect(git(root, ["status", "--porcelain"])).toBe("?? vendor-clone/");
    const raw = await readGitRawChanges(deps(root));
    expect(raw.truncated).toBe(false);
    expect(raw.changes).toEqual([]);
    expect(raw.opaqueUntrackedCount).toBe(1);
    const snapshot = await readGitRawWorktreeSnapshot(deps(root));
    expect(snapshot.untrackedFileCount).toBe(1);
  });
});

describe("a tracked submodule", () => {
  it("is not read as a file and reads clean when git status says clean", async () => {
    const root = repository();
    const upstream = repository();
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub"]);
    git(root, ["commit", "-qm", "add submodule"]);
    expect(gitStatusTracked(root)).toEqual([]);
    const raw = await readGitRawChanges(deps(root));
    expect(raw.changes).toEqual([]);
    expect(raw.truncated).toBe(false);
  });
});

describe("a tracked symlink the staging lane would refuse", () => {
  it.each([
    ["absolute", "/etc/hosts"],
    ["escaping", "../outside-target"],
  ])("reads an unchanged %s link as clean and a retargeted one as modified", async (_n, target) => {
    const root = repository();
    symlinkSync(target, join(root, "link"));
    git(root, ["add", "link"]);
    git(root, ["commit", "-qm", "link"]);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "code.txt"), later, later);
    expect(await readerStatus(root)).toEqual([]);
    rmSync(join(root, "link"));
    symlinkSync("elsewhere", join(root, "link"));
    expect(gitStatusTracked(root)).toEqual([" M link"]);
    expect(porcelain(await readerStatus(root))).toEqual(porcelain([" M link"]));
  });
});

describe("conversion and mode parity with git status", () => {
  // Status never converts to compare when the file SIZE moved (`ie_modified` reports the data change at
  // once), so a CRLF rewrite of an LF blob is ` M` there too: parity, not leniency.
  it("agrees that a CRLF rewrite of an LF blob under core.autocrlf=input is modified", async () => {
    const root = repository();
    git(root, ["config", "core.autocrlf", "input"]);
    writeFileSync(join(root, "text.txt"), "one\ntwo\n");
    git(root, ["add", "text.txt"]);
    git(root, ["commit", "-qm", "text"]);
    writeFileSync(join(root, "text.txt"), "one\r\ntwo\r\n");
    expect(gitStatusTracked(root)).toEqual([" M text.txt"]);
    expect(porcelain(await readerStatus(root))).toEqual(porcelain([" M text.txt"]));
  });

  it("keeps a CRLF blob already in the index clean under core.autocrlf=input after a touch", async () => {
    const root = repository();
    writeFileSync(join(root, "crlf.txt"), "one\r\ntwo\r\n");
    git(root, ["add", "crlf.txt"]);
    git(root, ["commit", "-qm", "crlf"]);
    git(root, ["config", "core.autocrlf", "input"]);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "crlf.txt"), later, later);
    expect(gitStatusTracked(root)).toEqual([]);
    expect(await readerStatus(root)).toEqual([]);
    writeFileSync(join(root, "crlf.txt"), "one\ntwo\n");
    expect(porcelain(await readerStatus(root))).toEqual(porcelain(gitStatusTracked(root)));
  });

  it("never converts a file git treats as binary", async () => {
    const root = repository();
    git(root, ["config", "core.autocrlf", "input"]);
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 10, 2]));
    git(root, ["add", "bin.dat"]);
    git(root, ["commit", "-qm", "bin"]);
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 13, 10, 2]));
    expect(gitStatusTracked(root)).toEqual([" M bin.dat"]);
    expect(porcelain(await readerStatus(root))).toEqual(porcelain([" M bin.dat"]));
  });

  it("honours core.fileMode=false for a chmod and still reports a content change", async () => {
    const root = repository();
    git(root, ["config", "core.fileMode", "false"]);
    chmodSync(join(root, "code.txt"), 0o755);
    expect(gitStatusTracked(root)).toEqual([]);
    expect(await readerStatus(root)).toEqual([]);
    writeFileSync(join(root, "code.txt"), "changed\n");
    expect(porcelain(await readerStatus(root))).toEqual(porcelain([" M code.txt"]));
  });

  it.each([
    ["an empty value", ""],
    ["a zero integer", "00"],
  ])("reads core.fileMode as Git's boolean for %s", async (_label, value) => {
    const root = repository();
    git(root, ["config", "core.fileMode", value]);
    chmodSync(join(root, "code.txt"), 0o755);
    expect(gitStatusTracked(root)).toEqual([]);
    expect(await readerStatus(root)).toEqual([]);
  });

  it("refuses a core.fileMode value Git cannot read as a boolean", async () => {
    const root = repository();
    git(root, ["config", "core.fileMode", "maybe"]);
    chmodSync(join(root, "code.txt"), 0o755);
    await expect(readerStatus(root)).rejects.toThrow();
  });

  it("reports a chmod as modified when core.fileMode is on", async () => {
    const root = repository();
    chmodSync(join(root, "code.txt"), 0o755);
    expect(gitStatusTracked(root)).toEqual([" M code.txt"]);
    expect(porcelain(await readerStatus(root))).toEqual(porcelain([" M code.txt"]));
  });
});

describe("an unborn HEAD", () => {
  it("fails with the closed unborn-head code instead of a generic git exit", async () => {
    const root = repository(false);
    const failure = await readGitRawChanges(deps(root)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitRawWorktreeReadError);
    expect(failure).toMatchObject({ code: "git-raw-unborn-head" });
  });

  // #4491: the first commit of a fresh `git init` is a root commit, so the reader that serves it
  // reports the unborn state explicitly and diffs against the empty tree.
  it("reads staged files of an unborn branch as additions against the empty tree", async () => {
    const root = repository(false);
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    writeFileSync(join(root, "loose.txt"), "loose\n");
    git(root, ["add", "a.txt", "b.txt"]);
    expect(gitStatusTracked(root)).toEqual(["A  a.txt", "A  b.txt"]);
    const raw = await readGitRawChangesAtHead(deps(root));
    expect(raw.head).toEqual({ kind: "unborn", branch: "master", objectIdLength: 40 });
    expect(raw.branch).toBe("master");
    const tracked = raw.changes
      .filter((change) => !change.untracked)
      .map((change) => `${change.indexStatus}${change.worktreeStatus} ${change.path}`);
    expect(porcelain(tracked)).toEqual(porcelain(gitStatusTracked(root)));
    expect(raw.changes.filter((change) => change.untracked).map((change) => change.path)).toEqual([
      "loose.txt",
    ]);
    const snapshot = await readGitRawWorktreeSnapshotAtHead(deps(root));
    expect(snapshot).toMatchObject({ stagedFileCount: 2, untrackedFileCount: 1 });
    expect(snapshot.headSha).toBeUndefined();
    expect(snapshot.currentBranchName).toBe("master");
  });

  it("keeps the closed failure for a caller that needs a commit", async () => {
    const root = repository(false);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "a.txt"]);
    await expect(readGitRawWorktreeSnapshot(deps(root))).rejects.toMatchObject({
      code: "git-raw-unborn-head",
    });
  });

  it("reads a SHA-256 repository's unborn head with its object id length", async () => {
    const root = tempDir();
    git(root, ["init", "-q", "-b", "master", "--object-format=sha256"]);
    expect((await readGitRawChangesAtHead(deps(root))).head).toEqual({
      kind: "unborn",
      branch: "master",
      objectIdLength: 64,
    });
  });

  it("treats a branch that was born during the read as drift", async () => {
    const root = repository(false);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, ["add", "a.txt"]);
    let born = false;
    const read = readGitRawChangesAtHead({
      ...deps(root),
      spawn: (command, args, spawnOptions) => {
        if (!born && args.includes("--others")) {
          born = true;
          git(root, ["commit", "-qm", "concurrent root"]);
        }
        return nodeSpawnFn(command, args, spawnOptions);
      },
    });
    await expect(read).rejects.toMatchObject({ code: "git-raw-snapshot-drift" });
  });
});

// The unborn state is exact: HEAD names a branch whose ref is absent. A ref that exists but does not
// resolve to a commit is damage and fails closed with its own closed cause, never as a fresh repository.
describe("the unborn state is exact", () => {
  it("fails closed when the branch ref exists but is not a commit", async () => {
    const root = repository(false);
    writeFileSync(join(root, "blob.txt"), "not a commit\n");
    const blob = git(root, ["hash-object", "-w", "blob.txt"]);
    writeFileSync(join(root, ".git", "refs", "heads", "master"), `${blob}\n`);
    await expect(readGitHeadState(deps(root))).rejects.toThrow("git-head-ref-unreadable");
    await expect(readGitRawChangesAtHead(deps(root))).rejects.toThrow("git-head-ref-unreadable");
  });
  it("still reads a branch with no ref as unborn", async () => {
    const root = repository(false);
    await expect(readGitHeadState(deps(root))).resolves.toEqual({
      kind: "unborn",
      branch: "master",
      objectIdLength: 40,
    });
  });
});
