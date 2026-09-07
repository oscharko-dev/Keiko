import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { ciReadinessSnapshot, CI_OBSERVED_AT } from "./_ciReadinessTestSupport";

type GitPullRequestIdentity = NonNullable<JourneyOutcome["remote"]>["identity"];

export function journeyFixture(): {
  snapshot: ReturnType<typeof ciReadinessSnapshot>;
  outcome: JourneyOutcome;
} {
  const snapshot = ciReadinessSnapshot();
  const draft = snapshot.draftDelivery;
  if (draft?.pullRequest === undefined || snapshot.ciReadiness === undefined)
    throw new Error("Expected a confirmed fixture PR and CI observation");
  const pr = draft.pullRequest;
  const source = draft.binding;
  return {
    snapshot,
    outcome: {
      schemaVersion: "1",
      state: "awaiting-ready-approval",
      reason: "ready-approval-required",
      observedAt: CI_OBSERVED_AT,
      expiresAt: "2026-09-05T00:01:00.000Z",
      evidenceRef: "journey-1",
      binding: {
        runId: source.runId,
        remoteDigest: source.remoteDigest,
        issueBindingDigest: source.issueBindingDigest,
        issueIdDigest: source.issueIdDigest,
        issueNumber: source.issueNumber,
        repository: source.repository,
        prNumber: pr.number,
        prExternalId: pr.externalId,
        baseRef: source.baseRef,
        headRef: source.headRef,
        headSha: source.headSha,
      },
      remote: remoteFixture(pr),
      observationFailure: null,
      readiness: snapshot.ciReadiness,
      description: descriptionFixture(pr, source.remoteDigest),
      keikoDescriptionApplied: true,
    },
  };
}

function descriptionFixture(
  pr: GitPullRequestIdentity,
  remoteDigest: string,
): PrDescriptionApplicationStatus {
  return {
    schemaVersion: "1",
    state: "current",
    reason: "applied",
    completeness: "complete",
    effect: "confirmed",
    concurrency: "read-check-write-verify",
    observedAt: CI_OBSERVED_AT,
    expiresAt: "2026-09-05T00:01:00.000Z",
    binding: {
      repositoryId: "repository-1",
      remoteDigest,
      repository: pr.repository,
      prNumber: pr.number,
      prExternalId: pr.externalId,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRepository: pr.headRepository,
      headRef: pr.headRef,
      headSha: pr.headSha,
      isDraft: pr.isDraft,
      snapshotDigest: "b".repeat(64),
      draftDigest: "c".repeat(64),
      renderingVersion: "1",
      expectedBodyDigest: "d".repeat(64),
      outsideRegionDigest: "e".repeat(64),
      finalBodyDigest: "f".repeat(64),
      providerUpdatedAt: CI_OBSERVED_AT,
    },
  };
}

export function completedJourneyFixture(closed: boolean): ReturnType<typeof journeyFixture> {
  const fixture = journeyFixture();
  const remote = fixture.outcome.remote;
  if (remote === null) throw new Error("Expected fixture remote");
  return {
    ...fixture,
    outcome: {
      ...fixture.outcome,
      state: closed ? "completed" : "merged-awaiting-issue-closure",
      reason: closed ? "merge-and-closure-observed" : "issue-closure-pending",
      keikoDescriptionApplied: false,
      remote: {
        ...remote,
        identity: { ...remote.identity, state: "closed", isDraft: false },
        mergedAt: "2026-09-05T00:00:01.000Z",
        mergeCommitSha: "4".repeat(40),
        issue: {
          ...remote.issue,
          state: closed ? "closed" : "open",
          closedAt: closed ? "2026-09-05T00:00:02.000Z" : null,
        },
      },
    },
  };
}

function remoteFixture(pr: GitPullRequestIdentity): NonNullable<JourneyOutcome["remote"]> {
  return {
    status: "observed",
    identity: pr,
    repositoryId: 1,
    defaultBranchRef: pr.baseRef,
    mergedAt: null,
    mergeCommitSha: null,
    reviewDecision: "review-required",
    issue: { number: 42, state: "open", closedAt: null },
    reviewConversations: { total: 2, unresolved: 0, resolved: 2 },
    factsDigest: "a".repeat(64),
  };
}
