import type {
  GitCiCheckCounts,
  GitCiHumanReviewState,
  GitCiPullRequestContext,
  GitCiReadinessReason,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  classifyGitCiChecks,
  type GitCiCheckClassification,
  type GitCiChecksResult,
} from "./git-ci-checks.js";
import type { GitCiProviderFacts } from "./git-ci-facts.js";
import type { GitProviderPageResult } from "./git-provider-observation.js";

export interface GitCiAssessment {
  readonly reason: GitCiReadinessReason;
  readonly complete: boolean;
  readonly requirementsDigest: string | null;
  readonly strictBaseRequired: boolean;
  readonly requiredChecks: GitCiCheckCounts;
  readonly advisoryChecks: GitCiCheckCounts;
  readonly pullRequest: GitCiPullRequestContext;
  readonly humanReview: GitCiHumanReviewState;
  /** Transient source identities for bounded failure-context reads; never stored in the snapshot. */
  readonly checks: GitCiChecksResult;
}
const COUNT_KEY: Readonly<
  Record<GitCiCheckClassification, Exclude<keyof GitCiCheckCounts, "total">>
> = {
  passed: "passed",
  failed: "failed",
  missing: "pending",
  "queued-or-running": "pending",
  skipped: "blocked",
  cancelled: "blocked",
  "stale-or-wrong-app": "unknown",
  unknown: "unknown",
};
export function gitCiCheckCounts(
  classes: readonly GitCiCheckClassification[] = [],
): GitCiCheckCounts {
  const counts = {
    total: classes.length,
    passed: 0,
    failed: 0,
    pending: 0,
    blocked: 0,
    unknown: 0,
  };
  for (const classification of classes) counts[COUNT_KEY[classification]] += 1;
  return counts;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_500;
}
function requiredReviews(facts: GitCiProviderFacts): number | null {
  if (facts.protection.outcome === "unknown" || !facts.lists["branch-rules"].completeness.complete)
    return null;
  const initial =
    facts.protection.outcome === "unprotected" ? 0 : facts.protection.value.reviewCount;
  if (!count(initial)) return null;
  let required = initial;
  for (const rule of facts.lists["branch-rules"].values) {
    if (!object(rule)) return null;
    if (rule.type !== "pull_request") continue;
    if (!object(rule.parameters) || !count(rule.parameters.required_approving_review_count))
      return null;
    required = Math.max(required, rule.parameters.required_approving_review_count);
  }
  return required;
}
interface Review {
  readonly id: number;
  readonly userId: number;
  readonly state: string;
  readonly commitSha: string;
  readonly submittedAt: string;
}
const REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function review(value: unknown): value is Review {
  if (!object(value)) return false;
  return (
    positive(value.id) &&
    positive(value.userId) &&
    typeof value.state === "string" &&
    REVIEW_STATES.has(value.state) &&
    typeof value.commitSha === "string" &&
    typeof value.submittedAt === "string" &&
    Number.isFinite(Date.parse(value.submittedAt))
  );
}
function selectLatestReview(latest: Map<number, Review>, value: Review): boolean {
  const prior = latest.get(value.userId);
  if (prior === undefined || Date.parse(value.submittedAt) > Date.parse(prior.submittedAt))
    latest.set(value.userId, value);
  else if (Date.parse(value.submittedAt) === Date.parse(prior.submittedAt)) return false;
  return true;
}
function reviewTally(
  page: GitProviderPageResult,
  headSha: string,
): { approved: number; changes: number } | undefined {
  if (!page.completeness.complete || page.completeness.entries !== page.values.length)
    return undefined;
  const latest = new Map<number, Review>();
  const ids = new Set<number>();
  for (const value of page.values) {
    if (!review(value) || ids.has(value.id)) return undefined;
    ids.add(value.id);
    // Comment-only reviews do not withdraw a previous formal approval/request for changes.
    if (value.state === "COMMENTED" || value.state === "PENDING") continue;
    if (!selectLatestReview(latest, value)) return undefined;
  }
  return {
    approved: [...latest.values()].filter(
      (value) => value.state === "APPROVED" && value.commitSha === headSha,
    ).length,
    changes: [...latest.values()].filter((value) => value.state === "CHANGES_REQUESTED").length,
  };
}
function humanReview(facts: GitCiProviderFacts): GitCiHumanReviewState {
  const requiredCount = requiredReviews(facts);
  const tally = reviewTally(facts.lists.reviews, facts.identity.headSha);
  return {
    visibility: requiredCount === null || tally === undefined ? "unknown" : "complete",
    requiredCount,
    approvedCount: tally?.approved ?? null,
    changesRequestedCount: tally?.changes ?? null,
  };
}
function pullRequest(facts: GitCiProviderFacts): GitCiPullRequestContext {
  return {
    status: facts.merged ? "merged" : facts.identity.state,
    isDraft: facts.identity.isDraft,
    conflict: facts.mergeable === null ? "unknown" : facts.mergeable ? "clear" : "conflicting",
    baseCurrency:
      facts.mergeState === "unknown"
        ? "unknown"
        : facts.mergeState === "behind"
          ? "behind"
          : "current",
  };
}
function pullRequestReason(facts: GitCiProviderFacts): GitCiReadinessReason | undefined {
  if (facts.merged || facts.identity.state !== "open") return "pull-request-closed";
  if (facts.mergeable === false || facts.mergeState === "dirty") return "merge-conflict";
  if (
    facts.mergeable === null ||
    !new Set(["clean", "behind", "blocked", "unstable", "draft"]).has(facts.mergeState)
  )
    return "merge-context-unknown";
  if (
    facts.requirements.status === "observed" &&
    facts.requirements.strict &&
    facts.mergeState === "behind"
  )
    return "base-outdated";
  return undefined;
}
function reason(facts: GitCiProviderFacts, checks: GitCiChecksResult): GitCiReadinessReason {
  if (facts.requirements.status === "unknown") return facts.requirements.failure.reason;
  if (facts.workflowDefinitions.status === "unknown")
    return facts.workflowDefinitions.failure.reason;
  if (checks.status === "unknown") return checks.failure.reason;
  const contextReason = pullRequestReason(facts);
  if (contextReason !== undefined) return contextReason;
  const reasons = {
    passed: "required-checks-passed",
    pending: "required-checks-pending",
    failed: "required-checks-failed",
    blocked: "required-checks-blocked",
    unknown: "required-checks-unknown",
  } as const;
  return reasons[checks.overall];
}
function digest(facts: GitCiProviderFacts): string | null {
  if (facts.requirements.status === "unknown" || facts.workflowDefinitions.status === "unknown")
    return null;
  return sha256Hex(
    canonicalise([
      "keiko-ci-effective-requirements-v1",
      facts.requirements.digest,
      facts.workflowDefinitions.definitions,
    ]),
  );
}
export function assessGitCiFacts(facts: GitCiProviderFacts): GitCiAssessment {
  const checks = classifyGitCiChecks({
    headSha: facts.identity.headSha,
    baseSha: facts.identity.baseSha,
    prNumber: facts.identity.number,
    repositoryId: facts.repositoryId,
    requirements: facts.requirements,
    checkRuns: facts.lists["check-runs"],
    commitStatuses: facts.lists["commit-statuses"],
    workflowRuns: facts.lists["workflow-runs"],
    ...(facts.workflowDefinitions.status === "unknown"
      ? {}
      : { workflowDefinitions: facts.workflowDefinitions.definitions }),
  });
  return {
    reason: reason(facts, checks),
    requirementsDigest: digest(facts),
    strictBaseRequired: facts.requirements.status === "observed" && facts.requirements.strict,
    complete:
      facts.requirements.status === "observed" &&
      facts.workflowDefinitions.status === "observed" &&
      checks.status === "observed",
    requiredChecks: gitCiCheckCounts(
      checks.status === "observed" ? checks.required.map((value) => value.classification) : [],
    ),
    advisoryChecks: gitCiCheckCounts(
      checks.status === "observed" ? checks.advisory.map((value) => value.classification) : [],
    ),
    pullRequest: pullRequest(facts),
    humanReview: humanReview(facts),
    checks,
  };
}
