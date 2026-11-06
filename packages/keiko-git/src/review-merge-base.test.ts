// The fixed-argv merge base of a review target (R4130-008), against real `git`: a pull request
// diffs from the commit its head branched from, never from the base branch's current tip.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "./env.js";
import { createGitReviewProcessRunner } from "./review-runner.js";
import {
  GitReviewOperandError,
  gitReviewRepositoryIsShallow,
  resolveGitReviewMergeBase,
  type GitReviewOperationContext,
} from "./review-operations.js";
import type { GitProcessRunner } from "./types.js";

let root: string;
let repo: string;

const ENV: NodeJS.ProcessEnv = {
  ...gitEnv(),
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repo, env: ENV }).toString("utf8").trim();
}

function commit(name: string, content: string): string {
  writeFileSync(join(repo, name), content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", name]);
  return git(["rev-parse", "HEAD"]);
}

function context(
  runner: GitProcessRunner = createGitReviewProcessRunner({}),
): GitReviewOperationContext {
  return { runner, timeoutMs: 20_000 };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-review-merge-base-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveGitReviewMergeBase", () => {
  it("answers the commit the head branched from after the base moved on", async () => {
    const forkPoint = commit("shared.ts", "export const shared = 1;\n");
    git(["switch", "-q", "-c", "feature"]);
    const head = commit("feature.ts", "export const feature = 1;\n");
    git(["switch", "-q", "main"]);
    const baseTip = commit("later.ts", "export const later = 1;\n");
    const result = await resolveGitReviewMergeBase(context(), {
      cwd: repo,
      baseSha: baseTip,
      headSha: head,
    });
    expect(result).toEqual({ ok: true, value: forkPoint });
  });

  it("answers undefined for commits that share no history", async () => {
    const base = commit("a.ts", "a\n");
    git(["switch", "-q", "--orphan", "unrelated"]);
    const head = commit("b.ts", "b\n");
    const result = await resolveGitReviewMergeBase(context(), {
      cwd: repo,
      baseSha: base,
      headSha: head,
    });
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("fails rather than answering for a commit the repository does not hold", async () => {
    const base = commit("a.ts", "a\n");
    const result = await resolveGitReviewMergeBase(context(), {
      cwd: repo,
      baseSha: base,
      headSha: "b".repeat(40),
    });
    expect(result.ok).toBe(false);
  });

  it("runs one fixed argument vector with both object ids after --end-of-options", async () => {
    const calls: (readonly string[])[] = [];
    const inner = createGitReviewProcessRunner({});
    const recording: GitProcessRunner = (args, options) => {
      calls.push(args);
      return inner(args, options);
    };
    const base = commit("a.ts", "a\n");
    const head = commit("b.ts", "b\n");
    await resolveGitReviewMergeBase(context(recording), {
      cwd: repo,
      baseSha: base,
      headSha: head,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(-4)).toEqual(["merge-base", "--end-of-options", base, head]);
  });

  it("refuses an abbreviated or option-shaped object id before a spawn", async () => {
    const full = "a".repeat(40);
    const call = (baseSha: string, headSha: string): Promise<unknown> =>
      resolveGitReviewMergeBase(context(), { cwd: repo, baseSha, headSha });
    await expect(call("abc123", full)).rejects.toBeInstanceOf(GitReviewOperandError);
    await expect(call(full, "--all")).rejects.toBeInstanceOf(GitReviewOperandError);
    await expect(call(full, "HEAD")).rejects.toBeInstanceOf(GitReviewOperandError);
  });
});

// R4130-036: in a shallow clone, merge-base cannot reach a fork point behind the shallow boundary
// and answers like unrelated histories. The shallow check tells the two apart.
describe("gitReviewRepositoryIsShallow", () => {
  function shallowClone(): {
    readonly clone: string;
    readonly base: string;
    readonly head: string;
  } {
    commit("shared.ts", "export const shared = 1;\n");
    git(["switch", "-q", "-c", "feature"]);
    const head = commit("feature.ts", "export const feature = 1;\n");
    git(["switch", "-q", "main"]);
    const base = commit("later.ts", "export const later = 1;\n");
    const clone = join(root, "shallow");
    // Only this fixture clone may use the file transport; review operations keep the denylist.
    const cloneEnv = { ...ENV, GIT_ALLOW_PROTOCOL: "file" };
    const args = ["clone", "-q", "--depth", "1", "--no-single-branch", `file://${repo}`, clone];
    execFileSync("git", args, { env: cloneEnv });
    return { clone, base, head };
  }

  it("answers true for a depth-1 clone whose merge base lies behind the boundary", async () => {
    const { clone, base, head } = shallowClone();
    expect(await gitReviewRepositoryIsShallow(context(), { cwd: clone })).toEqual({
      ok: true,
      value: true,
    });
    const merged = await resolveGitReviewMergeBase(context(), {
      cwd: clone,
      baseSha: base,
      headSha: head,
    });
    expect(merged).toEqual({ ok: true, value: undefined });
  });

  it("answers false for a complete repository", async () => {
    commit("a.ts", "a\n");
    expect(await gitReviewRepositoryIsShallow(context(), { cwd: repo })).toEqual({
      ok: true,
      value: false,
    });
  });

  it("runs one fixed argument vector", async () => {
    const calls: (readonly string[])[] = [];
    const inner = createGitReviewProcessRunner({});
    const recording: GitProcessRunner = (args, options) => {
      calls.push(args);
      return inner(args, options);
    };
    commit("a.ts", "a\n");
    await gitReviewRepositoryIsShallow(context(recording), { cwd: repo });
    expect(calls.map((args) => args.slice(-2))).toEqual([["rev-parse", "--is-shallow-repository"]]);
  });
});
