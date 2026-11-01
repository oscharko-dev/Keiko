import { describe, expect, it } from "vitest";

import { ReviewEval } from "@oscharko-dev/keiko-evaluations";

import { developmentSample, holdoutPullRequests } from "./selection.js";

type Thread = ReviewEval.ReviewHarvestThread;
type PullRequest = ReviewEval.ReviewHarvestPullRequest;

const BOUNDARY = ReviewEval.REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest;
const SHA = "a".repeat(40);

function thread(regionChange: Thread["regionChange"], refuted = false): Thread {
  return {
    id: `thread-${regionChange}-${String(refuted)}`,
    producer: "coderabbit",
    path: "src/a.ts",
    startLine: 1,
    endLine: 2,
    fileLevel: false,
    side: "right",
    reviewedCommit: SHA,
    resolved: true,
    outdated: false,
    reply: refuted ? { classification: "refuted", producer: "human" } : null,
    regionChange,
    bodyDigest: `sha256:${"0".repeat(64)}`,
  };
}

function pullRequest(number: number, threads: readonly Thread[], commits = true): PullRequest {
  return {
    number,
    state: "merged",
    headCommit: commits ? SHA : null,
    baseCommit: commits ? SHA : null,
    reviewedBy: ["coderabbit"],
    threads,
  };
}

describe("developmentSample", () => {
  it("takes the most recent development pull requests with a decided thread, ascending", () => {
    const dataset = {
      pullRequests: [
        pullRequest(10, [thread("changed")]),
        pullRequest(20, [thread("unchanged", true)]),
        pullRequest(30, [thread("unchanged")]),
        pullRequest(40, [thread("unavailable", true)]),
        pullRequest(50, [thread("changed")], false),
        pullRequest(60, [thread("no-later-commit", true)]),
        pullRequest(BOUNDARY, [thread("changed")]),
      ],
    };
    // 30 is undecided, 40 unmeasured, 50 has no commits and the boundary pull request is holdout.
    expect(developmentSample(dataset, 2)).toEqual([20, 60]);
    expect(developmentSample(dataset, 10)).toEqual([10, 20, 60]);
  });
});

describe("holdoutPullRequests", () => {
  it("lists every holdout pull request with a thread, from the manifest boundary on", () => {
    const dataset = {
      pullRequests: [
        pullRequest(BOUNDARY + 2, [thread("unchanged")]),
        pullRequest(BOUNDARY - 1, [thread("changed")]),
        pullRequest(BOUNDARY, [thread("changed")]),
        pullRequest(BOUNDARY + 1, []),
      ],
    };
    expect(holdoutPullRequests(dataset)).toEqual([BOUNDARY, BOUNDARY + 2]);
  });
});
