// Review runner and review operations against real `git` in temporary repositories (Issue #4133).
// Every neutralization is proven against a positive control: the same hostile fixture checked out
// through an unhardened runner DOES run the hook, the filters and fsmonitor and DOES create the
// symbolic link, so a passing hardened case cannot be an inert fixture.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "./env.js";
import {
  createGitReviewNetworkProcessRunner,
  createGitReviewProcessRunner,
  gitReviewFilterNeutralizationArgs,
  gitReviewFixedArgs,
  GIT_REVIEW_HARDENING_CONFIG,
  isSafeGitFilterDriverName,
} from "./review-runner.js";
import {
  addGitReviewWorktree,
  checkoutGitReviewWorktree,
  createGitReviewRef,
  deleteGitReviewRef,
  gitReviewCommitExists,
  gitReviewLocalRangeRef,
  gitReviewPullRequestBaseRef,
  gitReviewPullRequestRef,
  GitReviewOperandError,
  listGitReviewBinaryPaths,
  listGitReviewConfiguredFilterDrivers,
  listGitReviewRefs,
  listGitReviewTree,
  listGitReviewWorktrees,
  readGitReviewBlob,
  readGitReviewTreeIntoIndex,
  removeGitReviewWorktree,
  resolveGitReviewCommit,
  readGitReviewPathObject,
  showGitReviewFile,
  skipGitReviewWorktreePaths,
  unlockGitReviewWorktree,
  type GitReviewOperationContext,
} from "./review-operations.js";
import { createGitProcessRunner } from "./runner.js";
import type { GitProcessRunner } from "./types.js";

const LFS_POINTER =
  "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 12\n";

const NS = "k0123456789abcdef";
let root: string;
let repo: string;
let markers: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

function shellMarker(name: string): string {
  return `touch '${join(markers, name)}'`;
}

