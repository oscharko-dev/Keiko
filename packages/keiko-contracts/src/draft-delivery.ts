import { isGitObjectId, isSafeGitRefName } from "./git-repository.js";
import {
  GITHUB_ISSUE_NUMBER_MAX,
  isGitHubOwnerAndRepo,
  sameGitHubOwnerAndRepo,
} from "./github-issue-reference.js";
import {
  isGitPullRequestIdentity,
  type GitPullRequestIdentity,
} from "./git-pull-request-identity.js";

/** Durable remote intent and reconciliation facts; never a reusable grant or text-bearing payload. */
export interface DraftDeliveryBinding {
  readonly runId: string;
  readonly workspaceDigest: string;
  readonly runtimeAuthorityDigest: string;
  readonly envelopeDigest: string;
  readonly remoteDigest: string;
  readonly issueBindingDigest: string;
  readonly issueIdDigest: string;
  readonly issueNumber: number;
  readonly repository: string;
  readonly remoteAlias: "origin";
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly verifiedCommitProposalId: string;
  readonly recoveryId: string;
}

export type DraftDeliveryPhase =
  | "push-proposed"
  | "pushing"
  | "pushed"
  | "pr-proposed"
  | "creating-pr"
  | "draft-created"
  | "recovery-required";

export type DraftDeliveryReason =
  | "approval-required"
  | "in-flight"
  | "completed"
  | "authority-denied"
  | "remote-drift"
  | "issue-drift"
  | "provider-failed"
  | "ambiguous-remote"
  | "approval-invalid"
  | "payload-changed"
  | "restart-reconciliation"
  | "preflight-failed";

export interface DraftDeliveryRecord {
  readonly schemaVersion: "1";
  readonly binding: DraftDeliveryBinding;
  readonly revision: number;
  readonly phase: DraftDeliveryPhase;
  readonly reason: DraftDeliveryReason;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly recordedAt: string;
  readonly pullRequest?: GitPullRequestIdentity;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BINDING_DIGESTS = [
  "workspaceDigest",
  "runtimeAuthorityDigest",
  "envelopeDigest",
  "remoteDigest",
  "issueBindingDigest",
  "issueIdDigest",
] as const;
const BINDING_IDS = ["runId", "verifiedCommitProposalId", "recoveryId"] as const;
const BINDING_KEYS = new Set([
  ...BINDING_DIGESTS,
  ...BINDING_IDS,
  "issueNumber",
  "repository",
  "remoteAlias",
  "baseRef",
  "baseSha",
  "headRef",
  "headSha",
]);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "binding",
  "revision",
  "phase",
  "reason",
  "proposalId",
  "proposalDigest",
  "recordedAt",
  "pullRequest",
]);
const PHASE_REASONS: Readonly<Record<DraftDeliveryPhase, ReadonlySet<string>>> = {
  "push-proposed": new Set(["approval-required"]),
  pushing: new Set(["in-flight"]),
  pushed: new Set(["completed"]),
  "pr-proposed": new Set(["approval-required"]),
  "creating-pr": new Set(["in-flight"]),
  "draft-created": new Set(["completed"]),
  "recovery-required": new Set([
    "authority-denied",
    "remote-drift",
    "issue-drift",
    "provider-failed",
    "ambiguous-remote",
    "approval-invalid",
    "payload-changed",
    "restart-reconciliation",
    "preflight-failed",
  ]),
};

/**
 * Whether a record in this phase means something was actually delivered — a push that reached the
 * remote, or a draft pull request that exists. Derived from `PHASE_REASONS` rather than restated as
 * a second list: a delivered phase is exactly one whose only admissible reason is `completed`, so a
 * later phase added to the table is classified by the same rule that validates it. The in-flight
 * phases (`pushing`, `creating-pr`), the two approval-gated proposals, and `recovery-required` all
 * describe an attempt, never an artifact.
 *
 * A caller asking "did this run deliver anything?" needs this and not the record's presence: a
 * `recovery-required` or `push-proposed` record is proof that delivery was ATTEMPTED and did not
 * complete.
 */
export function isDeliveredDraftDeliveryPhase(phase: string): boolean {
  // Exported on the runtime subpath, so a JavaScript caller can hand in any string: a value that is
  // not one of the table's own phases is never delivered - not a thrown `size` read on `undefined`.
  if (!Object.hasOwn(PHASE_REASONS, phase)) return false;
  const reasons = PHASE_REASONS[phase as DraftDeliveryPhase];
  return reasons.size === 1 && reasons.has("completed");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && isSafeGitRefName(value) && !value.startsWith("refs/");
}

function validIssueNumber(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= GITHUB_ISSUE_NUMBER_MAX
  );
}

function validTarget(value: Record<string, unknown>): boolean {
  return (
    value.remoteAlias === "origin" &&
    typeof value.repository === "string" &&
    isGitHubOwnerAndRepo(value.repository) &&
    validIssueNumber(value.issueNumber) &&
    validRef(value.baseRef) &&
    validRef(value.headRef) &&
    value.baseRef !== value.headRef
  );
}

export function isDraftDeliveryBinding(value: unknown): value is DraftDeliveryBinding {
  return (
    record(value) &&
    Object.keys(value).length === BINDING_KEYS.size &&
    Object.keys(value).every((key) => BINDING_KEYS.has(key)) &&
    BINDING_DIGESTS.every((key) => matches(value[key], DIGEST)) &&
    BINDING_IDS.every((key) => matches(value[key], SAFE_ID)) &&
    isGitObjectId(value.baseSha) &&
    isGitObjectId(value.headSha) &&
    validTarget(value)
  );
}

function validRecordedAt(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}

function validPhase(value: Record<string, unknown>): boolean {
  if (typeof value.phase !== "string" || !Object.hasOwn(PHASE_REASONS, value.phase)) return false;
  return (
    typeof value.reason === "string" &&
    PHASE_REASONS[value.phase as DraftDeliveryPhase].has(value.reason)
  );
}

function validRemote(value: Record<string, unknown>, binding: DraftDeliveryBinding): boolean {
  const pr = value.pullRequest;
  if (pr === undefined) return value.phase !== "draft-created";
  if (!isGitPullRequestIdentity(pr)) return false;
  if (
    !sameGitHubOwnerAndRepo(pr.repository, binding.repository) ||
    !sameGitHubOwnerAndRepo(pr.headRepository, binding.repository) ||
    pr.headRef !== binding.headRef ||
    pr.baseRef !== binding.baseRef
  )
    return false;
  return value.phase !== "draft-created" || currentDraftMatches(pr, binding);
}

function currentDraftMatches(pr: GitPullRequestIdentity, binding: DraftDeliveryBinding): boolean {
  return (
    pr.headSha === binding.headSha &&
    pr.baseSha === binding.baseSha &&
    pr.isDraft &&
    pr.state === "open"
  );
}

function validRecordMetadata(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === "1" &&
    Object.keys(value).every((key) => RECORD_KEYS.has(key)) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    matches(value.proposalId, SAFE_ID) &&
    matches(value.proposalDigest, DIGEST) &&
    validRecordedAt(value.recordedAt) &&
    validPhase(value)
  );
}

export function isDraftDeliveryRecord(value: unknown): value is DraftDeliveryRecord {
  return (
    record(value) &&
    isDraftDeliveryBinding(value.binding) &&
    validRecordMetadata(value) &&
    validRemote(value, value.binding)
  );
}
