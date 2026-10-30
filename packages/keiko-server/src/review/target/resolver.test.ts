// The review target resolver against real `git` and a fixture-owned loopback HTTP remote
// (Issue #4133): AC2 (the user's branches, HEAD, index, working tree, stash and FETCH_HEAD are
// byte-identical across resolution, worktree creation and cleanup; the private refs are the only
// transient change and the retention sweep removes them), AC3 (a fetched head that differs from the
// reported head refuses `target-changed` and leaves no ref and no worktree), fork pull requests on
// the same path, the closed refusal reasons, and local ranges.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewPullRequestDetail } from "@oscharko-dev/keiko-contracts";
import type {
  GitReviewPrDetailOutcome,
  GitReviewPullRequestReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import { createReviewServices, type ReviewServices } from "../services.js";
import {
  commitFile,
  commitTree,
  createFixtureRoot,
  rawTree,
  writeRawObject,
  git,
  gitAsync,
  initRepository,
  repositoryStateDigest,
  startLoopbackGitRemote,
  type LoopbackGitRemote,
  type ReviewFixtureRoot,
} from "../reviewFixtures.test-support.js";

let fixture: ReviewFixtureRoot;
let remote: LoopbackGitRemote;
let repo: string;
let author: string;
let bare: string;
let log: ActivityLogCapture;
let baseSha: string;
let headSha: string;

function detail(overrides: Partial<ReviewPullRequestDetail> = {}): ReviewPullRequestDetail {
  return {
    number: 7,
    title: "feat: fork change",
    authorLogin: "forker",
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    baseRef: "main",
    baseSha,
    headRef: "feature",
    headSha,
    headRepository: "forker/repo",
    isCrossRepository: true,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "none",
    mergeable: "mergeable",
    checkState: "none",
    checkCounts: { passing: 0, failing: 0, pending: 0 },
    approvalCount: 0,
    ...overrides,
  };
}

function reviewServicesAt(
  stateName: string,
  outcome: () => GitReviewPrDetailOutcome,
): ReviewServices {
  const reader: GitReviewPullRequestReader = {
    listOpenPullRequests: () => Promise.resolve({ availability: "failed", pages: 1 }),
    readPullRequest: () => Promise.resolve(outcome()),
  };
  return createReviewServices({
    reviewRoot: join(fixture.root, stateName, "review-worktrees"),
    activityLog: log.sink,
    github: { ownerAndRepo: () => Promise.resolve("o/r"), readerFor: () => reader },
  });
}

function reviewServices(
  outcome: () => GitReviewPrDetailOutcome,
  ownerAndRepo: string | null = "o/r",
): ReviewServices {
  const reader: GitReviewPullRequestReader = {
    listOpenPullRequests: () =>
      Promise.resolve({
        availability: "available",
        pullRequests: [],
        truncated: false,
        pages: 1,
        rejectedCount: 0,
      }),
    readPullRequest: () => Promise.resolve(outcome()),
  };
  return createReviewServices({
    reviewRoot: join(fixture.root, "state", "review-worktrees"),
    activityLog: log.sink,
    github: {
      ownerAndRepo: () => Promise.resolve(ownerAndRepo ?? undefined),
      readerFor: () => reader,
    },
  });
}

function privateRefs(): readonly string[] {
  const listed = git(repo, "for-each-ref", "--format=%(refname)", "refs/keiko-review/");
  return listed.length === 0 ? [] : listed.split("\n");
}

beforeEach(async () => {
  fixture = createFixtureRoot("keiko-review-target-");
  log = captureActivityLog();
  author = join(fixture.root, "author");
  repo = join(fixture.root, "user");
  bare = join(fixture.root, "remotes", "repo.git");
  initRepository(author);
  baseSha = commitFile(author, "README.md", "base\n", "base");
  mkdirSync(join(fixture.root, "remotes"));
  git(fixture.root, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(author, "push", "-q", bare, "main");
  git(author, "checkout", "-q", "-b", "feature");
  headSha = commitFile(author, "change.txt", "fork change\n", "fork change");
  git(author, "push", "-q", bare, `${headSha}:refs/pull/7/head`);
  remote = await startLoopbackGitRemote(join(fixture.root, "remotes"));
  await gitAsync(fixture.root, "clone", "-q", `${remote.url}/repo.git`, repo);
  git(repo, "config", "user.email", "user@example.invalid");
  git(repo, "config", "user.name", "User");
  git(repo, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
  await remote.close();
  fixture.cleanup();
});

async function dirtyUserState(): Promise<void> {
  writeFileSync(join(repo, "README.md"), "stashed\n");
  git(repo, "stash", "push", "-m", "fixture");
  writeFileSync(join(repo, "README.md"), "unstaged edit\n");
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  await gitAsync(repo, "fetch", "-q", "origin", "main");
}

describe("pull request targets", () => {
  it("leaves every piece of user state byte-identical across resolution, worktree and cleanup (AC2)", async () => {
    await dirtyUserState();
    const before = repositoryStateDigest(repo);
    const review = reviewServices(() => ({ availability: "available", pullRequest: detail() }));
    const resolution = await review.resolveTarget({
      repositoryRoot: repo,
      runId: "run-ac2",
      request: { kind: "pull-request", number: 7 },
    });
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.target).toMatchObject({
      kind: "pull-request",
      number: 7,
      baseSha,
      headSha,
      isCrossRepository: true,
    });
    expect(privateRefs()).toEqual([`refs/keiko-review/${review.namespace}/7/${headSha}`]);
    const created = await review.worktrees.create({
      runId: "run-ac2",
      repositoryRoot: repo,
      headSha,
    });
    if (!created.ok) throw new Error(created.reason);
    expect(git(created.worktree.path, "rev-parse", "HEAD")).toBe(headSha);
    expect(await review.worktrees.remove("run-ac2", "settled")).toBe(true);
    expect(repositoryStateDigest(repo)).toEqual(before);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
    const swept = await review.sweepRefs("daily");
    expect(swept).toEqual({ deleted: 1, retained: 0, failed: 0 });
    expect(privateRefs()).toEqual([]);
    expect(repositoryStateDigest(repo)).toEqual(before);
    await review.dispose();
  });

  it("refuses a head that moved between the read and the fetch and leaves no ref or worktree (AC3)", async () => {
    const moved = commitFile(author, "change.txt", "moved\n", "moved");
    git(author, "push", "-q", "-f", bare, `${moved}:refs/pull/7/head`);
    const review = reviewServices(() => ({ availability: "available", pullRequest: detail() }));
    expect(
      await review.resolveTarget({
        repositoryRoot: repo,
        runId: "run-ac3",
        request: { kind: "pull-request", number: 7 },
      }),
    ).toEqual({ ok: false, reason: "target-changed" });
    expect(privateRefs()).toEqual([]);
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
    // Nothing was written below the state directory: the review root is created on first use.
    expect(existsSync(review.reviewRoot)).toBe(false);
    expect(log.withOp("review.target.refused").map((line) => line.extra?.reason)).toEqual([
      "target-changed",
    ]);
  });

  it("fetches a base commit that is not local into its own private ref", async () => {
    git(author, "checkout", "-q", "main");
    const advancedBase = commitFile(author, "base.txt", "advanced\n", "advance base");
    git(author, "push", "-q", bare, "main");
    const review = reviewServices(() => ({
      availability: "available",
      pullRequest: detail({ baseSha: advancedBase }),
    }));
    const resolution = await review.resolveTarget({
      repositoryRoot: repo,
      runId: "run-base",
      request: { kind: "pull-request", number: 7 },
    });
    expect(resolution.ok).toBe(true);
    expect(privateRefs()).toEqual(
      [
        `refs/keiko-review/${review.namespace}/7/${headSha}`,
        `refs/keiko-review/${review.namespace}/7/base-${advancedBase}`,
      ].sort(),
    );
    const [line] = log.withOp("review.target.resolved");
    expect(line?.extra).toMatchObject({
      targetKind: "pull-request",
      baseFetched: true,
      isCrossRepository: true,
    });
    expect(JSON.stringify(line)).not.toContain(headSha);
    expect(JSON.stringify(log.events)).not.toContain(repo);
  });

  it("refuses a pull request whose head carries a malformed tree: fsck rejects it at fetch", async () => {
    const small = writeRawObject(author, "blob", Buffer.from("small\n"));
    const large = writeRawObject(author, "blob", Buffer.alloc(4096, 0x63));
    const malformed = commitTree(
      author,
      rawTree(author, [
        ["100644", "x", small],
        ["100644", "x", large],
      ]),
      headSha,
    );
    git(author, "push", "-q", bare, `${malformed}:refs/pull/9/head`);
    const review = reviewServices(() => ({
      availability: "available",
      pullRequest: detail({ number: 9, headSha: malformed }),
    }));
    expect(
      await review.resolveTarget({
        repositoryRoot: repo,
        runId: "fsck",
        request: { kind: "pull-request", number: 9 },
      }),
    ).toEqual({ ok: false, reason: "fetch-failed" });
    expect(privateRefs()).toEqual([]);
    // The malformed objects never entered the user's object store.
    expect(() => git(repo, "cat-file", "-e", malformed)).toThrow();
  });

  it("maps provider and transport failures onto the closed refusal reasons", async () => {
    const cases: readonly [GitReviewPrDetailOutcome, string][] = [
      [{ availability: "gh-unauthenticated" }, "gh-unauthenticated"],
      [{ availability: "gh-unavailable" }, "gh-unavailable"],
      [{ availability: "rate-limited" }, "rate-limited"],
      [{ availability: "failed" }, "fetch-failed"],
      [{ availability: "available", pullRequest: null }, "not-found"],
    ];
    for (const [outcome, reason] of cases) {
      const review = reviewServices(() => outcome);
      expect(
        await review.resolveTarget({
          repositoryRoot: repo,
          runId: "r",
          request: { kind: "pull-request", number: 7 },
        }),
      ).toEqual({
        ok: false,
        reason,
      });
    }
    const noRemote = reviewServices(
      () => ({ availability: "available", pullRequest: detail() }),
      null,
    );
    expect(
      await noRemote.resolveTarget({
        repositoryRoot: repo,
        runId: "r",
        request: { kind: "pull-request", number: 7 },
      }),
    ).toEqual({
      ok: false,
      reason: "no-github-remote",
    });
    const invalid = reviewServices(() => ({ availability: "available", pullRequest: detail() }));
    expect(
      await invalid.resolveTarget({
        repositoryRoot: repo,
        runId: "r",
        request: { kind: "pull-request", number: 0 },
      }),
    ).toEqual({
      ok: false,
      reason: "not-found",
    });
    await remote.close();
    const unreachable = reviewServices(() => ({
      availability: "available",
      pullRequest: detail(),
    }));
    expect(
      await unreachable.resolveTarget({
        repositoryRoot: repo,
        runId: "r",
        request: { kind: "pull-request", number: 7 },
      }),
    ).toEqual({
      ok: false,
      reason: "fetch-failed",
    });
    remote = await startLoopbackGitRemote(join(fixture.root, "remotes"));
    expect(privateRefs()).toEqual([]);
  });
});

describe("private ref namespaces", () => {
  it("never sweeps the live refs of another installation reviewing the same repository", async () => {
    const other = reviewServicesAt("other-state", () => ({
      availability: "available",
      pullRequest: detail(),
    }));
    const mine = reviewServicesAt("my-state", () => ({
      availability: "available",
      pullRequest: detail(),
    }));
    expect(other.namespace).not.toBe(mine.namespace);
    const theirs = await other.resolveTarget({
      repositoryRoot: repo,
      runId: "theirs",
      request: { kind: "pull-request", number: 7 },
    });
    const ours = await mine.resolveTarget({
      repositoryRoot: repo,
      runId: "ours",
      request: { kind: "local-range", baseRef: "main", headRef: "main" },
    });
    if (!theirs.ok || !ours.ok) throw new Error("expected both targets");
    // Our resolution is not pinned by a worktree in this instance's memory after a restart.
    const restarted = reviewServicesAt("my-state", () => ({ availability: "failed" }));
    expect(await restarted.sweepRefs("daily")).toEqual({ deleted: 1, retained: 0, failed: 0 });
    expect(privateRefs()).toEqual([...theirs.privateRefs]);
    await other.dispose();
  });
});

describe("local range targets", () => {
  it("resolves both refs to full SHAs and retains the head under a run-scoped private ref", async () => {
    git(repo, "checkout", "-q", "-b", "topic");
    const topic = commitFile(repo, "topic.txt", "topic\n", "topic");
    git(repo, "checkout", "-q", "main");
    const before = repositoryStateDigest(repo);
    const review = reviewServices(() => ({ availability: "failed" }));
    const resolution = await review.resolveTarget({
      repositoryRoot: repo,
      runId: "run:local-1",
      request: { kind: "local-range", baseRef: "main", headRef: "topic" },
    });
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.target).toMatchObject({
      kind: "local-range",
      baseSha,
      headSha: topic,
      baseRef: "main",
      headRef: "topic",
    });
    expect(resolution.privateRefs).toHaveLength(1);
    expect(resolution.privateRefs[0]).toMatch(
      /^refs\/keiko-review\/k[a-f0-9]{16}\/local\/r-[a-f0-9]{24}$/u,
    );
    expect(repositoryStateDigest(repo)).toEqual(before);
  });

  it("refuses option-shaped, qualified, malformed and missing refs", async () => {
    const review = reviewServices(() => ({ availability: "failed" }));
    for (const [baseRef, headRef] of [
      ["main", "-x"],
      ["refs/heads/main", "main"],
      ["main", "a..b"],
      ["main", "missing-branch"],
      ["main", "HEAD@{1}"],
    ] as const) {
      expect(
        await review.resolveTarget({
          repositoryRoot: repo,
          runId: "r",
          request: { kind: "local-range", baseRef, headRef },
        }),
      ).toEqual({ ok: false, reason: "ref-invalid" });
    }
    expect(privateRefs()).toEqual([]);
  });
});
