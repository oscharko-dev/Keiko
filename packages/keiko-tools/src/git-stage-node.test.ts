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
import { nodeSpawnFn, type SpawnFn } from "./exec.js";
import {
  gitStageFilesSupported,
  gitStagedObjectPortArgvAllowed,
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
      expect(await rawFlags(repo, factoryPort(repo))).toEqual([["a.txt", true, false]]);
    },
  );

  type PortDeps = Partial<NodeGitWorktreeReaderDeps>;

  function readerEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
  }

  // The port production wires: the staging's own governed lane, not a hand-built stand-in.
  function factoryPort(repo: string, extra: PortDeps = {}): PortDeps {
    return {
      stagedObjectIds: createGitStagedObjectIdPort({
        workspace: workspaceInfo(repo),
        processEnv: readerEnv(),
        ...extra,
      }),
    };
  }

  async function rawFlags(repo: string, port: PortDeps): Promise<(string | boolean)[][]> {
    const raw = await readGitRawChanges({
      workspace: workspaceInfo(repo),
      processEnv: readerEnv(),
      ...port,
    });
    return raw.changes.map((change) => [change.path, change.staged, change.unstaged]);
  }

  function touchLater(repo: string, name = "a.txt"): void {
    const later = new Date(Date.now() + 5000);
    utimesSync(join(repo, name), later, later);
  }

  function countingSpawn(argvs: string[][]): SpawnFn {
    return (command, args, options) => {
      argvs.push([...args]);
      return nodeSpawnFn(command, args, options);
    };
  }

  // Git trusts a changed file size outright when the index entry carries stat data; only an entry
  // without it (Keiko's `--index-info` staging writes none) is compared through the conversion.
  function withoutStatData(repo: string, path = "a.txt"): void {
    const id = git(repo, ["rev-parse", `:${path}`]).trim();
    git(repo, ["update-index", "--index-info"], `100644 ${id}\t${path}\n`);
  }

  function statusUnstaged(repo: string): boolean {
    return git(repo, ["status", "--porcelain=v1", "--untracked-files=no"])
      .split("\n")
      .some((line) => /^.M /u.test(line));
  }

  // Each case is judged by Git itself (`git status`) and by the raw reader; they must agree, and the
  // reader may never call a file clean that Git calls modified.
  it.each([
    ["autocrlf=input, CRLF working file", "input", "", "v1\r\nv2\r\n", true],
    ["eol=lf attribute, CRLF working file", "false", "a.txt eol=lf\n", "v1\r\nv2\r\n", true],
    ["autocrlf=true, mixed line breaks", "true", "", "v1\r\nv2\n", true],
    ["autocrlf=true, lone carriage return", "true", "", "v1\rv2\n", false],
    ["autocrlf=input, genuinely different CRLF text", "input", "", "v1\r\nv3\r\n", false],
  ] as const)(
    "judges %s as `git status` does without requiring a round trip",
    async (_name, autocrlf, attributes, worktree, clean) => {
      const repo = plainRepository(worktree, "v1\nv2\n");
      git(repo, ["config", "core.autocrlf", autocrlf]);
      if (attributes !== "") writeFileSync(join(repo, ".git", "info", "attributes"), attributes);
      withoutStatData(repo);
      touchLater(repo);
      expect(statusUnstaged(repo)).toBe(!clean);
      expect(await rawFlags(repo, factoryPort(repo))).toEqual(
        clean ? [] : [["a.txt", false, true]],
      );
    },
  );

  it("keeps a CRLF file staged raw (text=auto, CR already in the index) clean in the working tree", async () => {
    const repo = plainRepository("v1\r\nv2\r\n", "v1\r\n");
    writeFileSync(join(repo, ".git", "info", "attributes"), "a.txt text=auto\n");
    await expect(stageExactFiles(context(repo), request(repo), "exact")).resolves.toBe(true);
    touchLater(repo);
    expect(await rawFlags(repo, factoryPort(repo))).toEqual([["a.txt", true, false]]);
  });

  it("still reports a genuinely modified CRLF file under autocrlf as unstaged", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    await expect(stageExactFiles(context(repo), request(repo), "autocrlf-true")).resolves.toBe(
      true,
    );
    writeFileSync(join(repo, "a.txt"), "v1\r\nv3\r\n");
    touchLater(repo);
    expect(await rawFlags(repo, factoryPort(repo))).toEqual([["a.txt", true, true]]);
  });

  describe("when the port cannot settle a file", () => {
    function stagedCrlfRepository(): string {
      const repo = plainRepository("v1\r\nv2\r\n");
      git(repo, ["config", "core.autocrlf", "true"]);
      git(repo, ["add", "a.txt"]);
      touchLater(repo);
      return repo;
    }

    it("keeps the file modified, with no evidence, when no port is supplied", async () => {
      const evidence: unknown[] = [];
      const repo = stagedCrlfRepository();
      expect(await rawFlags(repo, { onStagedConversion: (e) => evidence.push(e) })).toEqual([
        ["a.txt", true, true],
      ]);
      expect(evidence).toEqual([]);
    });

    it("reports an undecidable port as such and keeps the file modified", async () => {
      const evidence: unknown[] = [];
      const repo = stagedCrlfRepository();
      expect(
        await rawFlags(repo, {
          stagedObjectIds: () => Promise.resolve(undefined),
          onStagedConversion: (e) => evidence.push(e),
        }),
      ).toEqual([["a.txt", true, true]]);
      expect(evidence).toEqual([
        { convertible: 1, overCap: 0, settledClean: 0, outcome: "undecidable" },
      ]);
    });

    it("keeps the file modified and reports the failure when the port throws", async () => {
      const evidence: { outcome: string; error?: unknown }[] = [];
      const repo = stagedCrlfRepository();
      const failure = new Error("port exploded");
      expect(
        await rawFlags(repo, {
          stagedObjectIds: () => Promise.reject(failure),
          onStagedConversion: (e) => evidence.push(e),
        }),
      ).toEqual([["a.txt", true, true]]);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ convertible: 1, settledClean: 0, outcome: "error" });
      expect(evidence[0]?.error).toBe(failure);
    });

    it("maps a cancellation during the port call to git-raw-read-cancelled", async () => {
      const repo = stagedCrlfRepository();
      const controller = new AbortController();
      await expect(
        rawFlags(repo, {
          signal: controller.signal,
          stagedObjectIds: () => {
            controller.abort();
            return Promise.reject(new Error("aborted"));
          },
        }),
      ).rejects.toMatchObject({ code: "git-raw-read-cancelled" });
    });

    it("reports the settlement of an answering port", async () => {
      const evidence: unknown[] = [];
      const repo = stagedCrlfRepository();
      expect(
        await rawFlags(repo, { ...factoryPort(repo), onStagedConversion: (e) => evidence.push(e) }),
      ).toEqual([["a.txt", true, false]]);
      expect(evidence).toEqual([
        { convertible: 1, overCap: 0, settledClean: 1, outcome: "answered" },
      ]);
    });
  });

  it("never offers a symlink to the staged-object port", async () => {
    const repo = plainRepository("v1\n");
    symlinkSync("a.txt", join(repo, "l"));
    git(repo, ["add", "l"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "link"]);
    rmSync(join(repo, "l"));
    symlinkSync("other", join(repo, "l"));
    const offered: string[] = [];
    expect(
      await rawFlags(repo, {
        stagedObjectIds: (files) => {
          offered.push(...files.map((file) => file.path));
          return Promise.resolve(new Map());
        },
      }),
    ).toEqual([["l", false, true]]);
    expect(offered).toEqual([]);
  });

  it("never runs a configured filter driver while judging a stat-dirty file", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    const marker = join(repo, "..", `${repo.split("/").pop() ?? "r"}-driver-ran`);
    dirs.push(marker);
    git(repo, ["config", "filter.mark.clean", `touch '${marker}' && cat`]);
    writeFileSync(join(repo, ".git", "info", "attributes"), "a.txt filter=mark\n");
    touchLater(repo);
    expect(await rawFlags(repo, factoryPort(repo))).toEqual([["a.txt", false, true]]);
    expect(existsSync(marker)).toBe(false);
    // Positive control: Git itself runs the driver when it stages the file.
    git(repo, ["add", "a.txt"]);
    expect(existsSync(marker)).toBe(true);
  });

  it("neutralises a configured driver for the other files of the same batch", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    const marker = join(repo, "..", `${repo.split("/").pop() ?? "r"}-driver-ran-2`);
    dirs.push(marker);
    git(repo, ["config", "core.autocrlf", "true"]);
    writeFileSync(join(repo, "b.txt"), "x\n");
    git(repo, ["add", "a.txt", "b.txt"]);
    git(repo, ["config", "filter.mark.clean", `touch '${marker}' && cat`]);
    writeFileSync(join(repo, ".git", "info", "attributes"), "b.txt filter=mark\n");
    writeFileSync(join(repo, "b.txt"), "x\r\n");
    touchLater(repo);
    touchLater(repo, "b.txt");
    expect(await rawFlags(repo, factoryPort(repo))).toEqual([
      ["a.txt", true, false],
      ["b.txt", true, true],
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("settles a mixed batch of converted, modified, unconverted and filtered files together", async () => {
    const repo = plainRepository("v1\r\nv2\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    writeFileSync(join(repo, ".git", "info", "attributes"), "c.txt -text\nd.txt filter=nothing\n");
    for (const name of ["b.txt", "c.txt", "d.txt"]) writeFileSync(join(repo, name), "p\nq\n");
    git(repo, ["add", "a.txt", "b.txt", "c.txt", "d.txt"]);
    writeFileSync(join(repo, "b.txt"), "p\r\nchanged\r\n");
    writeFileSync(join(repo, "c.txt"), "p\r\nq\r\n");
    writeFileSync(join(repo, "d.txt"), "p\r\nq\r\n");
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) touchLater(repo, name);
    expect(await rawFlags(repo, factoryPort(repo))).toEqual([
      ["a.txt", true, false],
      ["b.txt", true, true],
      ["c.txt", true, true],
      ["d.txt", true, true],
    ]);
  });

  it("judges a file whose name is an option exactly as any other", async () => {
    const repo = plainRepository("v1\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    const names = ["-w", "--stdin-paths", "has space.txt"];
    for (const name of names) writeFileSync(join(repo, name), "p\r\nq\r\n");
    git(repo, ["add", "--", ...names]);
    for (const name of names) touchLater(repo, name);
    expect(await rawFlags(repo, factoryPort(repo))).toEqual([
      ["--stdin-paths", true, false],
      ["-w", true, false],
      ["has space.txt", true, false],
    ]);
  });

  it("settles a SHA-256 repository's converted file", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-sha256-")));
    dirs.push(base);
    git(base, ["init", "-q", "-b", "main", "--object-format=sha256"]);
    git(base, ["config", "user.name", "Keiko Test"]);
    git(base, ["config", "user.email", "keiko@example.test"]);
    writeFileSync(join(base, "seed.txt"), "seed\n");
    git(base, ["add", "seed.txt"]);
    git(base, ["-c", "commit.gpgsign=false", "commit", "-qm", "seed"]);
    git(base, ["config", "core.autocrlf", "true"]);
    writeFileSync(join(base, "a.txt"), "v1\r\nv2\r\n");
    git(base, ["add", "a.txt"]);
    touchLater(base);
    expect(git(base, ["rev-parse", ":a.txt"]).trim()).toHaveLength(64);
    expect(await rawFlags(base, factoryPort(base))).toEqual([["a.txt", true, false]]);
  });

  it("keeps every spawn bounded however many stat-dirty files there are", async () => {
    const repo = plainRepository("v1\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    const names = Array.from({ length: 150 }, (_, at) => `file-${String(at).padStart(3, "0")}.txt`);
    for (const name of names) writeFileSync(join(repo, name), `${name}\r\nline\r\n`);
    git(repo, ["add", ...names]);
    for (const name of names) touchLater(repo, name);
    const argvs: string[][] = [];
    const port = factoryPort(repo, { spawn: countingSpawn(argvs) });
    expect(await rawFlags(repo, port)).toEqual(names.map((name) => [name, true, false]));
    // One config read, one attribute read, one line-break listing and one hash for the whole batch
    // (plus the lane's one-time guard probes), never a process per file.
    expect(argvs.length).toBeLessThan(12);
    expect(argvs.filter((argv) => argv.includes("hash-object"))).toHaveLength(1);
    expect(argvs.flat()).not.toContain("-w");
  });

  it("settles only the capped number of files in one scan and leaves the rest modified", async () => {
    const repo = plainRepository("v1\r\n");
    git(repo, ["config", "core.autocrlf", "true"]);
    const names = Array.from({ length: 1003 }, (_, at) => `f${String(at).padStart(4, "0")}.txt`);
    // `a.txt` (CRLF over an LF index entry) is a convertible file too: it takes the first slot.
    for (const name of names) writeFileSync(join(repo, name), "p\r\n");
    git(repo, ["add", ...names]);
    for (const name of names) touchLater(repo, name);
    const evidence: unknown[] = [];
    const flags = await rawFlags(repo, {
      ...factoryPort(repo),
      onStagedConversion: (e) => evidence.push(e),
    });
    expect(flags).toEqual(names.map((name, at) => [name, true, at >= 999]));
    expect(evidence).toEqual([
      { convertible: 1000, overCap: 4, settledClean: 1000, outcome: "answered" },
    ]);
  });

  it("splits the line-break listing so a long path list never reaches the command-line limit", async () => {
    const repo = plainRepository("v1\n");
    const paths = Array.from({ length: 300 }, (_, at) => `${"d".repeat(70)}${String(at)}.txt`);
    for (const path of paths) writeFileSync(join(repo, path), "x\n");
    git(repo, ["add", ...paths]);
    const argvs: string[][] = [];
    const classes = await readGitIndexLineBreaks(
      {
        workspace: workspaceInfo(repo),
        processEnv: readerEnv(),
        spawn: countingSpawn(argvs),
      },
      paths,
    );
    expect([...classes.keys()].sort()).toEqual([...paths].sort());
    const listings = argvs.filter((argv) => argv.includes("--eol"));
    expect(listings.length).toBeGreaterThan(1);
    for (const argv of listings) expect(argv.join(" ").length).toBeLessThan(9000);
  });

  it("denies every Git run outside the read-only staged-object allowlist", () => {
    const allowed = [
      ["hash-object", "--stdin-paths"],
      ["-c", "filter.x.clean=", "-c", "core.autocrlf=input", "hash-object", "--stdin-paths"],
      [
        "check-attr",
        "-z",
        "filter",
        "working-tree-encoding",
        "ident",
        "crlf",
        "text",
        "eol",
        "--stdin",
      ],
    ];
    for (const argv of allowed) expect(gitStagedObjectPortArgvAllowed(argv)).toBe(true);
    const denied = [
      ["hash-object", "-w", "--stdin-paths"],
      ["hash-object", "--stdin-paths", "-w"],
      ["hash-object", "--stdin", "--path=x"],
      ["update-index", "--index-info"],
      ["add", "--", "a.txt"],
      ["-c", "filter.x.clean=evil", "hash-object", "--stdin-paths"],
      ["-c", "core.fsmonitor=evil", "hash-object", "--stdin-paths"],
      ["-c", "alias.x=!evil", "hash-object", "--stdin-paths"],
      ["-c", "core.autocrlf=weird", "hash-object", "--stdin-paths"],
      ["check-attr", "-z", "text", "--stdin"],
      ["config", "--get", "core.autocrlf"],
    ];
    for (const argv of denied) expect(gitStagedObjectPortArgvAllowed(argv)).toBe(false);
    // Operands after `--` are paths, never options: only what precedes them is inspected.
    expect(gitStagedObjectPortArgvAllowed(["hash-object", "--stdin-paths", "--", "-w"])).toBe(true);
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
