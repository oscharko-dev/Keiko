// Public type contracts for the governed Git delivery surface (Issue #471, Epic #470).
// Ownership: git-delivery domain. Disjoint from workflow-handoff.ts (one-shot agent invocation)
// and editor-agent.ts (editor bridge). Leaf-package rules (ADR-0019): pure types and frozen
// const tables only. No IO, no clock, no crypto, no randomness. Opaque hex hashes are produced
// by callers (sha256Hex in stableId.ts or equivalent). Relative imports end in ".js".
//
// This is the CORE atom module for the git-delivery surface. It imports NOTHING from its two
// siblings (git-delivery-policy.ts / git-delivery-provider.ts). The siblings import FROM here, so
// the dependency graph is a one-directional DAG with no cycles (verified by arch:check). The only
// internal import is `./workflow-handoff.js` for `isApprovalTokenShape` (a legal intra-package
// relative import; keiko-contracts modules may reference each other).

import { isApprovalTokenShape } from "./workflow-handoff.js";

export const GIT_DELIVERY_SCHEMA_VERSION = "1" as const;

// ─── Action kinds ─────────────────────────────────────────────────────────────

export type GitDeliveryActionKind =
  | "branch-create"
  | "branch-switch"
  | "stage"
  | "unstage"
  | "commit"
  | "push"
  | "pr-create"
  | "pr-update"
  | "merge"
  | "abort"
  | "recovery";

export const GIT_DELIVERY_ACTION_KINDS: readonly GitDeliveryActionKind[] = [
  "branch-create",
  "branch-switch",
  "stage",
  "unstage",
  "commit",
  "push",
  "pr-create",
  "pr-update",
  "merge",
  "abort",
  "recovery",
] as const;

// ─── Risk taxonomy ────────────────────────────────────────────────────────────
// AC2: severity is DATA, never inferred from kind names or shell arguments.
// Read GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass] to compare severity numerically.

export type GitDeliveryRiskClass =
  "local-mutation" | "publish" | "protected-or-merge" | "recovery-or-rewrite";

export const GIT_DELIVERY_RISK_CLASSES: readonly GitDeliveryRiskClass[] = [
  "local-mutation",
  "publish",
  "protected-or-merge",
  "recovery-or-rewrite",
] as const;

// Ordinal severity. Higher ordinal = higher risk. Never compare ordinals by action name string.
export const GIT_DELIVERY_RISK_CLASS_SEVERITY: Readonly<Record<GitDeliveryRiskClass, number>> = {
  "local-mutation": 1,
  publish: 2,
  "protected-or-merge": 3,
  "recovery-or-rewrite": 4,
} as const;

// Default risk class per action kind. Keys are ordered to match GIT_DELIVERY_ACTION_KINDS exactly.
// Unknown kinds (post-deserialization) default to the highest class via gitDeliveryDefaultRiskClass
// — this table covers all known kinds exactly.
export const GIT_DELIVERY_ACTION_RISK_DEFAULTS: Readonly<
  Record<GitDeliveryActionKind, GitDeliveryRiskClass>
> = {
  "branch-create": "local-mutation",
  "branch-switch": "local-mutation",
  stage: "local-mutation",
  unstage: "local-mutation",
  commit: "local-mutation",
  push: "publish",
  "pr-create": "protected-or-merge",
  "pr-update": "protected-or-merge",
  merge: "protected-or-merge",
  abort: "local-mutation",
  recovery: "recovery-or-rewrite",
} as const;

// ─── Per-kind resolved inputs (discriminated union) ─────────────────────────────
// Each member is a separate readonly interface. Only fields semantically required for that kind
// appear — no kind leaks another kind's fields.

export interface GitDeliveryBranchCreateInputs {
  readonly kind: "branch-create";
  readonly branchName: string;
  readonly baseBranchName: string;
  readonly startPointRefHash: string; // opaque commit SHA
}

// A local checkout of an EXISTING branch (no new ref is created — that is branch-create). Carries the
// target branch name in the clear, consistent with the snapshot's branch-name policy.
export interface GitDeliveryBranchSwitchInputs {
  readonly kind: "branch-switch";
  readonly branchName: string;
}

export interface GitDeliveryStageInputs {
  readonly kind: "stage";
  readonly pathCount: number; // count only — no raw paths in the contract layer
  readonly includesUntracked: boolean;
}

