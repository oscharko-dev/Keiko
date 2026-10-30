// Pull request list and detail service and routes (Issue #4133, AC6): closed availability states,
// a missing GitHub remote, the 30-second per-repository cache, body-free Activity Log lines, the
// `root`-addressed routes and their refusal of malformed pull request numbers.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewPullRequestSummary } from "@oscharko-dev/keiko-contracts";
import type {
  GitReviewPrListOutcome,
  GitReviewPullRequestReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "../../index.js";
import type { RouteContext } from "../../routes.js";
import type { UiStore } from "../../store/index.js";
import type { ReviewServices } from "../services.js";
import {
  createReviewPullRequestReads,
  REVIEW_PULL_REQUEST_CACHE_TTL_MS,
  type ReviewPullRequestReads,
} from "./pullRequestReads.js";
import { handleReviewPullRequestDetail, handleReviewPullRequestList } from "./routes.js";
import { git, initRepository } from "../reviewFixtures.test-support.js";

const SUMMARY: ReviewPullRequestSummary = {
  number: 3,
  title: "fix: something",
  authorLogin: "dev",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  baseRef: "main",
  baseSha: "a".repeat(40),
  headRef: "topic",
  headSha: "b".repeat(40),
  headRepository: "o/r",
  isCrossRepository: false,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: "none",
  mergeable: "unknown",
  checkState: "none",
};

let log: ActivityLogCapture;
let nowMs: number;
let listCalls: number;

function reader(outcome: GitReviewPrListOutcome): GitReviewPullRequestReader {
  return {
    listOpenPullRequests: (): Promise<GitReviewPrListOutcome> => {
      listCalls += 1;
      return Promise.resolve(outcome);
    },
    readPullRequest: (_ownerAndRepo, number) =>
      Promise.resolve(
        number === SUMMARY.number
          ? {
              availability: "available",
              pullRequest: {
                ...SUMMARY,
                checkCounts: { passing: 1, failing: 0, pending: 0 },
                approvalCount: 1,
              },
            }
          : { availability: "available", pullRequest: null },
      ),
  };
}

function reads(
  outcome: GitReviewPrListOutcome,
  ownerAndRepo: string | null = "o/r",
): ReviewPullRequestReads {
  return createReviewPullRequestReads({
    github: {
      ownerAndRepo: () => Promise.resolve(ownerAndRepo ?? undefined),
      readerFor: () => reader(outcome),
    },
    activityLog: log.sink,
    now: () => nowMs,
  });
}

const AVAILABLE: GitReviewPrListOutcome = {
  availability: "available",
  pullRequests: [SUMMARY],
  truncated: false,
  pages: 1,
  rejectedCount: 0,
};

beforeEach(() => {
  log = captureActivityLog();
  nowMs = 1_000;
  listCalls = 0;
});

describe("pull request reads", () => {
  it("caches the list per repository for 30 seconds and logs cache hits", async () => {
    const service = reads(AVAILABLE);
    expect((await service.list("/repo")).pullRequests).toEqual([SUMMARY]);
    await service.list("/repo");
    expect(listCalls).toBe(1);
    nowMs += REVIEW_PULL_REQUEST_CACHE_TTL_MS + 1;
    await service.list("/repo");
    expect(listCalls).toBe(2);
    expect(log.withOp("review.target.listed").map((line) => line.extra?.cacheHit)).toEqual([
      false,
      true,
      false,
    ]);
    expect(JSON.stringify(log.events)).not.toContain("fix: something");
  });

  it("reports a repository without a GitHub remote and each provider availability state", async () => {
    expect(await reads(AVAILABLE, null).list("/repo")).toMatchObject({
      availability: "no-github-remote",
      pullRequests: [],
    });
    for (const availability of [
      "gh-unavailable",
      "gh-unauthenticated",
      "rate-limited",
      "failed",
    ] as const) {
      expect(await reads({ availability, pages: 1 }).list("/repo")).toMatchObject({
        availability,
        truncated: false,
      });
    }
    const truncated = await reads({ ...AVAILABLE, truncated: true, pages: 20 }).list("/repo");
    expect(truncated.truncated).toBe(true);
    expect(
      await reads({ ...AVAILABLE, truncated: true, pages: 20 }).openNumbers("/repo"),
    ).toBeUndefined();
    expect(await reads(AVAILABLE).openNumbers("/repo")).toEqual(new Set([3]));
  });

  it("reads one pull request's detail and a missing number", async () => {
    const service = reads(AVAILABLE);
    expect((await service.detail("/repo", 3)).pullRequest?.approvalCount).toBe(1);
    expect(await service.detail("/repo", 4)).toMatchObject({
      availability: "available",
      pullRequest: null,
    });
  });
});

describe("pull request routes", () => {
  let root: string;
  let store: UiStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "keiko-review-routes-")));
    initRepository(root);
    git(root, "commit", "-q", "--allow-empty", "-m", "base");
    store = createInMemoryUiStore();
    store.createProject(root, "fixture");
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  function deps(reviewServices: ReviewServices | undefined): UiHandlerDeps {
    return {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store,
      ...(reviewServices === undefined ? {} : { reviewServices }),
    };
  }

  function ctx(path: string, params: Record<string, string> = {}): RouteContext {
    return {
      correlationId: "corr-review",
      req: Readable.from([]) as unknown as IncomingMessage,
      res: {} as unknown as ServerResponse,
      params,
      url: new URL(`http://localhost${path}`),
    };
  }

  function services(): ReviewServices {
    return { pullRequests: reads(AVAILABLE) } as unknown as ReviewServices;
  }

  it("lists and reads pull requests for a registered repository root", async () => {
    const query = `?root=${encodeURIComponent(root)}`;
    const list = await handleReviewPullRequestList(
      ctx(`/api/git-review/pull-requests${query}`),
      deps(services()),
    );
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ availability: "available", pullRequests: [{ number: 3 }] });
    const detail = await handleReviewPullRequestDetail(
      ctx(`/api/git-review/pull-requests/3${query}`, { number: "3" }),
      deps(services()),
    );
    expect(detail.body).toMatchObject({ availability: "available", pullRequest: { number: 3 } });
  });

  it("refuses malformed numbers, reports an unavailable repository and an uncomposed service", async () => {
    const query = `?root=${encodeURIComponent(root)}`;
    for (const number of ["0", "-1", "1e3", "03", "x", "99999999999"]) {
      const result = await handleReviewPullRequestDetail(
        ctx(`/api/git-review/pull-requests/${number}${query}`, { number }),
        deps(services()),
      );
      expect(result.status).toBe(400);
    }
    const missing = await handleReviewPullRequestList(
      ctx(`/api/git-review/pull-requests${query}`),
      deps(undefined),
    );
    expect(missing.status).toBe(503);
    const plain = await realpath(await mkdtemp(join(tmpdir(), "keiko-review-plain-")));
    store.createProject(plain, "plain");
    const notRepo = await handleReviewPullRequestList(
      ctx(`/api/git-review/pull-requests?root=${encodeURIComponent(plain)}`),
      deps(services()),
    );
    expect(notRepo.body).toMatchObject({ availability: "failed", pullRequests: [] });
    await rm(plain, { recursive: true, force: true });
  });
});
