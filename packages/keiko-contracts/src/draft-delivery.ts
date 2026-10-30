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

/**
 * Durable remote intent and reconciliation facts of an issue-bound run; never a reusable grant or
 * text-bearing payload. Persisted records of this shape carry no `kind` and stay valid unchanged.
 */
export interface DraftDeliveryIssueBinding {
  /** Absent on every issue-bound record; the discriminant that tells it from a branch-push one. */
  readonly kind?: undefined;
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

/**
 * Durable intent of an issue-free run that pushes its verified commit to its own task branch on
 * `origin` — any Git remote, so no repository, issue or pull request fact exists to bind. Only the
 * push phases are admissible (see `BRANCH_PHASES`); a pull request needs an issue binding.
 */
export interface DraftDeliveryBranchBinding {
  readonly kind: "branch-push";
  readonly runId: string;
  readonly workspaceDigest: string;
  readonly runtimeAuthorityDigest: string;
  readonly envelopeDigest: string;
  readonly remoteDigest: string;
  readonly remoteAlias: "origin";
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly verifiedCommitProposalId: string;
  readonly recoveryId: string;
}

export type DraftDeliveryBinding = DraftDeliveryIssueBinding | DraftDeliveryBranchBinding;

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
const BRANCH_BINDING_KEYS = new Set([
  "kind",
  "runId",
  "workspaceDigest",
  "runtimeAuthorityDigest",
  "envelopeDigest",
  "remoteDigest",
  "remoteAlias",
  "baseRef",
  "baseSha",
  "headRef",
  "headSha",
  "verifiedCommitProposalId",
  "recoveryId",
]);
const BRANCH_DIGESTS = [
  "workspaceDigest",
  "runtimeAuthorityDigest",
  "envelopeDigest",
  "remoteDigest",
] as const;
const BRANCH_PHASES: ReadonlySet<string> = new Set([
  "push-proposed",
  "pushing",
  "pushed",
  "recovery-required",
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

function isDraftDeliveryPhase(phase: string): phase is DraftDeliveryPhase {
  return Object.hasOwn(PHASE_REASONS, phase);
}

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
  if (!isDraftDeliveryPhase(phase)) return false;
  const phaseReasons: Readonly<Partial<Record<DraftDeliveryPhase, ReadonlySet<string>>>> =
    PHASE_REASONS;
  const reasons = phaseReasons[phase];
  if (reasons === undefined) return false;
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

function isIssueBindingShape(value: unknown): value is DraftDeliveryIssueBinding {
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

function validBranchTarget(value: Record<string, unknown>): boolean {
  return (
    value.remoteAlias === "origin" &&
    isGitObjectId(value.baseSha) &&
    isGitObjectId(value.headSha) &&
    validRef(value.baseRef) &&
    validRef(value.headRef)
  );
}

function isBranchBindingShape(value: unknown): value is DraftDeliveryBranchBinding {
  return (
    record(value) &&
    value.kind === "branch-push" &&
    Object.keys(value).length === BRANCH_BINDING_KEYS.size &&
    Object.keys(value).every((key) => BRANCH_BINDING_KEYS.has(key)) &&
    BRANCH_DIGESTS.every((key) => matches(value[key], DIGEST)) &&
    BINDING_IDS.every((key) => matches(value[key], SAFE_ID)) &&
    validBranchTarget(value)
  );
}

/** Whether a binding belongs to an issue-free run that pushes its own task branch. */
export function isDraftDeliveryBranchBinding(
  value: DraftDeliveryBinding,
): value is DraftDeliveryBranchBinding {
  return value.kind === "branch-push";
}

/** Whether a binding belongs to an issue-bound run, the only kind that can open a pull request. */
export function isDraftDeliveryIssueBinding(
  value: DraftDeliveryBinding,
): value is DraftDeliveryIssueBinding {
  return value.kind === undefined;
}

export function isDraftDeliveryBinding(value: unknown): value is DraftDeliveryBinding {
  return isIssueBindingShape(value) || isBranchBindingShape(value);
}

function validRecordedAt(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}

function validPhase(value: Record<string, unknown>): boolean {
  if (typeof value.phase !== "string" || !Object.hasOwn(PHASE_REASONS, value.phase)) return false;
  if (typeof value.reason !== "string") return false;
  const phase = value.phase;
  if (typeof phase !== "string" || !isDraftDeliveryPhase(phase)) return false;
  const reasons = PHASE_REASONS[phase];
  return reasons.has(value.reason);
}

function validRemote(value: Record<string, unknown>, binding: DraftDeliveryBinding): boolean {
  const pr = value.pullRequest;
  // A branch-push run has no pull request: neither an identity nor a pull-request phase can exist.
  if (isDraftDeliveryBranchBinding(binding))
    return pr === undefined && BRANCH_PHASES.has(String(value.phase));
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

function currentDraftMatches(
  pr: GitPullRequestIdentity,
  binding: DraftDeliveryIssueBinding,
): boolean {
  return (
    pr.headSha === binding.headSha &&
    pr.baseSha === binding.baseSha &&
    pr.isDraft &&
    pr.state === "open"
  );
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRecordMetadata(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === "1" &&
    Object.keys(value).every((key) => RECORD_KEYS.has(key)) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    validRevision(value.revision) &&
    matches(value.proposalId, SAFE_ID) &&
    matches(value.proposalDigest, DIGEST) &&
    validRecordedAt(value.recordedAt) &&
    validPhase(value)
  );
}

function validObservedRemote(value: Record<string, unknown>): boolean {
  const binding = value.binding;
  return isDraftDeliveryBinding(binding) && validRemote(value, binding);
}

/** A delivery record whose binding names an issue and a repository: the only kind with a pull request. */
export type IssueBoundDraftDeliveryRecord = DraftDeliveryRecord & {
  readonly binding: DraftDeliveryIssueBinding;
};

export function isIssueBoundDraftDeliveryRecord(
  value: DraftDeliveryRecord,
): value is IssueBoundDraftDeliveryRecord {
  return isDraftDeliveryIssueBinding(value.binding);
}

export function isDraftDeliveryRecord(value: unknown): value is DraftDeliveryRecord {
  return (
    record(value) &&
    isDraftDeliveryBinding(value.binding) &&
    validRecordMetadata(value) &&
    validObservedRemote(value)
  );
}
