// Repository-membership resolution against a real, disposable git repository — the point of this
// module is fidelity to real git behaviour (subdirectories, linked worktrees where `.git` is a
// file, unborn HEAD), so the spawn boundary is exercised for real. Local repo config only; the
// hardened env never reads global git state, keeping the run deterministic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { classifyGitFailure } from "./classify.js";
import { containsPath, resolveGitMembership } from "./resolve.js";
import { defaultGitProcessRunner } from "./runner.js";

const TIMEOUT = { timeoutMs: 10_000 } as const;

let base: string;
let repo: string;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-resolve-")));
  repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@keiko.example"]);
  git(repo, ["config", "user.name", "Keiko Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveGitMembership", () => {
  it("resolves the repository root with an empty prefix", async () => {
    const resolution = await resolveGitMembership(repo, defaultGitProcessRunner, TIMEOUT);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(realpathSync(resolution.membership.repositoryRoot)).toBe(repo);
    expect(resolution.membership.prefix).toBe("");
  });

  it("resolves a nested subdirectory to the owning repository with its prefix", async () => {
    const nested = join(repo, "packages", "sub");
    mkdirSync(nested, { recursive: true });
    const resolution = await resolveGitMembership(nested, defaultGitProcessRunner, TIMEOUT);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(realpathSync(resolution.membership.repositoryRoot)).toBe(repo);
    expect(resolution.membership.prefix).toBe("packages/sub");
  });

  it("works before the first commit (unborn HEAD)", async () => {
    const nested = join(repo, "src");
    mkdirSync(nested);
    const resolution = await resolveGitMembership(nested, defaultGitProcessRunner, TIMEOUT);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.membership.prefix).toBe("src");
  });

  it("resolves a linked worktree, where .git is a file, including subdirectories", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const worktree = join(base, "wt");
    git(repo, ["worktree", "add", "-q", "-b", "wt-branch", worktree]);
    const nested = join(worktree, "deep");
    mkdirSync(nested);
    const resolution = await resolveGitMembership(nested, defaultGitProcessRunner, TIMEOUT);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(realpathSync(resolution.membership.repositoryRoot)).toBe(worktree);
    expect(resolution.membership.prefix).toBe("deep");
  });

  it("fails with a classifiable not-a-repository result outside any repository", async () => {
    const outside = join(base, "plain");
    mkdirSync(outside);
    const resolution = await resolveGitMembership(outside, defaultGitProcessRunner, TIMEOUT);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(classifyGitFailure(resolution.result)).toBe("not-a-repository");
  });
});

describe("containsPath", () => {
  it("accepts the root itself and any descendant", () => {
    expect(containsPath(repo, repo)).toBe(true);
    expect(containsPath(repo, join(repo, "packages", "sub"))).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(containsPath(repo, base)).toBe(false);
    expect(containsPath(repo, join(base, "other"))).toBe(false);
    expect(containsPath(join(repo, "sub"), repo)).toBe(false);
  });

  it("rejects lookalike prefixes that are different directories", () => {
    expect(containsPath(repo, `${repo}-suffix`)).toBe(false);
    expect(containsPath(repo, `${repo}-suffix${sep}inner`)).toBe(false);
  });

  it("matches platform filesystem identity for letter case", () => {
    const upper = repo.toUpperCase();
    const expected = process.platform === "win32" || process.platform === "darwin";
    expect(containsPath(repo, join(upper, "child"))).toBe(expected);
  });

  it("matches platform filesystem identity for Unicode normalization", () => {
    // Same German folder name in the two Unicode forms APFS treats as one identity:
    // NFC (single code point U+00E4) vs NFD ("a" + combining U+0308).
    const rootNfc = join(repo, "b\u00e4r");
    const rootNfd = join(repo, "ba\u0308r");
    expect(rootNfc).not.toBe(rootNfd);
    const expected = process.platform === "win32" || process.platform === "darwin";
    expect(containsPath(rootNfc, join(rootNfd, "child"))).toBe(expected);
    expect(containsPath(rootNfc, join(rootNfc, "child"))).toBe(true);
  });
});
