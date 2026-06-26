// Governed merge orchestration contracts (Issue #478, Epic #470; ADR-0065). Ownership: the
// provider-neutral, content-free merge-governance leaf — the merge-readiness model, the strategy
// eligibility derivation, the merge recommendation, and the provider-failure rejection taxonomy. It is
// the merge counterpart of git-pull-request.ts (the PR-orchestration leaf) and sits on top of the
// existing merge action kind, merge inputs, merge strategy hints, the merge block-reason taxonomy, the
// provider-state interfaces, the execution-error codes, and the recovery vocabulary.
//
// Disjoint from git-delivery.ts (the action/risk model), git-delivery-provider.ts (provider-neutral
// state), git-delivery-evidence.ts (the audit record), git-delivery-action-sheet.ts (the approval
// surface), and git-pull-request.ts (the PR leaf). The GitHub-specific transport, the mergeable-state
// mapper, and the raw-error classifier are keiko-tools concerns; this leaf never imports a kernel type
// and never carries raw provider content.
//
// Leaf-package rules (ADR-0019, ADR-0058, ADR-0065): pure types, frozen const tables, and pure
// functions only. No IO, no clock, no crypto, no randomness, no provider field names. Relative imports
// end in ".js" and reference only sibling git-delivery*.ts leaves.
//
// Content-free by construction: a merge carries no user-authored free content. Its readiness is derived
// from counts, typed enums, and booleans (the provider-state interfaces), never from raw diffs, commit
// bodies, or provider error envelopes.

import type {
  GitDeliveryExecutionErrorCode,
  GitDeliveryMergeBlockReason,
  GitDeliveryMergeStrategyHint,
  GitDeliveryParseResult,
} from "./git-delivery.js";
import {
  GIT_DELIVERY_MERGE_BLOCK_REASONS,
  GIT_DELIVERY_MERGE_STRATEGY_HINTS,
} from "./git-delivery.js";
import type { GitDeliveryRecoveryActionHint } from "./git-delivery-action-sheet.js";
import type { GitDeliveryRecoveryDisposition } from "./git-delivery-evidence.js";
import type {
  GitDeliveryBranchProtection,
  GitDeliveryChecksState,
  GitDeliveryPullRequestState,
} from "./git-delivery-provider.js";

// Pinned schema version. A breaking change adds a NEW literal member; this one is never mutated.
export const GIT_MERGE_SCHEMA_VERSION = "1" as const;

// ─── Merge-readiness blocker taxonomy (AC3) ──────────────────────────────────────────────────────────
// The canonical merge-prerequisite vocabulary is the existing GitDeliveryMergeBlockReason (the #471
// seam): checks-failing / approvals-missing / conflicts / branch-protection / merge-queue-position /
// provider-policy. This leaf composes it with the lifecycle/preview states a pre-merge readiness check
// must also surface (the PR is closed, already merged, still a draft; the requested strategy is not
// eligible; readiness could not be confirmed; a provider read failed).

export type GitMergeLifecycleBlockerCode =
  | "pr-not-open"
  | "pr-already-merged"
  | "draft-pr"
  | "strategy-unavailable"
  | "readiness-unknown"
  | "provider-error";

export const GIT_MERGE_LIFECYCLE_BLOCKER_CODES: readonly GitMergeLifecycleBlockerCode[] = [
  "pr-not-open",
  "pr-already-merged",
  "draft-pr",
  "strategy-unavailable",
  "readiness-unknown",
  "provider-error",
] as const;

export type GitMergeReadinessBlockerCode =
  | GitDeliveryMergeBlockReason
  | GitMergeLifecycleBlockerCode;

export const GIT_MERGE_READINESS_BLOCKER_CODES: readonly GitMergeReadinessBlockerCode[] = [
  ...GIT_DELIVERY_MERGE_BLOCK_REASONS,
  ...GIT_MERGE_LIFECYCLE_BLOCKER_CODES,
] as const;

export type GitMergeBlockerSeverity = "blocking" | "advisory";
export type GitMergeRemediationClass = "user-actionable" | "internal";

export interface GitMergeReadinessBlocker {
  readonly code: GitMergeReadinessBlockerCode;
  readonly severity: GitMergeBlockerSeverity;
  readonly remediation: GitMergeRemediationClass;
}

