// The read-only pull request list and detail of the Pull requests area (ADR-0182, Issue #4133).
//
// The repository must carry a GitHub `origin` (the same verified owner/repo every governed GitHub
// read binds to); the reads go through the two fixed GraphQL documents of keiko-tools. Answers are
// cached per repository for 30 seconds so the Git window can refresh freely without spending the
// user's GitHub rate limit. Pull request text is untrusted display data; the body is never read.

import type {
  ReviewPullRequestDetailResponse,
  ReviewPullRequestListResponse,
} from "@oscharko-dev/keiko-contracts";
import { REVIEW_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type {
  GitReviewPrDetailOutcome,
  GitReviewPrListOutcome,
  GitReviewPullRequestReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { ServerLogSink } from "../../observability/index.js";
import { logReviewTargetListed } from "../activity-log.js";
import { reportReviewFailure } from "../diagnostics.js";

export const REVIEW_PULL_REQUEST_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;

export interface ReviewGitHubRepositoryPort {
  /** The verified `owner/repo` of the repository's GitHub `origin`, or `undefined` when none. */
  readonly ownerAndRepo: (repositoryRoot: string) => Promise<string | undefined>;
  readonly readerFor: (
    repositoryRoot: string,
    correlationId?: string,
  ) => GitReviewPullRequestReader;
}

export interface ReviewPullRequestReadsDeps {
  readonly github: ReviewGitHubRepositoryPort;
  readonly activityLog: ServerLogSink;
  readonly now: () => number;
}

export interface ReviewPullRequestReads {
  list(repositoryRoot: string, correlationId?: string): Promise<ReviewPullRequestListResponse>;
  detail(
    repositoryRoot: string,
    number: number,
    correlationId?: string,
  ): Promise<ReviewPullRequestDetailResponse>;
  /** The open pull request numbers when the list is complete; `undefined` when it is not known. */
  openNumbers(
    repositoryRoot: string,
    correlationId?: string,
  ): Promise<ReadonlySet<number> | undefined>;
}

interface CacheEntry<T> {
  readonly expiresAtMs: number;
  readonly value: T;
}

class BoundedCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  public get(key: string, nowMs: number): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs > nowMs) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  public set(key: string, value: T, nowMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAtMs: nowMs + REVIEW_PULL_REQUEST_CACHE_TTL_MS, value });
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function listResponse(
  outcome: GitReviewPrListOutcome | "no-github-remote" | "failed",
): ReviewPullRequestListResponse {
  if (typeof outcome === "string") {
    return {
      schemaVersion: REVIEW_CONTRACT_VERSION,
      availability: outcome,
      pullRequests: [],
      truncated: false,
    };
  }
  if (outcome.availability !== "available") {
    return {
      schemaVersion: REVIEW_CONTRACT_VERSION,
      availability: outcome.availability,
      pullRequests: [],
      truncated: false,
    };
  }
  return {
    schemaVersion: REVIEW_CONTRACT_VERSION,
    availability: "available",
    pullRequests: outcome.pullRequests,
    truncated: outcome.truncated,
  };
}

function detailResponse(
  outcome: GitReviewPrDetailOutcome | "no-github-remote" | "failed",
): ReviewPullRequestDetailResponse {
  if (typeof outcome === "string" || outcome.availability !== "available") {
    const availability = typeof outcome === "string" ? outcome : outcome.availability;
    return { schemaVersion: REVIEW_CONTRACT_VERSION, availability, pullRequest: null };
  }
  return {
    schemaVersion: REVIEW_CONTRACT_VERSION,
    availability: "available",
    pullRequest: outcome.pullRequest,
  };
}

type RepositoryIdentity =
  | { readonly ok: true; readonly ownerAndRepo: string }
  | { readonly ok: false; readonly availability: "no-github-remote" | "failed" };

