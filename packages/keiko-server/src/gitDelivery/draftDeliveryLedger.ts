import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type {
  DraftDeliveryProposal,
  DraftDeliveryRunContext,
  DraftDeliveryServiceOptions,
} from "./draftDeliveryTypes.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  isDraftDeliveryRecord,
  type DraftDeliveryBinding,
  type DraftDeliveryPhase,
  type DraftDeliveryReason,
  type DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import type { GitPushCommand, GitPrCreateCommand } from "@oscharko-dev/keiko-tools";
import { draftDeliveryId } from "./draftDeliveryFacts.js";
import { processServerLogSink } from "../process-log-sink.js";
import { draftDeliveryLineageRecord } from "../coding-runtime/codingRuntimeDraftDeliverySource.js";

const DRAFT_DELIVERY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.draft-delivery",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/draftDeliveryLedger.logDraftDeliveryActivity",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "push-proposed",
        "pushing",
        "pushed",
        "pr-proposed",
        "creating-pr",
        "draft-created",
        "recovery-required",
        "approval-issued",
        "approval-consumed",
        "approval",
        "refused",
        "failed",
      ],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "approval-required",
        "in-flight",
        "completed",
        "authority-denied",
        "remote-drift",
        "issue-drift",
        "provider-failed",
        "ambiguous-remote",
        "approval-invalid",
        "payload-changed",
        "restart-reconciliation",
        "preflight-failed",
        "operation-in-flight",
        "policy-authorized",
      ],
    },
    revision: { type: "integer", dataClass: "count", required: false },
    proposalId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    proposalDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    recoveryId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    headSha: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    baseSha: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    remoteDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    issueBindingDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    issueIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    issueNumber: { type: "integer", dataClass: "count", required: false },
    verifiedCommitProposalId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    runtimeAuthorityDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    envelopeDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    workspaceDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-draft-delivery"],
  proofIds: ["git.draft-delivery"],
  releaseImpact: "patch",
});

export interface DraftDeliveryActivityFields {
  readonly runId: string;
  readonly phase:
    | DraftDeliveryPhase
    | "approval-issued"
    | "approval-consumed"
    | "approval"
    | "refused"
    | "failed";
  readonly reason?: DraftDeliveryReason | "operation-in-flight" | "policy-authorized";
  readonly revision?: number;
  readonly proposalId?: string;
  readonly proposalDigest?: string;
  readonly recoveryId?: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly remoteDigest?: string;
  readonly issueBindingDigest?: string;
  readonly issueIdDigest?: string;
  readonly issueNumber?: number;
  readonly verifiedCommitProposalId?: string;
  readonly runtimeAuthorityDigest?: string;
  readonly envelopeDigest?: string;
  readonly workspaceDigest?: string;
  readonly failureKind?: string;
  readonly errorClass?: string;
  readonly code?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

export function logDraftDeliveryActivity(
  options: DraftDeliveryServiceOptions,
  correlationId: string,
  fields: DraftDeliveryActivityFields,
  failure?: { readonly errorKind: ActivityLogErrorKind },
): void {
  (options.execution?.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      DRAFT_DELIVERY_OPERATION,
      {
        correlationId,
        ...(failure === undefined ? {} : { level: "warn", errorKind: failure.errorKind }),
      },
      fields,
    ),
  );
}

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
  logDraftDeliveryActivity(options, context.correlationId, {
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
  const prior = draftDeliveryLineageRecord(snapshot, (runId) =>
    options.snapshots.get(runId),
  )?.record;
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
  logDraftDeliveryActivity(options, options.context()?.correlationId ?? UNKNOWN_CORRELATION_ID, {
    runId: proposal.record.binding.runId,
    phase,
    proposalId: proposal.record.proposalId,
    proposalDigest: proposal.record.proposalDigest,
  });
}
