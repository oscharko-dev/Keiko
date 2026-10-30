// Fake `gh` boundary for the read-only pull request list and detail (Issue #4133, AC6):
// pagination, the 20-page bound with its truncation flag, rate limiting, a missing and an
// unauthenticated `gh`, a missing pull request, and the refusal of every argument vector that is
// not one of the two fixed reads before any spawn.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeFakeChild, makeWorkspace } from "./_support.js";
import { CommandDeniedError } from "./errors.js";
import type { HomeProvider, SpawnFn } from "./exec.js";
import {
  createNodeGitReviewPullRequestReader,
  type GitReviewPullRequestReader,
} from "./git-pr-review-read-node.js";
import { isGitReviewPullRequestReadArgv } from "./git-pr-review-read.js";

const FAKE_HOME: HomeProvider = { make: () => "/tmp/keiko-fake-home", cleanup: () => undefined };

interface Step {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
}

function scripted(next: (index: number) => Step): {
  readonly spawn: SpawnFn;
  readonly calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const spawn: SpawnFn = (_command, args, _options: SpawnOptions): ChildProcess => {
    const step = next(calls.length);
    calls.push([...args]);
    const child = makeFakeChild();
    setImmediate(() => {
      if (step.stdout !== undefined) child.stdout.emit("data", Buffer.from(step.stdout));
      if (step.stderr !== undefined) child.stderr.emit("data", Buffer.from(step.stderr));
      child.emit("close", step.exit ?? 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

function node(number: number): Record<string, unknown> {
  return {
    number,
    title: `PR ${String(number)}`,
    isDraft: false,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    author: { login: "dev" },
    baseRefName: "dev",
    baseRefOid: "a".repeat(40),
    headRefName: `topic-${String(number)}`,
    headRefOid: "b".repeat(40),
    headRepository: { nameWithOwner: "o/r" },
    isCrossRepository: false,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    mergeable: "UNKNOWN",
    commits: { nodes: [] },
  };
}

function page(numbers: readonly number[], next: string | null): Step {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: next !== null, endCursor: next },
            nodes: numbers.map(node),
          },
        },
      },
    }),
  };
}

function reader(
  spawn: SpawnFn,
  resolveExecutable: (command: string) => string = () => "gh",
): GitReviewPullRequestReader {
  return createNodeGitReviewPullRequestReader({
    workspace: makeWorkspace().info,
    processEnv: { PATH: "/usr/bin" },
    now: () => 0,
    spawn,
    home: FAKE_HOME,
    resolveExecutable,
  });
}

describe("open pull request list", () => {
  it("follows the cursor across pages and passes only fixed reads to gh", async () => {
    const fake = scripted((index) => (index === 0 ? page([1, 2], "c1") : page([3], null)));
    const outcome = await reader(fake.spawn).listOpenPullRequests("o/r");
    expect(outcome).toMatchObject({ availability: "available", truncated: false, pages: 2 });
    expect(
      outcome.availability === "available" && outcome.pullRequests.map((pr) => pr.number),
    ).toEqual([1, 2, 3]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.slice(-2)).toEqual(["-f", "cursor=c1"]);
    for (const call of fake.calls) expect(isGitReviewPullRequestReadArgv(call)).toBe(true);
  });

  it("stops at 20 pages and reports truncation explicitly", async () => {
    const fake = scripted((index) => page([index + 1], `c${String(index + 1)}`));
    const outcome = await reader(fake.spawn).listOpenPullRequests("o/r");
    expect(fake.calls).toHaveLength(20);
    expect(outcome).toMatchObject({ availability: "available", truncated: true, pages: 20 });
  });

  it("maps rate limiting, missing authentication and a missing gh to closed availability states", async () => {
    const rateLimited = scripted(() => ({
      exit: 1,
      stderr: "gh: API rate limit exceeded (HTTP 403)",
    }));
    expect(await reader(rateLimited.spawn).listOpenPullRequests("o/r")).toMatchObject({
      availability: "rate-limited",
    });
    const graphqlLimited = scripted(() => ({
      exit: 1,
      stdout: '{"errors":[{"type":"RATE_LIMITED"}]}',
    }));
    expect(await reader(graphqlLimited.spawn).listOpenPullRequests("o/r")).toMatchObject({
      availability: "rate-limited",
    });
    const unauthenticated = scripted(() => ({
      exit: 4,
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
    }));
    expect(await reader(unauthenticated.spawn).listOpenPullRequests("o/r")).toMatchObject({
      availability: "gh-unauthenticated",
    });
    const missing = scripted(() => ({}));
    const outcome = await reader(missing.spawn, () => {
      throw new CommandDeniedError("executable not found on PATH: gh", "gh");
    }).listOpenPullRequests("o/r");
    expect(outcome).toMatchObject({ availability: "gh-unavailable" });
    expect(missing.calls).toHaveLength(0);
    const malformed = scripted(() => ({ stdout: "{not json" }));
    expect(await reader(malformed.spawn).listOpenPullRequests("o/r")).toMatchObject({
      availability: "failed",
    });
  });

  it("refuses an invalid repository identity before any spawn", async () => {
    const fake = scripted(() => page([], null));
    expect(await reader(fake.spawn).listOpenPullRequests("o/r --jq .")).toMatchObject({
      availability: "failed",
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("pull request detail", () => {
  it("returns the detail, a not-found answer and refuses a mismatched number", async () => {
    const detail = { data: { repository: { pullRequest: node(9) } } };
    const ok = scripted(() => ({ stdout: JSON.stringify(detail) }));
    const outcome = await reader(ok.spawn).readPullRequest("o/r", 9);
    expect(outcome.availability === "available" && outcome.pullRequest?.headSha).toBe(
      "b".repeat(40),
    );
    expect(ok.calls[0]?.slice(-2)).toEqual(["-F", "number=9"]);
    expect(await reader(ok.spawn).readPullRequest("o/r", 10)).toEqual({ availability: "failed" });
    const notFound = scripted(() => ({
      exit: 1,
      stdout:
        '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a PullRequest with the number of 99."}]}',
    }));
    expect(await reader(notFound.spawn).readPullRequest("o/r", 99)).toEqual({
      availability: "available",
      pullRequest: null,
    });
    const invalid = scripted(() => ({}));
    expect(await reader(invalid.spawn).readPullRequest("o/r", 0)).toEqual({
      availability: "failed",
    });
    expect(invalid.calls).toHaveLength(0);
  });
});
