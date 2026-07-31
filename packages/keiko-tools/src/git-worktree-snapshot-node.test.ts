// Integration coverage for the read-only worktree snapshot reader (Issue #475). Exercises the real
// read-only spawn boundary against a disposable, hermetic git repository: the reader builds a content-
// free GitWorktreeSnapshot from live `git status/branch/remote` output and lists staged paths, without
// any write subcommand reaching the dedicated read allowlist.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_WORKTREE_READ_COMMAND_RULES,
  GitWorktreeReadError,
  readGitRemoteUrl,
  readGitWorktreeSnapshot,
  readStagedConflictMarkerFileCount,
  readStagedPaths,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";
import { isCommandAllowed } from "./sandbox.js";

let root: string;
let info: WorkspaceInfo;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function workspaceInfo(rootPath: string): WorkspaceInfo {
  return {
    root: rootPath,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function deps(): NodeGitWorktreeReaderDeps {
  return { workspace: info, processEnv: { PATH: process.env.PATH ?? "" }, now: () => Date.now() };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-read-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  info = workspaceInfo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("read-only allowlist", () => {
  it("permits only inspection subcommands and denies every mutation/network verb", () => {
    for (const sub of ["status", "rev-parse", "branch", "remote", "diff"]) {
      expect(isCommandAllowed(GIT_WORKTREE_READ_COMMAND_RULES, "git", [sub]).allowed).toBe(true);
    }
    for (const sub of ["commit", "add", "switch", "reset", "push", "fetch"]) {
      expect(isCommandAllowed(GIT_WORKTREE_READ_COMMAND_RULES, "git", [sub]).allowed).toBe(false);
    }
  });
});

describe("readGitWorktreeSnapshot", () => {
  it("reports the current branch, staged/unstaged/untracked counts, and local branches", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    git(["branch", "feature/x"]);
    // staged change
    writeFileSync(join(root, "a.txt"), "v2\n", "utf8");
    git(["add", "a.txt"]);
    // unstaged change to a tracked file
    writeFileSync(join(root, "a.txt"), "v3\n", "utf8");
    // untracked file
    writeFileSync(join(root, "u.txt"), "new\n", "utf8");

    const snap = await readGitWorktreeSnapshot(deps());
    expect(snap.headDetached).toBe(false);
    expect(snap.currentBranchName).toBe("main");
    expect(snap.stagedFileCount).toBe(1);
    expect(snap.unstagedFileCount).toBe(1);
    expect(snap.untrackedFileCount).toBe(1);
    expect([...snap.existingLocalBranchNames].sort()).toEqual(["feature/x", "main"]);
    expect(snap.hasUpstream).toBe(false);
    expect(snap.remoteAliases).toEqual([]);
  });

  it("reports a detached HEAD", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    git(["checkout", "--detach", "HEAD"]);

    const snap = await readGitWorktreeSnapshot(deps());
    expect(snap.headDetached).toBe(true);
    expect(snap.currentBranchName).toBeUndefined();
  });

  it("throws a content-free GitWorktreeReadError outside a git repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-not-git-")));
    try {
      await expect(
        readGitWorktreeSnapshot({ ...deps(), workspace: workspaceInfo(bare) }),
      ).rejects.toBeInstanceOf(GitWorktreeReadError);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("readStagedPaths", () => {
  it("lists exactly the staged relative paths", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, "b.txt"), "x\n", "utf8");
    writeFileSync(join(root, "c.txt"), "y\n", "utf8");
    git(["add", "b.txt", "c.txt"]);

    const staged = await readStagedPaths(deps());
    expect([...staged].sort()).toEqual(["b.txt", "c.txt"]);
  });

  it("returns an empty list when nothing is staged", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    expect(await readStagedPaths(deps())).toEqual([]);
  });
});

describe("readGitRemoteUrl", () => {
  it("resolves exactly the configured URL for a safe remote alias", async () => {
    git(["remote", "add", "origin", "git@github.com:example/repository.git"]);
    expect(await readGitRemoteUrl(deps(), "origin")).toBe("git@github.com:example/repository.git");
  });

  it("rejects flag-shaped remote aliases before spawning git", async () => {
    await expect(readGitRemoteUrl(deps(), "--upload-pack=evil")).rejects.toBeInstanceOf(
      GitWorktreeReadError,
    );
  });
});

describe("readStagedConflictMarkerFileCount", () => {
  it("returns 0 for an ordinary staged change with no conflict markers", async () => {
    writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, "a.txt"), "v2\n", "utf8");
    git(["add", "a.txt"]);
    expect(await readStagedConflictMarkerFileCount(deps())).toBe(0);
  });

  // Reproduces the exact defect (issue #4 of the audit): a real, unresolved merge conflict whose
  // markers are staged (`git add`-ed) WITHOUT being resolved. `git add` clears git's own "unmerged
  // path" state for that file — it is no longer reported as a conflict by `git status` — so nothing
  // upstream of this reader would ever notice; a commit of the current staged tree would silently
  // bake the literal `<<<<<<<`/`=======`/`>>>>>>>` marker lines into history.
  it("counts a REAL staged, unresolved merge conflict whose markers were git-add-ed without being resolved", async () => {
    writeFileSync(join(root, "shared.txt"), "base\n", "utf8");
    git(["add", "shared.txt"]);
    git(["commit", "-m", "base"]);
    git(["checkout", "-b", "branch-a"]);
    writeFileSync(join(root, "shared.txt"), "change-a\n", "utf8");
    git(["commit", "-am", "change on a"]);
    git(["checkout", "-b", "branch-b", "main"]);
    writeFileSync(join(root, "shared.txt"), "change-b\n", "utf8");
    git(["commit", "-am", "change on b"]);
    try {
      git(["merge", "branch-a"]);
    } catch {
      // Expected: the merge conflicts. The working tree now holds git's own conflict markers.
    }
    const conflicted = readFileSync(join(root, "shared.txt"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    // Stage the STILL-CONFLICTED content verbatim — the exact "staged conflicted file" scenario the
    // fix targets, never actually resolving the conflict.
    git(["add", "shared.txt"]);
    expect(await readStagedConflictMarkerFileCount(deps())).toBe(1);
  });

  it("does not flag a staged whitespace-only issue as a conflict marker (distinct --check diagnostic)", async () => {
    writeFileSync(join(root, "a.txt"), "line one\n", "utf8");
    git(["add", "a.txt"]);
    git(["commit", "-m", "base"]);
    // Trailing whitespace: `git diff --check` reports THIS too, but under a different diagnostic
    // ("trailing whitespace"), never "leftover conflict marker" — must not be conflated with one.
    writeFileSync(join(root, "a.txt"), "line one \n", "utf8");
    git(["add", "a.txt"]);
    expect(await readStagedConflictMarkerFileCount(deps())).toBe(0);
  });

  it("throws a content-free GitWorktreeReadError outside a git repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-not-git-conflict-")));
    try {
      await expect(
        readStagedConflictMarkerFileCount({ ...deps(), workspace: workspaceInfo(bare) }),
      ).rejects.toBeInstanceOf(GitWorktreeReadError);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
