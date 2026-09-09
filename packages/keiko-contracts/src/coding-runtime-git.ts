import { isRootRelativeFileIdentifier } from "./editor-workspace-path.js";
import { parseGitEditorDiffResponse, type GitEditorDiffResponse } from "./git-editor.js";
import { GIT_STATUS_CODES, isSafeGitRefName, type GitChangedFile } from "./git-repository.js";

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
export type CodingRuntimeGitResult =
  CodingRuntimeGitStatus | CodingRuntimeGitDiff | CodingRuntimeGitStage;

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
function changes(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= CODING_RUNTIME_GIT_MAX_PATHS && value.every(change)
  );
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
function stage(value: Record<string, unknown>): boolean {
  return (
    keys(value, ["kind", "proposalId", "status", "reason", "pathCount"]) &&
    typeof value.proposalId === "string" &&
    /^stage-\d{1,39}$/u.test(value.proposalId) &&
    stageStatusReason(value.status, value.reason) &&
    typeof value.pathCount === "number" &&
    Number.isSafeInteger(value.pathCount) &&
    value.pathCount > 0 &&
    value.pathCount <= CODING_RUNTIME_GIT_MAX_PATHS
  );
}
function stageStatusReason(status: unknown, reason: unknown): boolean {
  if (typeof status !== "string" || !Object.hasOwn(STAGE_STATUS_REASONS, status)) return false;
  const allowed: readonly unknown[] =
    STAGE_STATUS_REASONS[status as CodingRuntimeGitStage["status"]];
  return allowed.includes(reason);
}
export function isCodingRuntimeGitResult(value: unknown): value is CodingRuntimeGitResult {
  try {
    if (
      !record(value) ||
      new TextEncoder().encode(JSON.stringify(value)).length > CODING_RUNTIME_GIT_MAX_BYTES
    )
      return false;
    if (value.kind === "status") return status(value);
    if (value.kind === "stage") return stage(value);
    return (
      value.kind === "diff" &&
      keys(value, ["kind", "diff"]) &&
      parseGitEditorDiffResponse(value.diff).ok
    );
  } catch {
    return false;
  }
}
