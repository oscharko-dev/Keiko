import type { DatabaseSync } from "node:sqlite";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { runMigrations } from "../../store/schema.js";
import {
  createCodingRuntimeSnapshotStore,
  type CodingRuntimeSnapshotStore,
} from "../../coding-runtime/codingRuntimeSnapshotStore.js";

export const AT = "2026-09-05T00:00:00.000Z";
export const DIGEST = "a".repeat(64);
export const COMMIT: VerifiedCommitResult = {
  schemaVersion: "1",
  runId: "run-1",
  proposalId: "commit-1",
  envelopeDigest: DIGEST,
  runtimeAuthorityDigest: DIGEST,
  workspaceDigest: DIGEST,
  repositoryDigest: DIGEST,
  baseSha: "1".repeat(40),
  parentSha: "2".repeat(40),
  stagedTreeDigest: DIGEST,
  verificationEvidenceId: "verification-1",
  messageDigest: DIGEST,
  issueBindingDigest: DIGEST,
  status: "succeeded",
  reason: "completed",
  headSha: "3".repeat(40),
  committedTreeDigest: DIGEST,
  recordedAt: AT,
};
const INITIAL: DraftDeliveryRecord = {
  schemaVersion: "1",
  revision: 0,
  phase: "push-proposed",
  reason: "approval-required",
  proposalId: "push-1",
  proposalDigest: DIGEST,
  recordedAt: AT,
  binding: {
    runId: "run-1",
    workspaceDigest: DIGEST,
    runtimeAuthorityDigest: DIGEST,
    envelopeDigest: DIGEST,
    remoteDigest: DIGEST,
    issueBindingDigest: DIGEST,
    issueIdDigest: DIGEST,
    issueNumber: 1,
    repository: "owner/repository",
    remoteAlias: "origin",
    baseRef: "dev",
    baseSha: "1".repeat(40),
    headRef: "feature/issue-1",
    headSha: "3".repeat(40),
    verifiedCommitProposalId: "commit-1",
    recoveryId: "delivery-1",
  },
};
function createRun(snapshots: CodingRuntimeSnapshotStore): void {
  snapshots.create({
    schemaVersion: "1",
    runId: "run-1",
    state: "running",
    revision: 0,
    requestedMode: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: AT,
    updatedAt: AT,
    taskDigest: DIGEST,
    workspaceDigest: DIGEST,
    operatorDigest: DIGEST,
    authorityDigest: DIGEST,
    bindingDigest: DIGEST,
    provenanceDigest: DIGEST,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
    issueBinding: {
      schemaVersion: "1",
      repositoryId: "repository-1",
      remoteDigest: DIGEST,
      issueNumber: 1,
      issueIdDigest: DIGEST,
      defaultBaseRef: "dev",
      contentRevisionDigest: DIGEST,
      bindingDigest: DIGEST,
    },
  });
}
export function createDraftRun(db: DatabaseSync): CodingRuntimeSnapshotStore {
  runMigrations(db);
  const snapshots = createCodingRuntimeSnapshotStore(db);
  createRun(snapshots);
  snapshots.recordVerifiedCommit(COMMIT);
  snapshots.recordDraftDelivery(INITIAL, null);
  const steps: readonly Pick<DraftDeliveryRecord, "phase" | "reason">[] = [
    { phase: "pushing", reason: "in-flight" },
    { phase: "pushed", reason: "completed" },
    { phase: "pr-proposed", reason: "approval-required" },
    { phase: "creating-pr", reason: "in-flight" },
    { phase: "draft-created", reason: "completed" },
  ];
  for (const [index, step] of steps.entries())
    snapshots.recordDraftDelivery(
      {
        ...INITIAL,
        ...step,
        revision: index + 1,
        ...(step.phase === "draft-created"
          ? {
              pullRequest: {
                number: 17,
                externalId: "PR_17",
                url: "https://github.com/owner/repository/pull/17",
                repository: "owner/repository",
                headRepository: "owner/repository",
                headRef: INITIAL.binding.headRef,
                headSha: INITIAL.binding.headSha,
                baseRef: INITIAL.binding.baseRef,
                baseSha: INITIAL.binding.baseSha,
                state: "open",
                isDraft: true,
              } as const,
            }
          : {}),
      },
      index,
    );
  return snapshots;
}
export function readySnapshot(): ReadinessSnapshot {
  const counts = { total: 0, passed: 0, failed: 0, pending: 0, blocked: 0, unknown: 0 };
  return {
    schemaVersion: "1",
    runId: INITIAL.binding.runId,
    remoteDigest: INITIAL.binding.remoteDigest,
    repository: INITIAL.binding.repository,
    prNumber: 17,
    baseRef: INITIAL.binding.baseRef,
    baseSha: INITIAL.binding.baseSha,
    headRef: INITIAL.binding.headRef,
    headSha: INITIAL.binding.headSha,
    requirementsVersion: "1",
    requirementsDigest: DIGEST,
    strictBaseRequired: false,
    observedAt: AT,
    expiresAt: "2026-09-05T00:01:00.000Z",
    evidenceRef: "ci-observation-1",
    complete: true,
    state: "technical-ready",
    reason: "required-checks-passed",
    requiredChecks: counts,
    advisoryChecks: counts,
    pullRequest: { status: "open", isDraft: true, conflict: "clear", baseCurrency: "current" },
    humanReview: {
      visibility: "complete",
      requiredCount: 0,
      approvedCount: 0,
      changesRequestedCount: 0,
    },
  };
}
