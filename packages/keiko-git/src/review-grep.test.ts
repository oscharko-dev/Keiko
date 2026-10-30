// The fixed-string tree search of the counter-check (Issue #4136), against real `git`: it reads the
// commit object, never the working tree, treats the needle as a literal, skips binary blobs and
// reports a cut listing as truncated.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "./env.js";
import { createGitReviewProcessRunner } from "./review-runner.js";
import {
  GitReviewOperandError,
  grepGitReviewTree,
  type GitReviewOperationContext,
} from "./review-operations.js";

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

function write(name: string, content: string | Buffer): void {
  writeFileSync(join(repo, name), content);
}

function context(maxBytes = 1024 * 1024): GitReviewOperationContext {
  return { runner: createGitReviewProcessRunner({}), timeoutMs: 20_000, maxBytes };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-review-grep-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo], { env: ENV });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function commitAll(): string {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  return git(["rev-parse", "HEAD"]);
}

describe("grepGitReviewTree", () => {
  it("finds a literal in the commit object, not in the working tree", async () => {
    write("a.ts", "const guard = value ?? fallback;\nreturn guard;\n");
    write("bin.dat", Buffer.from([0, 1, 2, 0x67, 0x75, 0x61, 0x72, 0x64]));
    const sha = commitAll();
    write("a.ts", "nothing here\n");
    write("b.ts", "guard added later\n");
    const result = await grepGitReviewTree(context(), {
      cwd: repo,
      sha,
      literal: "guard",
      maxCountPerFile: 10,
    });
    expect(result.ok && result.value).toEqual({
      matches: [
        { path: "a.ts", line: 1, text: "const guard = value ?? fallback;" },
        { path: "a.ts", line: 2, text: "return guard;" },
      ],
      truncated: false,
    });
  });

  it("treats regular-expression syntax literally and answers no match as empty", async () => {
    write("a.ts", "x.*y\nxzzy\n");
    const sha = commitAll();
    const hit = await grepGitReviewTree(context(), {
      cwd: repo,
      sha,
      literal: "x.*y",
      maxCountPerFile: 5,
    });
    expect(hit.ok && hit.value.matches).toEqual([{ path: "a.ts", line: 1, text: "x.*y" }]);
    const none = await grepGitReviewTree(context(), {
      cwd: repo,
      sha,
      literal: "absent",
      maxCountPerFile: 5,
    });
    expect(none.ok && none.value).toEqual({ matches: [], truncated: false });
  });

  it("reports a cut listing as truncated with its complete records only", async () => {
    write("a.ts", "needle line\n".repeat(50));
    const sha = commitAll();
    const result = await grepGitReviewTree(context(200), {
      cwd: repo,
      sha,
      literal: "needle",
      maxCountPerFile: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.matches.length).toBeGreaterThan(0);
    expect(result.value.matches.every((match) => match.text === "needle line")).toBe(true);
  });

  it("refuses control characters, empty needles and invalid bounds before a spawn", async () => {
    const sha = "a".repeat(40);
    const call = (literal: string, maxCountPerFile = 5): Promise<unknown> =>
      grepGitReviewTree(context(), { cwd: repo, sha, literal, maxCountPerFile });
    await expect(call("")).rejects.toBeInstanceOf(GitReviewOperandError);
    await expect(call("a\nb")).rejects.toBeInstanceOf(GitReviewOperandError);
    await expect(call("ok", 0)).rejects.toBeInstanceOf(GitReviewOperandError);
    await expect(call("ok", 101)).rejects.toBeInstanceOf(GitReviewOperandError);
  });
});
