import { isGitDeliveryObservationFailure } from "./git-delivery-observation.js";
import {
  journeyRemoteMatchesTask,
  journeyReadinessMatchesTask,
  journeyReadinessCurrent,
  journeyDescriptionApplied,
} from "./git-journey-freshness.js";
import { isGitObjectId, isSafeGitRefName } from "./git-repository.js";
import { isGitHubOwnerAndRepo, GITHUB_ISSUE_NUMBER_MAX } from "./github-issue-reference.js";
import { isGitPullRequestIdentity } from "./git-pull-request-identity.js";
import { isReadinessSnapshot } from "./git-ci-readiness.js";
import { isPrDescriptionApplicationStatus } from "./pr-description-application.js";
import {
  GIT_JOURNEY_REASON_STATES,
  type GitJourneyBinding,
  type GitJourneyRemoteFacts,
  type GitJourneyReason,
  type JourneyOutcome,
} from "./git-journey-outcome.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === expected.length &&
    expected.every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field !== undefined && Object.hasOwn(field, "value") && field.enumerable === true;
    })
  );
}
function count(value: unknown, max: number, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function pattern(value: unknown, expression: RegExp): value is string {
  return typeof value === "string" && expression.test(value);
}
function ref(value: unknown): value is string {
  return typeof value === "string" && isSafeGitRefName(value) && !value.startsWith("refs/");
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z")
  );
}
export function isGitJourneyBinding(value: unknown): value is GitJourneyBinding {
  if (
    !record(value) ||
    !keys(value, [
      "runId",
      "remoteDigest",
      "issueBindingDigest",
      "issueIdDigest",
      "issueNumber",
      "repository",
      "prNumber",
      "prExternalId",
      "baseRef",
      "headRef",
      "headSha",
    ])
  )
    return false;
  return (
    pattern(value.runId, ID) &&
    pattern(value.prExternalId, ID) &&
    [value.remoteDigest, value.issueBindingDigest, value.issueIdDigest].every((x) =>
      pattern(x, DIGEST),
    ) &&
    count(value.issueNumber, GITHUB_ISSUE_NUMBER_MAX, 1) &&
    count(value.prNumber, GITHUB_ISSUE_NUMBER_MAX, 1) &&
    bindingRepository(value)
  );
}
function bindingRepository(value: Record<string, unknown>): boolean {
  return (
    typeof value.repository === "string" &&
    isGitHubOwnerAndRepo(value.repository) &&
    ref(value.baseRef) &&
    ref(value.headRef) &&
    value.baseRef !== value.headRef &&
    isGitObjectId(value.headSha)
  );
}
function decision(value: unknown): boolean {
  return (
    typeof value === "string" &&
    new Set(["approved", "changes-requested", "review-required", "unknown"]).has(value)
  );
}
function issue(value: unknown): boolean {
  if (!record(value) || !keys(value, ["number", "state", "closedAt"])) return false;
  return (
    count(value.number, GITHUB_ISSUE_NUMBER_MAX, 1) &&
    ((value.state === "open" && value.closedAt === null) ||
      (value.state === "closed" && timestamp(value.closedAt)))
  );
}
function threads(value: unknown): boolean {
  if (!record(value) || !keys(value, ["total", "unresolved", "resolved"])) return false;
  return (
    count(value.total, 500) &&
    count(value.unresolved, 500) &&
    count(value.resolved, 500) &&
    value.total === value.unresolved + value.resolved
  );
}
function merge(value: Record<string, unknown>): boolean {
  if (!isGitPullRequestIdentity(value.identity)) return false;
  if (value.mergedAt === null) return value.mergeCommitSha === null;
  return (
    timestamp(value.mergedAt) &&
    isGitObjectId(value.mergeCommitSha) &&
    value.identity.state === "closed" &&
    !value.identity.isDraft
  );
}
export function isGitJourneyRemoteFacts(value: unknown): value is GitJourneyRemoteFacts {
  if (
    !record(value) ||
    !keys(value, [
      "status",
      "identity",
      "repositoryId",
      "defaultBranchRef",
      "mergedAt",
      "mergeCommitSha",
      "reviewDecision",
      "issue",
      "reviewConversations",
      "factsDigest",
    ])
  )
    return false;
  return (
    value.status === "observed" &&
    count(value.repositoryId, Number.MAX_SAFE_INTEGER, 1) &&
    ref(value.defaultBranchRef) &&
    merge(value) &&
    issue(value.issue) &&
    threads(value.reviewConversations) &&
    decision(value.reviewDecision) &&
    pattern(value.factsDigest, DIGEST)
  );
}
function boundRemote(binding: GitJourneyBinding, remote: GitJourneyRemoteFacts): boolean {
  return (
    remote.identity.repository.toLowerCase() === binding.repository.toLowerCase() &&
    remote.identity.number === binding.prNumber &&
    remote.identity.externalId === binding.prExternalId &&
    remote.issue.number === binding.issueNumber
  );
}
function state(value: Record<string, unknown>): boolean {
  if (typeof value.reason !== "string" || !Object.hasOwn(GIT_JOURNEY_REASON_STATES, value.reason))
    return false;
  return value.state === GIT_JOURNEY_REASON_STATES[value.reason as GitJourneyReason];
}
function remoteState(
  value: Record<string, unknown>,
  remote: GitJourneyRemoteFacts,
  binding: GitJourneyBinding,
): boolean {
  if (
    new Set(["completed", "merged-awaiting-issue-closure"]).has(String(value.state)) &&
    !journeyRemoteMatchesTask(binding, remote)
  )
    return false;
  if (value.state === "completed")
    return remote.mergedAt !== null && remote.issue.state === "closed";
  if (value.state === "merged-awaiting-issue-closure")
    return remote.mergedAt !== null && remote.issue.state === "open";
  return true;
}
function window(value: Record<string, unknown>): boolean {
  if (!timestamp(value.observedAt) || !timestamp(value.expiresAt)) return false;
  const duration = Date.parse(value.expiresAt) - Date.parse(value.observedAt);
  return duration > 0 && duration <= 60_000;
}
function productiveState(value: JourneyOutcome): boolean {
  const { remote, readiness, binding } = value;
  if (remote === null) return !value.keikoDescriptionApplied;
  const now = Date.parse(value.observedAt);
  if (
    value.keikoDescriptionApplied !==
    journeyDescriptionApplied(binding, remote, value.description, now)
  )
    return false;
  if (
    !new Set([
      "awaiting-ready-approval",
      "keiko-technical-ready",
      "ready-for-human-review",
      "awaiting-human-requirements",
    ]).has(value.state)
  )
    return true;
  return (
    journeyReadinessCurrent(binding, remote, readiness, now) &&
    readiness?.state === "technical-ready" &&
    value.keikoDescriptionApplied
  );
}
function descriptions(value: Record<string, unknown>): boolean {
  if (value.description === null) return value.keikoDescriptionApplied === false;
  if (!isPrDescriptionApplicationStatus(value.description)) return false;
  return (
    typeof value.keikoDescriptionApplied === "boolean" &&
    (!value.keikoDescriptionApplied ||
      new Set(["current", "partial", "fallback"]).has(value.description.state))
  );
}
const OUTCOME_KEYS = [
  "schemaVersion",
  "binding",
  "state",
  "reason",
  "observedAt",
  "expiresAt",
  "evidenceRef",
  "remote",
  "observationFailure",
  "readiness",
  "description",
  "keikoDescriptionApplied",
];
function outcomeIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === "1" && pattern(value.evidenceRef, ID) && window(value) && state(value)
  );
}
function subSnapshots(value: Record<string, unknown>, binding: GitJourneyBinding): boolean {
  if (
    value.readiness !== null &&
    (!isReadinessSnapshot(value.readiness) ||
      !journeyReadinessMatchesTask(binding, value.readiness))
  )
    return false;
  return (
    descriptions(value) &&
    (value.observationFailure === null || isGitDeliveryObservationFailure(value.observationFailure))
  );
}
function outcomeRemote(value: Record<string, unknown>, binding: GitJourneyBinding): boolean {
  if (value.remote === null)
    return (
      !value.keikoDescriptionApplied &&
      new Set(["blocked", "cancelled", "recovery-required"]).has(String(value.state))
    );
  return (
    value.observationFailure === null &&
    isGitJourneyRemoteFacts(value.remote) &&
    boundRemote(binding, value.remote) &&
    remoteState(value, value.remote, binding) &&
    productiveState(value as unknown as JourneyOutcome)
  );
}
export function isJourneyOutcome(value: unknown): value is JourneyOutcome {
  if (!record(value) || !keys(value, OUTCOME_KEYS) || !isGitJourneyBinding(value.binding))
    return false;
  return (
    outcomeIdentity(value) &&
    subSnapshots(value, value.binding) &&
    outcomeRemote(value, value.binding)
  );
}