export interface GitDeliveryUnstageInputs {
  readonly kind: "unstage";
  readonly pathCount: number;
}

export interface GitDeliveryCommitInputs {
  readonly kind: "commit";
  readonly messageByteLength: number; // length, not content
  readonly stagedPathCount: number;
  readonly allowEmptyCommit: boolean;
}

export interface GitDeliveryPushInputs {
  readonly kind: "push";
  readonly sourceBranchName: string;
  readonly remoteAlias: string;
  readonly remoteBranchName: string;
  readonly forcePush: boolean;
  readonly setUpstreamTracking: boolean;
}

export interface GitDeliveryPrCreateInputs {
  readonly kind: "pr-create";
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly titleByteLength: number;
  readonly bodyByteLength: number;
  readonly isDraft: boolean;
}

export interface GitDeliveryPrUpdateInputs {
  readonly kind: "pr-update";
  readonly prExternalId: string; // opaque provider-assigned ID
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly titleByteLength: number;
  readonly bodyByteLength: number;
  readonly convertToDraft: boolean;
  readonly convertFromDraft: boolean;
}

export type GitDeliveryMergeStrategyHint =
  "squash" | "rebase" | "merge-commit" | "provider-default";

export const GIT_DELIVERY_MERGE_STRATEGY_HINTS: readonly GitDeliveryMergeStrategyHint[] = [
  "squash",
  "rebase",
  "merge-commit",
  "provider-default",
] as const;

export interface GitDeliveryMergeInputs {
  readonly kind: "merge";
  readonly prExternalId: string;
  readonly mergeStrategyHint: GitDeliveryMergeStrategyHint;
  readonly deleteBranchAfterMerge: boolean;
}

export type GitDeliveryAbortableOperation =
  "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export const GIT_DELIVERY_ABORTABLE_OPERATIONS: readonly GitDeliveryAbortableOperation[] = [
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "bisect",
] as const;

export interface GitDeliveryAbortInputs {
  readonly kind: "abort";
  readonly operationToAbort: GitDeliveryAbortableOperation;
  readonly preserveIndexChanges: boolean;
}

export type GitDeliveryRecoveryStrategyHint =
  "soft-reset" | "mixed-reset" | "stash-and-reset" | "restore-index";

export const GIT_DELIVERY_RECOVERY_STRATEGY_HINTS: readonly GitDeliveryRecoveryStrategyHint[] = [
  "soft-reset",
  "mixed-reset",
  "stash-and-reset",
  "restore-index",
] as const;

// Recovery's elevated-approval requirement is expressed by policyDecision / approvalRequirement on
// the envelope, NOT by an operator-approval token in the inputs.
export interface GitDeliveryRecoveryInputs {
  readonly kind: "recovery";
  readonly recoveryStrategyHint: GitDeliveryRecoveryStrategyHint;
  readonly targetRefHash: string; // opaque commit SHA
  readonly affectedPathCount: number;
}

// The discriminated union. Exhaustive on kind.
export type GitDeliveryResolvedInputs =
  | GitDeliveryBranchCreateInputs
  | GitDeliveryBranchSwitchInputs
  | GitDeliveryStageInputs
  | GitDeliveryUnstageInputs
  | GitDeliveryCommitInputs
  | GitDeliveryPushInputs
  | GitDeliveryPrCreateInputs
  | GitDeliveryPrUpdateInputs
  | GitDeliveryMergeInputs
  | GitDeliveryAbortInputs
  | GitDeliveryRecoveryInputs;

// ─── Approval-intent model ──────────────────────────────────────────────────────
// Discriminated on `required`. Reuses isApprovalTokenShape (workflow-handoff.ts).

export interface GitDeliveryApprovalNotRequired {
  readonly required: false;
}

export interface GitDeliveryApprovalGranted {
  readonly required: true;
  // Hash of the approval token, not the token itself. Validated by isApprovalTokenShape (64-hex).
  readonly approvalTokenHash: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs?: number | undefined;
}

export type GitDeliveryApprovalRequirement =
  GitDeliveryApprovalNotRequired | GitDeliveryApprovalGranted;

// ─── Provider capability (owned here per ADR-0019 cycle-break) ───────────────────
// Owned by the core atom so both policy.ts (constraint) and provider.ts (descriptor) can import it
// without a cycle.

