// A file's size never ends a status read or a staging (owner decision 2026-11-24, "Work-ending
// limits"). Live evidence (macOS dev lab, Supervised mode): a model generated a 9 MB JSON file and a
// 4 MB binary; `keiko_git_status` and `keiko_git_stage` then failed on every call with the misleading
// `git-stage-file-incomplete`, because the raw reader and the staging both read the whole file under
// an 8 MiB bound. Every expectation here is derived from Git itself (`hash-object`, `status`,
// `ls-files -s`), never restated.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { CommandResult } from "./types.js";
import { readGitIndexLineBreaks } from "./git-worktree-snapshot-node.js";
import { readGitRawChanges } from "./git-raw-worktree-node.js";
import { createGitStagedObjectIdPort } from "./git-mutation-node.js";
import {
  gitStageFilesSupported,
  readGitStageCandidate,
  stageExactFiles,
  type GitStageEffectContext,
} from "./git-stage-node.js";

const dirs: string[] = [];
const MIB = 1024 * 1024;

function git(
  cwd: string,
  args: readonly string[],
  indexPath?: string,
  stdin?: Uint8Array | string,
): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * MIB,
    ...(stdin === undefined ? {} : { input: stdin }),
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...(indexPath === undefined ? {} : { GIT_INDEX_FILE: indexPath }),
    },
  });
}

