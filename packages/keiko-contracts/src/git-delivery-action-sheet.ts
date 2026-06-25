// UI-safe approval and preview contracts for the governed Git delivery surface (Issue #473,
// Epic #470). Ownership: git-delivery-action-sheet domain — the presentation projection that turns
// the kernel's content-free facts (the #471 contract envelope + #472 lifecycle outputs) into a
// consistent, UI-safe action sheet. Disjoint from git-delivery.ts (action model + risk + envelope),
// git-delivery-policy.ts (policy evaluator), and git-delivery-provider.ts (provider-neutral state).
//
// Leaf-package rules (ADR-0019, ADR-0060): pure types and frozen const tables and pure functions
// only. No IO, no clock, no crypto, no randomness. Relative imports end in ".js" and reference only
// the git-delivery sibling atoms — never a kernel (keiko-tools) type. The kernel's preflight finding
// codes are a keiko-tools concern; they reach this layer only as opaque, closed-vocabulary display
// keys (GitDeliveryExpectedBlocker.reasonCode), never as a type this leaf re-enumerates. All
// behavioural meaning is carried by typed fields (source/severity/remediation/cause/state), never
// inferred from a string — satisfying the issue's Engineering Note.
//
// This module is content-free: it carries counts, flags, branch names, and typed codes only. It
// never carries diff content, file paths, secrets, command strings, or raw subprocess output.

import type {
  GitDeliveryAbortableOperation,
  GitDeliveryActionKind,
  GitDeliveryActionPreview,
  GitDeliveryApprovalRequirement,
  GitDeliveryBlockReason,
  GitDeliveryConstraint,
  GitDeliveryParseResult,
  GitDeliveryPolicyDecision,
  GitDeliveryProviderCapability,
  GitDeliveryRecoveryStrategyHint,
  GitDeliveryResolvedInputs,
  GitDeliveryRiskClass,
} from "./git-delivery.js";
import {
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  gitDeliveryRiskClassForInputs,
  isGitDeliveryActionKind,
  isGitDeliveryBlockReason,
  isGitDeliveryConstraint,
  isGitDeliveryRecoveryStrategyHint,
  isGitDeliveryRiskClass,
} from "./git-delivery.js";
import type {
  GitDeliveryBranchProtection,
  GitDeliveryChecksState,
  GitDeliveryMergeReadiness,
  GitDeliveryPullRequestState,
} from "./git-delivery-provider.js";
import {
  isGitDeliveryBranchProtection,
  isGitDeliveryChecksState,
  isGitDeliveryMergeReadiness,
  isGitDeliveryPullRequestState,
} from "./git-delivery-provider.js";

export const GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION = "1" as const;

// ─── Action-sheet state (AC1/AC3 — distinct ready / waiting / blocked) ─────────────
// Three mutually exclusive states the UI renders distinctly: "waiting-for-approval" is the typed
// surface for the issue's "missing approvals" cause and is kept distinct from a hard "blocked".

export type GitDeliveryActionSheetState = "ready-to-execute" | "waiting-for-approval" | "blocked";

export const GIT_DELIVERY_ACTION_SHEET_STATES: readonly GitDeliveryActionSheetState[] = [
  "ready-to-execute",
  "waiting-for-approval",
  "blocked",
] as const;

// ─── Approval necessity (AC1 — mandatory / optional / impossible) ──────────────────
// "not-required" = the issue's "optional" (action proceeds without approval, possibly within
// constraints); "required" = mandatory; "impossible" = the action is blocked and no approval can
// authorize it.

export type GitDeliveryApprovalNecessity = "not-required" | "required" | "impossible";

export const GIT_DELIVERY_APPROVAL_NECESSITIES: readonly GitDeliveryApprovalNecessity[] = [
  "not-required",
  "required",
  "impossible",
] as const;

