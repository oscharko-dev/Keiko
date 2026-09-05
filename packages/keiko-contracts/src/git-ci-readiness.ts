import { isGitObjectId, isSafeGitRefName } from "./git-repository.js";
import { isGitHubOwnerAndRepo, GITHUB_ISSUE_NUMBER_MAX } from "./github-issue-reference.js";
import { GIT_DELIVERY_OBSERVATION_FAILURE_STATES } from "./git-delivery-observation.js";

export const GIT_CI_READINESS_REASON_STATES = Object.freeze({
  ...GIT_DELIVERY_OBSERVATION_FAILURE_STATES,
  "required-checks-passed": "technical-ready",
  "required-checks-pending": "pending",
  "required-checks-failed": "failed",
  "required-checks-blocked": "blocked",
  "required-checks-unknown": "unknown",
  "pull-request-closed": "blocked",
  "merge-conflict": "blocked",
  "base-outdated": "pending",
  "merge-context-unknown": "unknown",
  "repair-budget-exhausted": "blocked",
} as const);
export type GitCiReadinessReason = keyof typeof GIT_CI_READINESS_REASON_STATES;
export type GitCiReadinessState = (typeof GIT_CI_READINESS_REASON_STATES)[GitCiReadinessReason];

export interface GitCiCheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly blocked: number;
  readonly unknown: number;
}
export interface GitCiPullRequestContext {
  readonly status: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly conflict: "clear" | "conflicting" | "unknown";
  readonly baseCurrency: "current" | "behind" | "unknown";
}
export interface GitCiHumanReviewState {
  readonly visibility: "complete" | "unknown";
  readonly requiredCount: number | null;
  readonly approvedCount: number | null;
  readonly changesRequestedCount: number | null;
}
/** Body-free exact-revision evidence. This snapshot grants no merge or delivery authority. */
export interface ReadinessSnapshot {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly remoteDigest: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly requirementsVersion: "1";
  readonly requirementsDigest: string | null;
  /** Stable hash of failed required identities; absent when no identified failure was observed. */
  readonly failureSignatureDigest?: string;
  readonly strictBaseRequired: boolean;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly evidenceRef: string;
  readonly complete: boolean;
  readonly state: GitCiReadinessState;
  readonly reason: GitCiReadinessReason;
  readonly requiredChecks: GitCiCheckCounts;
  readonly advisoryChecks: GitCiCheckCounts;
  readonly pullRequest: GitCiPullRequestContext;
  readonly humanReview: GitCiHumanReviewState;
}
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KEYS = [
  "schemaVersion",
  "runId",
  "remoteDigest",
  "repository",
  "prNumber",
  "baseRef",
  "baseSha",
  "headRef",
  "headSha",
  "requirementsVersion",
  "requirementsDigest",
  "strictBaseRequired",
  "observedAt",
  "expiresAt",
  "evidenceRef",
  "complete",
  "state",
  "reason",
  "requiredChecks",
  "advisoryChecks",
  "pullRequest",
  "humanReview",
];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function pattern(value: unknown, expression: RegExp): value is string {
  return typeof value === "string" && expression.test(value);
}
function count(value: unknown, maximum = 1_500): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
export function isGitCiCheckCounts(value: unknown): value is GitCiCheckCounts {
  if (
    !object(value) ||
    !keys(value, ["total", "passed", "failed", "pending", "blocked", "unknown"])
  )
    return false;
  if (!Object.values(value).every((entry) => count(entry))) return false;
  return (
    value.total ===
    Object.entries(value)
      .filter(([key]) => key !== "total")
      .reduce((sum, [, amount]) => sum + (amount as number), 0)
  );
}
function member(value: unknown, values: ReadonlySet<string>): boolean {
  return typeof value === "string" && values.has(value);
}
function context(value: unknown): value is GitCiPullRequestContext {
  return (
    object(value) &&
    keys(value, ["status", "isDraft", "conflict", "baseCurrency"]) &&
    member(value.status, new Set(["open", "closed", "merged"])) &&
    typeof value.isDraft === "boolean" &&
    member(value.conflict, new Set(["clear", "conflicting", "unknown"])) &&
    member(value.baseCurrency, new Set(["current", "behind", "unknown"]))
  );
}
function humanReview(value: unknown): value is GitCiHumanReviewState {
  if (
    !object(value) ||
    !keys(value, ["visibility", "requiredCount", "approvedCount", "changesRequestedCount"])
  )
    return false;
  if (value.visibility !== "complete" && value.visibility !== "unknown") return false;
  return [value.requiredCount, value.approvedCount, value.changesRequestedCount].every((entry) =>
    entry === null ? value.visibility === "unknown" : count(entry),
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function refs(value: Record<string, unknown>): boolean {
  return (
    [value.baseRef, value.headRef].every(
      (ref) => typeof ref === "string" && isSafeGitRefName(ref) && !ref.startsWith("refs/"),
    ) &&
    value.baseRef !== value.headRef &&
    isGitObjectId(value.baseSha) &&
    isGitObjectId(value.headSha)
  );
}
function identity(value: Record<string, unknown>): boolean {
  return (
    pattern(value.runId, ID) &&
    pattern(value.remoteDigest, DIGEST) &&
    pattern(value.evidenceRef, ID) &&
    typeof value.repository === "string" &&
    isGitHubOwnerAndRepo(value.repository) &&
    count(value.prNumber, GITHUB_ISSUE_NUMBER_MAX) &&
    value.prNumber > 0 &&
    refs(value)
  );
}
function readiness(value: Record<string, unknown>): boolean {
  if (
    typeof value.reason !== "string" ||
    !Object.hasOwn(GIT_CI_READINESS_REASON_STATES, value.reason)
  )
    return false;
  if (value.state !== GIT_CI_READINESS_REASON_STATES[value.reason as GitCiReadinessReason])
    return false;
  if (typeof value.complete !== "boolean" || !isGitCiCheckCounts(value.requiredChecks))
    return false;
  if (value.state !== "technical-ready") return true;
  return (
    value.complete &&
    value.requirementsDigest !== null &&
    value.requiredChecks.total === value.requiredChecks.passed &&
    readyContext(value)
  );
}
function readyContext(value: Record<string, unknown>): boolean {
  if (
    !context(value.pullRequest) ||
    value.pullRequest.status !== "open" ||
    value.pullRequest.conflict !== "clear"
  )
    return false;
  return (
    value.pullRequest.baseCurrency === "current" ||
    (value.pullRequest.baseCurrency === "behind" && value.strictBaseRequired === false)
  );
}
function versions(value: Record<string, unknown>): boolean {
  return (
    keys(value, value.failureSignatureDigest === undefined ? KEYS : [...KEYS, "failureSignatureDigest"]) &&
    (value.failureSignatureDigest === undefined || pattern(value.failureSignatureDigest, DIGEST)) &&
    value.schemaVersion === "1" &&
    value.requirementsVersion === "1" &&
    typeof value.strictBaseRequired === "boolean"
  );
}
function window(value: Record<string, unknown>): boolean {
  if (!timestamp(value.observedAt) || !timestamp(value.expiresAt)) return false;
  const duration = Date.parse(value.expiresAt) - Date.parse(value.observedAt);
  return duration > 0 && duration <= 60_000;
}
export function isReadinessSnapshot(value: unknown): value is ReadinessSnapshot {
  if (!object(value) || !versions(value)) return false;
  if (
    !identity(value) ||
    !(value.requirementsDigest === null || pattern(value.requirementsDigest, DIGEST))
  )
    return false;
  return (
    window(value) &&
    readiness(value) &&
    isGitCiCheckCounts(value.advisoryChecks) &&
    context(value.pullRequest) &&
    humanReview(value.humanReview)
  );
}
