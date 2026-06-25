// Provider-neutral interfaces for governed Git delivery (Issue #471, Epic #470).
// Ownership: git-delivery-provider domain.
// THE RULE: no field name, value, or type from any specific provider's API documentation
// may appear in this file. Provider adapters (in keiko-workflows or keiko-server) map
// provider responses to these neutral interfaces. This is enforced by code review and by
// the leaf-package boundary (ADR-0019 rule 1): keiko-contracts cannot import a provider SDK.
// Leaf-package rules: pure types and frozen const tables only. No IO.
//
// Imports ONLY from ./git-delivery.js (GitDeliveryMergeBlockReason, GitDeliveryProviderCapability).

import type { GitDeliveryMergeBlockReason, GitDeliveryProviderCapability } from "./git-delivery.js";
import { isGitDeliveryMergeBlockReason } from "./git-delivery.js";

export const GIT_DELIVERY_PROVIDER_SCHEMA_VERSION = "1" as const;

// ─── Branch protection ───────────────────────────────────────────────────────────
// Presence of this interface on a branch descriptor indicates the branch has at least one
// protection rule active; absence means unprotected.

export interface GitDeliveryBranchProtection {
  readonly deletionAllowed: boolean;
  readonly forcePushAllowed: boolean;
  readonly linearHistoryRequired: boolean;
  readonly requiredReviewCount: number;
  // Count of required status checks (not names — provider-specific check names stay in adapters).
  readonly requiredStatusCheckCount: number;
}

// ─── Checks ──────────────────────────────────────────────────────────────────────

export type GitDeliveryChecksOverallStatus = "passing" | "failing" | "pending" | "skipped";

export const GIT_DELIVERY_CHECKS_OVERALL_STATUSES: readonly GitDeliveryChecksOverallStatus[] = [
  "passing",
  "failing",
  "pending",
  "skipped",
] as const;

// Aggregate check state. No check names, no provider run IDs.
export interface GitDeliveryChecksState {
  readonly total: number;
  readonly passing: number;
  readonly failing: number;
  readonly pending: number;
  readonly overallStatus: GitDeliveryChecksOverallStatus;
}

// ─── Pull request ────────────────────────────────────────────────────────────────
// Draftness is orthogonal to lifecycle status, so it is a separate boolean (not a status member).

export type GitDeliveryPullRequestStatus = "open" | "closed" | "merged";

export const GIT_DELIVERY_PULL_REQUEST_STATUSES: readonly GitDeliveryPullRequestStatus[] = [
  "open",
  "closed",
  "merged",
] as const;

export interface GitDeliveryMergeReadiness {
  readonly ready: boolean;
  readonly blockingReason?: GitDeliveryMergeBlockReason | undefined;
  readonly requiredApprovalCount: number;
  readonly receivedApprovalCount: number;
}

export interface GitDeliveryPullRequestState {
  readonly schemaVersion: typeof GIT_DELIVERY_PROVIDER_SCHEMA_VERSION;
  readonly externalId: string; // opaque provider-assigned ID
  readonly status: GitDeliveryPullRequestStatus;
  readonly isDraft: boolean;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly mergeReadiness: GitDeliveryMergeReadiness;
}

// ─── Remote target policy and provider descriptor ────────────────────────────────

export interface GitDeliveryRemoteTargetPolicy {
  // Branch name patterns the remote accepts as push targets. Empty array means all branches are
  // accepted (no restriction).
  readonly allowedPushTargetPatterns: readonly string[];
  readonly forcePushGloballyDenied: boolean;
}

// Provider capability descriptor. Populated by the adapter from the provider's
// capability-advertisement endpoint or static configuration.
export interface GitDeliveryProviderDescriptor {
  readonly schemaVersion: typeof GIT_DELIVERY_PROVIDER_SCHEMA_VERSION;
  // Opaque identifier for the provider instance (not a URL — avoid leaking endpoints).
  readonly providerInstanceId: string;
  readonly capabilities: readonly GitDeliveryProviderCapability[];
}

// ─── Private predicate helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isUndefinedOr<T>(check: (v: unknown) => v is T): (v: unknown) => v is T | undefined {
  return (v: unknown): v is T | undefined => v === undefined || check(v);
}

function isProviderCapability(value: unknown): boolean {
  return isNonEmptyString(value);
}

// ─── Guards ──────────────────────────────────────────────────────────────────────

export function isGitDeliveryChecksOverallStatus(
  value: unknown,
): value is GitDeliveryChecksOverallStatus {
  return (
    isNonEmptyString(value) &&
    (GIT_DELIVERY_CHECKS_OVERALL_STATUSES as readonly string[]).includes(value)
  );
}

export function isGitDeliveryPullRequestStatus(
  value: unknown,
): value is GitDeliveryPullRequestStatus {
  return (
    isNonEmptyString(value) &&
    (GIT_DELIVERY_PULL_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export function isGitDeliveryBranchProtection(
  value: unknown,
): value is GitDeliveryBranchProtection {
  return (
    isRecord(value) &&
    isBoolean(value.deletionAllowed) &&
    isBoolean(value.forcePushAllowed) &&
    isBoolean(value.linearHistoryRequired) &&
    isNonNegativeInteger(value.requiredReviewCount) &&
    isNonNegativeInteger(value.requiredStatusCheckCount)
  );
}

export function isGitDeliveryChecksState(value: unknown): value is GitDeliveryChecksState {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.passing) &&
    isNonNegativeInteger(value.failing) &&
    isNonNegativeInteger(value.pending) &&
    isGitDeliveryChecksOverallStatus(value.overallStatus)
  );
}

export function isGitDeliveryMergeReadiness(value: unknown): value is GitDeliveryMergeReadiness {
  return (
    isRecord(value) &&
    isBoolean(value.ready) &&
    isUndefinedOr(isGitDeliveryMergeBlockReason)(value.blockingReason) &&
    isNonNegativeInteger(value.requiredApprovalCount) &&
    isNonNegativeInteger(value.receivedApprovalCount)
  );
}

export function isGitDeliveryPullRequestState(
  value: unknown,
): value is GitDeliveryPullRequestState {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_DELIVERY_PROVIDER_SCHEMA_VERSION &&
    isNonEmptyString(value.externalId) &&
    isGitDeliveryPullRequestStatus(value.status) &&
    isBoolean(value.isDraft) &&
    isNonEmptyString(value.headBranchName) &&
    isNonEmptyString(value.baseBranchName) &&
    isGitDeliveryMergeReadiness(value.mergeReadiness)
  );
}

export function isGitDeliveryProviderDescriptor(
  value: unknown,
): value is GitDeliveryProviderDescriptor {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_DELIVERY_PROVIDER_SCHEMA_VERSION &&
    isNonEmptyString(value.providerInstanceId) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isProviderCapability)
  );
}
