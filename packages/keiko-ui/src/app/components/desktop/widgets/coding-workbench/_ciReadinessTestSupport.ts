import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";

export const CI_OBSERVED_AT = "2026-09-05T00:00:00.000Z";
export function ciReadinessSnapshot(
  overrides: Partial<ReadinessSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  const snapshot = draftDeliverySnapshot();
  const draft = snapshot.draftDelivery;
  if (draft?.pullRequest === undefined) throw new Error("Expected fixture delivery");
  return {
    ...snapshot,
    state: "running",
    ciReadiness: {
      schemaVersion: "1",
      runId: draft.binding.runId,
      remoteDigest: draft.binding.remoteDigest,
      repository: draft.binding.repository,
      prNumber: draft.pullRequest.number,
      headRef: draft.binding.headRef,
      headSha: draft.binding.headSha,
      baseRef: draft.binding.baseRef,
      baseSha: draft.binding.baseSha,
      requirementsVersion: "1",
      requirementsDigest: "c".repeat(64),
      strictBaseRequired: true,
      observedAt: CI_OBSERVED_AT,
      expiresAt: "2026-09-05T00:01:00.000Z",
      evidenceRef: "ci-observation-1",
      complete: true,
      state: "technical-ready",
      reason: "required-checks-passed",
      requiredChecks: { total: 2, passed: 2, failed: 0, pending: 0, blocked: 0, unknown: 0 },
      advisoryChecks: { total: 1, passed: 0, failed: 1, pending: 0, blocked: 0, unknown: 0 },
      pullRequest: { status: "open", isDraft: true, conflict: "clear", baseCurrency: "current" },
      humanReview: {
        visibility: "complete",
        requiredCount: 1,
        approvedCount: 0,
        changesRequestedCount: 1,
      },
      ...overrides,
    },
  };
}
