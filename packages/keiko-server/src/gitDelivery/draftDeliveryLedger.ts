import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { DraftDeliveryProposal } from "./draftDeliveryTypes.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  isDraftDeliveryRecord,
  type DraftDeliveryBinding,
  type DraftDeliveryPhase,
  type DraftDeliveryReason,
  type DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import type { GitPushCommand, GitPrCreateCommand } from "@oscharko-dev/keiko-tools";
import type { DraftDeliveryRunContext, DraftDeliveryServiceOptions } from "./draftDeliveryTypes.js";
import { draftDeliveryId } from "./draftDeliveryFacts.js";
import { processServerLogSink } from "../process-log-sink.js";

export type DraftDeliveryCommand = GitPushCommand | GitPrCreateCommand;
export function draftProposalDigest(
  binding: DraftDeliveryBinding,
  command: DraftDeliveryCommand,
): string {
  return sha256Hex(canonicalise(["keiko-draft-delivery-v1", binding, command]));
}
export function draftNow(options: DraftDeliveryServiceOptions): number {
  return options.execution?.now?.() ?? Date.now();
}
export function currentDraft(
  options: DraftDeliveryServiceOptions,
  context: DraftDeliveryRunContext,
): DraftDeliveryRecord | undefined {
  return options.snapshots.get(context.runId)?.draftDelivery;
}
export function storeDraft(
  options: DraftDeliveryServiceOptions,
  context: DraftDeliveryRunContext,
  record: DraftDeliveryRecord,
  expectedRevision: number | null,
): DraftDeliveryRecord {
  if (!isDraftDeliveryRecord(record)) throw new TypeError("invalid draft delivery state");
  freezeDraftRecord(record);
  options.snapshots.recordDraftDelivery(record, expectedRevision);
  draftChanged(options, context, record);
  return record;
}
export function draftChanged(
  options: DraftDeliveryServiceOptions,
  context: DraftDeliveryRunContext,
  record: DraftDeliveryRecord,
): void {
  (options.execution?.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.draft-delivery",
    correlationId: context.correlationId,
    extra: {
      runId: context.runId,
      phase: record.phase,
      reason: record.reason,
      revision: record.revision,
      proposalId: record.proposalId,
      proposalDigest: record.proposalDigest,
      recoveryId: record.binding.recoveryId,
      headSha: record.binding.headSha,
      baseSha: record.binding.baseSha,
      remoteDigest: record.binding.remoteDigest,
      issueBindingDigest: record.binding.issueBindingDigest,
      issueIdDigest: record.binding.issueIdDigest,
      issueNumber: record.binding.issueNumber,
      verifiedCommitProposalId: record.binding.verifiedCommitProposalId,
      runtimeAuthorityDigest: record.binding.runtimeAuthorityDigest,
      envelopeDigest: record.binding.envelopeDigest,
      workspaceDigest: record.binding.workspaceDigest,
    },
  });
  options.onChanged(record);
}
export function advanceDraft(
  options: DraftDeliveryServiceOptions,
  context: DraftDeliveryRunContext,
  current: DraftDeliveryRecord,
  phase: DraftDeliveryPhase,
  reason: DraftDeliveryReason,
  pullRequest = current.pullRequest,
): DraftDeliveryRecord {
  return storeDraft(
    options,
    context,
    {
      ...current,
      phase,
      reason,
      revision: current.revision + 1,
      recordedAt: new Date(draftNow(options)).toISOString(),
      ...(pullRequest === undefined ? {} : { pullRequest }),
    },
    current.revision,
  );
}
export function proposalRecord(
  options: DraftDeliveryServiceOptions,
  binding: DraftDeliveryBinding,
  command: DraftDeliveryCommand,
  current: DraftDeliveryRecord | undefined,
): DraftDeliveryRecord {
  return {
    schemaVersion: "1",
    binding,
    revision: (current?.revision ?? -1) + 1,
    phase: command.kind === "push" ? "push-proposed" : "pr-proposed",
    reason: "approval-required",
    proposalId: draftDeliveryId("delivery"),
    proposalDigest: draftProposalDigest(binding, command),
    recordedAt: new Date(draftNow(options)).toISOString(),
    ...(current?.pullRequest === undefined ? {} : { pullRequest: current.pullRequest }),
  };
}
export function adoptDraftPredecessor(
  options: DraftDeliveryServiceOptions,
  context: DraftDeliveryRunContext,
): DraftDeliveryRecord | undefined {
  const snapshot = options.snapshots.get(context.runId);
  if (snapshot?.predecessorRunId === undefined) return undefined;
  const prior = options.snapshots.get(snapshot.predecessorRunId)?.draftDelivery;
  if (prior === undefined) return undefined;
  const record: DraftDeliveryRecord = {
    ...prior,
    revision: 0,
    phase: "recovery-required",
    reason: "restart-reconciliation",
    recordedAt: new Date(draftNow(options)).toISOString(),
    proposalId: draftDeliveryId("delivery"),
    binding: {
      ...prior.binding,
      runId: context.runId,
      runtimeAuthorityDigest: context.runtimeAuthorityDigest,
      envelopeDigest: context.envelopeDigest,
    },
  };
  freezeDraftRecord(record);
  options.snapshots.adoptDraftDeliveryFromPredecessor(record);
  draftChanged(options, context, record);
  return record;
}
export function retainedRemoteIdentity(
  current: DraftDeliveryRecord,
  pullRequest: GitPullRequestIdentity | undefined,
): GitPullRequestIdentity | undefined {
  return pullRequest ?? current.pullRequest;
}

function freezeDraftRecord(record: DraftDeliveryRecord): void {
  Object.freeze(record.binding);
  if (record.pullRequest !== undefined) Object.freeze(record.pullRequest);
  Object.freeze(record);
}

export function draftApprovalChanged(
  options: DraftDeliveryServiceOptions,
  proposal: DraftDeliveryProposal,
  phase: "approval-issued" | "approval-consumed",
): void {
  (options.execution?.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git.draft-delivery",
    correlationId: options.context()?.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: {
      runId: proposal.record.binding.runId,
      phase,
      proposalId: proposal.record.proposalId,
      proposalDigest: proposal.record.proposalDigest,
    },
  });
}