// ─── Blocked cause (AC3) ───────────────────────────────────────────────────────────
// The hard-block causes. The issue's fourth cause, "missing approvals", is surfaced distinctly as
// the "waiting-for-approval" STATE (resolvable by approving), not as a hard block.

export type GitDeliveryBlockedCause = "policy" | "preflight" | "provider-not-ready";

export const GIT_DELIVERY_BLOCKED_CAUSES: readonly GitDeliveryBlockedCause[] = [
  "policy",
  "preflight",
  "provider-not-ready",
] as const;

// ─── Expected blocker (AC2/AC3 — content-free, typed) ──────────────────────────────
// A preview-time summary of a condition that does or could halt the action. All behaviour comes from
// source/severity/remediation; reasonCode is a stable display/i18n key only (closed at its producing
// layer), never parsed for meaning.

export type GitDeliveryBlockerSource = "preflight" | "policy" | "provider";

export const GIT_DELIVERY_BLOCKER_SOURCES: readonly GitDeliveryBlockerSource[] = [
  "preflight",
  "policy",
  "provider",
] as const;

export type GitDeliveryBlockerSeverity = "blocking" | "advisory";

export const GIT_DELIVERY_BLOCKER_SEVERITIES: readonly GitDeliveryBlockerSeverity[] = [
  "blocking",
  "advisory",
] as const;

export type GitDeliveryRemediationClass = "user-actionable" | "internal";

export const GIT_DELIVERY_REMEDIATION_CLASSES: readonly GitDeliveryRemediationClass[] = [
  "user-actionable",
  "internal",
] as const;

export interface GitDeliveryExpectedBlocker {
  readonly source: GitDeliveryBlockerSource;
  readonly severity: GitDeliveryBlockerSeverity;
  readonly remediation: GitDeliveryRemediationClass;
  // Stable, closed-vocabulary code from the producing layer (a preflight finding code, a block
  // reason, or a merge-block reason). Display/i18n key ONLY — never parsed for behaviour.
  readonly reasonCode: string;
}

// ─── Recovery hints (AC4 — common failure classes, in the same surface) ────────────

export type GitDeliveryRecoveryActionHint =
  | "retry"
  | "stage-changes"
  | "configure-upstream"
  | "resolve-conflicts"
  | "abort-in-progress-operation"
  | "request-approval"
  | "adjust-policy-target"
  | "recover-via-strategy"
  | "wait-for-provider";

export const GIT_DELIVERY_RECOVERY_ACTION_HINTS: readonly GitDeliveryRecoveryActionHint[] = [
  "retry",
  "stage-changes",
  "configure-upstream",
  "resolve-conflicts",
  "abort-in-progress-operation",
  "request-approval",
  "adjust-policy-target",
  "recover-via-strategy",
  "wait-for-provider",
] as const;

export interface GitDeliveryRecoveryHint {
  readonly actionHint: GitDeliveryRecoveryActionHint;
  readonly remediation: GitDeliveryRemediationClass;
  // Present only when actionHint === "recover-via-strategy": the concrete governed recovery strategy
  // the kernel would execute. Closes the kernel's failure→suggested-strategy gap at the UX layer.
  readonly suggestedRecoveryStrategy?: GitDeliveryRecoveryStrategyHint | undefined;
}

// ─── Approval summary (AC1) ────────────────────────────────────────────────────────

export interface GitDeliveryApprovalSummary {
  readonly necessity: GitDeliveryApprovalNecessity;
  // True only when necessity === "required" AND a granted approval payload is attached. This is a
  // DISPLAY/advisory signal, not an authority decision: the contract is clockless, so it cannot judge
  // token expiry — the caller (the server projection) supplies an already-expiry-checked approval
  // (an expired grant is passed as not-attached, surfacing as "waiting-for-approval"), and the #472
  // execution kernel independently re-validates the token and its expiry before any mutation runs.
  readonly satisfied: boolean;
  readonly riskClass: GitDeliveryRiskClass;
  readonly riskSeverity: number;
  readonly requiredApprovers: readonly string[];
}

