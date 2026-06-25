// Governed Git mutation EVIDENCE builder (Issue #474, Epic #470). Projects the #472 kernel's
// GitMutationLifecycleResult into the content-free, redacted-by-construction GitDeliveryEvidenceRecord
// the keiko-contracts evidence atom defines. This is the producer the orchestrator's idempotency
// journal comment anticipates ("a durable journal — the evidence ledger, #474"), except it records
// EVERY terminal outcome (succeeded, blocked, rejected, failed, recovery-required, approval-required),
// not only succeeded retries.
//
// PURE: a deterministic function of (lifecycle result, content-free snapshot, correlation, injected
// deps). No IO, no clock, no randomness — the clock and the hash are injected. Hashing uses the
// shared keiko-security sha256Hex so remote identifiers, the provider external id, and the repository
// identity become opaque hashes (AC2) rather than raw artifacts. Local branch names are retained as
// content-free repository context, consistent with the #473 action-sheet projection.
//
// The kernel's lifecycle-phase and outcome vocabularies are mapped onto the contract's self-contained
// mirrors with exhaustive switches/tables, so a divergence between the kernel and the contract is a
// compile error here rather than a silent audit gap.

import type {
  GitDeliveryActionEnvelope,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryEvidenceApproval,
  GitDeliveryEvidenceCorrelation,
  GitDeliveryEvidenceExecution,
  GitDeliveryEvidenceLifecyclePhase,
  GitDeliveryEvidenceOutcomeClass,
  GitDeliveryEvidencePreviewSummary,
  GitDeliveryEvidenceRecord,
  GitDeliveryEvidenceRef,
  GitDeliveryEvidenceRepoContext,
  GitDeliveryExecutionErrorCode,
  GitDeliveryExecutionResult,
  GitDeliveryRecoveryActionHint,
  GitDeliveryRecoveryMetadata,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  gitDeliveryRecoveryDispositionForBlockReason,
  gitDeliveryRecoveryDispositionForExecutionError,
  gitDeliveryRiskClassForInputs,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  GitMutationLifecycleResult,
  GitMutationOutcome,
} from "./git-mutation-orchestrator.js";
import type { GitMutationLifecyclePhase } from "./git-mutation-taxonomy.js";
import type { GitPreflightFinding, GitPreflightFindingCode } from "./git-mutation-preflight.js";

// ─── Build input + dependencies ─────────────────────────────────────────────────────────────

export interface GitDeliveryEvidenceBuildInput {
  readonly result: GitMutationLifecycleResult;
  // The content-free snapshot the lifecycle ran against (repository context for the record).
  readonly snapshot: GitDeliveryEvidenceSnapshot;
  // The triggering workflow run id (raw; hashed into the correlation so the ledger correlates without
  // recording a raw identifier).
  readonly workflowRunId: string;
  // The repository path/identity (raw; hashed into repoContext.repoIdHash). Optional.
  readonly repoId?: string | undefined;
  readonly attemptSequence?: number | undefined;
  readonly evidenceRef?: GitDeliveryEvidenceRef | undefined;
}

// The subset of the kernel worktree snapshot the evidence record consumes for repository context.
// Declared locally (rather than importing the kernel snapshot) so the builder depends only on the
// content-free fields it records.
export interface GitDeliveryEvidenceSnapshot {
  readonly headDetached: boolean;
  readonly currentBranchName?: string | undefined;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
}

export interface GitDeliveryEvidenceBuildDeps {
  readonly now: () => number;
  // Injected hash; defaults to keiko-security sha256Hex. Overridable for deterministic tests.
  readonly hash?: ((input: string) => string) | undefined;
}

// ─── Phase + outcome-class mapping (exhaustive) ────────────────────────────────────────────────

function mapLifecyclePhase(phase: GitMutationLifecyclePhase): GitDeliveryEvidenceLifecyclePhase {
  switch (phase) {
    case "resolve":
      return "resolve";
    case "preflight":
      return "preflight";
    case "preview":
      return "preview";
    case "policy":
      return "policy";
    case "execute":
      return "execute";
    case "result":
      return "result";
    default:
      return assertNever(phase);
  }
}

