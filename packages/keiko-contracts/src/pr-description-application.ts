import { isGitObjectId, isSafeGitRefName } from "./git-repository.js";
import { isGitHubOwnerAndRepo, GITHUB_ISSUE_NUMBER_MAX } from "./github-issue-reference.js";

export const PR_DESCRIPTION_APPLICATION_MAX_AGE_MS = 60_000;
export const PR_DESCRIPTION_APPLICATION_REASON_STATES = Object.freeze({
  applied: "current",
  reconciled: "current",
  "partial-applied": "partial",
  "fallback-applied": "fallback",
  "approval-required": "blocked",
  "approval-invalid": "blocked",
  "authority-denied": "blocked",
  "policy-blocked": "blocked",
  "invalid-request": "blocked",
  "malformed-region": "blocked",
  "unsafe-content": "blocked",
  "stale-pr": "stale",
  "stale-snapshot": "stale",
  "body-changed": "stale",
  expired: "stale",
  "provider-failed": "failed",
  "recovery-required": "failed",
  "unchanged-after-write": "failed",
} as const);
export type PrDescriptionApplicationReason = keyof typeof PR_DESCRIPTION_APPLICATION_REASON_STATES;
export type PrDescriptionApplicationState =
  (typeof PR_DESCRIPTION_APPLICATION_REASON_STATES)[PrDescriptionApplicationReason];
export type PrDescriptionApplicationCompleteness = "complete" | "partial" | "fallback";
export type PrDescriptionApplicationEffect = "none" | "confirmed" | "reconciled" | "uncertain";

export interface PrDescriptionApplicationBinding {
  readonly repositoryId: string;
  readonly remoteDigest: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly prExternalId: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRepository: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly snapshotDigest: string;
  readonly draftDigest: string;
  readonly renderingVersion: "1";
  readonly expectedBodyDigest: string;
  readonly outsideRegionDigest: string;
  readonly finalBodyDigest: string;
  /** Actual provider field, never a fabricated ETag or an atomic update precondition. */
  readonly providerUpdatedAt: string;
}

/** Exact observed body state, not authority and not a claim of atomic provider compare-and-swap. */
export interface PrDescriptionApplicationStatus {
  readonly schemaVersion: "1";
  readonly state: PrDescriptionApplicationState;
  readonly reason: PrDescriptionApplicationReason;
  readonly binding: PrDescriptionApplicationBinding;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly completeness: PrDescriptionApplicationCompleteness;
  readonly effect: PrDescriptionApplicationEffect;
  readonly concurrency: "read-check-write-verify";
}

export const PR_DESCRIPTION_CONCURRENCY_LIMITATION =
  "GitHub cannot lock the PR body during this update. Keiko checks immediately before and after " +
  "writing, but cannot detect an intervening edit that GitHub overwrote during the write.";

const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BINDING_KEYS = [
  "repositoryId",
  "remoteDigest",
  "repository",
  "prNumber",
  "prExternalId",
  "baseRef",
  "baseSha",
  "headRepository",
  "headRef",
  "headSha",
  "isDraft",
  "snapshotDigest",
  "draftDigest",
  "renderingVersion",
  "expectedBodyDigest",
  "outsideRegionDigest",
  "finalBodyDigest",
  "providerUpdatedAt",
];
const STATUS_KEYS = [
  "schemaVersion",
  "state",
  "reason",
  "binding",
  "observedAt",
  "expiresAt",
  "completeness",
  "effect",
  "concurrency",
];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === expected.length &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}
function pattern(value: unknown, expression: RegExp): value is string {
  return typeof value === "string" && expression.test(value);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function validPrNumber(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= GITHUB_ISSUE_NUMBER_MAX
  );
}
function successfulEffect(value: unknown): boolean {
  return value === "confirmed" || value === "reconciled";
}
function validCompleteness(value: unknown): boolean {
  return value === "complete" || value === "partial" || value === "fallback";
}
function validRepositoryBinding(value: Record<string, unknown>): boolean {
  return (
    pattern(value.repositoryId, ID) &&
    pattern(value.remoteDigest, DIGEST) &&
    typeof value.repository === "string" &&
    isGitHubOwnerAndRepo(value.repository) &&
    typeof value.headRepository === "string" &&
    isGitHubOwnerAndRepo(value.headRepository) &&
    validPrNumber(value.prNumber) &&
    pattern(value.prExternalId, ID)
  );
}
function validRevisionBinding(value: Record<string, unknown>): boolean {
  return (
    typeof value.baseRef === "string" &&
    isSafeGitRefName(value.baseRef) &&
    typeof value.headRef === "string" &&
    isSafeGitRefName(value.headRef) &&
    isGitObjectId(value.baseSha) &&
    isGitObjectId(value.headSha) &&
    typeof value.isDraft === "boolean" &&
    value.renderingVersion === "1" &&
    timestamp(value.providerUpdatedAt)
  );
}
export function isPrDescriptionApplicationBinding(
  value: unknown,
): value is PrDescriptionApplicationBinding {
  if (!record(value) || !keys(value, BINDING_KEYS)) return false;
  return (
    validRepositoryBinding(value) &&
    validRevisionBinding(value) &&
    [
      "snapshotDigest",
      "draftDigest",
      "expectedBodyDigest",
      "outsideRegionDigest",
      "finalBodyDigest",
    ].every((key) => pattern(value[key], DIGEST))
  );
}
function validState(value: Record<string, unknown>): boolean {
  if (
    typeof value.reason !== "string" ||
    !Object.hasOwn(PR_DESCRIPTION_APPLICATION_REASON_STATES, value.reason)
  )
    return false;
  const state =
    PR_DESCRIPTION_APPLICATION_REASON_STATES[value.reason as PrDescriptionApplicationReason];
  if (value.state !== state) return false;
  if (state === "current") return value.completeness === "complete" && exactSuccessfulEffect(value);
  if (state === "partial" || state === "fallback")
    return value.completeness === state && successfulEffect(value.effect);
  return value.effect === "none" || value.effect === "uncertain";
}
export function isPrDescriptionApplicationStatus(
  value: unknown,
): value is PrDescriptionApplicationStatus {
  if (!record(value) || !keys(value, STATUS_KEYS)) return false;
  if (!validObservationWindow(value)) return false;
  return (
    value.schemaVersion === "1" &&
    value.concurrency === "read-check-write-verify" &&
    isPrDescriptionApplicationBinding(value.binding) &&
    validCompleteness(value.completeness) &&
    validState(value)
  );
}

function validObservationWindow(value: Record<string, unknown>): boolean {
  if (!timestamp(value.observedAt) || !timestamp(value.expiresAt)) return false;
  const age = Date.parse(value.expiresAt) - Date.parse(value.observedAt);
  return age > 0 && age <= PR_DESCRIPTION_APPLICATION_MAX_AGE_MS;
}

function exactSuccessfulEffect(value: Record<string, unknown>): boolean {
  return (
    (value.reason === "applied" && value.effect === "confirmed") ||
    (value.reason === "reconciled" && value.effect === "reconciled")
  );
}
