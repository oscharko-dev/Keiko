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
  | "dirty-worktree-impacts-recovery";

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