export type GitDeliveryProviderCapability =
  "branch-protection" | "draft-pr" | "required-checks" | "merge-queue" | "protected-branch-delete";

export const GIT_DELIVERY_PROVIDER_CAPABILITIES: readonly GitDeliveryProviderCapability[] = [
  "branch-protection",
  "draft-pr",
  "required-checks",
  "merge-queue",
  "protected-branch-delete",
] as const;

// ─── Typed branch patterns (AC3 — structured data, not parsed strings) ───────────
// Closed match set: exact, prefix. Glob is intentionally EXCLUDED to keep the leaf parse-free
// (documented in ADR-0058).

export type GitDeliveryBranchMatchKind = "exact" | "prefix";

export const GIT_DELIVERY_BRANCH_MATCH_KINDS: readonly GitDeliveryBranchMatchKind[] = [
  "exact",
  "prefix",
] as const;

export interface GitDeliveryBranchPattern {
  readonly matchKind: GitDeliveryBranchMatchKind;
  readonly value: string;
}

export interface GitDeliveryBranchPatternConstraint {
  readonly kind: "branch-pattern";
  readonly patterns: readonly GitDeliveryBranchPattern[];
}

export interface GitDeliveryProviderCapabilityConstraint {
  readonly kind: "provider-capability";
  readonly capability: GitDeliveryProviderCapability;
}

// A genuine ceiling: actions whose default risk class severity EXCEEDS maxRiskClass are out of
// bounds. (Replaces the misnamed/circular "min-risk-class" constraint.)
export interface GitDeliveryRiskClassCeilingConstraint {
  readonly kind: "risk-class-ceiling";
  readonly maxRiskClass: GitDeliveryRiskClass;
}

export type GitDeliveryConstraint =
  | GitDeliveryBranchPatternConstraint
  | GitDeliveryProviderCapabilityConstraint
  | GitDeliveryRiskClassCeilingConstraint;

// ─── Policy decision ────────────────────────────────────────────────────────────

export type GitDeliveryBlockReason =
  | "policy-pack-blocked"
  | "protected-branch"
  | "provider-capability-absent"
  | "approval-expired"
  | "risk-class-ceiling"
  | "no-applicable-rule"; // fail-closed when neither level has a rule or defaultRule

export const GIT_DELIVERY_BLOCK_REASONS: readonly GitDeliveryBlockReason[] = [
  "policy-pack-blocked",
  "protected-branch",
  "provider-capability-absent",
  "approval-expired",
  "risk-class-ceiling",
  "no-applicable-rule",
] as const;

export type GitDeliveryMergeBlockReason =
  | "checks-failing"
  | "approvals-missing"
  | "conflicts"
  | "branch-protection"
  | "merge-queue-position"
  | "provider-policy";

export const GIT_DELIVERY_MERGE_BLOCK_REASONS: readonly GitDeliveryMergeBlockReason[] = [
  "checks-failing",
  "approvals-missing",
  "conflicts",
  "branch-protection",
  "merge-queue-position",
  "provider-policy",
] as const;

export type GitDeliveryPolicyDecision =
  | { readonly outcome: "allowed" }
  | { readonly outcome: "blocked"; readonly reason: GitDeliveryBlockReason }
  | { readonly outcome: "approval-gated"; readonly requiredApprovers: readonly string[] }
  | { readonly outcome: "constrained"; readonly constraints: readonly GitDeliveryConstraint[] };

// ─── Preview and result (content-free) ──────────────────────────────────────────
// Content-free preview descriptor: counts, flags, affected branch name only. Never carries diff
// content, file paths, secrets, or command strings.

export interface GitDeliveryActionPreview {
  readonly schemaVersion: typeof GIT_DELIVERY_SCHEMA_VERSION;
  readonly affectedBranchName?: string | undefined;
  readonly estimatedFileCount?: number | undefined;
  readonly estimatedBytesDelta?: number | undefined;
  readonly wouldCreateRemoteBranch: boolean;
  readonly wouldTriggerChecks: boolean;
}

export type GitDeliveryExecutionOutcome = "succeeded" | "failed" | "aborted" | "partial";