export interface GitMergeReadinessSummary {
  readonly schemaVersion: typeof GIT_MERGE_SCHEMA_VERSION;
  // True iff there are no BLOCKING blockers — the merge may proceed (subject to policy + approval).
  readonly mergeable: boolean;
  // Severity-ranked: every "blocking" entry precedes every "advisory" entry.
  readonly blockers: readonly GitMergeReadinessBlocker[];
}

// Frozen, exhaustive code → remediation table. Keyed on every code so a new code forces an explicit
// classification here (the Record is not Partial).
const MERGE_BLOCKER_REMEDIATION: Readonly<
  Record<GitMergeReadinessBlockerCode, GitMergeRemediationClass>
> = {
  "checks-failing": "user-actionable",
  "approvals-missing": "user-actionable",
  conflicts: "user-actionable",
  "branch-protection": "user-actionable",
  "merge-queue-position": "user-actionable",
  "provider-policy": "internal",
  "pr-not-open": "user-actionable",
  "pr-already-merged": "user-actionable",
  "draft-pr": "user-actionable",
  "strategy-unavailable": "user-actionable",
  "readiness-unknown": "internal",
  "provider-error": "internal",
} as const;

export function gitMergeBlockerRemediationFor(
  code: GitMergeReadinessBlockerCode,
): GitMergeRemediationClass {
  return MERGE_BLOCKER_REMEDIATION[code];
}

// ─── Recovery action hints (reused #473 vocabulary) ───────────────────────────────────────────────────
// Hints only where the vocabulary fits cleanly; a blocker with no clean hint carries none rather than a
// misleading one. The precise blocker code remains the primary user-facing signal.
const MERGE_BLOCKER_ACTION_HINT: Readonly<
  Record<GitMergeReadinessBlockerCode, GitDeliveryRecoveryActionHint | undefined>
> = {
  "checks-failing": "wait-for-provider",
  "approvals-missing": "request-approval",
  conflicts: "resolve-conflicts",
  "branch-protection": "adjust-policy-target",
  "merge-queue-position": "wait-for-provider",
  "provider-policy": "adjust-policy-target",
  "pr-not-open": undefined,
  "pr-already-merged": undefined,
  "draft-pr": undefined,
  "strategy-unavailable": "recover-via-strategy",
  "readiness-unknown": "wait-for-provider",
  "provider-error": "wait-for-provider",
} as const;

export function gitMergeBlockerActionHintFor(
  code: GitMergeReadinessBlockerCode,
): GitDeliveryRecoveryActionHint | undefined {
  return MERGE_BLOCKER_ACTION_HINT[code];
}

// ─── Strategy eligibility (AC2 — derived from policy ∩ provider capability, never a UI default) ───────

export interface GitMergeStrategyPolicy {
  // The merge strategies this deployment's policy permits. Authored as data (org/repo config).
  readonly allowedStrategies: readonly GitDeliveryMergeStrategyHint[];
}

export interface GitMergeStrategyEligibility {
  // The eligible set: policy-permitted ∩ provider-capable, in the canonical GIT_DELIVERY order.
  readonly eligible: readonly GitDeliveryMergeStrategyHint[];
  // The deterministic default selection: the requested strategy when eligible, else the first eligible.
  readonly selectedDefault: GitDeliveryMergeStrategyHint | undefined;
  // Whether the requested strategy is itself eligible.
  readonly requestedEligible: boolean;
}

// "provider-default" defers strategy choice to the provider; it is eligible iff policy permits it AND at
// least one CONCRETE strategy is eligible (so the provider has something to default to). Concrete
// strategies are eligible iff both policy and provider allow them.
export function deriveEligibleMergeStrategies(
  requested: GitDeliveryMergeStrategyHint,
  policy: GitMergeStrategyPolicy,
  providerCapable: readonly GitDeliveryMergeStrategyHint[],
): GitMergeStrategyEligibility {
  const policySet = new Set(policy.allowedStrategies);
  const providerSet = new Set(providerCapable);
  const concrete = GIT_DELIVERY_MERGE_STRATEGY_HINTS.filter(
    (s) => s !== "provider-default" && policySet.has(s) && providerSet.has(s),
  );
  const providerDefaultEligible = policySet.has("provider-default") && concrete.length > 0;
  const eligible: GitDeliveryMergeStrategyHint[] = [...concrete];
  if (providerDefaultEligible) {
    eligible.push("provider-default");
  }
  const requestedEligible = eligible.includes(requested);
  const selectedDefault = requestedEligible ? requested : eligible[0];
  return {
    eligible,
    ...(selectedDefault !== undefined ? { selectedDefault } : { selectedDefault: undefined }),
    requestedEligible,
  };
}