function repository(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-large-")));
  dirs.push(base);
  git(base, ["init", "-q", "-b", "main"]);
  git(base, ["config", "user.name", "Keiko Test"]);
  git(base, ["config", "user.email", "keiko@example.test"]);
  writeFileSync(join(base, "a.txt"), "base\n");
  git(base, ["add", "a.txt"]);
  git(base, ["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
  return base;
}

function workspaceInfo(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "large",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const readerEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

// A recording port: every whole-file read the layer under test performs is visible, so a test can
// prove that no read ever held a large file.
function largeFileReads(reads: readonly string[]): string[] {
  return reads.filter((path) => statSync(path).size > 65_536 && !path.includes("/.git/"));
}
function recordingFs(reads: string[]): WorkspaceFs {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new Error("the node port reads bytes");
  return {
    ...nodeWorkspaceFs,
    readFileBytes: (path, maxBytes, policy, expected): Promise<Uint8Array> => {
      reads.push(path);
      return read(path, maxBytes, policy, expected);
    },
  };
}

function context(
  repo: string,
  fs?: WorkspaceFs,
  before?: (argv: readonly string[]) => void,
): GitStageEffectContext {
  return {
    workspaceRoot: repo,
    ...(fs === undefined ? {} : { fs }),
    check: () => Promise.resolve(true),
    authorized: () => true,
    run: (argv, stdin, indexPath): Promise<CommandResult> => {
      before?.(argv);
      return Promise.resolve({
        command: "git",
        args: [...argv],
        exitCode: 0,
        signal: null,
        stdout: git(repo, argv, indexPath, stdin),
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      });
    },
    filterDriverNames: () => Promise.resolve([]),
    indexLineBreaks: (paths) =>
      readGitIndexLineBreaks({ workspace: workspaceInfo(repo), processEnv: readerEnv() }, paths),
  };
}

function request(
  repo: string,
  pathspecs: readonly string[],
  worktreeDigest?: string,
): Parameters<typeof stageExactFiles>[1] {
  const headSha = git(repo, ["rev-parse", "HEAD"]).trim();
  return {
    pathspecs,
    ...(worktreeDigest === undefined ? {} : { worktreeDigest }),
    verified: {
      head: { kind: "born" as const, sha: headSha },
      stagedTreeDigest: "0".repeat(64),
      branchName: "main",
      baseRef: "refs/heads/main",
      base: { kind: "born" as const, sha: headSha },
    },
  };
}

const textOfSize = (bytes: number): Buffer => {
  const line = '{"key": "value-with-some-length-to-fill-the-line"},\n';
  return Buffer.from(line.repeat(Math.ceil(bytes / line.length))).subarray(0, bytes);
};
const binaryOfSize = (bytes: number): Buffer => {
  const buffer = Buffer.alloc(bytes);
  for (let at = 0; at < bytes; at += 1) buffer[at] = (at * 31 + 7) % 256;
  return buffer;
};

function writeGenerated(repo: string): void {
  writeFileSync(join(repo, "large.json"), textOfSize(9 * MIB));
  writeFileSync(join(repo, "blob.bin"), binaryOfSize(4 * MIB));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a large file never fails the status read", () => {
  it("lists a 9 MiB text file and a 4 MiB binary without reading either whole", async () => {
    const repo = repository();
    writeGenerated(repo);
    const reads: string[] = [];
    const raw = await readGitRawChanges({
      workspace: workspaceInfo(repo),
      processEnv: readerEnv(),
      fs: recordingFs(reads),
    });
    expect(raw.truncated).toBe(false);
    expect(raw.changes.map((change) => [change.path, change.untracked])).toEqual([
      ["blob.bin", true],
      ["large.json", true],
    ]);
    // Memory: no whole-file read was ever asked to hold the 4 MiB file, let alone the 9 MiB one.
    expect(largeFileReads(reads)).toEqual([]);
  });

  it("keeps a byte-identical rewrite of a tracked large file clean and an edit modified, as Git says", async () => {
    const repo = repository();
    writeFileSync(join(repo, "large.json"), textOfSize(9 * MIB));
    git(repo, ["add", "large.json"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "large"]);
    // Keiko's own staging writes index entries without stat data; the later mtime defeats the stat
    // shortcut so the content itself is compared.
    const id = git(repo, ["rev-parse", ":large.json"]).trim();
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      input: `100644 ${id}\tlarge.json\n`,
    });
    const later = new Date(Date.now() + 5000);
    utimesSync(join(repo, "large.json"), later, later);
    const reads: string[] = [];
    const deps = {
      workspace: workspaceInfo(repo),
      processEnv: readerEnv(),
      fs: recordingFs(reads),
    };
    expect(git(repo, ["status", "--porcelain=v1"]).trim()).toBe("");
    expect((await readGitRawChanges(deps)).changes).toEqual([]);

    appendFileSync(join(repo, "large.json"), "edited\n");
    expect(git(repo, ["status", "--porcelain=v1"]).trim()).toBe("M large.json");
    expect((await readGitRawChanges(deps)).changes.map((c) => [c.path, c.worktreeStatus])).toEqual([
      ["large.json", "M"],
    ]);
    expect(largeFileReads(reads)).toEqual([]);
  });

  it("judges a large CRLF file under autocrlf=true as `git status` does", async () => {
    const repo = repository();
    git(repo, ["config", "core.autocrlf", "true"]);
    const lf = textOfSize(2 * MIB);
    writeFileSync(join(repo, "doc.txt"), lf);
    git(repo, ["add", "doc.txt"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "doc"]);
    const id = git(repo, ["rev-parse", ":doc.txt"]).trim();
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      input: `100644 ${id}\tdoc.txt\n`,
    });
    writeFileSync(join(repo, "doc.txt"), lf.toString("latin1").replaceAll("\n", "\r\n"), "latin1");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(repo, "doc.txt"), later, later);
    expect(git(repo, ["status", "--porcelain=v1"]).trim()).toBe("");
    const deps = {
      workspace: workspaceInfo(repo),
      processEnv: readerEnv(),
      stagedObjectIds: createGitStagedObjectIdPort({
        workspace: workspaceInfo(repo),
        processEnv: readerEnv(),
      }),
    };
    expect((await readGitRawChanges(deps)).changes).toEqual([]);
  });
});