export const GIT_DELIVERY_EXECUTION_OUTCOMES: readonly GitDeliveryExecutionOutcome[] = [
  "succeeded",
  "failed",
  "aborted",
  "partial",
] as const;

export type GitDeliveryExecutionErrorCode =
  | "provider-rejected"
  | "network-failure"
  | "conflict"
  | "precondition-failed"
  | "timeout"
  | "internal-error";

export const GIT_DELIVERY_EXECUTION_ERROR_CODES: readonly GitDeliveryExecutionErrorCode[] = [
  "provider-rejected",
  "network-failure",
  "conflict",
  "precondition-failed",
  "timeout",
  "internal-error",
] as const;

export interface GitDeliveryPartialDetail {
  readonly attemptedUnitCount: number;
  readonly succeededUnitCount: number;
}

export interface GitDeliveryExecutionResult {
  readonly schemaVersion: typeof GIT_DELIVERY_SCHEMA_VERSION;
  readonly outcome: GitDeliveryExecutionOutcome;
  readonly durationMs: number;
  // Opaque provider-assigned external ID (e.g. PR number, commit SHA) — never raw output.
  readonly externalId?: string | undefined;
  readonly errorCode?: GitDeliveryExecutionErrorCode | undefined;
  readonly partialDetail?: GitDeliveryPartialDetail | undefined;
}

// Content-free evidence reference. Never raw diffs, command output, or secrets. Field naming aligns
// with evidence.ts (EvidenceGovernedWorkflowHandoff): sourceGroundedRunId + manifest stable-id hash.
export interface GitDeliveryEvidenceRef {
  readonly sourceGroundedRunId: string;
  readonly evidenceManifestStableIdHash: string; // SHA-256 hex
}

// ─── Lifecycle envelope (AC1) ───────────────────────────────────────────────────
// Sound discriminated union: kind === resolvedInputs.kind holds by construction. Each member is
// parameterised by its per-kind resolved-input type; GitDeliveryActionEnvelope is the union over
// all ten members.

export interface GitDeliveryActionEnvelopeFor<I extends GitDeliveryResolvedInputs> {
  readonly schemaVersion: typeof GIT_DELIVERY_SCHEMA_VERSION;
  readonly actionId: string;
  readonly kind: I["kind"];
  readonly resolvedInputs: I;
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
  readonly preview?: GitDeliveryActionPreview | undefined;
  readonly executionResult?: GitDeliveryExecutionResult | undefined;
  readonly evidenceRef?: GitDeliveryEvidenceRef | undefined;
}

export type GitDeliveryActionEnvelope =
  | GitDeliveryActionEnvelopeFor<GitDeliveryBranchCreateInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryBranchSwitchInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryStageInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryUnstageInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryCommitInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryPushInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryPrCreateInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryPrUpdateInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryMergeInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryAbortInputs>
  | GitDeliveryActionEnvelopeFor<GitDeliveryRecoveryInputs>;

// ─── Shared parse-result discriminated union ─────────────────────────────────────
// Defined ONCE here; policy/provider parsers reuse it.

export type GitDeliveryParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

// ─── Private predicate helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isUndefinedOr<T>(check: (v: unknown) => v is T): (v: unknown) => v is T | undefined {
  return (v: unknown): v is T | undefined => v === undefined || check(v);
}

// ─── Exported guards ─────────────────────────────────────────────────────────────

export function isGitDeliveryActionKind(value: unknown): value is GitDeliveryActionKind {
  return isString(value) && (GIT_DELIVERY_ACTION_KINDS as readonly string[]).includes(value);
}

export function isGitDeliveryRiskClass(value: unknown): value is GitDeliveryRiskClass {
  return isString(value) && (GIT_DELIVERY_RISK_CLASSES as readonly string[]).includes(value);
}

