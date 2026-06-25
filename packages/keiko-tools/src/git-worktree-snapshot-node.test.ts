// Integration coverage for the read-only worktree snapshot reader (Issue #475). Exercises the real
// read-only spawn boundary against a disposable, hermetic git repository: the reader builds a content-
// free GitWorktreeSnapshot from live `git status/branch/remote` output and lists staged paths, without
// any write subcommand reaching the dedicated read allowlist.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_WORKTREE_READ_COMMAND_RULES,
  GitWorktreeReadError,
  readGitWorktreeSnapshot,
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
