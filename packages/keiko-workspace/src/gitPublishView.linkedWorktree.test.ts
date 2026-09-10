// #3452: gitPublishView.ts now resolves the gitdir through boundWorkspaceFs(workspace,
// nodeWorkspaceFs) -- the owned-root port a prover bound to a Keiko-owned root's WorkspaceInfo, or
// the plain node port for an ordinary one. This file pins both linked-worktree paths that change
// exists for: an ordinary root works exactly as it always has (also pinned by the sibling
// "supports the reciprocal linked-worktree object store" test in gitPublishView.test.ts; kept here
// too as an explicit regression pin scoped to boundWorkspaceFs itself), and a linked worktree placed
// below the always-denied `.keiko` segment is refused through a plain WorkspaceInfo but resolves
// through the owned-root WorkspaceInfo the prover bound to it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withGitPublishView } from "./gitPublishView.js";
import { nodeWorkspaceFs } from "./fs.js";
import {
  workspaceFsWithOwnedRootAuthority,
  workspaceInfoWithOwnedRootAuthority,
} from "./ownedRootMint.js";
import type { WorkspaceInfo } from "./types.js";

function ordinaryWorkspace(workspaceRoot: string): WorkspaceInfo {
  return {
    root: workspaceRoot,
    selectedRoot: workspaceRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

let root: string;
let privateRoot: string;

function git(args: readonly string[], cwd = root): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-publish-linked-worktree-")));
  privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-publish-linked-private-")));
  git(["init", "-qb", "dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  writeFileSync(join(root, "file"), "verified\n");
  git(["add", "file"]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "verified"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(privateRoot, { recursive: true, force: true });
});

describe("withGitPublishView through a linked worktree (#3452 boundWorkspaceFs)", () => {
  it("resolves the parent repository's shared object directory for an ordinary WorkspaceInfo", async () => {
    const worktree = join(root, "worktree");
    git(["worktree", "add", "-qb", "feature/linked-ordinary", worktree]);
    const commit = git(["rev-parse", "HEAD"], worktree);

    await withGitPublishView(
      ordinaryWorkspace(worktree),
      commit,
      (view) => {
        expect(view.objectDirectory).toBe(join(root, ".git/objects"));
        return Promise.resolve();
      },
      privateRoot,
    );
  });

  it("refuses a linked worktree below a denied .keiko segment through a plain WorkspaceInfo", async () => {
    const managed = join(root, ".keiko", "task-workspaces", "ws_1");
    git(["worktree", "add", "-qb", "feature/linked-denied", managed]);
    const commit = git(["rev-parse", "HEAD"], managed);

    await expect(
      withGitPublishView(ordinaryWorkspace(managed), commit, () => Promise.resolve(), privateRoot),
    ).rejects.toThrow("git-publish-metadata-unavailable");
  });

  it("resolves the same linked worktree through the owned-root WorkspaceInfo bound to it", async () => {
    const managed = join(root, ".keiko", "task-workspaces", "ws_1");
    git(["worktree", "add", "-qb", "feature/linked-owned", managed]);
    const commit = git(["rev-parse", "HEAD"], managed);
    const ownedFs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    const workspace = workspaceInfoWithOwnedRootAuthority(ordinaryWorkspace(managed), ownedFs);

    await withGitPublishView(
      workspace,
      commit,
      (view) => {
        expect(view.objectDirectory).toBe(join(root, ".git/objects"));
        return Promise.resolve();
      },
      privateRoot,
    );
  });
});