// ─── Policy explanation (AC1/AC3 — visible policy reason, no raw output) ────────────

export interface GitDeliveryPolicyExplanation {
  readonly decision: GitDeliveryPolicyDecision["outcome"];
  readonly requiredApprovers: readonly string[];
  readonly constraints: readonly GitDeliveryConstraint[];
  readonly blockReason?: GitDeliveryBlockReason | undefined;
}

// ─── Preview manifest (AC2) ────────────────────────────────────────────────────────
// A consistent, UI-safe superset of the kernel's content-free GitDeliveryActionPreview, enriched
// with branch targets, remote impact, provider PR/merge/branch-protection/checks state, and the
// expected-blocker summary. Counts/flags/names only.

export interface GitDeliveryPreviewManifest {
  readonly schemaVersion: typeof GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION;
  readonly actionKind: GitDeliveryActionKind;
  readonly riskClass: GitDeliveryRiskClass;
  readonly riskSeverity: number;
  readonly affectedBranchName?: string | undefined;
  readonly baseBranchName?: string | undefined;
  readonly remoteBranchName?: string | undefined;
  readonly estimatedFileCount?: number | undefined;
  readonly estimatedBytesDelta?: number | undefined;
  readonly touchesRemote: boolean;
  readonly wouldCreateRemoteBranch: boolean;
  readonly wouldForcePublish: boolean;
  readonly wouldTriggerChecks: boolean;
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly mergeReadiness?: GitDeliveryMergeReadiness | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
  readonly expectedBlockers: readonly GitDeliveryExpectedBlocker[];
}

// ─── Blocked detail (AC3) ──────────────────────────────────────────────────────────

export interface GitDeliveryBlockedDetail {
  readonly cause: GitDeliveryBlockedCause;
  readonly expectedBlockers: readonly GitDeliveryExpectedBlocker[];
}

// ─── The action sheet (the top-level UI-safe manifest) ─────────────────────────────

export interface GitDeliveryActionSheet {
  readonly schemaVersion: typeof GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION;
  readonly actionId: string;
  readonly actionKind: GitDeliveryActionKind;
  readonly state: GitDeliveryActionSheetState;
  readonly preview: GitDeliveryPreviewManifest;
  readonly approval: GitDeliveryApprovalSummary;
  readonly policyExplanation: GitDeliveryPolicyExplanation;
  readonly recovery: readonly GitDeliveryRecoveryHint[];
  // Present iff state === "blocked".
  readonly blocked?: GitDeliveryBlockedDetail | undefined;
}

// ─── Wire request (the over-the-wire BFF contract for POST /api/git-delivery/action-sheet) ──────────
// The shape a CALLER sends to obtain an action sheet. It carries only the content-free repository
// facts a caller legitimately holds — never authority fields. The server computes policy, approval
// necessity, providerReady, expected blockers, and recovery hints itself (AC1); those are NOT part of
// this request and are rejected if sent. Distinct from GitDeliveryActionSheetInput (the server-side
// assembler input, which carries the server-computed facts).

// A content-free worktree snapshot, structurally identical to the keiko-tools kernel GitWorktreeSnapshot
// but owned by the contract leaf so the wire shape does not depend on a kernel (keiko-tools) type.
// Counts, flags, and branch/remote names only.
export interface GitDeliveryWorktreeSnapshot {
  readonly headDetached: boolean;
  readonly currentBranchName?: string | undefined;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly existingLocalBranchNames: readonly string[];
  readonly remoteAliases: readonly string[];
  readonly remoteReachable?: boolean | undefined;
  readonly operationInProgress?: GitDeliveryAbortableOperation | undefined;
}

export interface GitDeliveryActionSheetProviderState {
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly mergeReadiness?: GitDeliveryMergeReadiness | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
}

