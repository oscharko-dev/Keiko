// The exact-file staging effect reads worktree content and opens Git's index transaction through the
// port its effect context carries. A managed task worktree lives below the state directory's
// always-denied `.keiko` segment: without the owned-root port the prover bound to it, both reads
// resolved the root through the plain node port and were refused (run 5, 2026-09-10 -- the raw
// status reader failed first, the staging step would have failed the same way one step later).
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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
import { afterEach, describe, expect, it } from "vitest";
import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceFsWithOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-mint";
import { GIT_STAGE_CANDIDATE_MAX_BYTES } from "@oscharko-dev/keiko-workspace/internal/git-index";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { CommandResult } from "./types.js";
import { readGitIndexLineBreaks } from "./git-worktree-snapshot-node.js";
import { readGitRawChanges } from "./git-raw-worktree-node.js";
import type { NodeGitWorktreeReaderDeps } from "./git-worktree-snapshot-node.js";
import { createGitStagedObjectIdPort } from "./git-mutation-node.js";
import {
  gitStageFilesSupported,
  gitStagedObjectIdOf,
  type GitStageLineEndings,
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
    filterDriverNames: () =>
      Promise.resolve(
        [
          ...git(managed, ["config", "--name-only", "--list"]).matchAll(
            /^filter\.(.+)\.(?:clean|smudge|process|required)$/gmu,
          ),
        ].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
      ),
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
      head: { kind: "born", sha: headSha },
      stagedTreeDigest: "0".repeat(64),
      branchName: "main",
      baseRef: "refs/heads/main",
      base: { kind: "born", sha: headSha },
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

  // Review finding on PR #4568: the conversion hash passes `--path`, so Git applies the
  // attribute-selected clean driver. The attribute check runs earlier, so an attribute that lands
  // after it must not make staging run a configured driver.
  it("never runs a configured clean filter driver during the conversion hash", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    const marker = join(repo, "..", `${repo.split("/").pop() ?? "repo"}-driver-ran`);
    dirs.push(marker);
    writeFileSync(join(repo, ".gitattributes"), "a.txt filter=probe\n");
    git(repo, ["config", "filter.probe.clean", `touch '${marker}'; cat`]);

    await expect(gitStageFilesSupported(context(repo), ["a.txt"], "autocrlf-true")).resolves.toBe(
      true,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses the conversion hash when the filter configuration cannot be read", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    const unreadable = {
      ...context(repo),
      filterDriverNames: (): Promise<undefined> => Promise.resolve(undefined),
    };

    await expect(gitStageFilesSupported(unreadable, ["a.txt"], "autocrlf-true")).rejects.toThrow(
      "git-stage-filter-config-unavailable",
    );
  });

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

  // #4506 AC1: Keiko's own index entry carries no stat data, so the commit-facts reader must judge
  // the CRLF working file the way `git status` does (converted), or every staged file on a Windows
  // checkout reads as unstaged and the commit proof never forms.
  it.each(["autocrlf", "eol=crlf"] as const)(
    "lets the raw reader see a CRLF file staged under %s as clean in the working tree",
    async (setting) => {
      const repo = plainRepository("v1\r\nv2\r\n");
      if (setting === "autocrlf") git(repo, ["config", "core.autocrlf", "true"]);
      else writeFileSync(join(repo, ".git", "info", "attributes"), `a.txt ${setting}\n`);
      const mode = setting === "autocrlf" ? "autocrlf-true" : "exact";
      await expect(stageExactFiles(context(repo), request(repo), mode)).resolves.toBe(true);
      // A later mtime defeats the stat shortcut, as Windows' differing stat data does: both
      // readers must then compare the converted content.
      const later = new Date(Date.now() + 5000);
      utimesSync(join(repo, "a.txt"), later, later);
      expect(git(repo, ["status", "--porcelain=v1", "--untracked-files=no"]).trim()).toBe(
        "M  a.txt",
      );
      expect(await rawFlags(repo, withPort(repo, mode))).toEqual([["a.txt", true, false]]);
    },
  );

  function withPort(
    repo: string,
    mode: GitStageLineEndings,
    calls: string[][] = [],
  ): Pick<NodeGitWorktreeReaderDeps, "stagedObjectIds"> {
    return {
      stagedObjectIds: (files): ReturnType<typeof gitStagedObjectIdOf> => {
        calls.push(files.map((file) => file.path));
        return gitStagedObjectIdOf(context(repo), mode, files);
      },
    };
  }

  async function rawFlags(
    repo: string,
    port: Pick<NodeGitWorktreeReaderDeps, "stagedObjectIds">,
  ): Promise<(string | boolean)[][]> {
    const raw = await readGitRawChanges({
      workspace: workspaceInfo(repo),
      processEnv: { PATH: process.env.PATH ?? "" },
      ...port,
    });
    return raw.changes.map((change) => [change.path, change.staged, change.unstaged]);
  }

  function touchLater(repo: string, name = "a.txt"): void {
    const later = new Date(Date.now() + 5000);
    utimesSync(join(repo, name), later, later);
  }

  it("keeps a CRLF file staged raw (text=auto, CR already in the index) clean in the working tree", async () => {
    const repo = plainRepository("v1\r\nv2\r\n", "v1\r\n");
    writeFileSync(join(repo, ".git", "info", "attributes"), "a.txt text=auto\n");
    await expect(stageExactFiles(context(repo), request(repo), "exact")).resolves.toBe(true);
    touchLater(repo);
    expect(await rawFlags(repo, withPort(repo, "exact"))).toEqual([["a.txt", true, false]]);
  });

  it("still reports a genuinely modified CRLF file under autocrlf as unstaged", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    writeFileSync(join(repo, "a.txt"), "v1\r\nv3\r\n");
    touchLater(repo);
    expect(await rawFlags(repo, withPort(repo, "autocrlf-true"))).toEqual([["a.txt", true, true]]);
  });

  it("keeps the converted file modified when no staged-object port is supplied", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    touchLater(repo);
    expect(await rawFlags(repo, {})).toEqual([["a.txt", true, true]]);
    expect(await rawFlags(repo, { stagedObjectIds: () => Promise.resolve(undefined) })).toEqual([
      ["a.txt", true, true],
    ]);
  });

  it("lets the governed port factory judge a converted file clean without writing an object", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    touchLater(repo);
    const before = git(repo, ["count-objects", "-v"]);
    const port = createGitStagedObjectIdPort({
      workspace: workspaceInfo(repo),
      processEnv: { PATH: process.env.PATH ?? "" },
    });
    expect(await rawFlags(repo, { stagedObjectIds: port })).toEqual([["a.txt", true, false]]);
    expect(git(repo, ["count-objects", "-v"])).toBe(before);
  });

  it("never offers a symlink to the staged-object port", async () => {
    const repo = plainRepository("v1\n");
    symlinkSync("a.txt", join(repo, "l"));
    git(repo, ["add", "l"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "link"]);
    rmSync(join(repo, "l"));
    symlinkSync("other", join(repo, "l"));
    const calls: string[][] = [];
    expect(await rawFlags(repo, withPort(repo, "exact", calls))).toEqual([["l", false, true]]);
    expect(calls.flat()).not.toContain("l");
  });

  it("never runs a configured filter driver while judging a stat-dirty file", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    const marker = join(repo, "..", `${repo.split("/").pop() ?? "r"}-driver-ran`);
    dirs.push(marker);
    git(repo, ["config", "filter.mark.clean", `touch '${marker}' && cat`]);
    writeFileSync(join(repo, ".git", "info", "attributes"), "a.txt filter=mark\n");
    touchLater(repo);
    expect(await rawFlags(repo, withPort(repo, "exact"))).toEqual([["a.txt", false, true]]);
    expect(existsSync(marker)).toBe(false);
    // Positive control: Git itself runs the driver when it stages the file.
    git(repo, ["add", "a.txt"]);
    expect(existsSync(marker)).toBe(true);
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

// #4491 (night audit 2026-11-27): any `text` or `eol` attribute refused every verified staging, so
// a repository with `* text=auto` (GitHub's default `.gitattributes`) could never commit from the
// Workbench. Git's own `git add` and checkout are the oracle: a staging that succeeds stores exactly
// the object `git add` stores, and that object either is the verified bytes or checks out as them.
describe("exact-file staging under text and eol attributes", () => {
  const MODES = [
    ["false", "exact"],
    ["true", "autocrlf-true"],
    ["input", "autocrlf-input"],
  ] as const;
  const CONTENTS = {
    lf: "v1\nv2\n",
    crlf: "v1\r\nv2\r\n",
    mixed: "v1\r\nv2\n",
    binary: "a\r\n\0b\r\n",
    empty: "",
    loneCr: "v1\rv2\r\n",
  } as const;

  function attributedRepository(attributes: string, committed: string): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-attr-")));
    dirs.push(base);
    git(base, ["init", "-q", "-b", "main"]);
    git(base, ["config", "user.name", "Keiko Test"]);
    git(base, ["config", "user.email", "keiko@example.test"]);
    git(base, ["config", "core.safecrlf", "false"]);
    writeFileSync(join(base, "a.txt"), committed);
    git(base, ["update-index", "--add", "--cacheinfo", `100644,${blob(base, committed)},a.txt`]);
    git(base, ["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
    if (attributes !== "")
      writeFileSync(join(base, ".git", "info", "attributes"), `${attributes}\n`);
    return base;
  }

  function blob(repo: string, bytes: string): string {
    return git(repo, ["hash-object", "-w", "--no-filters", "--stdin"], bytes).trim();
  }

  function oracleObject(repo: string, autocrlf: string): string {
    const oracleIndex = join(repo, ".git", "oracle-index");
    copyFileSync(join(repo, ".git", "index"), oracleIndex);
    git(repo, ["-c", `core.autocrlf=${autocrlf}`, "add", "a.txt"], undefined, oracleIndex);
    return git(repo, ["rev-parse", ":a.txt"], undefined, oracleIndex).trim();
  }

  function checkout(repo: string, autocrlf: string, oid: string): string {
    return git(repo, [
      "-c",
      `core.autocrlf=${autocrlf}`,
      "cat-file",
      "--filters",
      "--path=a.txt",
      oid,
    ]);
  }

  async function stageUnder(
    repo: string,
    autocrlf: string,
    lineEndings: Parameters<typeof stageExactFiles>[2],
    worktree: string,
  ): Promise<{ readonly staged: boolean; readonly oracle: string; readonly raw: string }> {
    git(repo, ["read-tree", "HEAD"]);
    git(repo, ["config", "core.autocrlf", autocrlf]);
    writeFileSync(join(repo, "a.txt"), worktree);
    const oracle = oracleObject(repo, autocrlf);
    const raw = git(repo, ["hash-object", "--no-filters", "--stdin"], worktree).trim();
    const staged = await stageExactFiles(context(repo), request(repo), lineEndings);
    return { staged, oracle, raw };
  }

  it.each([
    ["* text=auto"],
    ["* text"],
    ["* -text"],
    ["* text eol=lf"],
    ["* text eol=crlf"],
    ["* eol=crlf"],
    ["* eol=lf"],
    ["* text=auto eol=crlf"],
    ["* text=auto eol=lf"],
    [""],
  ])(
    "never stores an object git add would not, nor one that checks out differently: %j",
    async (attributes) => {
      let stagedCount = 0;
      for (const committed of [CONTENTS.lf, CONTENTS.crlf]) {
        const repo = attributedRepository(attributes, committed);
        for (const [autocrlf, lineEndings] of MODES) {
          for (const worktree of Object.values(CONTENTS)) {
            const { staged, oracle, raw } = await stageUnder(repo, autocrlf, lineEndings, worktree); // NOSONAR typescript:S9382 -- one repository state at a time
            if (!staged) {
              expect(git(repo, ["diff", "--cached", "--name-only"]).trim()).toBe("");
              continue;
            }
            stagedCount += 1;
            expect(git(repo, ["rev-parse", ":a.txt"]).trim()).toBe(oracle);
            if (oracle !== raw) expect(checkout(repo, autocrlf, oracle)).toBe(worktree);
          }
        }
      }
      // Every attribute set stages at least its unchanged LF file in each mode: never vacuous.
      expect(stagedCount).toBeGreaterThanOrEqual(MODES.length * 2);
    },
  );

  it.each([
    ["* text=auto", "false", "exact", "lf"],
    ["* text=auto", "true", "autocrlf-true", "lf"],
    ["* text=auto", "true", "autocrlf-true", "crlf"],
    ["* text=auto", "input", "autocrlf-input", "lf"],
    ["* text", "false", "exact", "lf"],
    ["* text eol=crlf", "false", "exact", "crlf"],
    ["* eol=crlf", "input", "autocrlf-input", "crlf"],
    ["* -text", "true", "autocrlf-true", "mixed"],
  ] as const)(
    "stages under %j with core.autocrlf=%s (%s) a verified %s file",
    async (attributes, autocrlf, lineEndings, content) => {
      const repo = attributedRepository(attributes, CONTENTS.lf);
      const { staged, oracle } = await stageUnder(repo, autocrlf, lineEndings, CONTENTS[content]);
      expect(staged).toBe(true);
      expect(git(repo, ["rev-parse", ":a.txt"]).trim()).toBe(oracle);
    },
  );

  it.each([
    ["* text eol=lf", "false", "exact", "crlf"],
    ["* text", "false", "exact", "crlf"],
    ["* text=auto", "input", "autocrlf-input", "crlf"],
  ] as const)(
    "refuses under %j with core.autocrlf=%s (%s) a %s file Git would check out differently",
    async (attributes, autocrlf, lineEndings, content) => {
      const repo = attributedRepository(attributes, CONTENTS.lf);
      const { staged } = await stageUnder(repo, autocrlf, lineEndings, CONTENTS[content]);
      expect(staged).toBe(false);
      expect(git(repo, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    },
  );

  it.each([
    ["* filter=lfs"],
    ["* ident"],
    ["* working-tree-encoding=UTF-16"],
    ["* crlf=input"],
    ["* text=bogus"],
    ["* eol=bogus"],
  ])("still refuses %j", async (attributes) => {
    const repo = attributedRepository(attributes, CONTENTS.lf);
    writeFileSync(join(repo, "a.txt"), CONTENTS.lf);
    await expect(stageExactFiles(context(repo), request(repo))).resolves.toBe(false);
    expect(git(repo, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });
});

// Audit of the #4491 attribute fix: Git on macOS prints a decomposed file name precomposed, so a
// check-attr answer for an NFD pathspec must still be matched to its path, not refused.
describe("exact-file staging of a decomposed (NFD) file name", () => {
  it("stages a file whose pathspec is NFD while Git precomposes its name", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-nfd-")));
    dirs.push(base);
    git(base, ["init", "-q", "-b", "main"]);
    git(base, ["config", "user.name", "Keiko Test"]);
    git(base, ["config", "user.email", "keiko@example.test"]);
    git(base, ["config", "core.precomposeunicode", "true"]);
    writeFileSync(join(base, "a.txt"), "v1\n");
    git(base, ["add", "a.txt"]);
    git(base, ["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
    const decomposed = "e\u0301.txt";
    writeFileSync(join(base, decomposed), "v1\n");
    const headSha = git(base, ["rev-parse", "HEAD"]).trim();
    await expect(
      stageExactFiles(context(base), {
        pathspecs: [decomposed],
        verified: {
          head: { kind: "born", sha: headSha },
          stagedTreeDigest: "0".repeat(64),
          branchName: "main",
          baseRef: "refs/heads/main",
          base: { kind: "born", sha: headSha },
        },
      }),
    ).resolves.toBe(true);
    expect(
      git(base, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only"])
        .trim()
        .normalize("NFC"),
    ).toBe("\u00e9.txt");
  });
});
