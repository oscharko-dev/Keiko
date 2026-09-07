import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { DatabaseSync } from "node:sqlite";
import type { GitJourneyRemoteFacts } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { createDraftRun, AT, DIGEST } from "../ciObservationTest/_support.js";
import { produceCiReadinessSnapshot } from "../ciReadinessSnapshot.js";
import type { JourneyOutcomeInput } from "../journeyOutcome.js";

export function journeyFixture(
  isDraft = true,
): JourneyOutcomeInput & { readonly facts: GitJourneyRemoteFacts } {
  const db = new DatabaseSync(":memory:");
  try {
    const draft = createDraftRun(db).get("run-1")?.draftDelivery;
    if (draft?.pullRequest === undefined) throw new TypeError("Confirmed draft fixture missing");
    const identity = { ...draft.pullRequest, isDraft };
    const readiness = observedReadiness(draft, identity);
    const description = appliedDescription(draft, identity, readiness.expiresAt);
    return {
      draft,
      readiness,
      description,
      observedAtMs: Date.parse(AT),
      facts: {
        status: "observed",
        identity,
        repositoryId: 41,
        defaultBranchRef: "dev",
        mergedAt: null,
        mergeCommitSha: null,
        reviewDecision: "unknown",
        issue: { number: draft.binding.issueNumber, state: "open", closedAt: null },
        reviewConversations: { total: 0, unresolved: 0, resolved: 0 },
        factsDigest: DIGEST,
      },
    };
  } finally {
    db.close();
  }
}

function appliedDescription(
  draft: DraftDeliveryRecord,
  identity: GitPullRequestIdentity,
  expiresAt: string,
): PrDescriptionApplicationStatus {
  return {
    schemaVersion: "1",
    state: "current",
    reason: "applied",
    observedAt: AT,
    expiresAt: expiresAt,
    completeness: "complete",
    effect: "confirmed",
    concurrency: "read-check-write-verify",
    binding: {
      repositoryId: "repository-1",
      remoteDigest: draft.binding.remoteDigest,
      repository: identity.repository,
      prNumber: identity.number,
      prExternalId: identity.externalId,
      baseRef: identity.baseRef,
      baseSha: identity.baseSha,
      headRepository: identity.headRepository,
      headRef: identity.headRef,
      headSha: identity.headSha,
      isDraft: identity.isDraft,
      snapshotDigest: DIGEST,
      draftDigest: DIGEST,
      renderingVersion: "1",
      expectedBodyDigest: DIGEST,
      outsideRegionDigest: DIGEST,
      finalBodyDigest: DIGEST,
      providerUpdatedAt: AT,
    },
  };
}

function observedReadiness(
  draft: DraftDeliveryRecord,
  identity: GitPullRequestIdentity,
): NonNullable<JourneyOutcomeInput["readiness"]> {
  const page = {
    values: [],
    completeness: { complete: true, pages: 1, entries: 0, bytes: 2 },
  } as const;
  return produceCiReadinessSnapshot(
    draft,
    {
      status: "observed",
      identity,
      repositoryId: 41,
      mergeable: true,
      mergeState: "clean",
      merged: false,
      protection: { outcome: "unprotected" },
      requirements: { status: "observed", requirements: [], strict: false, digest: DIGEST },
      workflowDefinitions: { status: "observed", definitions: [] },
      lists: {
        "branch-rules": page,
        "check-runs": page,
        "commit-statuses": page,
        "workflow-runs": page,
        reviews: page,
      },
    },
    Date.parse(AT),
  ).snapshot;
}