export interface GitDeliveryActionSheetRequest {
  readonly schemaVersion: typeof GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION;
  readonly resolvedInputs: GitDeliveryResolvedInputs;
  readonly worktreeSnapshot: GitDeliveryWorktreeSnapshot;
  readonly approval?: GitDeliveryApprovalRequirement | undefined;
  readonly providerState?: GitDeliveryActionSheetProviderState | undefined;
  readonly activeProviderCapabilities?: readonly GitDeliveryProviderCapability[] | undefined;
}

// ─── Assembler input (content-free backend facts) ──────────────────────────────────
// The caller (the server BFF) gathers these from trusted sources: policyDecision from
// evaluateGitPolicy over trusted packs, expectedBlockers/recovery mapped from the kernel's preflight
// findings, providerReady from the deployment capability gate, and the optional provider state from
// the provider adapter. Authority (policy/approval) is never client-asserted.

export interface GitDeliveryActionSheetInput {
  readonly actionId: string;
  readonly resolvedInputs: GitDeliveryResolvedInputs;
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
  readonly providerReady: boolean;
  readonly expectedBlockers: readonly GitDeliveryExpectedBlocker[];
  readonly recovery: readonly GitDeliveryRecoveryHint[];
  readonly kernelPreview?: GitDeliveryActionPreview | undefined;
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly mergeReadiness?: GitDeliveryMergeReadiness | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
}

// ─── Private predicate helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isUndefinedOr<T>(check: (v: unknown) => v is T): (v: unknown) => v is T | undefined {
  return (v: unknown): v is T | undefined => v === undefined || check(v);
}

function isInSet<T extends string>(set: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => isString(v) && (set as readonly string[]).includes(v);
}

// ─── Exported enum guards ────────────────────────────────────────────────────────────

export const isGitDeliveryActionSheetState = isInSet(GIT_DELIVERY_ACTION_SHEET_STATES);
export const isGitDeliveryApprovalNecessity = isInSet(GIT_DELIVERY_APPROVAL_NECESSITIES);
export const isGitDeliveryBlockedCause = isInSet(GIT_DELIVERY_BLOCKED_CAUSES);
export const isGitDeliveryBlockerSource = isInSet(GIT_DELIVERY_BLOCKER_SOURCES);
export const isGitDeliveryBlockerSeverity = isInSet(GIT_DELIVERY_BLOCKER_SEVERITIES);
export const isGitDeliveryRemediationClass = isInSet(GIT_DELIVERY_REMEDIATION_CLASSES);
export const isGitDeliveryRecoveryActionHint = isInSet(GIT_DELIVERY_RECOVERY_ACTION_HINTS);

// ─── Exported structural guards ──────────────────────────────────────────────────────

export function isGitDeliveryExpectedBlocker(value: unknown): value is GitDeliveryExpectedBlocker {
  return (
    isRecord(value) &&
    isGitDeliveryBlockerSource(value.source) &&
    isGitDeliveryBlockerSeverity(value.severity) &&
    isGitDeliveryRemediationClass(value.remediation) &&
    isNonEmptyString(value.reasonCode)
  );
}

export function isGitDeliveryRecoveryHint(value: unknown): value is GitDeliveryRecoveryHint {
  if (!isRecord(value)) {
    return false;
  }
  if (!isGitDeliveryRecoveryActionHint(value.actionHint)) {
    return false;
  }
  if (!isGitDeliveryRemediationClass(value.remediation)) {
    return false;
  }
  if (!isUndefinedOr(isGitDeliveryRecoveryStrategyHint)(value.suggestedRecoveryStrategy)) {
    return false;
  }
  // A concrete strategy is only meaningful for the "recover-via-strategy" hint.
  if (
    value.suggestedRecoveryStrategy !== undefined &&
    value.actionHint !== "recover-via-strategy"
  ) {
    return false;
  }
  return true;
}