function outcomeClassFor(outcome: GitMutationOutcome): GitDeliveryEvidenceOutcomeClass {
  switch (outcome.status) {
    case "succeeded":
      return "succeeded";
    case "approval-required":
      return "approval-required";
    case "blocked":
      return "blocked";
    case "recovery-required":
      return "recovery-required";
    case "failed":
      // A provider rejection is a "rejected" attempt; every other failure (network, timeout,
      // internal) is a transient "failed" attempt.
      return outcome.executionResult.errorCode === "provider-rejected" ? "rejected" : "failed";
    default:
      return assertNever(outcome);
  }
}

// ─── Recovery-metadata derivation (AC3) ─────────────────────────────────────────────────────────
// Action hints REUSE the #473 GitDeliveryRecoveryActionHint vocabulary. Every table is exhaustive
// over its closed contract/kernel vocabulary, so a new code forces an explicit classification here.

const ACTION_HINT_BY_BLOCK_REASON: Readonly<
  Record<GitDeliveryBlockReason, GitDeliveryRecoveryActionHint>
> = {
  "policy-pack-blocked": "adjust-policy-target",
  "protected-branch": "adjust-policy-target",
  "provider-capability-absent": "adjust-policy-target",
  "approval-expired": "request-approval",
  "risk-class-ceiling": "adjust-policy-target",
  "no-applicable-rule": "adjust-policy-target",
} as const;

const ACTION_HINT_BY_EXECUTION_ERROR: Readonly<
  Record<GitDeliveryExecutionErrorCode, GitDeliveryRecoveryActionHint>
> = {
  // A provider rejection is most often a diverged/non-fast-forward ref; resolving the divergence is
  // the operator's fix. The provider execution slices (#477/#478) may refine this.
  "provider-rejected": "resolve-conflicts",
  "network-failure": "wait-for-provider",
  conflict: "resolve-conflicts",
  "precondition-failed": "resolve-conflicts",
  timeout: "retry",
  "internal-error": "retry",
} as const;

const ACTION_HINT_BY_PREFLIGHT_FINDING: Readonly<
  Record<GitPreflightFindingCode, GitDeliveryRecoveryActionHint>
> = {
  "detached-head": "recover-via-strategy",
  "branch-already-exists": "retry",
  "base-branch-missing": "retry",
  "no-changes-to-stage": "stage-changes",
  "nothing-staged-to-unstage": "stage-changes",
  "nothing-staged-to-commit": "stage-changes",
  "untracked-files-impacted": "stage-changes",
  "no-upstream-configured": "configure-upstream",
  "nothing-to-push": "retry",
  "remote-alias-missing": "configure-upstream",
  "remote-unreachable": "wait-for-provider",
  "operation-in-progress": "abort-in-progress-operation",
  "no-operation-to-abort": "retry",
  "recovery-target-unset": "recover-via-strategy",
  "dirty-worktree-impacts-recovery": "recover-via-strategy",
} as const;

function recoveryForBlockReason(reason: GitDeliveryBlockReason): GitDeliveryRecoveryMetadata {
  return {
    disposition: gitDeliveryRecoveryDispositionForBlockReason(reason),
    actionHint: ACTION_HINT_BY_BLOCK_REASON[reason],
    blockReason: reason,
  };
}

function recoveryForPreflight(
  findings: readonly GitPreflightFinding[],
): GitDeliveryRecoveryMetadata {
  // A blocked-by-preflight attempt is user-fixable: the operator changes the named repository
  // condition. The dominant (first, deterministic order) blocking finding names the action.
  const code = findings[0]?.code;
  return {
    disposition: "user-fixable",
    ...(code !== undefined ? { actionHint: ACTION_HINT_BY_PREFLIGHT_FINDING[code] } : {}),
  };
}

function recoveryForExecution(result: GitDeliveryExecutionResult): GitDeliveryRecoveryMetadata {
  const code = result.errorCode ?? "internal-error";
  return {
    disposition: gitDeliveryRecoveryDispositionForExecutionError(code),
    actionHint: ACTION_HINT_BY_EXECUTION_ERROR[code],
    ...(result.errorCode !== undefined ? { executionErrorCode: result.errorCode } : {}),
  };
}