export function isGitDeliveryProviderCapability(
  value: unknown,
): value is GitDeliveryProviderCapability {
  return (
    isString(value) && (GIT_DELIVERY_PROVIDER_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isGitDeliveryBranchMatchKind(value: unknown): value is GitDeliveryBranchMatchKind {
  return isString(value) && (GIT_DELIVERY_BRANCH_MATCH_KINDS as readonly string[]).includes(value);
}

export function isGitDeliveryBlockReason(value: unknown): value is GitDeliveryBlockReason {
  return isString(value) && (GIT_DELIVERY_BLOCK_REASONS as readonly string[]).includes(value);
}

export function isGitDeliveryMergeBlockReason(
  value: unknown,
): value is GitDeliveryMergeBlockReason {
  return isString(value) && (GIT_DELIVERY_MERGE_BLOCK_REASONS as readonly string[]).includes(value);
}

export function isGitDeliveryMergeStrategyHint(
  value: unknown,
): value is GitDeliveryMergeStrategyHint {
  return (
    isString(value) && (GIT_DELIVERY_MERGE_STRATEGY_HINTS as readonly string[]).includes(value)
  );
}

export function isGitDeliveryAbortableOperation(
  value: unknown,
): value is GitDeliveryAbortableOperation {
  return (
    isString(value) && (GIT_DELIVERY_ABORTABLE_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isGitDeliveryRecoveryStrategyHint(
  value: unknown,
): value is GitDeliveryRecoveryStrategyHint {
  return (
    isString(value) && (GIT_DELIVERY_RECOVERY_STRATEGY_HINTS as readonly string[]).includes(value)
  );
}

export function isGitDeliveryExecutionOutcome(
  value: unknown,
): value is GitDeliveryExecutionOutcome {
  return isString(value) && (GIT_DELIVERY_EXECUTION_OUTCOMES as readonly string[]).includes(value);
}

export function isGitDeliveryExecutionErrorCode(
  value: unknown,
): value is GitDeliveryExecutionErrorCode {
  return (
    isString(value) && (GIT_DELIVERY_EXECUTION_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isGitDeliveryBranchPattern(value: unknown): value is GitDeliveryBranchPattern {
  return (
    isRecord(value) &&
    isGitDeliveryBranchMatchKind(value.matchKind) &&
    isNonEmptyString(value.value)
  );
}

export function isGitDeliveryConstraint(value: unknown): value is GitDeliveryConstraint {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "branch-pattern") {
    return Array.isArray(value.patterns) && value.patterns.every(isGitDeliveryBranchPattern);
  }
  if (value.kind === "provider-capability") {
    return isGitDeliveryProviderCapability(value.capability);
  }
  if (value.kind === "risk-class-ceiling") {
    return isGitDeliveryRiskClass(value.maxRiskClass);
  }
  return false;
}

function isApprovalGranted(value: Record<string, unknown>): boolean {
  return (
    value.required === true &&
    isString(value.approvalTokenHash) &&
    isApprovalTokenShape(value.approvalTokenHash) &&
    isNonEmptyString(value.approvedByUserId) &&
    isNonNegativeInteger(value.approvedAtMs) &&
    isUndefinedOr(isNonNegativeInteger)(value.expiresAtMs)
  );
}

export function isGitDeliveryApprovalRequirement(
  value: unknown,
): value is GitDeliveryApprovalRequirement {
  if (!isRecord(value)) {
    return false;
  }
  if (value.required === false) {
    return true;
  }
  return isApprovalGranted(value);
}

export function isGitDeliveryPolicyDecision(value: unknown): value is GitDeliveryPolicyDecision {
  if (!isRecord(value)) {
    return false;
  }
  if (value.outcome === "allowed") {
    return true;
  }
  if (value.outcome === "blocked") {
    return isGitDeliveryBlockReason(value.reason);
  }
  if (value.outcome === "approval-gated") {
    return isStringArray(value.requiredApprovers);
  }
  if (value.outcome === "constrained") {
    return Array.isArray(value.constraints) && value.constraints.every(isGitDeliveryConstraint);
  }
  return false;
}

export function isGitDeliveryEvidenceRef(value: unknown): value is GitDeliveryEvidenceRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sourceGroundedRunId) &&
    isNonEmptyString(value.evidenceManifestStableIdHash)
  );
}

function isPartialDetail(value: unknown): value is GitDeliveryPartialDetail {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.attemptedUnitCount) &&
    isNonNegativeInteger(value.succeededUnitCount)
  );
}

export function isGitDeliveryExecutionResult(value: unknown): value is GitDeliveryExecutionResult {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_DELIVERY_SCHEMA_VERSION &&
    isGitDeliveryExecutionOutcome(value.outcome) &&
    isNonNegativeInteger(value.durationMs) &&
    isUndefinedOr(isNonEmptyString)(value.externalId) &&
    isUndefinedOr(isGitDeliveryExecutionErrorCode)(value.errorCode) &&
    isUndefinedOr(isPartialDetail)(value.partialDetail)
  );
}

function isActionPreview(value: unknown): value is GitDeliveryActionPreview {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_DELIVERY_SCHEMA_VERSION &&
    isUndefinedOr(isNonEmptyString)(value.affectedBranchName) &&
    isUndefinedOr(isNonNegativeInteger)(value.estimatedFileCount) &&
    isUndefinedOr(isNonNegativeInteger)(value.estimatedBytesDelta) &&
    isBoolean(value.wouldCreateRemoteBranch) &&
    isBoolean(value.wouldTriggerChecks)
  );
}

// ─── Per-kind resolved-input guards (one per kind for the dispatch lookup) ────────

function isBranchCreateInputs(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.branchName) &&
    isNonEmptyString(value.baseBranchName) &&
    isNonEmptyString(value.startPointRefHash)
  );
}