export function isGitDeliveryApprovalSummary(value: unknown): value is GitDeliveryApprovalSummary {
  return (
    isRecord(value) &&
    isGitDeliveryApprovalNecessity(value.necessity) &&
    isBoolean(value.satisfied) &&
    isGitDeliveryRiskClass(value.riskClass) &&
    isNonNegativeInteger(value.riskSeverity) &&
    isStringArray(value.requiredApprovers)
  );
}

export const GIT_DELIVERY_POLICY_DECISION_OUTCOMES: readonly GitDeliveryPolicyDecision["outcome"][] =
  ["allowed", "blocked", "approval-gated", "constrained"] as const;

export const isGitDeliveryPolicyDecisionOutcome = isInSet(GIT_DELIVERY_POLICY_DECISION_OUTCOMES);

export function isGitDeliveryPolicyExplanation(
  value: unknown,
): value is GitDeliveryPolicyExplanation {
  return (
    isRecord(value) &&
    isGitDeliveryPolicyDecisionOutcome(value.decision) &&
    isStringArray(value.requiredApprovers) &&
    Array.isArray(value.constraints) &&
    value.constraints.every(isGitDeliveryConstraint) &&
    isUndefinedOr(isGitDeliveryBlockReason)(value.blockReason)
  );
}

function isExpectedBlockerArray(value: unknown): value is readonly GitDeliveryExpectedBlocker[] {
  return Array.isArray(value) && value.every(isGitDeliveryExpectedBlocker);
}

function previewProviderFieldsValid(value: Record<string, unknown>): boolean {
  return (
    isUndefinedOr(isGitDeliveryPullRequestState)(value.pullRequest) &&
    isUndefinedOr(isGitDeliveryMergeReadiness)(value.mergeReadiness) &&
    isUndefinedOr(isGitDeliveryBranchProtection)(value.branchProtection) &&
    isUndefinedOr(isGitDeliveryChecksState)(value.checks)
  );
}

function previewScalarFieldsValid(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION &&
    isGitDeliveryActionKind(value.actionKind) &&
    isGitDeliveryRiskClass(value.riskClass) &&
    isNonNegativeInteger(value.riskSeverity) &&
    isUndefinedOr(isNonEmptyString)(value.affectedBranchName) &&
    isUndefinedOr(isNonEmptyString)(value.baseBranchName) &&
    isUndefinedOr(isNonEmptyString)(value.remoteBranchName) &&
    isUndefinedOr(isNonNegativeInteger)(value.estimatedFileCount) &&
    isUndefinedOr(isNonNegativeInteger)(value.estimatedBytesDelta)
  );
}

function previewFlagFieldsValid(value: Record<string, unknown>): boolean {
  return (
    isBoolean(value.touchesRemote) &&
    isBoolean(value.wouldCreateRemoteBranch) &&
    isBoolean(value.wouldForcePublish) &&
    isBoolean(value.wouldTriggerChecks)
  );
}

export function isGitDeliveryPreviewManifest(value: unknown): value is GitDeliveryPreviewManifest {
  return (
    isRecord(value) &&
    previewScalarFieldsValid(value) &&
    previewFlagFieldsValid(value) &&
    previewProviderFieldsValid(value) &&
    isExpectedBlockerArray(value.expectedBlockers)
  );
}

export function isGitDeliveryBlockedDetail(value: unknown): value is GitDeliveryBlockedDetail {
  return (
    isRecord(value) &&
    isGitDeliveryBlockedCause(value.cause) &&
    isExpectedBlockerArray(value.expectedBlockers)
  );
}

function actionSheetCoreFieldsValid(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION &&
    isNonEmptyString(value.actionId) &&
    isGitDeliveryActionKind(value.actionKind) &&
    isGitDeliveryActionSheetState(value.state)
  );
}

function actionSheetCompositeFieldsValid(value: Record<string, unknown>): boolean {
  return (
    isGitDeliveryPreviewManifest(value.preview) &&
    isGitDeliveryApprovalSummary(value.approval) &&
    isGitDeliveryPolicyExplanation(value.policyExplanation) &&
    Array.isArray(value.recovery) &&
    value.recovery.every(isGitDeliveryRecoveryHint) &&
    isUndefinedOr(isGitDeliveryBlockedDetail)(value.blocked)
  );
}

