import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fileAt,
  git,
  hasCommit,
  prepareOverlay,
  preparePullRequest,
  pullRequestRefs,
  seedRefs,
} from "./repository.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@keiko.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@keiko.invalid",
};

let repository = "";

function commitFile(path: string, content: string, message: string): string {
  writeFileSync(join(repository, path), content);
  git(repository, ["add", path]);
  git(repository, ["commit", "-q", "-m", message], { env: IDENTITY });
  return git(repository, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  repository = mkdtempSync(join(tmpdir(), "keiko-review-gate-repo-"));
  git(repository, ["init", "-q", "--template=", "--initial-branch=dev"]);
});

afterEach(() => {
  rmSync(repository, { recursive: true, force: true });
});

describe("preparePullRequest", () => {
  it("branches the merge base and the head, so base-side drift is not reviewed", () => {
    const root = commitFile("a.ts", "export const a = 1;\n", "root");
    git(repository, ["checkout", "-q", "-b", "topic"]);
    const head = commitFile("b.ts", "export const b = 2;\n", "topic change");
    git(repository, ["checkout", "-q", "dev"]);
    const base = commitFile("a.ts", "export const a = 3;\n", "base drift");

    const refs = preparePullRequest(repository, { number: 42, baseCommit: base, headCommit: head });

    expect(refs).toEqual(pullRequestRefs(42));
    expect(git(repository, ["rev-parse", "keiko-eval/pr-42/base"])).toBe(root);
    expect(git(repository, ["rev-parse", "keiko-eval/pr-42/head"])).toBe(head);
  });

  it("reports a pull request whose commits are unrecorded or unobtainable as unavailable", () => {
    const base = commitFile("a.ts", "x\n", "root");
    expect(preparePullRequest(repository, { number: 7, baseCommit: null, headCommit: base })).toBe(
      undefined,
    );
    // No `origin` exists, so the missing head cannot be fetched.
    const missing = "f".repeat(40);
    expect(hasCommit(repository, missing)).toBe(false);
    expect(
      preparePullRequest(repository, { number: 7, baseCommit: base, headCommit: missing }),
    ).toBeUndefined();
    expect(git(repository, ["branch", "--list", "keiko-eval/*"])).toBe("");
  });
});

describe("prepareOverlay", () => {
  it("commits the seeded file on top of the base without touching the working tree", () => {
    const content = "line one\nline two\n";
    writeFileSync(join(repository, "run.sh"), content);
    chmodSync(join(repository, "run.sh"), 0o755);
    git(repository, ["add", "run.sh"]);
    git(repository, ["commit", "-q", "-m", "root"], { env: IDENTITY });
    const base = git(repository, ["rev-parse", "HEAD"]);

    const refs = prepareOverlay(repository, "seed-a", base, { "run.sh": "line one\nline 2\n" });

    expect(refs).toEqual(seedRefs("seed-a"));
    const head = git(repository, ["rev-parse", refs.headRef]);
    expect(git(repository, ["rev-parse", `${head}^`])).toBe(base);
    expect(git(repository, ["rev-parse", refs.baseRef])).toBe(base);
    expect(fileAt(repository, head, "run.sh")).toBe("line one\nline 2\n");
    expect(git(repository, ["ls-tree", head, "run.sh"]).split(" ")[0]).toBe("100755");
    expect(readFileSync(join(repository, "run.sh"), "utf8")).toBe(content);
    expect(git(repository, ["status", "--porcelain"])).toBe("");
  });
});

describe("fileAt", () => {
  it("returns a file's exact bytes, including a missing final newline, or undefined", () => {
    const commit = commitFile("a.txt", "no newline  ", "root");
    expect(fileAt(repository, commit, "a.txt")).toBe("no newline  ");
    expect(fileAt(repository, commit, "absent.txt")).toBeUndefined();
  });
});