// ─── Merge recommendation (PURE) ──────────────────────────────────────────────────────────────────────

export type GitMergeRecommendation =
  | "merge-allowed"
  | "needs-approval"
  | "blocked"
  | "already-merged";

export const GIT_MERGE_RECOMMENDATIONS: readonly GitMergeRecommendation[] = [
  "merge-allowed",
  "needs-approval",
  "blocked",
  "already-merged",
] as const;

export interface GitMergeApprovalContext {
  readonly requiresApproval: boolean;
  readonly approvalSatisfied: boolean;
}

export function gitMergeRecommendationFor(
  readiness: GitMergeReadinessSummary,
  approval: GitMergeApprovalContext,
): GitMergeRecommendation {
  if (readiness.blockers.some((b) => b.code === "pr-already-merged")) {
    return "already-merged";
  }
  if (readiness.blockers.some((b) => b.severity === "blocking")) {
    return "blocked";
  }
  if (approval.requiresApproval && !approval.approvalSatisfied) {
    return "needs-approval";
  }
  return "merge-allowed";
}

// ─── Provider-failure rejection taxonomy (AC4 — neutral enum; classifier lives in keiko-tools) ────────

export type GitMergeRejectionReason =
  | "not-mergeable"
  | "checks-failing"
  | "approvals-missing"
  | "conflict"
  | "head-modified"
  | "strategy-unavailable"
  | "branch-protection"
  | "already-merged"
  | "not-found"
  | "permission-denied"
  | "rate-limited"
  | "provider-unavailable"
  | "unknown";

export const GIT_MERGE_REJECTION_REASONS: readonly GitMergeRejectionReason[] = [
  "not-mergeable",
  "checks-failing",
  "approvals-missing",
  "conflict",
  "head-modified",
  "strategy-unavailable",
  "branch-protection",
  "already-merged",
  "not-found",
  "permission-denied",
  "rate-limited",
  "provider-unavailable",
  "unknown",
] as const;

// Exhaustive reason → content-free execution error code (recorded in evidence). Total Record (not
// Partial): a new reason is a compile error here rather than a silent gap.
export const GIT_MERGE_REJECTION_ERROR_CODE: Readonly<
  Record<GitMergeRejectionReason, GitDeliveryExecutionErrorCode>
> = {
  "not-mergeable": "precondition-failed",
  "checks-failing": "precondition-failed",
  "approvals-missing": "precondition-failed",
  conflict: "conflict",
  "head-modified": "precondition-failed",
  "strategy-unavailable": "provider-rejected",
  "branch-protection": "provider-rejected",
  "already-merged": "precondition-failed",
  "not-found": "provider-rejected",
  "permission-denied": "provider-rejected",
  "rate-limited": "network-failure",
  "provider-unavailable": "network-failure",
  unknown: "provider-rejected",
} as const;

// Exhaustive reason → three-way recovery disposition (reused #474 vocabulary).
export const GIT_MERGE_REJECTION_DISPOSITION: Readonly<
  Record<GitMergeRejectionReason, GitDeliveryRecoveryDisposition>
> = {
  "not-mergeable": "user-fixable",
  "checks-failing": "user-fixable",
  "approvals-missing": "user-fixable",
  conflict: "user-fixable",
  "head-modified": "retryable",
  "strategy-unavailable": "user-fixable",
  "branch-protection": "policy-forbidden",
  "already-merged": "none",
  "not-found": "user-fixable",
  "permission-denied": "policy-forbidden",
  "rate-limited": "retryable",
  "provider-unavailable": "retryable",
  unknown: "user-fixable",
} as const;

// Reason → recovery action hint, where the vocabulary fits cleanly (else none).
const MERGE_REJECTION_ACTION_HINT: Readonly<
  Record<GitMergeRejectionReason, GitDeliveryRecoveryActionHint | undefined>