async function repositoryIdentity(
  github: ReviewGitHubRepositoryPort,
  repositoryRoot: string,
  correlationId: string | undefined,
): Promise<RepositoryIdentity> {
  try {
    const ownerAndRepo = await github.ownerAndRepo(repositoryRoot);
    return ownerAndRepo === undefined
      ? { ok: false, availability: "no-github-remote" }
      : { ok: true, ownerAndRepo };
  } catch (error) {
    reportReviewFailure("review.target.github-identity", correlationId, error);
    return { ok: false, availability: "failed" };
  }
}

interface ListRead {
  readonly response: ReviewPullRequestListResponse;
  readonly pages?: number | undefined;
  readonly rejectedCount?: number | undefined;
}

async function readList(
  deps: ReviewPullRequestReadsDeps,
  repositoryRoot: string,
  correlationId: string | undefined,
): Promise<ListRead> {
  const identity = await repositoryIdentity(deps.github, repositoryRoot, correlationId);
  if (!identity.ok) return { response: listResponse(identity.availability) };
  const reader = deps.github.readerFor(repositoryRoot, correlationId);
  const outcome = await reader.listOpenPullRequests(identity.ownerAndRepo);
  return {
    response: listResponse(outcome),
    pages: outcome.pages,
    rejectedCount: outcome.availability === "available" ? outcome.rejectedCount : undefined,
  };
}

async function readDetail(
  deps: ReviewPullRequestReadsDeps,
  repositoryRoot: string,
  number: number,
  correlationId: string | undefined,
): Promise<ReviewPullRequestDetailResponse> {
  const identity = await repositoryIdentity(deps.github, repositoryRoot, correlationId);
  if (!identity.ok) return detailResponse(identity.availability);
  const reader = deps.github.readerFor(repositoryRoot, correlationId);
  return detailResponse(await reader.readPullRequest(identity.ownerAndRepo, number));
}

class ReviewPullRequestReadsImpl implements ReviewPullRequestReads {
  private readonly lists = new BoundedCache<ReviewPullRequestListResponse>();
  private readonly details = new BoundedCache<ReviewPullRequestDetailResponse>();

  public constructor(private readonly deps: ReviewPullRequestReadsDeps) {}

  public async list(
    repositoryRoot: string,
    correlationId?: string,
  ): Promise<ReviewPullRequestListResponse> {
    const cached = this.lists.get(repositoryRoot, this.deps.now());
    const read =
      cached === undefined ? await readList(this.deps, repositoryRoot, correlationId) : undefined;
    const response = cached ?? read?.response;
    if (response === undefined) throw new TypeError("pull request list read produced no response");
    if (read !== undefined) this.lists.set(repositoryRoot, read.response, this.deps.now());
    logReviewTargetListed(this.deps.activityLog, correlationId, {
      read: "list",
      availability: response.availability,
      count: response.pullRequests.length,
      truncated: response.truncated,
      cacheHit: cached !== undefined,
      pages: read?.pages,
      rejectedCount: read?.rejectedCount,
    });
    return response;
  }

  public async detail(
    repositoryRoot: string,
    number: number,
    correlationId?: string,
  ): Promise<ReviewPullRequestDetailResponse> {
    const key = `${repositoryRoot}\u0000${String(number)}`;
    const cached = this.details.get(key, this.deps.now());
    const response = cached ?? (await readDetail(this.deps, repositoryRoot, number, correlationId));
    if (cached === undefined) this.details.set(key, response, this.deps.now());
    logReviewTargetListed(this.deps.activityLog, correlationId, {
      read: "detail",
      availability: response.availability,
      count: response.pullRequest === null ? 0 : 1,
      truncated: false,
      cacheHit: cached !== undefined,
    });
    return response;
  }

  public async openNumbers(
    repositoryRoot: string,
    correlationId?: string,
  ): Promise<ReadonlySet<number> | undefined> {
    const response = await this.list(repositoryRoot, correlationId);
    if (response.availability !== "available" || response.truncated) return undefined;
    return new Set(response.pullRequests.map((pullRequest) => pullRequest.number));
  }
}

export function createReviewPullRequestReads(
  deps: ReviewPullRequestReadsDeps,
): ReviewPullRequestReads {
  return new ReviewPullRequestReadsImpl(deps);
}