function actionSheetBlockedInvariant(value: Record<string, unknown>): boolean {
  // blocked detail present iff state is blocked.
  return (value.state === "blocked") === (value.blocked !== undefined);
}

export function isGitDeliveryActionSheet(value: unknown): value is GitDeliveryActionSheet {
  return (
    isRecord(value) &&
    actionSheetCoreFieldsValid(value) &&
    actionSheetCompositeFieldsValid(value) &&
    actionSheetBlockedInvariant(value)
  );
}

export function parseGitDeliveryActionSheet(
  value: unknown,
): GitDeliveryParseResult<GitDeliveryActionSheet> {
  if (!isGitDeliveryActionSheet(value)) {
    return { ok: false, errors: ["value is not a valid GitDeliveryActionSheet"] };
  }
  return { ok: true, value };
}

// ─── Pure projection helpers ─────────────────────────────────────────────────────────

const REMOTE_ACTION_KINDS: readonly GitDeliveryActionKind[] = [
  "push",
  "pr-create",
  "pr-update",
  "merge",
];

function actionTouchesRemote(kind: GitDeliveryActionKind): boolean {
  return (REMOTE_ACTION_KINDS as readonly string[]).includes(kind);
}

function affectedBranchOf(inputs: GitDeliveryResolvedInputs): string | undefined {
  switch (inputs.kind) {
    case "branch-create":
      return inputs.branchName;
    case "push":
      return inputs.sourceBranchName;
    case "pr-create":
    case "pr-update":
      return inputs.headBranchName;
    default:
      return undefined;
  }
}

function baseBranchOf(inputs: GitDeliveryResolvedInputs): string | undefined {
  switch (inputs.kind) {
    case "branch-create":
    case "pr-create":
    case "pr-update":
      return inputs.baseBranchName;
    default:
      return undefined;
  }
}

function remoteBranchOf(inputs: GitDeliveryResolvedInputs): string | undefined {
  return inputs.kind === "push" ? inputs.remoteBranchName : undefined;
}

function wouldForcePublishOf(inputs: GitDeliveryResolvedInputs): boolean {
  return inputs.kind === "push" && inputs.forcePush;
}

function wouldCreateRemoteBranchOf(
  inputs: GitDeliveryResolvedInputs,
  kernelPreview: GitDeliveryActionPreview | undefined,
): boolean {
  if (inputs.kind === "push") {
    return inputs.setUpstreamTracking;
  }
  return kernelPreview?.wouldCreateRemoteBranch ?? false;
}

export interface GitDeliveryPreviewManifestInput {
  readonly resolvedInputs: GitDeliveryResolvedInputs;
  readonly expectedBlockers: readonly GitDeliveryExpectedBlocker[];
  readonly kernelPreview?: GitDeliveryActionPreview | undefined;
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly mergeReadiness?: GitDeliveryMergeReadiness | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
}

// A mutable view over the manifest's optional fields, populated only when a value is present so that
// no `undefined` is spread into the result (exactOptionalPropertyTypes-safe).
interface MutablePreviewOptional {
  affectedBranchName?: string;
  baseBranchName?: string;
  remoteBranchName?: string;
  estimatedFileCount?: number;
  estimatedBytesDelta?: number;
  pullRequest?: GitDeliveryPullRequestState;
  mergeReadiness?: GitDeliveryMergeReadiness;
  branchProtection?: GitDeliveryBranchProtection;
  checks?: GitDeliveryChecksState;
}