function recoveryForRecoveryRequired(
  result: GitDeliveryExecutionResult,
  inputs: GitDeliveryResolvedInputs,
): GitDeliveryRecoveryMetadata {
  const strategy = inputs.kind === "recovery" ? inputs.recoveryStrategyHint : undefined;
  return {
    disposition: "user-fixable",
    actionHint: "recover-via-strategy",
    ...(result.errorCode !== undefined ? { executionErrorCode: result.errorCode } : {}),
    ...(strategy !== undefined ? { suggestedRecoveryStrategy: strategy } : {}),
  };
}

function recoveryFor(
  outcome: GitMutationOutcome,
  inputs: GitDeliveryResolvedInputs,
): GitDeliveryRecoveryMetadata {
  switch (outcome.status) {
    case "succeeded":
      return { disposition: "none" };
    case "approval-required":
      return { disposition: "user-fixable", actionHint: "request-approval" };
    case "blocked":
      return outcome.category === "policy-block"
        ? recoveryForBlockReason(outcome.blockReason)
        : recoveryForPreflight(outcome.findings);
    case "failed":
      return recoveryForExecution(outcome.executionResult);
    case "recovery-required":
      return recoveryForRecoveryRequired(outcome.executionResult, inputs);
    default:
      return assertNever(outcome);
  }
}

// ─── Section projections ─────────────────────────────────────────────────────────────────────

// Branch names are echoed raw into the audit record (they are git refs, not secrets). Strip
// bidirectional/zero-width/BOM format characters so a crafted ref cannot visually spoof which branch
// an audit row refers to when the export is rendered. Mirrors the action-sheet route's boundary
// scanner; git ref rules already bar C0/C1 controls and spaces, so only the format-char set is removed.
const UNSAFE_FORMAT_CHARS = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]",
  "gu",
);

function sanitizeRef(value: string): string {
  return value.replace(UNSAFE_FORMAT_CHARS, "");
}

function approvalFor(approval: GitDeliveryApprovalRequirement): GitDeliveryEvidenceApproval {
  if (!approval.required) {
    return { required: false };
  }
  return {
    required: true,
    approvalTokenHash: approval.approvalTokenHash,
    approvedByUserId: approval.approvedByUserId,
    approvedAtMs: approval.approvedAtMs,
    ...(approval.expiresAtMs !== undefined ? { expiresAtMs: approval.expiresAtMs } : {}),
  };
}

function previewFor(
  preview: GitDeliveryActionEnvelope["preview"],
): GitDeliveryEvidencePreviewSummary | undefined {
  if (preview === undefined) {
    return undefined;
  }
  return {
    ...(preview.affectedBranchName !== undefined
      ? { affectedBranchName: sanitizeRef(preview.affectedBranchName) }
      : {}),
    ...(preview.estimatedFileCount !== undefined
      ? { estimatedFileCount: preview.estimatedFileCount }
      : {}),
    ...(preview.estimatedBytesDelta !== undefined
      ? { estimatedBytesDelta: preview.estimatedBytesDelta }
      : {}),
    wouldCreateRemoteBranch: preview.wouldCreateRemoteBranch,
    wouldTriggerChecks: preview.wouldTriggerChecks,
  };
}

function executionFor(
  result: GitDeliveryExecutionResult | undefined,
  hash: (input: string) => string,
): GitDeliveryEvidenceExecution | undefined {
  if (result === undefined) {
    return undefined;
  }
  return {
    outcome: result.outcome,
    durationMs: result.durationMs,
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.partialDetail !== undefined
      ? {
          attemptedUnitCount: result.partialDetail.attemptedUnitCount,
          succeededUnitCount: result.partialDetail.succeededUnitCount,
        }
      : {}),
    ...(result.externalId !== undefined ? { externalIdHash: hash(result.externalId) } : {}),
  };
}

function repoContextFor(
  inputs: GitDeliveryResolvedInputs,
  snapshot: GitDeliveryEvidenceSnapshot,
  repoId: string | undefined,
  hash: (input: string) => string,
): GitDeliveryEvidenceRepoContext {
  const target = inputs.kind === "branch-create" ? inputs.branchName : snapshot.currentBranchName;
  return {
    ...(repoId !== undefined ? { repoIdHash: hash(repoId) } : {}),
    ...(target !== undefined ? { targetBranchName: sanitizeRef(target) } : {}),
    headDetached: snapshot.headDetached,
    stagedFileCount: snapshot.stagedFileCount,
    unstagedFileCount: snapshot.unstagedFileCount,
    untrackedFileCount: snapshot.untrackedFileCount,
    ...(inputs.kind === "push"
      ? { remoteRefHash: hash(`${inputs.remoteAlias}/${inputs.remoteBranchName}`) }
      : {}),
  };
}

