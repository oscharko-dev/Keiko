// Shared, body-free preflight taxonomy. The Git kernel remains the producer and execution owner.
export type GitPreflightFindingCode =
  | "detached-head"
  | "branch-already-exists"
  | "base-branch-missing"
  | "switch-target-missing"
  | "no-changes-to-stage"
  | "nothing-staged-to-unstage"
  | "nothing-staged-to-commit"
  | "untracked-files-impacted"
  | "no-upstream-configured"
  | "nothing-to-push"
  | "non-fast-forward"
  | "remote-alias-missing"
  | "remote-unreachable"
  | "operation-in-progress"
  | "no-operation-to-abort"
  | "recovery-target-unset"
  | "dirty-worktree-impacts-recovery"
  // #3394 review, finding 1: the caller-supplied `verifiedCommitSha` no longer equals the freshly
  // re-read local worktree head — the branch moved between preview/approval and execute. Blocking so
  // a drifted push is refused instead of silently publishing a different commit than was reviewed.
  | "verified-commit-drifted"
  // #3394 review, follow-up on the drift check: `snapshot.headSha` is the head of the CHECKED-OUT
  // branch, so the pinned-commit comparison only speaks for `sourceBranchName` when that branch is
  // the one checked out. A push naming any other branch (or issued from a detached head) is refused
  // outright instead of being judged -- and possibly passed -- by another branch's head.
  | "source-branch-not-checked-out";

export const GIT_PREFLIGHT_FINDING_CODES: readonly GitPreflightFindingCode[] = [
  "detached-head",
  "branch-already-exists",
  "base-branch-missing",
  "switch-target-missing",
  "no-changes-to-stage",
  "nothing-staged-to-unstage",
  "nothing-staged-to-commit",
  "untracked-files-impacted",
  "no-upstream-configured",
  "nothing-to-push",
  "non-fast-forward",
  "remote-alias-missing",
  "remote-unreachable",
  "operation-in-progress",
  "no-operation-to-abort",
  "recovery-target-unset",
  "dirty-worktree-impacts-recovery",
  "verified-commit-drifted",
  "source-branch-not-checked-out",
] as const;

// A blocking finding halts the lifecycle before execution; an advisory finding is surfaced for the
// caller (and preview/UX) but does not halt.
export type GitPreflightSeverity = "blocking" | "advisory";

// Intrinsic to each code: a user-actionable finding describes a repository condition the operator
// can fix; an internal finding describes a kernel/caller construction fault. AC2 distinguishes these
// so approval UX routes "you need to stage a file" differently from "the kernel was misconfigured".
export type GitPreflightRemediation = "user-actionable" | "internal";

export interface GitPreflightFinding {
  readonly code: GitPreflightFindingCode;
  readonly severity: GitPreflightSeverity;
  readonly remediation: GitPreflightRemediation;
  readonly phase: "preflight";
}

export function isGitPreflightFindingCode(value: unknown): value is GitPreflightFindingCode {
  return (
    typeof value === "string" && (GIT_PREFLIGHT_FINDING_CODES as readonly string[]).includes(value)
  );
}