> = {
  "not-mergeable": undefined,
  "checks-failing": "wait-for-provider",
  "approvals-missing": "request-approval",
  conflict: "resolve-conflicts",
  "head-modified": "retry",
  "strategy-unavailable": "recover-via-strategy",
  "branch-protection": "adjust-policy-target",
  "already-merged": undefined,
  "not-found": undefined,
  "permission-denied": undefined,
  "rate-limited": "wait-for-provider",
  "provider-unavailable": "wait-for-provider",
  unknown: undefined,
} as const;

export function gitMergeRejectionToErrorCode(
  reason: GitMergeRejectionReason,
): GitDeliveryExecutionErrorCode {
  return GIT_MERGE_REJECTION_ERROR_CODE[reason];
}

export function gitMergeRejectionToDisposition(
  reason: GitMergeRejectionReason,
): GitDeliveryRecoveryDisposition {
  return GIT_MERGE_REJECTION_DISPOSITION[reason];
}

export interface GitMergeRejection {
  readonly reason: GitMergeRejectionReason;
  readonly disposition: GitDeliveryRecoveryDisposition;
  readonly actionHint?: GitDeliveryRecoveryActionHint | undefined;
}

export function gitMergeRejectionFor(reason: GitMergeRejectionReason): GitMergeRejection {
  const actionHint = MERGE_REJECTION_ACTION_HINT[reason];
  return {
    reason,
    disposition: gitMergeRejectionToDisposition(reason),
    ...(actionHint !== undefined ? { actionHint } : {}),
  };
}

// ─── Private predicate helpers ──────────────────────────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInSet<T extends string>(set: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => isString(v) && (set as readonly string[]).includes(v);
}

// ─── Exported enum guards ─────────────────────────────────────────────────────────────────────────

export const isGitMergeReadinessBlockerCode = isInSet(GIT_MERGE_READINESS_BLOCKER_CODES);
export const isGitMergeRecommendation = isInSet(GIT_MERGE_RECOMMENDATIONS);
export const isGitMergeRejectionReason = isInSet(GIT_MERGE_REJECTION_REASONS);

// ─── Readiness derivation (PURE) ──────────────────────────────────────────────────────────────────────
// Provider facts are gathered by the server (GitDeliveryPullRequestState / GitDeliveryChecksState /
// GitDeliveryBranchProtection) and passed in; this leaf performs only the pure derivation. No network.

export interface GitMergeReadinessInput {
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
  readonly branchProtection?: GitDeliveryBranchProtection | undefined;
  // Whether the requested merge strategy is eligible (from deriveEligibleMergeStrategies). Absent ⇒ not
  // evaluated here (no strategy blocker is emitted).
  readonly strategyEligible?: boolean | undefined;
  // Set by the server when a provider read/operation failed.
  readonly providerError?: boolean | undefined;
}

function blocking(code: GitMergeReadinessBlockerCode): GitMergeReadinessBlocker {
  return { code, severity: "blocking", remediation: gitMergeBlockerRemediationFor(code) };
}

function advisory(code: GitMergeReadinessBlockerCode): GitMergeReadinessBlocker {
  return { code, severity: "advisory", remediation: gitMergeBlockerRemediationFor(code) };
}

const MERGE_PREREQ_CODES: ReadonlySet<string> = new Set(GIT_DELIVERY_MERGE_BLOCK_REASONS);

// The provider merge-readiness signal plus the approval/check enrichment, in deterministic order.
// Duplicates (a blockingReason that coincides with the approvals/checks derivation) are removed by the
// caller's dedupeByCode, so no `.includes` guards are needed here.
function mergePrerequisiteCodes(
  mr: GitDeliveryPullRequestState["mergeReadiness"],
  checksFailing: boolean,
): readonly GitMergeReadinessBlockerCode[] {
  const codes: GitMergeReadinessBlockerCode[] = [];
  if (!mr.ready && mr.blockingReason !== undefined) {
    codes.push(mr.blockingReason);
  }
  if (mr.receivedApprovalCount < mr.requiredApprovalCount) {
    codes.push("approvals-missing");
  }
  if (!mr.ready && checksFailing) {
    codes.push("checks-failing");
  }
  return codes;
}