describe("a large file stages", () => {
  // The oracle: what Git's own `git add` stores, written into a copy of the index.
  function oracleBlob(repo: string, path: string, extra: readonly string[] = []): string {
    const oracleIndex = join(repo, ".git", `oracle-${path}`);
    copyFileSync(join(repo, ".git", "index"), oracleIndex);
    git(repo, [...extra, "-c", "core.safecrlf=false", "add", path], oracleIndex);
    return git(repo, ["rev-parse", `:${path}`], oracleIndex).trim();
  }

  it("stages a 9 MiB text file and a 4 MiB binary as the objects `git hash-object` names", async () => {
    const repo = repository();
    writeGenerated(repo);
    const paths = ["blob.bin", "large.json"];
    const reads: string[] = [];
    const fs = recordingFs(reads);
    const digest = await readGitStageCandidate(repo, paths, fs);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(gitStageFilesSupported(context(repo, fs), paths, "exact")).resolves.toBe(true);
    await expect(
      stageExactFiles(context(repo, fs), request(repo, paths, digest), "exact"),
    ).resolves.toBe(true);
    for (const path of paths) {
      expect(git(repo, ["rev-parse", `:${path}`]).trim()).toBe(
        git(repo, ["hash-object", "--no-filters", path]).trim(),
      );
    }
    // The objects are really in the database: Git reads them back at the exact size.
    expect(git(repo, ["cat-file", "-s", ":large.json"]).trim()).toBe(String(9 * MIB));
    expect(git(repo, ["cat-file", "-s", ":blob.bin"]).trim()).toBe(String(4 * MIB));
    // Memory: no whole-file read ever covered a large file (the in-memory path is for small files).
    expect(largeFileReads(reads)).toEqual([]);
  });

  it("digests a selection far above the old 32 MiB aggregate without holding it", async () => {
    const repo = repository();
    const paths = ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"];
    for (const path of paths)
      writeFileSync(join(repo, path), Buffer.alloc(7 * MIB, path.charCodeAt(0)));
    const reads: string[] = [];
    await expect(readGitStageCandidate(repo, paths, recordingFs(reads))).resolves.toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(largeFileReads(reads)).toEqual([]);
  });

  it("stages a large all-CRLF text file under autocrlf=true exactly as Git's own add does", async () => {
    const repo = repository();
    git(repo, ["config", "core.autocrlf", "true"]);
    writeFileSync(
      join(repo, "doc.txt"),
      textOfSize(2 * MIB)
        .toString("latin1")
        .replaceAll("\n", "\r\n"),
      "latin1",
    );
    const expected = oracleBlob(repo, "doc.txt", ["-c", "core.autocrlf=true"]);
    await expect(
      stageExactFiles(context(repo), request(repo, ["doc.txt"]), "autocrlf-true"),
    ).resolves.toBe(true);
    expect(git(repo, ["rev-parse", ":doc.txt"]).trim()).toBe(expected);
    expect(git(repo, ["cat-file", "-p", ":doc.txt"]).includes("\r")).toBe(false);
  });

  it("refuses a large text file with mixed line breaks under autocrlf=true, as the small path does", async () => {
    const repo = repository();
    git(repo, ["config", "core.autocrlf", "true"]);
    writeFileSync(
      join(repo, "doc.txt"),
      `${textOfSize(2 * MIB)
        .toString("latin1")
        .replaceAll("\n", "\r\n")}tail\n`,
      "latin1",
    );
    await expect(gitStageFilesSupported(context(repo), ["doc.txt"], "autocrlf-true")).resolves.toBe(
      false,
    );
  });

  it("fails closed with its own code when a large file changes while Git reads it", async () => {
    const repo = repository();
    writeGenerated(repo);
    const paths = ["large.json"];
    const indexBefore = git(repo, ["ls-files", "-s"]);
    let touched = false;
    const mutating = context(repo, undefined, (argv) => {
      if (!touched && argv.includes("hash-object")) {
        touched = true;
        appendFileSync(join(repo, "large.json"), "changed during the read\n");
      }
    });
    await expect(stageExactFiles(mutating, request(repo, paths), "exact")).rejects.toThrow(
      "git-stage-file-changed",
    );
    expect(git(repo, ["ls-files", "-s"])).toBe(indexBefore);
  });

  it("fails closed with its own code when a large file is swapped for a link", async () => {
    const repo = repository();
    writeGenerated(repo);
    const swapped = context(repo, undefined, (argv) => {
      if (argv.includes("hash-object")) {
        rmSync(join(repo, "large.json"));
        execFileSync("ln", ["-s", "/etc/hosts", join(repo, "large.json")]);
      }
    });
    await expect(stageExactFiles(swapped, request(repo, ["large.json"]), "exact")).rejects.toThrow(
      "git-stage-file-changed",
    );
  });
});
