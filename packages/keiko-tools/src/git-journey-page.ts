import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { sameGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  isSafeGitRefName,
  isGitObjectId,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  gitDeliveryObservationFailure,
  type GitDeliveryObservationFailureReason,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { parseGitPrIdentity } from "./git-pr-identity.js";
import type { GitJourneyReadTarget } from "./git-journey-read-argv.js";
import type { GitJourneyHeader, GitJourneyPage } from "./git-journey-facts-types.js";

export class GitJourneyReadError extends Error {
  public readonly failure;
  public constructor(reason: GitDeliveryObservationFailureReason) {
    super("Journey observation unavailable");
    this.name = "GitJourneyReadError";
    this.failure = gitDeliveryObservationFailure(reason);
  }
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new GitJourneyReadError("malformed-response");
  return value as Record<string, unknown>;
}
function count(value: unknown, max: number, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value))
    return false;
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z")
  );
}
function decision(value: unknown): GitJourneyHeader["reviewDecision"] {
  if (value === null) return "unknown";
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes-requested";
  if (value === "REVIEW_REQUIRED") return "review-required";
  throw new GitJourneyReadError("malformed-response");
}
function repositoryMatches(value: unknown, expected: string): boolean {
  return typeof value === "string" && sameGitHubOwnerAndRepo(value, expected);
}
function issue(raw: unknown, target: GitJourneyReadTarget): GitJourneyHeader["issue"] {
  const value = object(raw);
  if (
    typeof value.id !== "string" ||
    sha256Hex(value.id) !== target.issueIdDigest ||
    value.number !== target.issueNumber ||
    !repositoryMatches(object(value.repository).nameWithOwner, target.repository)
  )
    throw new GitJourneyReadError("revision-changed");
  if (value.state === "OPEN" && value.closedAt === null)
    return { number: target.issueNumber, state: "open", closedAt: null };
  if (value.state === "CLOSED" && instant(value.closedAt))
    return { number: target.issueNumber, state: "closed", closedAt: value.closedAt };
  throw new GitJourneyReadError("malformed-response");
}
function identity(
  pr: Record<string, unknown>,
  target: GitJourneyReadTarget,
): GitJourneyHeader["identity"] {
  const state = pullRequestState(pr.state);
  const value = parseGitPrIdentity(
    {
      number: pr.number,
      externalId: pr.id,
      url: pr.url,
      repository: object(pr.repository).nameWithOwner,
      headRepository: object(pr.headRepository).nameWithOwner,
      headRef: pr.headRefName,
      headSha: pr.headRefOid,
      baseRef: pr.baseRefName,
      baseSha: pr.baseRefOid,
      state,
      isDraft: pr.isDraft,
    },
    target.repository,
  );
  if (value?.number !== target.prNumber || value.externalId !== target.prNodeId)
    throw new GitJourneyReadError("revision-changed");
  return value;
}
function pullRequestState(value: unknown): unknown {
  if (value === "MERGED") return "closed";
  if (typeof value === "string") return value.toLowerCase();
  return value;
}
function merge(pr: Record<string, unknown>): Pick<GitJourneyHeader, "mergedAt" | "mergeCommitSha"> {
  if (pr.state !== "MERGED") {
    if (pr.mergedAt !== null || pr.mergeCommit !== null)
      throw new GitJourneyReadError("malformed-response");
    return { mergedAt: null, mergeCommitSha: null };
  }
  const sha = object(pr.mergeCommit).oid;
  if (!instant(pr.mergedAt) || !isGitObjectId(sha))
    throw new GitJourneyReadError("malformed-response");
  return { mergedAt: pr.mergedAt, mergeCommitSha: sha };
}
function header(
  repo: Record<string, unknown>,
  pr: Record<string, unknown>,
  target: GitJourneyReadTarget,
): GitJourneyHeader {
  const ref = object(repo.defaultBranchRef).name;
  if (
    !repositoryMatches(repo.nameWithOwner, target.repository) ||
    !count(repo.databaseId, Number.MAX_SAFE_INTEGER, 1) ||
    typeof ref !== "string" ||
    !isSafeGitRefName(ref)
  )
    throw new GitJourneyReadError("revision-changed");
  return {
    identity: identity(pr, target),
    repositoryId: repo.databaseId,
    defaultBranchRef: ref,
    issue: issue(repo.issue, target),
    ...merge(pr),
    reviewDecision: decision(pr.reviewDecision),
  };
}
function thread(raw: unknown): GitJourneyPage["threads"][number] {
  const value = object(raw);
  if (
    Object.keys(value).length !== 2 ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_=-]{1,256}$/u.test(value.id) ||
    typeof value.isResolved !== "boolean"
  )
    throw new GitJourneyReadError("malformed-response");
  return { id: value.id, isResolved: value.isResolved };
}
function connection(raw: unknown): Omit<GitJourneyPage, "header"> {
  const value = object(raw);
  const paging = object(value.pageInfo);
  if (!count(value.totalCount, 500) || !Array.isArray(value.nodes) || value.nodes.length > 100)
    throw new GitJourneyReadError("pagination-exhausted");
  if (
    typeof paging.hasNextPage !== "boolean" ||
    (paging.endCursor !== null &&
      (typeof paging.endCursor !== "string" ||
        !/^[A-Za-z0-9_+/=-]{1,512}$/u.test(paging.endCursor)))
  )
    throw new GitJourneyReadError("malformed-response");
  return {
    threads: value.nodes.map(thread),
    total: value.totalCount,
    hasNextPage: paging.hasNextPage,
    cursor: paging.endCursor,
  };
}
/** Maps only the fixed query fields; source identities and per-thread IDs remain transient. */
export function parseGitJourneyPage(raw: unknown, target: GitJourneyReadTarget): GitJourneyPage {
  const envelope = object(raw);
  if (envelope.errors !== undefined) throw new GitJourneyReadError("visibility-unknown");
  const repo = object(object(envelope.data).repository);
  const pr = object(repo.pullRequest);
  return { header: header(repo, pr, target), ...connection(pr.reviewThreads) };
}
export function journeyPageHeaderDigest(value: GitJourneyHeader): string {
  return sha256Hex(canonicalise(value));
}