// ─── Policy fields ─────────────────────────────────────────────────────────────────────────────

interface PolicyFields {
  readonly blockReason?: GitDeliveryBlockReason | undefined;
  readonly requiredApprovers?: readonly string[] | undefined;
}

function effectiveBlockReason(
  envelope: GitDeliveryActionEnvelope,
  outcome: GitMutationOutcome,
): GitDeliveryBlockReason | undefined {
  if (outcome.status === "blocked" && outcome.category === "policy-block") {
    return outcome.blockReason;
  }
  // The kernel evaluates policy eagerly (prepareLifecycle) even when preflight halts the lifecycle
  // first, so a preflight-blocked envelope can still carry a "blocked" policyDecision that was never
  // the terminal enforcement. Recording that policy reason here would contradict the preflight
  // disposition, so a preflight-blocked attempt (the only remaining "blocked" category) carries no
  // policy block reason — its cause is a preflight finding, reflected in recovery.actionHint and
  // phaseReached === "preflight".
  if (outcome.status === "blocked") {
    return undefined;
  }
  return envelope.policyDecision.outcome === "blocked" ? envelope.policyDecision.reason : undefined;
}

function effectiveApprovers(
  envelope: GitDeliveryActionEnvelope,
  outcome: GitMutationOutcome,
): readonly string[] | undefined {
  if (envelope.policyDecision.outcome === "approval-gated") {
    return envelope.policyDecision.requiredApprovers;
  }
  return outcome.status === "approval-required" ? outcome.requiredApprovers : undefined;
}

function policyFieldsFor(
  envelope: GitDeliveryActionEnvelope,
  outcome: GitMutationOutcome,
): PolicyFields {
  const blockReason = effectiveBlockReason(envelope, outcome);
  const requiredApprovers = effectiveApprovers(envelope, outcome);
  return {
    ...(blockReason !== undefined ? { blockReason } : {}),
    ...(requiredApprovers !== undefined ? { requiredApprovers } : {}),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────────────────────

export function buildGitDeliveryEvidenceRecord(
  input: GitDeliveryEvidenceBuildInput,
  deps: GitDeliveryEvidenceBuildDeps,
): GitDeliveryEvidenceRecord {
  const hash = deps.hash ?? sha256Hex;
  const { envelope, outcome, phaseReached } = input.result;
  const inputs = envelope.resolvedInputs;
  const riskClass = gitDeliveryRiskClassForInputs(inputs);
  const workflowRunIdHash = hash(input.workflowRunId);
  const evidenceId = `gde-${hash(`${workflowRunIdHash}:${envelope.actionId}`).slice(0, 40)}`;
  const correlation: GitDeliveryEvidenceCorrelation = {
    workflowRunIdHash,
    actionId: envelope.actionId,
    ...(input.attemptSequence !== undefined ? { attemptSequence: input.attemptSequence } : {}),
  };
  const preview = previewFor(envelope.preview);
  const execution = executionFor(envelope.executionResult, hash);
  return {
    schemaVersion: GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
    evidenceId,
    actionKind: envelope.kind,
    riskClass,
    riskSeverity: GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass],
    outcomeClass: outcomeClassFor(outcome),
    phaseReached: mapLifecyclePhase(phaseReached),
    policyOutcome: envelope.policyDecision.outcome,
    ...policyFieldsFor(envelope, outcome),
    correlation,
    approval: approvalFor(envelope.approvalRequirement),
    ...(preview !== undefined ? { preview } : {}),
    ...(execution !== undefined ? { execution } : {}),
    repoContext: repoContextFor(inputs, input.snapshot, input.repoId, hash),
    recovery: recoveryFor(outcome, inputs),
    recordedAtMs: deps.now(),
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled git mutation evidence variant: ${JSON.stringify(value)}`);
}