function previewBranchAndScopeFields(
  inputs: GitDeliveryResolvedInputs,
  kernelPreview: GitDeliveryActionPreview | undefined,
): MutablePreviewOptional {
  const out: MutablePreviewOptional = {};
  const affected = affectedBranchOf(inputs);
  if (affected !== undefined) {
    out.affectedBranchName = affected;
  }
  const base = baseBranchOf(inputs);
  if (base !== undefined) {
    out.baseBranchName = base;
  }
  const remote = remoteBranchOf(inputs);
  if (remote !== undefined) {
    out.remoteBranchName = remote;
  }
  if (kernelPreview?.estimatedFileCount !== undefined) {
    out.estimatedFileCount = kernelPreview.estimatedFileCount;
  }
  if (kernelPreview?.estimatedBytesDelta !== undefined) {
    out.estimatedBytesDelta = kernelPreview.estimatedBytesDelta;
  }
  return out;
}

function previewProviderFields(input: GitDeliveryPreviewManifestInput): MutablePreviewOptional {
  const out: MutablePreviewOptional = {};
  if (input.pullRequest !== undefined) {
    out.pullRequest = input.pullRequest;
  }
  if (input.mergeReadiness !== undefined) {
    out.mergeReadiness = input.mergeReadiness;
  }
  if (input.branchProtection !== undefined) {
    out.branchProtection = input.branchProtection;
  }
  if (input.checks !== undefined) {
    out.checks = input.checks;
  }
  return out;
}

export function buildGitDeliveryPreviewManifest(
  input: GitDeliveryPreviewManifestInput,
): GitDeliveryPreviewManifest {
  const { resolvedInputs, kernelPreview } = input;
  const riskClass = gitDeliveryRiskClassForInputs(resolvedInputs);
  const touchesRemote = actionTouchesRemote(resolvedInputs.kind);
  return {
    schemaVersion: GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION,
    actionKind: resolvedInputs.kind,
    riskClass,
    riskSeverity: GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass],
    ...previewBranchAndScopeFields(resolvedInputs, kernelPreview),
    touchesRemote,
    wouldCreateRemoteBranch: wouldCreateRemoteBranchOf(resolvedInputs, kernelPreview),
    wouldForcePublish: wouldForcePublishOf(resolvedInputs),
    // Re-derived from inputs (every remote action kind triggers checks), not read from
    // kernelPreview.wouldTriggerChecks: the local kernel always reports false, and this projection
    // owns the UI-facing derivation. The two are equivalent for the current action kinds.
    wouldTriggerChecks: touchesRemote,
    ...previewProviderFields(input),
    expectedBlockers: input.expectedBlockers,
  };
}

export function gitDeliveryApprovalNecessityForDecision(
  decision: GitDeliveryPolicyDecision,
): GitDeliveryApprovalNecessity {
  switch (decision.outcome) {
    case "approval-gated":
      return "required";
    case "blocked":
      return decision.reason === "approval-expired" ? "required" : "impossible";
    case "allowed":
    case "constrained":
      return "not-required";
    default:
      return "impossible";
  }
}

function approvalIsAttached(approval: GitDeliveryApprovalRequirement): boolean {
  return approval.required;
}

function hasBlockingPreflight(blockers: readonly GitDeliveryExpectedBlocker[]): boolean {
  return blockers.some((b) => b.source === "preflight" && b.severity === "blocking");
}

export interface GitDeliveryActionSheetStateInput {
  readonly policyDecision: GitDeliveryPolicyDecision;
  readonly approvalRequirement: GitDeliveryApprovalRequirement;
  readonly providerReady: boolean;
  readonly hasBlockingPreflight: boolean;
}

export function gitDeliveryActionSheetStateFor(
  input: GitDeliveryActionSheetStateInput,
): GitDeliveryActionSheetState {
  if (!input.providerReady) {
    return "blocked";
  }
  if (input.hasBlockingPreflight) {
    return "blocked";
  }
  const decision = input.policyDecision;
  if (decision.outcome === "blocked") {
    return decision.reason === "approval-expired" ? "waiting-for-approval" : "blocked";
  }
  if (decision.outcome === "approval-gated") {
    return approvalIsAttached(input.approvalRequirement)
      ? "ready-to-execute"
      : "waiting-for-approval";
  }
  return "ready-to-execute";
}

