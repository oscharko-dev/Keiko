import { isRootRelativeFileIdentifier } from "./editor-workspace-path.js";
import { parseGitEditorDiffResponse, type GitEditorDiffResponse } from "./git-editor.js";
import { GIT_STATUS_CODES, isSafeGitRefName, type GitChangedFile } from "./git-repository.js";
import { isGitSyncOutcome, type GitSyncOutcome } from "./git-sync.js";

export const CODING_RUNTIME_GIT_MAX_PATHS = 50;
export const CODING_RUNTIME_GIT_MAX_BYTES = 65_536;
const STATUSES: ReadonlySet<string> = new Set(GIT_STATUS_CODES);
const STAGE_STATUS_REASONS = {
  ready: ["none"],
  "approval-required": ["approval-required"],
  succeeded: ["none"],
  blocked: [
    "approval-invalid",
    "authority-denied",
    "scope-denied",
    "policy-block",
    "preflight-block",
    "unsupported-transformation",
    // The runtime Git service's own admission refusals for a stage proposal (runtimeGitService.ts).
    // Each is a complete Git result the model can act on; before 2026-09-10 (Coding Workbench run
    // 13) the service answered them with no result at all and the model was told its Git authority
    // had been revoked. `selection-unreviewed`: a requested path is not a pending or fully staged
    // change Git lists for the worktree — unchanged, absent, a directory, in conflict, or hidden
    // behind a truncated change list. `buffers-dirty`: an editor session holds unsaved content, so
    // the bytes to bind are not settled. `proposal-limit`: too many stage proposals are open.
    "selection-unreviewed",
    "buffers-dirty",
    "proposal-limit",
  ],
  drift: ["candidate-drift"],
  failed: ["execution-failed"],
  "recovery-required": ["execution-uncertain"],
} as const;

export interface CodingRuntimeGitStatus {
  readonly kind: "status";
  readonly headSha: string;
  readonly stagedTreeDigest: string;
  readonly branch: string;
  readonly changes: readonly GitChangedFile[];
  readonly truncated: boolean;
}
export interface CodingRuntimeGitDiff {
  readonly kind: "diff";
  readonly diff: GitEditorDiffResponse;
}
export interface CodingRuntimeGitStage {
  readonly kind: "stage";
  readonly proposalId: string;
  readonly status: keyof typeof STAGE_STATUS_REASONS;
  readonly reason: (typeof STAGE_STATUS_REASONS)[keyof typeof STAGE_STATUS_REASONS][number];
  readonly pathCount: number;
}
/**
 * An unstage proposal's result (#3902 AC2): the same lifecycle as a stage proposal, for paths whose
 * staged change the index gives back to the worktree. Its id carries its own prefix.
 */
export interface CodingRuntimeGitUnstage {
  readonly kind: "unstage";
  readonly proposalId: string;
  readonly status: CodingRuntimeGitStage["status"];
  readonly reason: CodingRuntimeGitStage["reason"];
  readonly pathCount: number;
}
/**
 * A fetch, or a fast-forward pull of the current branch from its upstream, that the Git sync owner
 * ran for the run (#3902 AC2): its closed outcome, and the branch and its distance from the
 * upstream afterwards when Git could still read them.
 */
export type CodingRuntimeGitSync =
  | (CodingRuntimeGitSyncFacts & { readonly kind: "fetch" })
  | (CodingRuntimeGitSyncFacts & { readonly kind: "pull" });
interface CodingRuntimeGitSyncFacts {
  readonly status: GitSyncOutcome;
  readonly branch?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly truncated: boolean;
}
/**
 * The closed outcome of `keiko_git_branch` (#3907, owner decision 2026-10-31): the run created a
 * task branch at its current commit and switched to it (`succeeded`), or Keiko refused or could not
 * (`blocked`, `failed`, `recovery-required`) and says why in one closed word. The branch name is
 * the model's own argument echoed back, and only when it is a safe Git ref name.
 */
