// Coverage for the narrow managed-worktree adapter (Issue #445). Proves the AC5 property at the
// command-safety layer (the dedicated allowlist can NEVER reach a #470 write subcommand), validates
// the pure operand guards + argv builders + porcelain parser, and exercises the real spawn boundary
// against a disposable git repository (add / list / remove a managed worktree).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { isCommandAllowed } from "./sandbox.js";
import {
  buildAddWorktreeArgv,
  buildLocalBranchExistsArgv,
  buildRefResolvesArgv,
  buildRemoveWorktreeArgv,
  createNodeGitWorktreeAdapter,
  GIT_WORKTREE_COMMAND_RULES,
  GitWorktreeOperandError,
  isSafeGitRefName,
  isSafeWorktreePathOperand,
  parseWorktreeListPorcelain,
  type NodeGitWorktreeAdapterDeps,
} from "./git-worktree-adapter.js";

describe("GIT_WORKTREE_COMMAND_RULES allowlist (AC5)", () => {
  it("permits only the read-only worktree / rev-parse / show-ref / status verbs", () => {
    for (const sub of ["worktree", "rev-parse", "show-ref", "status"]) {
      expect(isCommandAllowed(GIT_WORKTREE_COMMAND_RULES, "git", [sub]).allowed).toBe(true);
    }
  });

  it("can never reach a #470 branch/commit/publish/PR/merge write subcommand", () => {
    for (const sub of [
      "branch",
      "commit",
      "switch",
      "add",
      "restore",
      "push",
      "merge",
      "pull",
      "fetch",
      "reset",
      "checkout",
      "tag",
    ]) {
      expect(isCommandAllowed(GIT_WORKTREE_COMMAND_RULES, "git", [sub]).allowed).toBe(false);
    }
  });

  it("denies global cwd/config-shifting flags before subcommand resolution", () => {
    for (const flag of ["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]) {
      expect(
        isCommandAllowed(GIT_WORKTREE_COMMAND_RULES, "git", [flag, "/x", "worktree"]).allowed,
      ).toBe(false);
    }
  });

  it("denies a non-git executable", () => {
    expect(isCommandAllowed(GIT_WORKTREE_COMMAND_RULES, "rm", ["-rf"]).allowed).toBe(false);
  });
});

describe("operand validation", () => {
  it("accepts the deterministic keiko branch shape", () => {
    expect(isSafeGitRefName("keiko/task/my-task-abc12345")).toBe(true);
    expect(isSafeGitRefName("main")).toBe(true);
  });

  it("rejects options, traversal, metacharacters, control bytes, and empties", () => {
    for (const bad of [
      "-x",
      "../escape",
      "a b",
      "a..b",
      "a//b",
      "a@{0}",
      "a~1",
      "a^1",
      "a:b",
      "a?",
      "a*",
      "a[",
      "a\\b",
      "x/",
      ".x",
      "x.lock",
      "",
      "a\u0000b",
    ]) {
      expect(isSafeGitRefName(bad)).toBe(false);
    }
  });

  it("worktree path operand requires an absolute path and rejects dash/control/relative/empty", () => {
    expect(isSafeWorktreePathOperand("/abs/path/wt")).toBe(true);
    expect(isSafeWorktreePathOperand("-rf")).toBe(false);
    expect(isSafeWorktreePathOperand("relative/path")).toBe(false);
    expect(isSafeWorktreePathOperand("a\u0000b")).toBe(false);
    expect(isSafeWorktreePathOperand("")).toBe(false);
  });

  it("argv builders reject unsafe operands before constructing argv", () => {
    expect(() =>
      buildAddWorktreeArgv({ worktreePath: "/wt", taskBranch: "-evil", baseRef: "main" }),
    ).toThrow(GitWorktreeOperandError);
    expect(() =>
      buildAddWorktreeArgv({ worktreePath: "-wt", taskBranch: "ok", baseRef: "main" }),
    ).toThrow(GitWorktreeOperandError);
    expect(() => buildRefResolvesArgv("--upload-pack=evil")).toThrow(GitWorktreeOperandError);
    expect(() => buildLocalBranchExistsArgv("a b")).toThrow(GitWorktreeOperandError);
  });

  it("builds the expected add / remove argv", () => {
    expect(
      buildAddWorktreeArgv({ worktreePath: "/wt", taskBranch: "keiko/task/x-1", baseRef: "main" }),
    ).toEqual(["worktree", "add", "--no-track", "-b", "keiko/task/x-1", "/wt", "main"]);
    expect(buildRemoveWorktreeArgv({ worktreePath: "/wt", force: true })).toEqual([
      "worktree",
      "remove",
      "--force",
      "/wt",
    ]);
  });
});

describe("parseWorktreeListPorcelain", () => {
  it("parses multiple worktree blocks with attributes", () => {
    const out = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.keiko/wt-1",
      "HEAD def456",
      "branch refs/heads/keiko/task/x",
      "locked because reasons",
      "",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(out);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      path: "/repo",
      head: "abc123",
      branch: "refs/heads/main",
      locked: false,
    });
    expect(entries[1]).toMatchObject({ path: "/repo/.keiko/wt-1", locked: true });
  });

  it("handles a detached / bare block and trailing block without blank line", () => {
    const entries = parseWorktreeListPorcelain("worktree /a\nbare\n\nworktree /b\ndetached\n");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: "/a", bare: true });
    expect(entries[1]).toMatchObject({ path: "/b", detached: true });
  });
});

