import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  GIT_JOURNEY_REASON_STATES,
  type GitJourneyBinding,
  type GitJourneyRemoteFacts,
  type GitJourneyReason,
  type JourneyOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import {
  isGitJourneyRemoteFacts,
  isJourneyOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import {
  journeyReadinessCurrent,
  journeyReadinessMatchesTask,
  journeyDescriptionApplied,
  journeyEvidenceFresh,
} from "@oscharko-dev/keiko-contracts/runtime/git-journey-freshness";
import {
  isDraftDeliveryRecord,
  type DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  isReadinessSnapshot,
  gitDeliveryObservationFailure,
  isGitDeliveryObservationFailure,
  type ReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import {
  isPrDescriptionApplicationStatus,
  type PrDescriptionApplicationStatus,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type { GitJourneyFactsResult } from "@oscharko-dev/keiko-tools/internal/git-mutation";

export interface JourneyOutcomeInput {
  readonly draft: DraftDeliveryRecord;
  readonly facts: GitJourneyFactsResult;
  readonly readiness: ReadinessSnapshot | null;
  readonly description: PrDescriptionApplicationStatus | null;
  readonly observedAtMs: number;
}
function binding(draft: DraftDeliveryRecord): GitJourneyBinding {
  if (!isDraftDeliveryRecord(draft) || draft.pullRequest === undefined)
    throw new TypeError("Journey requires a confirmed accepted PR");
  const { binding: value, pullRequest: pr } = draft;
  return {
    runId: value.runId,
    remoteDigest: value.remoteDigest,
    issueBindingDigest: value.issueBindingDigest,
    issueIdDigest: value.issueIdDigest,
    issueNumber: value.issueNumber,
    repository: value.repository,
    prNumber: pr.number,
    prExternalId: pr.externalId,
    baseRef: value.baseRef,
    headRef: value.headRef,
    headSha: value.headSha,
  };
}
export function captureJourneyFacts(input: unknown): GitJourneyFactsResult {
  if (isGitJourneyRemoteFacts(input)) return structuredClone(input);
  if (
    typeof input === "object" &&
    input !== null &&
    "status" in input &&
    input.status === "unavailable" &&
    "failure" in input &&
    isGitDeliveryObservationFailure(input.failure)
  )
    return { status: "unavailable", failure: { ...input.failure } };
  return { status: "unavailable", failure: gitDeliveryObservationFailure("malformed-response") };
}
function lifecycleReason(
  value: GitJourneyBinding,
  facts: GitJourneyRemoteFacts,
): GitJourneyReason | undefined {
  const pr = facts.identity;
  if (pr.baseRef !== value.baseRef || facts.defaultBranchRef !== value.baseRef) return "retargeted";
  if (
    pr.headSha !== value.headSha ||
    pr.headRef !== value.headRef ||
    pr.headRepository.toLowerCase() !== value.repository.toLowerCase()
  )
    return "head-changed";
  if (facts.mergedAt !== null)
    return facts.issue.state === "closed" ? "merge-and-closure-observed" : "issue-closure-pending";
  if (facts.issue.state === "closed") return "issue-closed-without-merge";
  if (pr.state === "closed") return "closed-unmerged";
  return undefined;
}
function humanReason(facts: GitJourneyRemoteFacts, readiness: ReadinessSnapshot): GitJourneyReason {
  const reviews = readiness.humanReview;
  if (facts.reviewConversations.unresolved > 0) return "unresolved-conversations";
  if (facts.reviewDecision === "changes-requested" || (reviews.changesRequestedCount ?? 0) > 0)
    return "changes-requested";
  if (
    reviews.visibility !== "complete" ||
    reviews.requiredCount === null ||
    reviews.approvedCount === null ||
    reviews.changesRequestedCount === null
  )
    return "review-visibility-unknown";
  return approvalReason(facts.reviewDecision, reviews.requiredCount, reviews.approvedCount);
}
function approvalReason(
  decision: GitJourneyRemoteFacts["reviewDecision"],
  required: number,
  approved: number,
): GitJourneyReason {
  if (approved < required || decision === "review-required") return "required-reviews-missing";
  return decision === "unknown" && required > 0
    ? "review-visibility-unknown"
    : "human-review-ready";
}
function openReason(
  input: JourneyOutcomeInput,
  value: GitJourneyBinding,
  facts: GitJourneyRemoteFacts,
  descriptionApplied: boolean,
): GitJourneyReason {
  const { readiness, description, observedAtMs: now } = input;
  if (readiness === null) return "readiness-unavailable";
  if (!journeyReadinessCurrent(value, facts, readiness, now)) return "readiness-stale";
  if (readiness.state !== "technical-ready") return "checks-not-ready";
  if (description === null) return "description-unavailable";
  if (!journeyEvidenceFresh(description, now) || description.state === "stale")
    return "description-stale";
  if (!descriptionApplied) return "description-not-applied";
  return facts.identity.isDraft ? "ready-approval-required" : humanReason(facts, readiness);
}
function reason(
  input: JourneyOutcomeInput,
  value: GitJourneyBinding,
  facts: GitJourneyFactsResult,
  descriptionApplied: boolean,
): GitJourneyReason {
  if (facts.status === "unavailable") {
    if (facts.failure.reason === "cancelled") return "cancelled";
    if (facts.failure.state === "blocked") return "authority-denied";
    return "provider-unavailable";
  }
  return lifecycleReason(value, facts) ?? openReason(input, value, facts, descriptionApplied);
}
/** Composition observes GitHub facts; it does not generate a narrative or perform any remote effect. */
export function produceJourneyOutcome(source: JourneyOutcomeInput): JourneyOutcome {
  const value = binding(source.draft);
  const now = source.observedAtMs;
  if (!Number.isSafeInteger(now) || now < 0)
    throw new TypeError("Invalid journey observation clock");
  const input = {
    ...source,
    readiness:
      isReadinessSnapshot(source.readiness) && journeyReadinessMatchesTask(value, source.readiness)
        ? structuredClone(source.readiness)
        : null,
    description: isPrDescriptionApplicationStatus(source.description)
      ? structuredClone(source.description)
      : null,
  };
  const facts = captureJourneyFacts(input.facts);
  const remote = facts.status === "observed" ? facts : null;
  const keikoDescriptionApplied =
    remote !== null && journeyDescriptionApplied(value, remote, input.description, now);
  const resultReason = reason(input, value, facts, keikoDescriptionApplied);
  const fields = {
    schemaVersion: "1" as const,
    binding: value,
    state: GIT_JOURNEY_REASON_STATES[resultReason],
    reason: resultReason,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    remote,
    observationFailure: facts.status === "unavailable" ? facts.failure : null,
    readiness: input.readiness,
    description: input.description,
    keikoDescriptionApplied,
  };
  const outcome = { ...fields, evidenceRef: `journey-${sha256Hex(canonicalise(fields))}` };
  if (!isJourneyOutcome(outcome)) throw new TypeError("Invalid generated journey outcome");
  return Object.freeze(outcome);
}
