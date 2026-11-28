import { isRootRelativeFileIdentifier } from "./editor-workspace-path.js";
import { parseGitEditorDiffResponse, type GitEditorDiffResponse } from "./git-editor.js";
import { GIT_STATUS_CODES, isSafeGitRefName, type GitChangedFile } from "./git-repository.js";
import { isGitSyncOutcome, type GitSyncOutcome } from "./git-sync.js";

/**
 * The most entries one model-facing Git request carries (`paths` of keiko_git_stage, keiko_git_diff
 * and the unstage inverse) and the most changed files a status answer lists. It protects the
 * model's context window, not the work: a path may name a directory, which the server expands.
 */
export const CODING_RUNTIME_GIT_MAX_PATHS = 50;
/**
 * The most files one stage or unstage proposal binds after directory pathspecs expanded. A fixed
 * small bound here ended healthy work (U-28: a 301-file rename could not be staged), so this one
 * only protects memory and bounds a runaway loop: it equals the raw worktree snapshot's own scan
 * limit (`MAX_INSPECTED_PATHS`), beyond which Git's change list is not known to be complete anyway.
 */
export const CODING_RUNTIME_GIT_MAX_STAGE_PATHS = 10_000;
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

interface CodingRuntimeGitStatusBody {
  readonly kind: "status";
  readonly stagedTreeDigest: string;
  readonly branch: string;
  readonly changes: readonly GitChangedFile[];
  readonly truncated: boolean;
}
/**
 * The repository's status. `head` says whether the branch has a commit: an unborn branch (a fresh
 * repository, #4491) has no `headSha` and its next commit is a root commit; a born one names it.
 */
export type CodingRuntimeGitStatus = CodingRuntimeGitStatusBody &
  (
    | { readonly head: "born"; readonly headSha: string }
    | { readonly head: "unborn"; readonly headSha?: never }
  );
export interface CodingRuntimeGitDiff {
  readonly kind: "diff";
  readonly diff: GitEditorDiffResponse;
}
/**
 * Why a stage proposal was refused as `unsupported-transformation` (#4491): the one closed cause the
 * verified staging found, so the model and the operator act on the real class instead of a guess.
 * `config-unsupported`: the stage configuration could not be read or is outside what a verified
 * staging admits (`core.safecrlf`, an unknown `core.autocrlf`, a failed read). `filter-driver`: a
 * configured filter driver cannot be neutralised. `attribute-*`: the Git attribute rule class that
 * applies (from any `.gitattributes`, `.git/info/attributes` or a global attributes file).
 * `content-conversion`: a file's bytes would not round-trip under the effective line-ending mode.
 */
export const CODING_RUNTIME_GIT_STAGE_CAUSES = [
  "config-unsupported",
  "filter-driver",
  "attribute-filter",
  "attribute-encoding",
  "attribute-ident",
  "attribute-line-ending",
  "attribute-unreadable",
  "content-conversion",
] as const;
export type CodingRuntimeGitStageCause = (typeof CODING_RUNTIME_GIT_STAGE_CAUSES)[number];
export function isCodingRuntimeGitStageCause(value: unknown): value is CodingRuntimeGitStageCause {
  return (
    typeof value === "string" &&
    (CODING_RUNTIME_GIT_STAGE_CAUSES as readonly string[]).includes(value)
  );
}
export interface CodingRuntimeGitStage {
  readonly kind: "stage";
  readonly proposalId: string;
  readonly status: keyof typeof STAGE_STATUS_REASONS;
  readonly reason: (typeof STAGE_STATUS_REASONS)[keyof typeof STAGE_STATUS_REASONS][number];
  readonly pathCount: number;
  /** Present only on an `unsupported-transformation` refusal of the verified staging check. */
  readonly cause?: CodingRuntimeGitStageCause;
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
function changes(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= CODING_RUNTIME_GIT_MAX_PATHS && value.every(change)
  );
}
// A born branch names its commit; an unborn one (a fresh repository) has none and says so.
function statusHead(value: Record<string, unknown>): boolean {
  if (value.head === "unborn") return value.headSha === undefined;
  return (
    value.head === "born" &&
    typeof value.headSha === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.headSha)
  );
}
function status(value: Record<string, unknown>): boolean {
  return (
    keys(value, [
      "kind",
      "head",
      "headSha",
      "stagedTreeDigest",
      "branch",
      "changes",
      "truncated",
    ]) &&
    statusHead(value) &&
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
// A cause belongs to a stage proposal's `unsupported-transformation` refusal and nowhere else.
function causeAdmitted(value: Record<string, unknown>, kind: "stage" | "unstage"): boolean {
  if (value.cause === undefined) return true;
  return (
    kind === "stage" &&
    value.reason === "unsupported-transformation" &&
    isCodingRuntimeGitStageCause(value.cause)
  );
}
function proposal(value: Record<string, unknown>, kind: "stage" | "unstage"): boolean {
  return (
    keys(value, ["kind", "proposalId", "status", "reason", "pathCount", "cause"]) &&
    causeAdmitted(value, kind) &&
    typeof value.proposalId === "string" &&
    PROPOSAL_ID[kind].test(value.proposalId) &&
    stageStatusReason(value.status, value.reason) &&
    typeof value.pathCount === "number" &&
    Number.isSafeInteger(value.pathCount) &&
    value.pathCount > 0 &&
    value.pathCount <= CODING_RUNTIME_GIT_MAX_STAGE_PATHS
  );
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
function branch(value: Record<string, unknown>): boolean {
  return (
    keys(value, ["kind", "status", "reason", "branch"]) &&
    typeof value.status === "string" &&
    Object.hasOwn(CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS, value.status) &&
    (
      CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS[
        value.status as keyof typeof CODING_RUNTIME_GIT_BRANCH_STATUS_REASONS
      ] as readonly unknown[]
    ).includes(value.reason) &&
    (value.branch === undefined || isSafeTaskBranchName(value.branch))
  );
}
function stageStatusReason(status: unknown, reason: unknown): boolean {
  if (typeof status !== "string" || !Object.hasOwn(STAGE_STATUS_REASONS, status)) return false;
  const allowed: readonly unknown[] =
    STAGE_STATUS_REASONS[status as CodingRuntimeGitStage["status"]];
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
/**
 * A status persisted by 1.5.10 (a history or replay record) names its commit and carries no `head`
 * marker. Read at the boundary where such a record re-enters, before the guard runs, it is a born
 * branch. The guard itself stays strict: a status still needs `head`, and an unborn branch is never
 * inferred from a missing marker. Any other value is returned as it came.
 */
export function normalizePersistedCodingRuntimeGitResult(value: unknown): unknown {
  if (!record(value) || value.kind !== "status" || value.head !== undefined) return value;
  return typeof value.headSha === "string" ? { ...value, head: "born" } : value;
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