describe("real git worktree lifecycle (EV2)", () => {
  let repoRoot: string;
  let worktreeParent: string;

  function git(args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
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

  function deps(): NodeGitWorktreeAdapterDeps {
    return {
      workspace: workspaceInfo(repoRoot),
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
    };
  }

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-wt-repo-")));
    worktreeParent = realpathSync(mkdtempSync(join(tmpdir(), "keiko-wt-managed-")));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@keiko.example"]);
    git(["config", "user.name", "Keiko Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repoRoot, "README.md"), "# demo\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "initial"]);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeParent, { recursive: true, force: true });
  });

  it("resolves the repository root, base ref, and branch existence", async () => {
    const adapter = createNodeGitWorktreeAdapter(deps());
    expect(await adapter.resolveRepositoryRoot()).toBe(repoRoot);
    expect(await adapter.refResolves("main")).toBe(true);
    expect(await adapter.refResolves("does-not-exist")).toBe(false);
    expect(await adapter.localBranchExists("main")).toBe(true);
    expect(await adapter.localBranchExists("keiko/task/none")).toBe(false);
  });

  it("adds, lists, then removes a managed worktree on a new task branch", async () => {
    const adapter = createNodeGitWorktreeAdapter(deps());
    const worktreePath = join(worktreeParent, "wt");
    const branch = "keiko/task/demo-00112233";

    const added = await adapter.addWorktree({ worktreePath, taskBranch: branch, baseRef: "main" });
    expect(added.ok).toBe(true);
    expect(statSync(worktreePath).isDirectory()).toBe(true);
    expect(await adapter.localBranchExists(branch)).toBe(true);
    const worktreeReal = realpathSync(worktreePath);

    const list = await adapter.listWorktrees();
    expect(list.map((entry) => realpathSync(entry.path))).toContain(worktreeReal);

    const removed = await adapter.removeWorktree({ worktreePath, force: true });
    expect(removed.ok).toBe(true);
    await adapter.pruneWorktrees();
    const finalList = await adapter.listWorktrees();
    expect(finalList.map((entry) => entry.path)).not.toContain(worktreeReal);
  });

  it("worktreeStatus reports a clean worktree clean and a dirtied one dirty (#448)", async () => {
    const repoAdapter = createNodeGitWorktreeAdapter(deps());
    const worktreePath = join(worktreeParent, "wt-status");
    await repoAdapter.addWorktree({
      worktreePath,
      taskBranch: "keiko/task/status-aabbccdd",
      baseRef: "main",
    });
    // A freshly created worktree is clean.
    const worktreeAdapter = createNodeGitWorktreeAdapter({
      workspace: workspaceInfo(worktreePath),
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
    });
    const clean = await worktreeAdapter.worktreeStatus();
    expect(clean).toEqual({ ok: true, dirty: false });

    // An untracked file makes it dirty (the conservative deletion-gate signal).
    writeFileSync(join(worktreePath, "scratch.txt"), "work in progress\n");
    const dirty = await worktreeAdapter.worktreeStatus();
    expect(dirty.ok).toBe(true);
    expect(dirty.dirty).toBe(true);
  });

  it("worktreeStatus reports ok=false for a non-worktree path", async () => {
    const adapter = createNodeGitWorktreeAdapter({
      workspace: workspaceInfo(worktreeParent),
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
    });
    const status = await adapter.worktreeStatus();
    expect(status.ok).toBe(false);
    expect(status.dirty).toBe(false);
  });
});
