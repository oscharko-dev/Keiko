// Deterministic unit coverage for the raw-status stat cache reader/comparator (git-index-stat.ts).
// `parseGitIndexStat` parses `git ls-files --debug -z`'s exact NUL/newline framing.
// `indexStatMatches` is the racy-clean-aware comparator gating `unstagedFileCount` on the
// commit-facts / editor-diff path (git-raw-worktree-node.ts -> verifiedCommitFacts.ts): it must
// never report a stat "match" the caller can safely skip re-reading content for.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeWorkspace } from "./_support.js";
import {
  indexStatMatches,
  parseGitIndexStat,
  readGitIndexWriteTimeNs,
  type GitIndexStat,
} from "./git-index-stat.js";

function debugFrame(path: string, ctime: string, mtime: string, size: number): string {
  return (
    `${path}\0  ctime: ${ctime}\n  mtime: ${mtime}\n  dev: 1\tino: 1\n` +
    `  uid: 0\tgid: 0\n  size: ${String(size)}\tflags: 0\n`
  );
}

describe("parseGitIndexStat", () => {
  it("parses a single entry into its ctime/mtime/size", () => {
    const output = debugFrame("src/a.ts", "10:20", "30:40", 12);
    const result = parseGitIndexStat(output);
    expect(result.get("src/a.ts")).toEqual({
      ctimeNs: String(10n * 1_000_000_000n + 20n),
      mtimeNs: String(30n * 1_000_000_000n + 40n),
      size: 12,
    });
  });

  it("parses multiple entries in sequence", () => {
    const output = debugFrame("a.ts", "1:0", "2:0", 1) + debugFrame("b.ts", "3:0", "4:0", 2);
    const result = parseGitIndexStat(output);
    expect([...result.keys()]).toEqual(["a.ts", "b.ts"]);
  });

  it.each([
    ["empty ctime line", "a.ts\0  mtime: 1:0\n  x\n  x\n  size: 1\tflags: 0\n"],
    ["malformed timestamp", debugFrame("a.ts", "not-a-number", "2:0", 1)],
    ["missing NUL separator", "a.ts  ctime: 1:0\n"],
    ["truncated frame (fewer than 5 lines)", "a.ts\0  ctime: 1:0\n  mtime: 2:0\n"],
    ["malformed size line", "a.ts\0  ctime: 1:0\n  mtime: 2:0\n  x\n  x\n  size: bad\n"],
  ])("refuses %s", (_name, output) => {
    expect(() => parseGitIndexStat(output)).toThrow(TypeError);
  });

  it("refuses a duplicate path", () => {
    const output = debugFrame("a.ts", "1:0", "2:0", 1) + debugFrame("a.ts", "1:0", "2:0", 1);
    expect(() => parseGitIndexStat(output)).toThrow(TypeError);
  });
});

describe("indexStatMatches", () => {
  function writeAndStat(root: string, path: string, content: string): GitIndexStat {
    writeFileSync(join(root, path), content, "utf8");
    const stat = nodeWorkspaceFs.stat(join(root, path));
    if (stat.mtimeNs === undefined || stat.ctimeNs === undefined) {
      throw new Error("test-fixture-no-nanosecond-stat");
    }
    return { ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size };
  }

  it("returns false when no expected stat is on file", () => {
    const { root } = makeWorkspace();
    expect(indexStatMatches(root, "package.json", undefined)).toBe(false);
  });

  it("returns false when the file does not exist", () => {
    const { root } = makeWorkspace();
    const expected: GitIndexStat = { ctimeNs: "1", mtimeNs: "1", size: 0 };
    expect(indexStatMatches(root, "missing.ts", expected)).toBe(false);
  });

  it("matches an unchanged file's exact stat, with no index write time supplied", () => {
    const { root } = makeWorkspace();
    const expected = writeAndStat(root, "unchanged.ts", "same content");
    expect(indexStatMatches(root, "unchanged.ts", expected)).toBe(true);
  });

  it("returns false when size, ctime or mtime differs from the recorded entry", () => {
    const { root } = makeWorkspace();
    const expected = writeAndStat(root, "changed.ts", "content");
    expect(indexStatMatches(root, "changed.ts", { ...expected, size: expected.size + 1 })).toBe(
      false,
    );
    expect(indexStatMatches(root, "changed.ts", { ...expected, mtimeNs: "1" })).toBe(false);
    expect(indexStatMatches(root, "changed.ts", { ...expected, ctimeNs: "1" })).toBe(false);
  });

  // Owner audit finding b2-7: a stat match whose recorded mtime is not strictly OLDER than the
  // index file's own write time is racily clean and must be reported as NOT matching, even though
  // every field still agrees with what is on disk right now.
  it("treats a stat match as inconclusive when the entry mtime is not older than the index write time", () => {
    const { root } = makeWorkspace();
    const expected = writeAndStat(root, "racy.ts", "staged content");
    const sameInstantAsEntry = expected.mtimeNs;
    const oneNsBeforeEntry = String(BigInt(expected.mtimeNs) - 1n);

    // Baseline: with no index write time available, the exact stat match is trusted.
    expect(indexStatMatches(root, "racy.ts", expected)).toBe(true);

    // The index was written in the exact same instant as the cached entry's mtime -> the entry is
    // not OLDER than the index write time -> racily clean.
    expect(indexStatMatches(root, "racy.ts", expected, sameInstantAsEntry)).toBe(false);

    // The index was written strictly BEFORE the entry's mtime -> the entry is newer than the index
    // itself, i.e. still not older -> also racily clean.
    expect(indexStatMatches(root, "racy.ts", expected, oneNsBeforeEntry)).toBe(false);
  });

  it("keeps trusting a stat match strictly older than the index write time", () => {
    const { root } = makeWorkspace();
    const expected = writeAndStat(root, "settled.ts", "settled content");
    const oneNsAfterEntry = String(BigInt(expected.mtimeNs) + 1n);
    expect(indexStatMatches(root, "settled.ts", expected, oneNsAfterEntry)).toBe(true);
  });

  it("refuses a path outside the workspace root", () => {
    const { root } = makeWorkspace();
    const expected: GitIndexStat = { ctimeNs: "1", mtimeNs: "1", size: 0 };
    expect(() => indexStatMatches(root, "../outside.ts", expected)).toThrow();
  });
});