// A repository whose OWN configuration wires a hook directory, a filter driver, an LFS driver and
// an fsmonitor hook, and whose head ships the hook, the attributes and a symbolic link that
// escapes the worktree. Husky-style `core.hooksPath` makes the head's own hook file executable
// configuration, which is the realistic attack on a reviewer's checkout.
function buildHostileRepository(): string {
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  mkdirSync(join(repo, ".githooks"));
  writeFileSync(join(repo, ".githooks", "post-checkout"), `#!/bin/sh\n${shellMarker("hook")}\n`);
  chmodSync(join(repo, ".githooks", "post-checkout"), 0o755);
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=marker\n*.bin filter=lfs\n");
  writeFileSync(join(repo, "notes.txt"), "plain text\n");
  writeFileSync(join(repo, "asset.bin"), LFS_POINTER);
  writeFileSync(join(repo, "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 4]));
  symlinkSync("../../outside-secret", join(repo, "escape"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "hostile head");
  git(repo, "config", "core.hooksPath", ".githooks");
  git(repo, "config", "filter.marker.smudge", `sh -c "${shellMarker("filter")}; cat"`);
  git(repo, "config", "filter.marker.clean", "cat");
  git(repo, "config", "filter.marker.required", "true");
  git(repo, "config", "filter.lfs.smudge", `sh -c "${shellMarker("lfs")}; echo smudged"`);
  git(repo, "config", "filter.lfs.required", "true");
  const fsmonitor = join(root, "fsmonitor.sh");
  writeFileSync(fsmonitor, `#!/bin/sh\n${shellMarker("fsmonitor")}\n`);
  chmodSync(fsmonitor, 0o755);
  git(repo, "config", "core.fsmonitor", fsmonitor);
  return git(repo, "rev-parse", "HEAD");
}

function context(runner: GitProcessRunner): GitReviewOperationContext {
  return { runner, timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 };
}

async function materialize(runner: GitProcessRunner, sha: string, path: string): Promise<void> {
  const ctx = context(runner);
  expect((await addGitReviewWorktree(ctx, { repositoryRoot: repo, path, sha })).ok).toBe(true);
  expect((await readGitReviewTreeIntoIndex(ctx, { worktreePath: path, sha })).ok).toBe(true);
  await checkoutGitReviewWorktree(ctx, { worktreePath: path, sha });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-review-")));
  repo = join(root, "repo");
  markers = join(root, "markers");
  mkdirSync(repo);
  mkdirSync(markers);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("review runner configuration", () => {
  it("injects every reviewed hardening pair ahead of the caller's arguments", () => {
    const args = gitReviewFixedArgs({ platform: "linux" });
    for (const [key, value] of GIT_REVIEW_HARDENING_CONFIG) {
      const expected = key === "core.hooksPath" ? "/dev/null" : value;
      expect(args).toContain(`${key}=${expected}`);
    }
    expect(gitReviewFixedArgs({ platform: "win32" })).toContain("core.hooksPath=NUL");
    expect(args).toContain("filter.lfs.smudge=");
    expect(args).toContain("filter.lfs.required=false");
  });

  it("neutralizes every named driver and refuses names that could move the key boundary", () => {
    expect(gitReviewFilterNeutralizationArgs(["Marker.v2"])).toEqual(
      expect.arrayContaining([
        "filter.Marker.v2.smudge=",
        "filter.Marker.v2.clean=",
        "filter.Marker.v2.process=",
        "filter.Marker.v2.required=false",
      ]),
    );
    for (const unsafe of ["x.smudge=evil", "a b", "-c", "", "a..b", "x\nfilter", "é"]) {
      expect(isSafeGitFilterDriverName(unsafe)).toBe(false);
      expect(() => gitReviewFilterNeutralizationArgs([unsafe])).toThrow(RangeError);
    }
    expect(() =>
      gitReviewFilterNeutralizationArgs(Array.from({ length: 70 }, (_, i) => `d${String(i)}`)),
    ).toThrow(RangeError);
  });

  it("validates the big-file threshold as a bounded positive integer", () => {
    expect(gitReviewFixedArgs({ bigFileThresholdBytes: 2_097_152 })).toContain(
      "core.bigFileThreshold=2097152",
    );
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40]) {
      expect(() => gitReviewFixedArgs({ bigFileThresholdBytes: bad })).toThrow(RangeError);
    }
  });

  it("refuses every caller-supplied configuration override before a process starts", async () => {
    for (const runner of [createGitReviewProcessRunner(), createGitReviewNetworkProcessRunner()]) {
      for (const args of [
        ["-c", "core.hooksPath=.githooks", "status"],
        ["--config-env", "core.symlinks=ENV", "status"],
        ["--config-env=filter.x.smudge=ENV", "status"],
        ["-ccore.fsmonitor=true", "status"],
        ["status", "-c", "user.name=x"],
      ]) {
        const result = await runner(args, { cwd: repo, timeoutMs: 5_000, maxBytes: 1024 });
        expect(result.refusal).toBe("config-override");
        expect(result.exitCode).toBe(128);
      }
    }
  });
});

describe("hostile fixture checkout", () => {
  it("runs the hook, both filters, fsmonitor and creates the escaping link without hardening (positive control)", async () => {
    const sha = buildHostileRepository();
    const path = join(root, "control");
    await materialize(
      createGitProcessRunner(() => gitEnv()),
      sha,
      path,
    );
    expect(readdirSync(markers).sort()).toEqual(["filter", "fsmonitor", "hook", "lfs"]);
    expect(lstatSync(join(path, "escape")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(path, "asset.bin"), "utf8")).toBe("smudged\n");
  });

  it("checks out at the exact raw SHA with no hook, filter, LFS smudge or fsmonitor and links as files", async () => {
    const sha = buildHostileRepository();
    const path = join(root, "review");
    const runner = createGitReviewProcessRunner({ filterDrivers: ["marker"] });
    await materialize(runner, sha, path);
    expect(readdirSync(markers)).toEqual([]);
    expect(lstatSync(join(path, "escape")).isFile()).toBe(true);
    expect(readFileSync(join(path, "escape"), "utf8")).toBe("../../outside-secret");
    expect(readFileSync(join(path, "asset.bin"), "utf8")).toBe(LFS_POINTER);
    expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe("plain text\n");
    expect(git(path, "rev-parse", "HEAD")).toBe(sha);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  });

  it("keeps skip-worktree paths out of the materialized tree", async () => {
    const sha = buildHostileRepository();
    const path = join(root, "skip");
    const ctx = context(createGitReviewProcessRunner({ filterDrivers: ["marker"] }));
    await addGitReviewWorktree(ctx, { repositoryRoot: repo, path, sha });
    await readGitReviewTreeIntoIndex(ctx, { worktreePath: path, sha });
    expect(
      (await skipGitReviewWorktreePaths(ctx, { worktreePath: path, paths: ["blob.dat"] })).ok,
    ).toBe(true);
    expect((await checkoutGitReviewWorktree(ctx, { worktreePath: path, sha })).ok).toBe(true);
    expect(existsSync(join(path, "blob.dat"))).toBe(false);
    expect(existsSync(join(path, "notes.txt"))).toBe(true);
  });
});

describe("materialization fidelity", () => {
  // macOS repositories carry `core.precomposeunicode=true`, which re-encodes decomposed argv.
  function decomposedRepository(): string {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "core.precomposeunicode", "true");
    const store = (content: Buffer | string): string =>
      execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo,
        env: gitEnv(),
        input: content,
      })
        .toString("utf8")
        .trim();
    // Index entries are written directly so no add-time conversion touches the fixture blobs.
    const add = (blob: string, name: string): void => {
      git(
        repo,
        "-c",
        "core.precomposeunicode=false",
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},${name}`,
      );
    };
    add(store(Buffer.from([0, 1, 2, 0])), "cafe\u0301.bin");
    add(store("*.txt eol=crlf ident working-tree-encoding=UTF-16\n"), ".gitattributes");
    add(store("line $Id$\nsecond\n"), "notes.txt");
    git(repo, "commit", "-q", "-m", "decomposed");
    return git(repo, "rev-parse", "HEAD");
  }

  it("skips a decomposed path in a precomposing repository through one stdin process", async () => {
    const sha = decomposedRepository();
    const path = join(root, "nfd");
    const ctx = context(createGitReviewProcessRunner({ neutralizeTreeAttributes: "sha1" }));
    await addGitReviewWorktree(ctx, { repositoryRoot: repo, path, sha });
    await readGitReviewTreeIntoIndex(ctx, { worktreePath: path, sha });
    const skipped = await skipGitReviewWorktreePaths(ctx, {
      worktreePath: path,
      paths: ["cafe\u0301.bin"],
    });
    expect(skipped.ok).toBe(true);
    expect((await checkoutGitReviewWorktree(ctx, { worktreePath: path, sha })).ok).toBe(true);
    expect(readdirSync(path).filter((name) => name.endsWith(".bin"))).toEqual([]);
  });

  it("materializes every file byte-identical to its blob whatever the head's attributes say", async () => {
    const sha = decomposedRepository();
    const neutralized = join(root, "neutralized");
    await materialize(
      createGitReviewProcessRunner({ neutralizeTreeAttributes: "sha1" }),
      sha,
      neutralized,
    );
    expect(readFileSync(join(neutralized, "notes.txt"), "utf8")).toBe("line $Id$\nsecond\n");
    // Positive control: the same head through a runner that honours in-tree attributes expands
    // the file (CRLF, the `$Id$` keyword, UTF-16) far beyond its blob size.
    const honoured = join(root, "honoured");
    await materialize(createGitReviewProcessRunner(), sha, honoured);
    expect(statSync(join(honoured, "notes.txt")).size).toBeGreaterThan(2 * 18);
  });
});

describe("review operations", () => {
  function plainRepository(): string {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "user.name", "Fixture");
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "-dash.bin"), Buffer.from([0, 0, 1]));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "one");
    return git(repo, "rev-parse", "HEAD");
  }

  it("lists the tree with sizes and binary paths and reads objects without filters", async () => {
    const sha = plainRepository();
    const ctx = context(createGitReviewProcessRunner({ bigFileThresholdBytes: 1024 }));
    const tree = await listGitReviewTree(ctx, { cwd: repo, sha });
    expect(tree.ok && tree.value.map((entry) => [entry.path, entry.size])).toEqual([
      ["-dash.bin", 3],
      ["a.txt", 6],
    ]);
    const binary = await listGitReviewBinaryPaths(ctx, { cwd: repo, sha });
    expect(binary.ok && [...binary.value]).toEqual(["-dash.bin"]);
    const oid = tree.ok ? (tree.value[1]?.oid ?? "") : "";
    const blob = await readGitReviewBlob(ctx, { cwd: repo, oid });
    expect(blob.ok && blob.value).toBe("alpha\n");
    const shown = await showGitReviewFile(ctx, { cwd: repo, sha, path: "a.txt" });
    expect(shown.ok && shown.value).toBe("alpha\n");
  });

  it("resolves one path of a commit to its object without reading it (#4135)", async () => {
    const sha = plainRepository();
    const ctx = context(createGitReviewProcessRunner());
    const found = await readGitReviewPathObject(ctx, { cwd: repo, sha, path: "a.txt" });
    expect(found.ok && found.value).toMatchObject({ type: "blob", size: 6 });
    expect(await readGitReviewPathObject(ctx, { cwd: repo, sha, path: "missing.md" })).toEqual({
      ok: true,
      value: undefined,
    });
    // A path naming nothing in a commit the repository does not hold is a failed read, not absent.
    const unknown = await readGitReviewPathObject(ctx, {
      cwd: repo,
      sha: "f".repeat(40),
      path: "a.txt",
    });
    expect(unknown.ok).toBe(false);
    await expect(
      readGitReviewPathObject(ctx, { cwd: repo, sha, path: "a\nb.txt" }),
    ).rejects.toThrow(GitReviewOperandError);
    await expect(
      readGitReviewPathObject(ctx, { cwd: repo, sha: "HEAD", path: "a.txt" }),
    ).rejects.toThrow(GitReviewOperandError);
  });

  it("resolves commits, rejects option-shaped refs and creates, lists and deletes private refs only", async () => {
    const sha = plainRepository();
    const ctx = context(createGitReviewProcessRunner());
    expect(await resolveGitReviewCommit(ctx, { cwd: repo, ref: "main" })).toEqual({
      ok: true,
      value: sha,
    });
    expect(await resolveGitReviewCommit(ctx, { cwd: repo, ref: "missing" })).toEqual({
      ok: true,
      value: undefined,
    });
    await expect(resolveGitReviewCommit(ctx, { cwd: repo, ref: "--output=x" })).rejects.toThrow(
      GitReviewOperandError,
    );
    expect(await gitReviewCommitExists(ctx, { cwd: repo, sha })).toEqual({ ok: true, value: true });
    expect(await gitReviewCommitExists(ctx, { cwd: repo, sha: "b".repeat(40) })).toEqual({
      ok: true,
      value: false,
    });
    const ref = gitReviewLocalRangeRef(NS, "run-1");
    expect((await createGitReviewRef(ctx, { cwd: repo, ref, sha })).ok).toBe(true);
    expect(await listGitReviewRefs(ctx, { cwd: repo, namespace: NS })).toEqual({
      ok: true,
      value: [ref],
    });
    const foreign = gitReviewLocalRangeRef("kfedcba9876543210", "run-1");
    expect((await createGitReviewRef(ctx, { cwd: repo, ref: foreign, sha })).ok).toBe(true);
    expect((await deleteGitReviewRef(ctx, { cwd: repo, ref })).ok).toBe(true);
    expect(await listGitReviewRefs(ctx, { cwd: repo, namespace: NS })).toEqual({
      ok: true,
      value: [],
    });
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/keiko-review/")).toBe(foreign);
    expect(() => deleteGitReviewRef(ctx, { cwd: repo, ref: "refs/heads/main" })).toThrow(
      GitReviewOperandError,
    );
    expect(git(repo, "rev-parse", "main")).toBe(sha);
  });

  it("names private refs from validated operands only", () => {
    const sha = "c".repeat(40);
    expect(gitReviewPullRequestRef(NS, 7, sha)).toBe(`refs/keiko-review/${NS}/7/${sha}`);
    expect(gitReviewPullRequestBaseRef(NS, 7, sha)).toBe(`refs/keiko-review/${NS}/7/base-${sha}`);
    expect(() => gitReviewPullRequestRef(NS, 0, sha)).toThrow(GitReviewOperandError);
    expect(() => gitReviewPullRequestRef(NS, 7, "HEAD")).toThrow(GitReviewOperandError);
    expect(() => gitReviewPullRequestRef("local", 7, sha)).toThrow(GitReviewOperandError);
    expect(() => gitReviewLocalRangeRef(NS, "../x")).toThrow(GitReviewOperandError);
  });

  it("lists configured filter drivers and locks, unlocks and removes a worktree with its entry", async () => {
    const sha = plainRepository();
    git(repo, "config", "filter.Custom.smudge", "cat");
    const ctx = context(createGitReviewProcessRunner());
    expect(await listGitReviewConfiguredFilterDrivers(ctx, { cwd: repo })).toEqual({
      ok: true,
      value: ["Custom"],
    });
    const path = join(root, "wt");
    expect((await addGitReviewWorktree(ctx, { repositoryRoot: repo, path, sha })).ok).toBe(true);
    git(repo, "worktree", "prune", "--expire=now");
    const listed = await listGitReviewWorktrees(ctx, { repositoryRoot: repo });
    expect(listed.ok && listed.value.find((entry) => entry.path === path)?.lockReason).toBe(
      "keiko-review",
    );
    rmSync(path, { recursive: true, force: true });
    git(repo, "worktree", "prune", "--expire=now");
    expect(readdirSync(join(repo, ".git", "worktrees"))).toHaveLength(1);
    expect((await unlockGitReviewWorktree(ctx, { repositoryRoot: repo, path })).ok).toBe(true);
    expect((await removeGitReviewWorktree(ctx, { repositoryRoot: repo, path })).ok).toBe(true);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
  });

  it("refuses relative and option-shaped worktree paths before a spawn", () => {
    const ctx = context(createGitReviewProcessRunner());
    for (const path of ["relative/wt", "-wt", "/tmp/a\nb"]) {
      expect(() =>
        addGitReviewWorktree(ctx, { repositoryRoot: repo, path, sha: "a".repeat(40) }),
      ).toThrow(GitReviewOperandError);
    }
  });
});
