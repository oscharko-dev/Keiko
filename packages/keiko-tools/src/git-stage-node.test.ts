// The exact-file staging effect reads worktree content and opens Git's index transaction through the
// port its effect context carries. A managed task worktree lives below the state directory's
// always-denied `.keiko` segment: without the owned-root port the prover bound to it, both reads
// resolved the root through the plain node port and were refused (run 5, 2026-09-10 -- the raw
// status reader failed first, the staging step would have failed the same way one step later).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceFsWithOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";
import { GIT_STAGE_CANDIDATE_MAX_BYTES } from "@oscharko-dev/keiko-workspace/internal/git-index";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { CommandResult } from "./types.js";
import { readGitIndexLineBreaks } from "./git-worktree-snapshot-node.js";
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
    indexLineBreaks: (paths) =>
      readGitIndexLineBreaks(
        { workspace: workspaceInfo(managed), processEnv: { PATH: process.env.PATH ?? "" } },
        paths,
      ),
  };
}

function workspaceInfo(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "stage",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
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
  // Owner review of PR #3452 (2026-09-10): the candidate digest summed raw bytes across the whole
  // selection and threw `git-stage-candidate-too-large` above 64 KiB, so a legitimate selection was
  // refused whole for its size — the failure class the stage-admission repair had just removed one
  // helper away. The bound is now a per-proposal ceiling far above any lockfile or asset set, and a
  // selection beyond it is still refused as a whole.
  it("digests a candidate far above the old 64 KiB aggregate and still bounds the selection", async () => {
    const managed = deniedRepository();
    const fs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    writeFileSync(join(managed, "one.bin"), Buffer.alloc(120 * 1024, 0x61));
    writeFileSync(join(managed, "two.bin"), Buffer.alloc(120 * 1024, 0x62));
    await expect(readGitStageCandidate(managed, ["one.bin", "two.bin"], fs)).resolves.toMatch(
      /^[a-f0-9]{64}$/u,
    );
    const slice = Math.ceil(GIT_STAGE_CANDIDATE_MAX_BYTES / 5) + 1;
    const paths = ["a", "b", "c", "d", "e"].map((name) => `${name}.bin`);
    for (const path of paths) writeFileSync(join(managed, path), Buffer.alloc(slice, 0x63));
    await expect(readGitStageCandidate(managed, paths, fs)).rejects.toThrow(
      "git-stage-candidate-too-large",
    );
  });

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

// #4491 (Windows 1.5.9 lab): Git for Windows sets `core.autocrlf=true` for the whole system and
// checks text files out with CRLF, so every governed stage there was refused and no Workbench run
// could commit. A file Git converts is now staged as Git's own built-in conversion, but only when
// that conversion checks the verified bytes out again exactly; every other case stays refused.
describe("exact-file staging under the effective core.autocrlf", () => {
  function plainRepository(
    worktree: Uint8Array | string,
    committed: Uint8Array | string = "v1\n",
  ): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-eol-")));
    dirs.push(base);
    git(base, ["init", "-q", "-b", "main"]);
    git(base, ["config", "user.name", "Keiko Test"]);
    git(base, ["config", "user.email", "keiko@example.test"]);
    writeFileSync(join(base, "a.txt"), committed);
    git(base, ["-c", "core.autocrlf=false", "add", "a.txt"]);
    git(base, ["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
    writeFileSync(join(base, "a.txt"), worktree);
    return base;
  }

  function checkedOut(repo: string): string {
    return git(repo, [
      "-c",
      "core.autocrlf=true",
      "cat-file",
      "--filters",
      "--path=a.txt",
      ":a.txt",
    ]);
  }

  // The oracle: the object Git's own `git add` stores for the same bytes under autocrlf=true, staged
  // into a copy of the index so the repository under test is left alone.
  function gitAddObject(repo: string): string {
    const oracleIndex = join(repo, ".git", "oracle-index");
    copyFileSync(join(repo, ".git", "index"), oracleIndex);
    git(
      repo,
      ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", "add", "a.txt"],
      undefined,
      oracleIndex,
    );
    return git(repo, ["rev-parse", ":a.txt"], undefined, oracleIndex).trim();
  }

  it("stages Git's LF form of a CRLF file under autocrlf=true, which checks out the verified bytes", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    const expected = gitAddObject(repo);
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    expect(git(repo, ["rev-parse", ":a.txt"]).trim()).toBe(expected);
    expect(git(repo, ["show", ":a.txt"])).toBe("v1\nv2\n");
    expect(checkedOut(repo)).toBe("v1\r\nv2\r\n");
    expect(git(repo, ["-c", "core.autocrlf=true", "diff", "--name-only"]).trim()).toBe("");
  });

  it("stages a file Git leaves unchanged under autocrlf=true as its exact bytes", async () => {
    const repo = plainRepository("v1\nv3\n");
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    expect(git(repo, ["show", ":a.txt"])).toBe("v1\nv3\n");
  });

  it("stages a file with a stray carriage return as its exact bytes, which Git does not convert", async () => {
    const repo = plainRepository("v1\r\nv\r2\r\n");
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    expect(git(repo, ["show", ":a.txt"])).toBe("v1\r\nv\r2\r\n");
    expect(checkedOut(repo)).toBe("v1\r\nv\r2\r\n");
  });

  it("stages a binary file with CRLF bytes as its exact bytes, as Git does", async () => {
    const bytes = Buffer.from("a\r\n\0b\r\n", "binary");
    const repo = plainRepository(bytes);
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    expect(git(repo, ["cat-file", "-s", ":a.txt"]).trim()).toBe(String(bytes.length));
  });

  // Audit of #4491: Git keeps the bytes of a path whose index entry already stores a CR
  // (`has_crlf_in_index`), so a repository that stores CRLF keeps it; converting there rewrote every
  // line of the file in the commit.
  it.each([
    ["an all-CRLF file", "v1\r\nv2\r\n"],
    ["a mixed file", "v1\r\nv2\n"],
  ])(
    "stages %s as its exact bytes when the index entry already stores CRLF, as git add does",
    async (_case, worktree) => {
      const repo = plainRepository(worktree, "v1\r\n");
      const expected = gitAddObject(repo);
      await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
        true,
      );
      expect(git(repo, ["rev-parse", ":a.txt"]).trim()).toBe(expected);
      expect(git(repo, ["show", ":a.txt"])).toBe(worktree);
      expect(git(repo, ["-c", "core.autocrlf=true", "diff", "--name-only"]).trim()).toBe("");
    },
  );

  it.each([
    ["mixed line breaks under autocrlf=true", "v1\r\nv2\n", "autocrlf-true", "v1\n"],
    ["CRLF line breaks under autocrlf=input", "v1\r\nv2\r\n", "autocrlf-input", "v1\n"],
    ["a CRLF file over a binary index entry", "v1\r\nv2\r\n", "autocrlf-true", "a\0b\n"],
  ] as const)(
    "refuses %s and leaves the index alone",
    async (_case, worktree, lineEndings, committed) => {
      const repo = plainRepository(worktree, committed);
      await expect(stageExactFiles(context(repo), request(repo), lineEndings)).resolves.toBe(false);
      expect(git(repo, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    },
  );

  it("keeps staging the raw bytes when no conversion is configured", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    await expect(stageExactFiles(context(repo), request(repo))).resolves.toBe(true);
    expect(git(repo, ["show", ":a.txt"])).toBe("v1\r\nv2\r\n");
  });
});