// Owner audit finding b2-7 (corrected fix): `indexStatMatches`'s racy-clean guard needs the
// `.git/index` file's OWN write time as `indexWriteTimeNs`. This is the fs-capable owner of that
// resolution (never `git-worktree-snapshot-node.ts`, whose header bans direct FS access).
describe("readGitIndexWriteTimeNs", () => {
  const dirs: string[] = [];
  function git(cwd: string, args: readonly string[]): string {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  }
  function tempRepoRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-write-time-")));
    dirs.push(root);
    return root;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when there is no .git at all", () => {
    const { root } = makeWorkspace();
    expect(readGitIndexWriteTimeNs(root)).toBeUndefined();
  });

  it("returns undefined before the first stage (.git exists, but no index file yet)", () => {
    const root = tempRepoRoot();
    git(root, ["init", "-q", "-b", "master"]);
    expect(readGitIndexWriteTimeNs(root)).toBeUndefined();
  });

  it("returns the real .git/index file's own mtimeNs once staged", () => {
    const root = tempRepoRoot();
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.name", "Keiko Test"]);
    git(root, ["config", "user.email", "keiko@example.test"]);
    writeFileSync(join(root, "a.txt"), "hi\n", "utf8");
    git(root, ["add", "a.txt"]);
    const indexStat = nodeWorkspaceFs.stat(join(root, ".git", "index"));
    expect(readGitIndexWriteTimeNs(root)).toBe(indexStat.mtimeNs);
  });

  it("follows a linked worktree's gitdir pointer to ITS OWN separate index file", () => {
    const root = tempRepoRoot();
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.name", "Keiko Test"]);
    git(root, ["config", "user.email", "keiko@example.test"]);
    writeFileSync(join(root, "a.txt"), "hi\n", "utf8");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "-qm", "base"]);
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-write-time-wt-")));
    rmSync(worktree, { recursive: true, force: true });
    dirs.push(worktree);
    git(root, ["worktree", "add", "-q", "-b", "wt-branch", worktree]);
    writeFileSync(join(worktree, "b.txt"), "hi\n", "utf8");
    git(worktree, ["add", "b.txt"]);
    // The linked worktree's OWN index lives under the main repo's `.git/worktrees/<name>/index`,
    // never under `<worktree>/.git` (a plain file pointer, not a directory) — proving the pointer
    // is actually followed rather than a bare `<root>/.git/index` guess.
    const mainRepoIndex = nodeWorkspaceFs.exists(join(root, ".git", "index"))
      ? nodeWorkspaceFs.stat(join(root, ".git", "index")).mtimeNs
      : undefined;
    const resolved = readGitIndexWriteTimeNs(worktree);
    expect(resolved).toBeDefined();
    expect(resolved).not.toBe(mainRepoIndex);
  });

  it("returns undefined for a malformed gitdir pointer file instead of throwing", () => {
    const root = tempRepoRoot();
    writeFileSync(join(root, ".git"), "not a real pointer\n", "utf8");
    expect(readGitIndexWriteTimeNs(root)).toBeUndefined();
  });
});