export function gitDeliveryBlockedCauseFor(
  input: GitDeliveryActionSheetStateInput,
): GitDeliveryBlockedCause | undefined {
  if (!input.providerReady) {
    return "provider-not-ready";
  }
  if (input.hasBlockingPreflight) {
    return "preflight";
  }
  if (
    input.policyDecision.outcome === "blocked" &&
    input.policyDecision.reason !== "approval-expired"
  ) {
    return "policy";
  }
  return undefined;
}

// Fills the kernel's failure→suggested-strategy gap with a deterministic default: a dirty worktree
// must be preserved (stash), a commit is undone non-destructively (soft reset), everything else
// resets the index but keeps working-tree files (mixed reset).
export function gitDeliverySuggestedRecoveryStrategy(
  actionKind: GitDeliveryActionKind,
  worktreeIsDirty: boolean,
): GitDeliveryRecoveryStrategyHint {
  if (worktreeIsDirty) {
    return "stash-and-reset";
  }
  if (actionKind === "commit") {
    return "soft-reset";
  }
  return "mixed-reset";
}

function buildApprovalSummary(
  resolvedInputs: GitDeliveryResolvedInputs,
  decision: GitDeliveryPolicyDecision,
  approval: GitDeliveryApprovalRequirement,
): GitDeliveryApprovalSummary {
  const riskClass = gitDeliveryRiskClassForInputs(resolvedInputs);
  const necessity = gitDeliveryApprovalNecessityForDecision(decision);
  const requiredApprovers = decision.outcome === "approval-gated" ? decision.requiredApprovers : [];
  return {
    necessity,
    satisfied: necessity === "required" && approvalIsAttached(approval),
    riskClass,
    riskSeverity: GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass],
    requiredApprovers,
  };
}

function buildPolicyExplanation(decision: GitDeliveryPolicyDecision): GitDeliveryPolicyExplanation {
  const requiredApprovers = decision.outcome === "approval-gated" ? decision.requiredApprovers : [];
  const constraints = decision.outcome === "constrained" ? decision.constraints : [];
  const base: GitDeliveryPolicyExplanation = {
    decision: decision.outcome,
    requiredApprovers,
    constraints,
  };
  if (decision.outcome === "blocked") {
    return { ...base, blockReason: decision.reason };
  }
  return base;
}

export function buildGitDeliveryActionSheet(
  input: GitDeliveryActionSheetInput,
): GitDeliveryActionSheet {
  const stateInput: GitDeliveryActionSheetStateInput = {
    policyDecision: input.policyDecision,
    approvalRequirement: input.approvalRequirement,
    providerReady: input.providerReady,
    hasBlockingPreflight: hasBlockingPreflight(input.expectedBlockers),
  };
  const state = gitDeliveryActionSheetStateFor(stateInput);
  const preview = buildGitDeliveryPreviewManifest({
    resolvedInputs: input.resolvedInputs,
    expectedBlockers: input.expectedBlockers,
    kernelPreview: input.kernelPreview,
    pullRequest: input.pullRequest,
    mergeReadiness: input.mergeReadiness,
    branchProtection: input.branchProtection,
    checks: input.checks,
  });
  const base: GitDeliveryActionSheet = {
    schemaVersion: GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION,
    actionId: input.actionId,
    actionKind: input.resolvedInputs.kind,
    state,
    preview,
    approval: buildApprovalSummary(
      input.resolvedInputs,
      input.policyDecision,
      input.approvalRequirement,
    ),
    policyExplanation: buildPolicyExplanation(input.policyDecision),
    recovery: input.recovery,
  };
  if (state !== "blocked") {
    return base;
  }
  const cause = gitDeliveryBlockedCauseFor(stateInput) ?? "policy";
  return { ...base, blocked: { cause, expectedBlockers: input.expectedBlockers } };
}
