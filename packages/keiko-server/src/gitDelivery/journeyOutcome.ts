import type { DatabaseSync } from "node:sqlite";
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

const JOURNEY_OUTCOME_MAX_BYTES = 8192;

/**
 * Durable JourneyOutcome projection for restart/refresh (#3389 AC6). Independent of the run-bound
 * coding_runtime_snapshots row: keyed by the same-repository identity (`remoteDigest`) and PR
 * number, never by `repositoryId` or a run's live/terminal state, so a restarted process or a
 * terminated run still reconstructs the last observed outcome without resuming mutation authority.
 * CAS by `observedAt`: a write for an outcome no newer than the stored one is rejected rather than
 * silently republishing an older fact.
 */
export interface GitJourneyOutcomeStore {
  get(remoteDigest: string, prNumber: number): JourneyOutcome | undefined;
  record(outcome: JourneyOutcome): boolean;
}

interface JourneyOutcomeRow {
  readonly revision: number;
  readonly outcome_json: string;
  readonly observed_at: string;
}

function journeyOutcomeRow(
  db: DatabaseSync,
  remoteDigest: string,
  prNumber: number,
): JourneyOutcomeRow | undefined {
  return db
    .prepare(
      "SELECT revision, outcome_json, observed_at FROM git_journey_outcomes WHERE remote_digest = ? AND pr_number = ?",
    )
    .get(remoteDigest, prNumber) as JourneyOutcomeRow | undefined;
}

function parseStoredJourneyOutcome(json: string): JourneyOutcome {
  const value: unknown = JSON.parse(json);
  if (!isJourneyOutcome(value)) throw new TypeError("Invalid persisted journey outcome");
  return value;
}

function insertJourneyOutcome(db: DatabaseSync, outcome: JourneyOutcome, json: string): boolean {
  const { runId, remoteDigest, prNumber } = outcome.binding;
  const result = db
    .prepare(
      `INSERT INTO git_journey_outcomes
        (remote_digest, pr_number, run_id, revision, state, reason, observed_at, outcome_json, updated_at)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(
      remoteDigest,
      prNumber,
      runId,
      outcome.state,
      outcome.reason,
      outcome.observedAt,
      json,
      outcome.observedAt,
    );
  return Number(result.changes) === 1;
}

function updateJourneyOutcome(
  db: DatabaseSync,
  outcome: JourneyOutcome,
  json: string,
  existing: JourneyOutcomeRow,
): boolean {
  if (Date.parse(outcome.observedAt) <= Date.parse(existing.observed_at)) return false;
  const { runId, remoteDigest, prNumber } = outcome.binding;
  const result = db
    .prepare(
      `UPDATE git_journey_outcomes
        SET run_id = ?, revision = revision + 1, state = ?, reason = ?, observed_at = ?,
            outcome_json = ?, updated_at = ?
        WHERE remote_digest = ? AND pr_number = ? AND revision = ?`,
    )
    .run(
      runId,
      outcome.state,
      outcome.reason,
      outcome.observedAt,
      json,
      outcome.observedAt,
      remoteDigest,
      prNumber,
      existing.revision,
    );
  return Number(result.changes) === 1;
}

export function createGitJourneyOutcomeStore(db: DatabaseSync): GitJourneyOutcomeStore {
  return {
    get(remoteDigest, prNumber): JourneyOutcome | undefined {
      const row = journeyOutcomeRow(db, remoteDigest, prNumber);
      return row === undefined ? undefined : parseStoredJourneyOutcome(row.outcome_json);
    },
    record(outcome): boolean {
      if (!isJourneyOutcome(outcome)) return false;
      const json = JSON.stringify(outcome);
      if (Buffer.byteLength(json, "utf8") > JOURNEY_OUTCOME_MAX_BYTES) return false;
      const { remoteDigest, prNumber } = outcome.binding;
      const existing = journeyOutcomeRow(db, remoteDigest, prNumber);
      return existing === undefined
        ? insertJourneyOutcome(db, outcome, json)
        : updateJourneyOutcome(db, outcome, json, existing);
    },
  };
}
