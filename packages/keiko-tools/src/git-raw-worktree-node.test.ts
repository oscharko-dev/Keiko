import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { readGitRawWorktreeSnapshot } from "./git-raw-worktree-node.js";
import { readGitWorktreeSnapshot } from "./git-worktree-snapshot-node.js";

let root: string;
let remote: string;
let workspace: WorkspaceInfo;
const git = (args: readonly string[], cwd = root): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-")));
  remote = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-remote-")));
  git(["init", "-q", "-b", "master"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "user.email", "keiko@example.test"]);
  writeFileSync(join(root, "code.txt"), "base\n");
  git(["add", "code.txt"]);
  git(["commit", "-qm", "base"]);
  git(["init", "--bare", "-q", remote]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "-u", "origin", "master"]);
  // Advance the remote independently of the local worktree so the local branch is behind.
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "keiko-raw-worktree-clone-")));
  git(["clone", "-q", remote, clone], tmpdir());
  writeFileSync(join(clone, "code.txt"), "advanced\n");
  git(["-C", clone, "add", "code.txt"]);
  git(["-C", clone, "config", "user.name", "Keiko Test"]);
  git(["-C", clone, "config", "user.email", "keiko@example.test"]);
  git(["-C", clone, "commit", "-qm", "advance"]);
  git(["-C", clone, "push", "-q", "origin", "master"]);
  git(["fetch", "-q", "origin"]);
  rmSync(clone, { recursive: true, force: true });
  workspace = {
    root,
    selectedRoot: root,
    name: "test",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe("readGitRawWorktreeSnapshot documented tracking limits", () => {
  it("never reflects the real upstream/ahead/behind state, unlike readGitWorktreeSnapshot", async () => {
    // The real reader sees the local branch is behind its configured upstream.
    const real = await readGitWorktreeSnapshot({ workspace });
    expect(real.hasUpstream).toBe(true);
    expect(real.behindCount).toBeGreaterThan(0);
    // The content-scoped raw reader (commit-facts / editor-diff path) fixes these fields at their
    // disengaged values regardless of the real tracking relation — this is why it must never back a
    // push effect's snapshotReader (see the header comment and doc comment in
    // git-raw-worktree-node.ts). This pin fails if the raw reader is ever changed to derive these
    // fields without also updating the callers that rely on the documented limitation.
    const raw = await readGitRawWorktreeSnapshot({ workspace });
    expect(raw.hasUpstream).toBe(false);
    expect(raw.aheadCount).toBe(0);
    expect(raw.behindCount).toBe(0);
  });
});