export const CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS = {
  succeeded: ["none"],
  blocked: [
    "invalid-name",
    "protected-name",
    "branch-exists",
    "not-on-base",
    "not-local-checkout",
    "executable-filters",
    "authority-denied",
    "policy-block",
    "preflight-block",
  ],
  failed: ["execution-failed", "rebind-failed"],
  "recovery-required": ["execution-uncertain"],
} as const;
export interface CodingRuntimeGitBranch {
  readonly kind: "branch";
  readonly status: keyof typeof CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS;
  readonly reason: (typeof CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS)[keyof typeof CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS][number];
  readonly branch?: string;
}
export type CodingRuntimeGitResult =
  | CodingRuntimeGitStatus
  | CodingRuntimeGitDiff
  | CodingRuntimeGitStage
  | CodingRuntimeGitUnstage
  | CodingRuntimeGitSync
  | CodingRuntimeGitBranch;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function isCodingRuntimeGitPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    isRootRelativeFileIdentifier(value) &&
    !value.includes("\uFFFD") &&
    !value.split("/").includes(".")
  );
}
function change(value: unknown): value is GitChangedFile {
  if (
    !record(value) ||
    !keys(value, [
      "path",
      "oldPath",
      "indexStatus",
      "worktreeStatus",
      "staged",
      "unstaged",
      "untracked",
      "conflicted",
    ])
  )
    return false;
  return (
    isCodingRuntimeGitPath(value.path) &&
    (value.oldPath === undefined || isCodingRuntimeGitPath(value.oldPath)) &&
    typeof value.indexStatus === "string" &&
    STATUSES.has(value.indexStatus) &&
    typeof value.worktreeStatus === "string" &&
    STATUSES.has(value.worktreeStatus) &&
    [value.staged, value.unstaged, value.untracked, value.conflicted].every(
      (flag) => typeof flag === "boolean",
    )
  );
}
function changes(value: unknown): value is readonly GitChangedFile[] {
  if (!Array.isArray(value) || value.length > CODING_RUNTIME_GIT_MAX_PATHS) return false;
  const count = value.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in value) || !change(value[index])) return false;
  }
  return true;
}
function status(value: Record<string, unknown>): boolean {
  return (
    keys(value, ["kind", "headSha", "stagedTreeDigest", "branch", "changes", "truncated"]) &&
    typeof value.headSha === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.headSha) &&
    typeof value.stagedTreeDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(value.stagedTreeDigest) &&
    typeof value.branch === "string" &&
    isSafeGitRefName(value.branch) &&
    typeof value.truncated === "boolean" &&
    changes(value.changes)
  );
}
const PROPOSAL_ID: Readonly<Record<"stage" | "unstage", RegExp>> = {
  stage: /^stage-\d{1,39}$/u,
  unstage: /^unstage-\d{1,39}$/u,
};
function proposal(value: Record<string, unknown>, kind: "stage" | "unstage"): boolean {
  return (
    keys(value, ["kind", "proposalId", "status", "reason", "pathCount"]) &&
    typeof value.proposalId === "string" &&
    PROPOSAL_ID[kind].test(value.proposalId) &&
    stageStatusReason(value.status, value.reason) &&
    typeof value.pathCount === "number" &&
    Number.isSafeInteger(value.pathCount) &&
    value.pathCount > 0 &&
    value.pathCount <= CODING_RUNTIME_GIT_MAX_PATHS
  );
}
function isStageStatus(value: unknown): value is CodingRuntimeGitStage["status"] {
  return typeof value === "string" && Object.hasOwn(STAGE_STATUS_REASONS, value);
}
function count(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}
function sync(value: Record<string, unknown>): boolean {
  return (
    keys(value, ["kind", "status", "branch", "ahead", "behind", "truncated"]) &&
    isGitSyncOutcome(value.status) &&
    (value.branch === undefined ||
      (typeof value.branch === "string" && isSafeGitRefName(value.branch))) &&
    count(value.ahead) &&
    count(value.behind) &&
    typeof value.truncated === "boolean"
  );
}
/**
 * A task-branch name `keiko_git_branch` may create and echo back (#3907): a safe Git ref name that
 * cannot be read as an option. The one check its producer and this result validator share.
 */
export function isSafeTaskBranchName(value: unknown): value is string {
  return typeof value === "string" && isSafeGitRefName(value) && !value.startsWith("-");
}
function isBranchStatus(
  value: unknown,
): value is keyof typeof CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS {
  return (
    typeof value === "string" && Object.hasOwn(CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS, value)
  );
}
function branchStatusReason(status: unknown, reason: unknown): boolean {
  if (!isBranchStatus(status)) return false;
  const allowed: readonly unknown[] = CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS[status];
  return allowed.includes(reason);
}
function branch(value: Record<string, unknown>): boolean {
  return (
    keys(value, ["kind", "status", "reason", "branch"]) &&
    branchStatusReason(value.status, value.reason) &&
    (value.branch === undefined || isSafeTaskBranchName(value.branch))
  );
}
function stageStatusReason(status: unknown, reason: unknown): boolean {
  if (!isStageStatus(status)) return false;
  const allowed: readonly unknown[] = STAGE_STATUS_REASONS[status];
  return allowed.includes(reason);
}
function resultOfKind(value: Record<string, unknown>): boolean {
  if (value.kind === "status") return status(value);
  if (value.kind === "stage" || value.kind === "unstage") return proposal(value, value.kind);
  if (value.kind === "fetch" || value.kind === "pull") return sync(value);
  if (value.kind === "branch") return branch(value);
  return (
    value.kind === "diff" &&
    keys(value, ["kind", "diff"]) &&
    parseGitEditorDiffResponse(value.diff).ok
  );
}
export function isCodingRuntimeGitResult(value: unknown): value is CodingRuntimeGitResult {
  try {
    if (
      !record(value) ||
      new TextEncoder().encode(JSON.stringify(value)).length > CODING_RUNTIME_GIT_MAX_BYTES
    )
      return false;
    return resultOfKind(value);
  } catch {
    return false;
  }
}
