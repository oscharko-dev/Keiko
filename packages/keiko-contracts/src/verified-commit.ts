import { isGitDeliveryBlockReason, type GitDeliveryBlockReason } from "./git-delivery.js";
import { isGitPreflightFindingCode, type GitPreflightFinding } from "./git-preflight.js";
import {
  GIT_COMMIT_MESSAGE_VIOLATION_CODES,
  isGitCommitMessageViolationCode,
  type GitCommitMessageViolationCode,
} from "./git-commit-policy.js";

/** Body-free receipt for one exact verified Code-task commit. No approval token is serializable. */
export const VERIFIED_COMMIT_SCHEMA_VERSION = "1" as const;

export const VERIFIED_COMMIT_STATUSES = [
  "succeeded",
  "approval-required",
  "blocked",
  "failed",
  "recovery-required",
  "verification-failed",
  "drift",
] as const;
export type VerifiedCommitStatus = (typeof VERIFIED_COMMIT_STATUSES)[number];

export const VERIFIED_COMMIT_REASONS = [
  "approval-required",
  "approval-invalid",
  "authority-denied",
  "verification-missing",
  "verification-failed",
  "verification-stale",
  "candidate-drift",
  "repository-drift",
  "message-policy",
  "review-incomplete",
  "issue-directive",
  "conflict-markers",
  "policy-block",
  "preflight-block",
  "execution-failed",
  "execution-uncertain",
  "restart-reconciliation",
  "completed",
] as const;
export type VerifiedCommitReason = (typeof VERIFIED_COMMIT_REASONS)[number];

export interface VerifiedCommitBinding {
  readonly proposalId: string;
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly runtimeAuthorityDigest: string;
  readonly workspaceDigest: string;
  readonly repositoryDigest: string;
  readonly baseSha: string;
  readonly parentSha: string;
  readonly stagedTreeDigest: string;
  readonly verificationEvidenceId: string;
  readonly messageDigest: string;
  readonly issueBindingDigest?: string;
}

export interface VerifiedCommitResult extends VerifiedCommitBinding {
  readonly schemaVersion: typeof VERIFIED_COMMIT_SCHEMA_VERSION;
  readonly status: VerifiedCommitStatus;
  readonly reason: VerifiedCommitReason;
  readonly recordedAt: string;
  readonly headSha?: string;
  readonly committedTreeDigest?: string;
  readonly blockReason?: GitDeliveryBlockReason;
  readonly preflightFindings?: readonly GitPreflightFinding[];
  // Present only when reason === "message-policy": the closed, content-free violation codes the
  // pure git-commit-policy validator computed for the rejected draft (never the message itself).
  readonly violations?: readonly GitCommitMessageViolationCode[];
}

const DIGEST = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KEYS = new Set([
  "schemaVersion",
  "status",
  "reason",
  "recordedAt",
  "proposalId",
  "runId",
  "envelopeDigest",
  "runtimeAuthorityDigest",
  "workspaceDigest",
  "repositoryDigest",
  "baseSha",
  "parentSha",
  "stagedTreeDigest",
  "verificationEvidenceId",
  "messageDigest",
  "issueBindingDigest",
  "headSha",
  "committedTreeDigest",
  "blockReason",
  "preflightFindings",
  "violations",
]);
const STATUSES = new Set<string>(VERIFIED_COMMIT_STATUSES);
const REASONS = new Set<string>(VERIFIED_COMMIT_REASONS);
const STATUS_REASONS: Readonly<Record<VerifiedCommitStatus, readonly VerifiedCommitReason[]>> = {
  succeeded: ["completed"],
  "approval-required": ["approval-required"],
  blocked: [
    "approval-invalid",
    "authority-denied",
    "message-policy",
    "review-incomplete",
    "issue-directive",
    "conflict-markers",
    "policy-block",
    "preflight-block",
  ],
  failed: ["execution-failed"],
  "recovery-required": ["execution-uncertain", "restart-reconciliation"],
  "verification-failed": ["verification-missing", "verification-failed"],
  drift: ["verification-stale", "candidate-drift", "repository-drift"],
};
function validStatusReason(value: Record<string, unknown>): boolean {
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return false;
  return (
    typeof value.reason === "string" &&
    REASONS.has(value.reason) &&
    STATUS_REASONS[value.status as VerifiedCommitStatus].includes(
      value.reason as VerifiedCommitReason,
    )
  );
}
function validRecordedAt(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function matches(
  record: Record<string, unknown>,
  keys: readonly string[],
  pattern: RegExp,
): boolean {
  return keys.every((key) => typeof record[key] === "string" && pattern.test(record[key]));
}

function optionalDigest(record: Record<string, unknown>, key: string, pattern: RegExp): boolean {
  return (
    record[key] === undefined || (typeof record[key] === "string" && pattern.test(record[key]))
  );
}

function validResultState(value: Record<string, unknown>): boolean {
  if (value.status === "succeeded") {
    return (
      value.reason === "completed" &&
      typeof value.headSha === "string" &&
      OBJECT_ID.test(value.headSha) &&
      value.committedTreeDigest === value.stagedTreeDigest
    );
  }
  return (
    value.headSha === undefined &&
    value.committedTreeDigest === undefined &&
    value.reason !== "completed"
  );
}

function validFinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  return [
    Object.keys(finding).length === 4,
    isGitPreflightFindingCode(finding.code),
    finding.phase === "preflight",
    finding.severity === "blocking" || finding.severity === "advisory",
    finding.remediation === "user-actionable" || finding.remediation === "internal",
  ].every(Boolean);
}
function validBlockedDetails(value: Record<string, unknown>): boolean {
  if (value.reason === "policy-block")
    return isGitDeliveryBlockReason(value.blockReason) && value.preflightFindings === undefined;
  if (value.reason === "preflight-block")
    return (
      value.blockReason === undefined &&
      Array.isArray(value.preflightFindings) &&
      value.preflightFindings.length > 0 &&
      value.preflightFindings.length <= 32 &&
      value.preflightFindings.every(validFinding)
    );
  return value.blockReason === undefined && value.preflightFindings === undefined;
}

/** Strict persisted/wire validator: unknown fields (including live claims) fail closed. */
export function isVerifiedCommitResult(value: unknown): value is VerifiedCommitResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const conditions = [
    Object.keys(record).every((key) => KEYS.has(key)),
    record.schemaVersion === "1",
    typeof record.status === "string" && STATUSES.has(record.status),
    typeof record.reason === "string" && REASONS.has(record.reason),
    validRecordedAt(record.recordedAt),
    validStatusReason(record),
    matches(record, ["proposalId", "runId", "verificationEvidenceId"], ID),
    matches(
      record,
      [
        "envelopeDigest",
        "runtimeAuthorityDigest",
        "workspaceDigest",
        "repositoryDigest",
        "stagedTreeDigest",
        "messageDigest",
      ],
      DIGEST,
    ),
    matches(record, ["baseSha", "parentSha"], OBJECT_ID),
    optionalDigest(record, "issueBindingDigest", DIGEST),
    validResultState(record),
    validBlockedDetails(record),
  ];
  return conditions.every(Boolean);
}