// Merge-prerequisite blocker codes for an OPEN PR, in deterministic order. Draft and strategy come
// first (preview-time facts), then the provider merge-readiness signal, then the readiness-unknown
// fallback when not ready and nothing concrete was surfaced.
function collectOpenPrBlockerCodes(
  pr: GitDeliveryPullRequestState,
  input: GitMergeReadinessInput,
): readonly GitMergeReadinessBlockerCode[] {
  const codes: GitMergeReadinessBlockerCode[] = [];
  if (pr.isDraft) {
    codes.push("draft-pr");
  }
  if (input.strategyEligible === false) {
    codes.push("strategy-unavailable");
  }
  codes.push(
    ...mergePrerequisiteCodes(pr.mergeReadiness, input.checks?.overallStatus === "failing"),
  );
  if (!pr.mergeReadiness.ready && codes.length === 0) {
    codes.push("readiness-unknown");
  }
  return codes;
}

function collectMergeBlocking(input: GitMergeReadinessInput): readonly GitMergeReadinessBlocker[] {
  if (input.providerError === true) {
    return [blocking("provider-error")];
  }
  const pr = input.pullRequest;
  if (pr === undefined) {
    return [blocking("readiness-unknown")];
  }
  if (pr.status === "merged") {
    return [blocking("pr-already-merged")];
  }
  if (pr.status === "closed") {
    return [blocking("pr-not-open")];
  }
  return dedupeByCode(collectOpenPrBlockerCodes(pr, input)).map(blocking);
}

function collectMergeAdvisory(input: GitMergeReadinessInput): readonly GitMergeReadinessBlocker[] {
  const pr = input.pullRequest;
  // A provider-mergeable PR whose non-required checks are failing (e.g. an "unstable" state): merge is
  // permitted, but the failing checks are worth surfacing as an advisory.
  if (
    pr?.status === "open" &&
    !pr.isDraft &&
    pr.mergeReadiness.ready &&
    input.checks?.overallStatus === "failing"
  ) {
    return [advisory("checks-failing")];
  }
  return [];
}

function dedupeByCode(
  codes: readonly GitMergeReadinessBlockerCode[],
): readonly GitMergeReadinessBlockerCode[] {
  const seen = new Set<string>();
  const out: GitMergeReadinessBlockerCode[] = [];
  for (const code of codes) {
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

export function gitMergeReadinessFor(input: GitMergeReadinessInput): GitMergeReadinessSummary {
  const blockingBlockers = collectMergeBlocking(input);
  const advisoryBlockers = collectMergeAdvisory(input);
  return {
    schemaVersion: GIT_MERGE_SCHEMA_VERSION,
    mergeable: blockingBlockers.length === 0,
    blockers: [...blockingBlockers, ...advisoryBlockers],
  };
}

// `MERGE_PREREQ_CODES` is exported indirectly through gitMergeReadinessBlockerIsPrerequisite so callers
// can tell a merge-prerequisite blocker (the #471 taxonomy) from a lifecycle/preview blocker.
export function gitMergeReadinessBlockerIsPrerequisite(
  code: GitMergeReadinessBlockerCode,
): boolean {
  return MERGE_PREREQ_CODES.has(code);
}

// ─── Structural guards ──────────────────────────────────────────────────────────────────────────────

export function isGitMergeReadinessBlocker(value: unknown): value is GitMergeReadinessBlocker {
  return (
    isRecord(value) &&
    isGitMergeReadinessBlockerCode(value.code) &&
    (value.severity === "blocking" || value.severity === "advisory") &&
    (value.remediation === "user-actionable" || value.remediation === "internal")
  );
}

function isBlockerArray(value: unknown): value is readonly GitMergeReadinessBlocker[] {
  return Array.isArray(value) && value.every(isGitMergeReadinessBlocker);
}

export function isGitMergeReadinessSummary(value: unknown): value is GitMergeReadinessSummary {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_MERGE_SCHEMA_VERSION &&
    isBoolean(value.mergeable) &&
    isBlockerArray(value.blockers)
  );
}

// ─── Parse ──────────────────────────────────────────────────────────────────────────────────────────

export function parseGitMergeReadinessSummary(
  value: unknown,
): GitDeliveryParseResult<GitMergeReadinessSummary> {
  if (!isGitMergeReadinessSummary(value)) {
    return { ok: false, errors: ["value is not a valid GitMergeReadinessSummary"] };
  }
  return { ok: true, value };
}
