// The exact-file staging effect reads worktree content and opens Git's index transaction through the
// port its effect context carries. A managed task worktree lives below the state directory's
// always-denied `.keiko` segment: without the owned-root port the prover bound to it, both reads
// resolved the root through the plain node port and were refused (run 5, 2026-09-10 -- the raw
// status reader failed first, the staging step would have failed the same way one step later).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceFsWithOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";
import type { CommandResult } from "./types.js";
import {
  readGitStageCandidate,
  stageExactFiles,
  type GitStageEffectContext,
} from "./git-stage-node.js";

const dirs: string[] = [];

function git(
  cwd: string,
  args: readonly string[],
  stdin?: Uint8Array | string,
  indexPath?: string,
): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(stdin === undefined ? {} : { input: stdin }),
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...(indexPath === undefined ? {} : { GIT_INDEX_FILE: indexPath }),
    },
  });
}

function deniedRepository(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-denied-")));
  dirs.push(base);
  const managed = join(base, ".keiko", "ui", "task-workspaces", "repo_1", "ws_1");
  mkdirSync(managed, { recursive: true });
  git(managed, ["init", "-q", "-b", "main"]);
  git(managed, ["config", "user.name", "Keiko Test"]);
  git(managed, ["config", "user.email", "keiko@example.test"]);
  writeFileSync(join(managed, "a.txt"), "v1\n");
  git(managed, ["add", "a.txt"]);
  git(managed, ["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
  writeFileSync(join(managed, "a.txt"), "v2\n");
  return managed;
}

function context(managed: string, fs?: GitStageEffectContext["fs"]): GitStageEffectContext {
  return {
    workspaceRoot: managed,
    ...(fs === undefined ? {} : { fs }),
    check: () => Promise.resolve(true),
    authorized: () => true,
    run: (argv, stdin, indexPath): Promise<CommandResult> => {
      const stdout = git(managed, argv, stdin, indexPath);
      return Promise.resolve({
        command: "git",
        args: [...argv],
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      });
    },
  };
}

function request(managed: string): Parameters<typeof stageExactFiles>[1] {
  const headSha = git(managed, ["rev-parse", "HEAD"]).trim();
  return {
    pathspecs: ["a.txt"],
    verified: {
      headSha,
      stagedTreeDigest: "0".repeat(64),
      branchName: "main",
      baseRef: "refs/heads/main",
      baseSha: headSha,
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exact-file staging inside a root below an always-denied segment", () => {
  it("refuses the candidate digest and the staging through the plain port", async () => {
    const managed = deniedRepository();
    await expect(readGitStageCandidate(managed, ["a.txt"])).rejects.toBeInstanceOf(PathDeniedError);
    await expect(stageExactFiles(context(managed), request(managed))).rejects.toThrow(
      "git-index-metadata-unavailable",
    );
    expect(git(managed, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("stages the exact file once the effect context carries the owned-root port", async () => {
    const managed = deniedRepository();
    const fs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    const digest = await readGitStageCandidate(managed, ["a.txt"], fs);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      stageExactFiles(context(managed, fs), { ...request(managed), worktreeDigest: digest }),
    ).resolves.toBe(true);
    expect(git(managed, ["diff", "--cached", "--name-only"]).trim()).toBe("a.txt");
    expect(git(managed, ["show", ":a.txt"])).toBe("v2\n");
  });
});
