import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  inspectCurrentCandidate,
  mergeCandidateFailures,
  runCiMergeCandidateCheck,
} from "../check-ci-merge-candidate.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const gitExecutable = resolveHostExecutable("git");

function git(cwd, args) {
  return execFileSync(gitExecutable, args, { cwd, encoding: "utf8" }).trim();
}

describe("CI merge candidate", () => {
  it("accepts the immutable GitHub merge commit for the exact event base and head", () => {
    expect(
      mergeCandidateFailures({
        actualSha: mergeSha,
        baseSha,
        eventName: "pull_request",
        headSha,
        isClean: true,
        parents: [baseSha, headSha],
        ref: "refs/pull/3378/merge",
        runSha: mergeSha,
      }),
    ).toEqual([]);
  });

  it("rejects a moving ref, stale base, wrong head, and non-merge checkout", () => {
    expect(
      mergeCandidateFailures({
        actualSha: "d".repeat(40),
        baseSha,
        eventName: "pull_request",
        headSha,
        isClean: false,
        parents: ["e".repeat(40)],
        ref: "refs/heads/feature",
        runSha: mergeSha,
      }),
    ).toEqual([
      "pull-request ref is not a GitHub merge ref",
      "checked-out revision does not match the immutable workflow revision",
      "candidate worktree differs from the immutable workflow revision",
      "candidate is not a two-parent merge commit",
      "candidate first parent does not match the pull-request base",
      "candidate second parent does not match the pull-request head",
    ]);
  });

  it("rejects empty candidate metadata", () => {
    expect(
      mergeCandidateFailures({
        actualSha: "",
        baseSha: "",
        eventName: "pull_request",
        headSha: "",
        isClean: false,
        parents: [],
        ref: "",
        runSha: "",
      }),
    ).not.toEqual([]);
  });

  it("rejects a candidate with surplus parents", () => {
    expect(
      mergeCandidateFailures({
        actualSha: mergeSha,
        baseSha,
        eventName: "pull_request",
        headSha,
        isClean: true,
        parents: [baseSha, headSha, "d".repeat(40)],
        ref: "refs/pull/3378/merge",
        runSha: mergeSha,
      }),
    ).toEqual(["candidate is not a two-parent merge commit"]);
  });

  it("fails closed before quality work and skips non-pull-request events", () => {
    const log = vi.fn();
    expect(
      runCiMergeCandidateCheck({
        env: { GITHUB_EVENT_NAME: "push" },
        inspect: vi.fn(),
        log,
      }),
    ).toEqual([]);
    expect(log).toHaveBeenCalledWith("ci-merge-candidate: PASS - not a pull-request event.");

    expect(() =>
      runCiMergeCandidateCheck({
        env: {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/3378/merge",
          GITHUB_SHA: mergeSha,
          KEIKO_CANDIDATE_BASE_SHA: baseSha,
          KEIKO_CANDIDATE_HEAD_SHA: headSha,
        },
        inspect: () => ({ actualSha: headSha, isClean: true, parents: [baseSha, headSha] }),
        log,
      }),
    ).toThrow("checked-out revision does not match the immutable workflow revision");
  });

  it("executes Git only through the trusted host-executable resolver", () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(`${mergeSha}\n`)
      .mockReturnValueOnce(
        `tree ${"d".repeat(40)}\nparent ${baseSha}\nparent ${headSha}\n\nmerge\n`,
      )
      .mockReturnValueOnce("\n");
    const resolveExecutable = vi.fn(() => "/usr/bin/git");

    expect(inspectCurrentCandidate({ execute, resolveExecutable })).toEqual({
      actualSha: mergeSha,
      isClean: true,
      parents: [baseSha, headSha],
    });
    expect(resolveExecutable).toHaveBeenCalledWith("git");
    expect(execute).toHaveBeenNthCalledWith(1, "/usr/bin/git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    expect(execute).toHaveBeenNthCalledWith(2, "/usr/bin/git", ["cat-file", "commit", "HEAD"], {
      encoding: "utf8",
    });
    expect(execute).toHaveBeenNthCalledWith(
      3,
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" },
    );
  });

  it("detects a changed candidate tree even while HEAD still names the workflow revision", () => {
    const repository = mkdtempSync(join(tmpdir(), "keiko-ci-candidate-dirty-"));
    try {
      git(repository, ["init", "--initial-branch=main"]);
      git(repository, ["config", "user.email", "ci@example.invalid"]);
      git(repository, ["config", "user.name", "CI"]);
      writeFileSync(join(repository, "tracked.txt"), "original\n", "utf8");
      git(repository, ["add", "tracked.txt"]);
      git(repository, ["commit", "-m", "candidate"]);
      const candidateSha = git(repository, ["rev-parse", "HEAD"]);
      writeFileSync(join(repository, "tracked.txt"), "mutated\n", "utf8");

      expect(inspectCurrentCandidate({ cwd: repository })).toMatchObject({
        actualSha: candidateSha,
        isClean: false,
      });
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("reads raw merge parents when Git marks the checked-out commit as shallow", () => {
    const repository = mkdtempSync(join(tmpdir(), "keiko-ci-candidate-"));
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.email", "ci@example.invalid"]);
    git(repository, ["config", "user.name", "CI"]);
    git(repository, ["commit", "--allow-empty", "-m", "base"]);
    const actualBase = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["checkout", "--quiet", "-b", "feature"]);
    git(repository, ["commit", "--allow-empty", "-m", "head"]);
    const actualHead = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["checkout", "--quiet", "main"]);
    git(repository, ["merge", "--no-ff", "feature", "-m", "merge"]);
    const actualMerge = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(join(repository, ".git", "shallow"), `${actualMerge}\n`);

    expect(git(repository, ["show", "-s", "--format=%P", "HEAD"])).toBe("");
    expect(inspectCurrentCandidate({ cwd: repository })).toEqual({
      actualSha: actualMerge,
      isClean: true,
      parents: [actualBase, actualHead],
    });
  });

  it("does not accept parent-shaped lines from a one-parent commit message", () => {
    const repository = mkdtempSync(join(tmpdir(), "keiko-ci-candidate-message-"));
    try {
      git(repository, ["init", "--initial-branch=main"]);
      git(repository, ["config", "user.email", "ci@example.invalid"]);
      git(repository, ["config", "user.name", "CI"]);
      git(repository, ["commit", "--allow-empty", "-m", "base"]);
      const actualBase = git(repository, ["rev-parse", "HEAD"]);
      git(repository, [
        "commit",
        "--allow-empty",
        "-m",
        "ordinary child",
        "-m",
        `parent ${baseSha}\nparent ${headSha}`,
      ]);
      const actualHead = git(repository, ["rev-parse", "HEAD"]);
      const inspected = inspectCurrentCandidate({ cwd: repository });

      expect(inspected).toEqual({ actualSha: actualHead, isClean: true, parents: [actualBase] });
      expect(
        mergeCandidateFailures({
          ...inspected,
          baseSha: actualBase,
          eventName: "pull_request",
          headSha,
          ref: "refs/pull/3378/merge",
          runSha: actualHead,
        }),
      ).toEqual([
        "candidate is not a two-parent merge commit",
        "candidate second parent does not match the pull-request head",
      ]);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });
});