function isBranchSwitchInputs(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.branchName);
}

function isStageInputs(value: Record<string, unknown>): boolean {
  return isNonNegativeInteger(value.pathCount) && isBoolean(value.includesUntracked);
}

function isUnstageInputs(value: Record<string, unknown>): boolean {
  return isNonNegativeInteger(value.pathCount);
}

function isCommitInputs(value: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(value.messageByteLength) &&
    isNonNegativeInteger(value.stagedPathCount) &&
    isBoolean(value.allowEmptyCommit)
  );
}

function isPushInputs(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.sourceBranchName) &&
    isNonEmptyString(value.remoteAlias) &&
    isNonEmptyString(value.remoteBranchName) &&
    isBoolean(value.forcePush) &&
    isBoolean(value.setUpstreamTracking)
  );
}

function isPrCreateInputs(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.headBranchName) &&
    isNonEmptyString(value.baseBranchName) &&
    isNonNegativeInteger(value.titleByteLength) &&
    isNonNegativeInteger(value.bodyByteLength) &&
    isBoolean(value.isDraft)
  );
}

function isPrUpdateInputs(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.prExternalId) &&
    isNonEmptyString(value.headBranchName) &&
    isNonEmptyString(value.baseBranchName) &&
    isNonNegativeInteger(value.titleByteLength) &&
    isNonNegativeInteger(value.bodyByteLength) &&
    isBoolean(value.convertToDraft) &&
    isBoolean(value.convertFromDraft)
  );
}

function isMergeInputs(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.prExternalId) &&
    isGitDeliveryMergeStrategyHint(value.mergeStrategyHint) &&
    isBoolean(value.deleteBranchAfterMerge)
  );
}

function isAbortInputs(value: Record<string, unknown>): boolean {
  return (
    isGitDeliveryAbortableOperation(value.operationToAbort) && isBoolean(value.preserveIndexChanges)
  );
}

function isRecoveryInputs(value: Record<string, unknown>): boolean {
  return (
    isGitDeliveryRecoveryStrategyHint(value.recoveryStrategyHint) &&
    isNonEmptyString(value.targetRefHash) &&
    isNonNegativeInteger(value.affectedPathCount)
  );
}

const RESOLVED_INPUT_GUARDS: Readonly<
  Record<GitDeliveryActionKind, (value: Record<string, unknown>) => boolean>
> = {
  "branch-create": isBranchCreateInputs,
  "branch-switch": isBranchSwitchInputs,
  stage: isStageInputs,
  unstage: isUnstageInputs,
  commit: isCommitInputs,
  push: isPushInputs,
  "pr-create": isPrCreateInputs,
  "pr-update": isPrUpdateInputs,
  merge: isMergeInputs,
  abort: isAbortInputs,
  recovery: isRecoveryInputs,
} as const;

// ─── Parsers ─────────────────────────────────────────────────────────────────────

export function parseGitDeliveryResolvedInputs(
  value: unknown,
): GitDeliveryParseResult<GitDeliveryResolvedInputs> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["resolvedInputs must be an object"] };
  }
  if (!isGitDeliveryActionKind(value.kind)) {
    return { ok: false, errors: ["resolvedInputs.kind must be a known GitDeliveryActionKind"] };
  }
  const guard = RESOLVED_INPUT_GUARDS[value.kind];
  if (!guard(value)) {
    return { ok: false, errors: [`resolvedInputs for kind "${value.kind}" has invalid fields`] };
  }
  return { ok: true, value: value as unknown as GitDeliveryResolvedInputs };
}

