// Integration coverage for the default-branch reader (#3385). Exercises the real read-only spawn
// boundary against disposable git repositories, plus the injected-spawn seam for the shapes a real
// repository cannot easily produce (a hostile or multi-line answer, a child that fails to run).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { recordingSpawn } from "./_support.js";
import { readGitDefaultBranch } from "./git-default-branch-node.js";
import {
  GIT_REMOTE_URL_READ_SANDBOX_POLICY,
  GIT_WORKTREE_READ_COMMAND_RULES,
  GitWorktreeReadError,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";
import { isCommandAllowed } from "./sandbox.js";

let root: string;
let info: WorkspaceInfo;
const scratchDirs: string[] = [];

function git(args: readonly string[], cwd: string = root): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function workspaceInfo(rootPath: string): WorkspaceInfo {
  return {
    root: rootPath,
    selectedRoot: rootPath,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function deps(overrides: Partial<NodeGitWorktreeReaderDeps> = {}): NodeGitWorktreeReaderDeps {
  return {
    workspace: info,
    processEnv: { PATH: process.env.PATH ?? "" },
    now: () => Date.now(),
    ...overrides,
  };
}

function commitEmpty(): void {
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
}

// A remote-tracking branch plus the symbolic remote head `git clone` would have written — no
// network, no second repository.
function setRemoteHead(branch: string, alias = "origin"): void {
  git(["update-ref", `refs/remotes/${alias}/${branch}`, "HEAD"]);
  git(["symbolic-ref", `refs/remotes/${alias}/HEAD`, `refs/remotes/${alias}/${branch}`]);
}

// Drives the reader through the injected spawn seam with ONE scripted stdout answer.
async function readThroughFakeSpawn(
  stdout: string,
  exitCode = 0,
  processEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" },
): Promise<{
  readonly branch: string | undefined;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
}> {
  const spawn = recordingSpawn();
  const pending = readGitDefaultBranch(deps({ spawn: spawn.fn, processEnv }));
  spawn.child.stdout.emit("data", Buffer.from(stdout, "utf8"));
  spawn.child.emit("close", exitCode, null);
  const branch = await pending;
  const call = spawn.calls()[0];
  return { branch, argv: call?.args ?? [], env: call?.options.env ?? {} };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-default-branch-")));
  git(["init", "-q", "-b", "main"]);
  info = workspaceInfo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readGitDefaultBranch", () => {
  it("resolves the branch the remote head points at", async () => {
    commitEmpty();
    setRemoteHead("main");
    expect(await readGitDefaultBranch(deps())).toBe("main");
  });

  it("keeps a nested branch name intact", async () => {
    commitEmpty();
    setRemoteHead("release/2026.09");
    expect(await readGitDefaultBranch(deps())).toBe("release/2026.09");
  });

  it("reads the alias it is asked for, not always origin", async () => {
    commitEmpty();
    setRemoteHead("trunk", "upstream");
    expect(await readGitDefaultBranch(deps(), "upstream")).toBe("trunk");
    expect(await readGitDefaultBranch(deps())).toBeUndefined();
  });

  // The checkout built by `git init` + `git remote add` + `git fetch` has remote branches but no
  // remote head; `git clone` writes one, `git remote set-head` repairs one. Nothing here guesses.
  it("answers undefined when the remote head is not set", async () => {
    commitEmpty();
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(await readGitDefaultBranch(deps())).toBeUndefined();
  });

  it("answers undefined for an unborn repository with no remote at all", async () => {
    expect(await readGitDefaultBranch(deps())).toBeUndefined();
  });

  it("answers undefined outside a repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-not-git-default-")));
    scratchDirs.push(bare);
    expect(await readGitDefaultBranch(deps({ workspace: workspaceInfo(bare) }))).toBeUndefined();
  });

  // `git symbolic-ref` accepts a branch whose name begins with a dash; every downstream git
  // invocation would read it as an option. The one ref predicate refuses it, so the reader does.
  it("answers undefined for a remote head that names an unsafe branch", async () => {
    commitEmpty();
    setRemoteHead("-evil");
    expect(await readGitDefaultBranch(deps())).toBeUndefined();
  });

  // A LOCAL branch called `origin/main` makes the short spelling ambiguous. Strict abbreviation
  // then prints `remotes/origin/main`, which still names the remote branch and is accepted; loose
  // abbreviation would have printed the short form with a warning and let the ambiguity through.
  it("resolves through an ambiguous short name to the remote branch", async () => {
    commitEmpty();
    setRemoteHead("main");
    git(["branch", "origin/main"]);
    expect(await readGitDefaultBranch(deps())).toBe("main");
  });

  it("refuses an unsafe remote alias before spawning anything", async () => {
    const spawn = recordingSpawn();
    await expect(
      readGitDefaultBranch(deps({ spawn: spawn.fn }), "--upload-pack=evil"),
    ).rejects.toBeInstanceOf(GitWorktreeReadError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("throws when git could not run at all, rather than answering undefined", async () => {
    const spawn = recordingSpawn();
    const pending = readGitDefaultBranch(deps({ spawn: spawn.fn }));
    spawn.child.emit("error", new Error("spawn ENOENT"));
    await expect(pending).rejects.toBeInstanceOf(GitWorktreeReadError);
  });

  // Every answer the child can give that is not exactly one branch name under the alias.
  it.each([
    ["HEAD", "a remote head that is not a symbolic ref"],
    ["origin/HEAD", "a self-referential remote head"],
    ["main", "a name without the alias prefix"],
    ["upstream/main", "another alias"],
    ["origin/", "an empty branch name"],
    ["origin/a..b", "a traversal spelling"],
    ["origin/main\norigin/dev", "two lines"],
    ["", "no output"],
    ["origin/feature.lock", "a lock suffix"],
  ])("answers undefined for %j (%s)", async (stdout) => {
    expect((await readThroughFakeSpawn(stdout)).branch).toBeUndefined();
  });

  it("consults the exit code before the output git echoes on failure", async () => {
    expect((await readThroughFakeSpawn("origin/main\n", 128)).branch).toBeUndefined();
  });

  it("accepts the strict long form and trims the trailing newline", async () => {
    expect((await readThroughFakeSpawn("remotes/origin/main\n")).branch).toBe("main");
  });

  it("runs exactly one read-only rev-parse under the dedicated read policy", async () => {
    const { argv, env } = await readThroughFakeSpawn("origin/main\n", 0, {
      PATH: process.env.PATH ?? "",
      GH_TOKEN: "ghp_secret_value",
      HOME: "/home/someone",
    });
    expect(argv).toEqual(["rev-parse", "--abbrev-ref=strict", "refs/remotes/origin/HEAD"]);
    expect(isCommandAllowed(GIT_WORKTREE_READ_COMMAND_RULES, "git", argv)).toMatchObject({
      allowed: true,
    });
    // No credential reaches the child, and the user's own HOME is not inherited: the pinned
    // config-scope switches of the remote-URL read policy are what the child sees instead.
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.HOME).not.toBe("/home/someone");
    for (const [name, value] of Object.entries(
      GIT_REMOTE_URL_READ_SANDBOX_POLICY.pinnedEnv ?? {},
    )) {
      expect(env[name]).toBe(value);
    }
  });
});