function envelopeFieldErrors(value: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== GIT_DELIVERY_SCHEMA_VERSION) {
    errors.push("envelope.schemaVersion must equal the GIT_DELIVERY_SCHEMA_VERSION literal");
  }
  if (!isNonEmptyString(value.actionId)) {
    errors.push("envelope.actionId must be a non-empty string");
  }
  if (!isGitDeliveryPolicyDecision(value.policyDecision)) {
    errors.push("envelope.policyDecision is not a valid GitDeliveryPolicyDecision");
  }
  if (!isGitDeliveryApprovalRequirement(value.approvalRequirement)) {
    errors.push("envelope.approvalRequirement is not a valid GitDeliveryApprovalRequirement");
  }
  if (!isUndefinedOr(isActionPreview)(value.preview)) {
    errors.push("envelope.preview is not a valid GitDeliveryActionPreview");
  }
  if (!isUndefinedOr(isGitDeliveryExecutionResult)(value.executionResult)) {
    errors.push("envelope.executionResult is not a valid GitDeliveryExecutionResult");
  }
  if (!isUndefinedOr(isGitDeliveryEvidenceRef)(value.evidenceRef)) {
    errors.push("envelope.evidenceRef is not a valid GitDeliveryEvidenceRef");
  }
  return errors;
}

export function parseGitDeliveryActionEnvelope(
  value: unknown,
): GitDeliveryParseResult<GitDeliveryActionEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["envelope must be an object"] };
  }
  const inputs = parseGitDeliveryResolvedInputs(value.resolvedInputs);
  if (!inputs.ok) {
    return { ok: false, errors: inputs.errors };
  }
  if (value.kind !== inputs.value.kind) {
    return { ok: false, errors: ["envelope.kind must equal envelope.resolvedInputs.kind"] };
  }
  const fieldErrors = envelopeFieldErrors(value);
  if (fieldErrors.length > 0) {
    return { ok: false, errors: fieldErrors };
  }
  return { ok: true, value: value as unknown as GitDeliveryActionEnvelope };
}

// ─── Risk-class lookups ──────────────────────────────────────────────────────────

// Fail-closed risk lookup: unknown kinds → "recovery-or-rewrite" (ordinal 4).
export function gitDeliveryDefaultRiskClass(kind: string): GitDeliveryRiskClass {
  if (isGitDeliveryActionKind(kind)) {
    return GIT_DELIVERY_ACTION_RISK_DEFAULTS[kind];
  }
  return "recovery-or-rewrite";
}

// Inputs-aware classifier: a force-push escalates beyond the default "publish" class so it is never
// under-classified relative to its true blast radius.
export function gitDeliveryRiskClassForInputs(
  inputs: GitDeliveryResolvedInputs,
): GitDeliveryRiskClass {
  if (inputs.kind === "push" && inputs.forcePush) {
    return "recovery-or-rewrite";
  }
  return gitDeliveryDefaultRiskClass(inputs.kind);
}

// True when the action kind's default risk severity is at or below the ceiling severity.
export function gitDeliveryRiskClassWithinCeiling(
  actionKind: GitDeliveryActionKind,
  ceiling: GitDeliveryRiskClass,
): boolean {
  const actionSeverity = GIT_DELIVERY_RISK_CLASS_SEVERITY[gitDeliveryDefaultRiskClass(actionKind)];
  return actionSeverity <= GIT_DELIVERY_RISK_CLASS_SEVERITY[ceiling];
}

// ─── Branch matchers ─────────────────────────────────────────────────────────────

export function gitDeliveryBranchNameMatchesPattern(
  branchName: string,
  pattern: GitDeliveryBranchPattern,
): boolean {
  if (pattern.matchKind === "exact") {
    return branchName === pattern.value;
  }
  return branchName.startsWith(pattern.value);
}

export function gitDeliveryBranchNameMatchesAny(
  branchName: string,
  patterns: readonly GitDeliveryBranchPattern[],
): boolean {
  return patterns.some((pattern) => gitDeliveryBranchNameMatchesPattern(branchName, pattern));
}
