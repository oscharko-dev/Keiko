// Deterministic preflight evaluation for governed Git writes (Issue #472, Epic #470).
//
// Preflight is a PURE function over a content-free repository snapshot. Same (resolvedInputs,
// snapshot) pair always yields the same report, so preflight reruns are idempotent by construction
// (the issue's "safe retry and idempotency for preflight reruns" requirement). Each finding carries
// a typed `code`, a contextual `severity` (blocking vs advisory), and an intrinsic `remediation`
// (user-actionable vs internal). That remediation split is the AC2 distinction: callers can tell an
// actionable user fix ("stage a file", "configure an upstream") from an internal construction fault
// without parsing any message string.
//
// The snapshot is produced by a read-only inspection port (the Node reader reuses the existing
// read-only git inspection allowlist — `git status / rev-parse / branch / remote`). Preflight never
// runs git itself; it only reasons over the snapshot. No IO, no clock, no randomness.

import type {
  GitDeliveryAbortableOperation,
  GitDeliveryActionKind,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";

// ─── Repository snapshot ─────────────────────────────────────────────────────────────────
// Content-free: counts, flags, and branch/remote NAMES only (names are required to evaluate branch
// existence and remote aliases). No raw paths, diffs, or command output, so the snapshot is safe to
// serialize into preview/evidence and cannot leak file contents.

export interface GitWorktreeSnapshot {
  readonly headDetached: boolean;
  // Present iff !headDetached. The branch HEAD currently points at.
  readonly currentBranchName?: string | undefined;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
  // True when the current branch tracks a remote-tracking branch.
  readonly hasUpstream: boolean;
  // Commits the current branch is ahead of / behind its upstream. 0 when there is no upstream or the
  // distance is unknown.
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly existingLocalBranchNames: readonly string[];
  readonly remoteAliases: readonly string[];
  // undefined = reachability was not probed (preflight then emits no reachability finding); a probed
  // value of false yields a blocking remote-unreachable finding for network actions.
  readonly remoteReachable?: boolean | undefined;
  // A sequencing operation (merge/rebase/cherry-pick/revert/bisect) currently in progress, if any.
  readonly operationInProgress?: GitDeliveryAbortableOperation | undefined;
}

// ─── Finding taxonomy ─────────────────────────────────────────────────────────────────────

export type GitPreflightFindingCode =
  | "detached-head"
  | "branch-already-exists"
  | "base-branch-missing"
  | "no-changes-to-stage"
  | "nothing-staged-to-unstage"
  | "nothing-staged-to-commit"
  | "untracked-files-impacted"
  | "no-upstream-configured"
  | "nothing-to-push"
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
  "no-changes-to-stage",
  "nothing-staged-to-unstage",
  "nothing-staged-to-commit",
  "untracked-files-impacted",
  "no-upstream-configured",
  "nothing-to-push",
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

// Frozen, exhaustive code → remediation table. Keyed on every code so a new code forces an explicit
// classification here (the Record is not Partial).
const FINDING_REMEDIATION: Readonly<Record<GitPreflightFindingCode, GitPreflightRemediation>> = {
  "detached-head": "user-actionable",
  "branch-already-exists": "user-actionable",
  "base-branch-missing": "user-actionable",
  "no-changes-to-stage": "user-actionable",
  "nothing-staged-to-unstage": "user-actionable",
  "nothing-staged-to-commit": "user-actionable",
  "untracked-files-impacted": "user-actionable",
  "no-upstream-configured": "user-actionable",
  "nothing-to-push": "user-actionable",
  "remote-alias-missing": "user-actionable",
  "remote-unreachable": "user-actionable",
  "operation-in-progress": "user-actionable",
  "no-operation-to-abort": "user-actionable",
  "recovery-target-unset": "internal",
  "dirty-worktree-impacts-recovery": "user-actionable",
} as const;

export function gitPreflightRemediationFor(code: GitPreflightFindingCode): GitPreflightRemediation {
  return FINDING_REMEDIATION[code];
}

export interface GitPreflightFinding {
  readonly code: GitPreflightFindingCode;
  readonly severity: GitPreflightSeverity;
  readonly remediation: GitPreflightRemediation;
  readonly phase: "preflight";
}

export interface GitPreflightReport {
  // True when there are no blocking findings — the lifecycle may proceed to preview/policy/execute.
  readonly ok: boolean;
  readonly findings: readonly GitPreflightFinding[];
  readonly blocking: readonly GitPreflightFinding[];
  readonly advisory: readonly GitPreflightFinding[];
}

// ─── Finding builders ───────────────────────────────────────────────────────────────────────

function blocking(code: GitPreflightFindingCode): GitPreflightFinding {
  return {
    code,
    severity: "blocking",
    remediation: gitPreflightRemediationFor(code),
    phase: "preflight",
  };
}

function advisory(code: GitPreflightFindingCode): GitPreflightFinding {
  return {
    code,
    severity: "advisory",
    remediation: gitPreflightRemediationFor(code),
    phase: "preflight",
  };
}

function report(findings: readonly GitPreflightFinding[]): GitPreflightReport {
  const blockingFindings = findings.filter((f) => f.severity === "blocking");
  const advisoryFindings = findings.filter((f) => f.severity === "advisory");
  return {
    ok: blockingFindings.length === 0,
    findings,
    blocking: blockingFindings,
    advisory: advisoryFindings,
  };
}

function branchExists(snapshot: GitWorktreeSnapshot, name: string): boolean {
  return snapshot.existingLocalBranchNames.includes(name) || snapshot.currentBranchName === name;
}

// ─── Per-kind evaluators ──────────────────────────────────────────────────────────────────
// Each evaluator is a pure function of (typed inputs, snapshot). Findings are emitted in a stable,
// deterministic order so repeated runs produce byte-identical reports.

function preflightBranchCreate(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "branch-create" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  const findings: GitPreflightFinding[] = [];
  if (branchExists(snapshot, inputs.branchName)) {
    findings.push(blocking("branch-already-exists"));
  }
  if (!branchExists(snapshot, inputs.baseBranchName)) {
    findings.push(blocking("base-branch-missing"));
  }
  if (snapshot.headDetached) {
    findings.push(advisory("detached-head"));
  }
  return findings;
}

function preflightStage(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "stage" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  const findings: GitPreflightFinding[] = [];
  if (inputs.pathCount === 0) {
    findings.push(blocking("no-changes-to-stage"));
  }
  if (inputs.includesUntracked && snapshot.untrackedFileCount > 0) {
    findings.push(advisory("untracked-files-impacted"));
  }
  if (snapshot.operationInProgress !== undefined) {
    findings.push(advisory("operation-in-progress"));
  }
  return findings;
}

function preflightUnstage(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "unstage" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  if (inputs.pathCount === 0 || snapshot.stagedFileCount === 0) {
    return [blocking("nothing-staged-to-unstage")];
  }
  return [];
}

function preflightCommit(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "commit" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  const findings: GitPreflightFinding[] = [];
  if (snapshot.stagedFileCount === 0 && !inputs.allowEmptyCommit) {
    findings.push(blocking("nothing-staged-to-commit"));
  }
  if (snapshot.headDetached) {
    // A commit on a detached HEAD produces an unreferenced commit; the governed flow requires a
    // branch so the result is reachable and auditable.
    findings.push(blocking("detached-head"));
  }
  if (snapshot.operationInProgress !== undefined) {
    // Concluding a merge/rebase via commit is legitimate; surface it without halting.
    findings.push(advisory("operation-in-progress"));
  }
  return findings;
}

function preflightPush(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "push" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  const findings: GitPreflightFinding[] = [];
  if (!snapshot.remoteAliases.includes(inputs.remoteAlias)) {
    findings.push(blocking("remote-alias-missing"));
  }
  if (!snapshot.hasUpstream && !inputs.setUpstreamTracking) {
    findings.push(blocking("no-upstream-configured"));
  }
  if (snapshot.remoteReachable === false) {
    findings.push(blocking("remote-unreachable"));
  }
  if (snapshot.aheadCount === 0 && !inputs.forcePush) {
    findings.push(advisory("nothing-to-push"));
  }
  return findings;
}

function preflightAbort(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "abort" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  if (snapshot.operationInProgress !== inputs.operationToAbort) {
    // Either nothing is in progress, or a different operation is — both mean the requested abort has
    // no matching operation to act on.
    return [blocking("no-operation-to-abort")];
  }
  return [];
}

function preflightRecovery(
  inputs: Extract<GitDeliveryResolvedInputs, { kind: "recovery" }>,
  snapshot: GitWorktreeSnapshot,
): readonly GitPreflightFinding[] {
  const findings: GitPreflightFinding[] = [];
  if (inputs.targetRefHash.length === 0) {
    findings.push(blocking("recovery-target-unset"));
  }
  const dirty = snapshot.unstagedFileCount > 0 || snapshot.untrackedFileCount > 0;
  const discardsWorktree =
    inputs.recoveryStrategyHint === "mixed-reset" || inputs.recoveryStrategyHint === "soft-reset";
  if (dirty && discardsWorktree) {
    // A reset that does not stash first leaves (soft) or touches (mixed) local changes; surface the
    // interaction so the operator can choose stash-and-reset instead.
    findings.push(advisory("dirty-worktree-impacts-recovery"));
  }
  return findings;
}

// Provider actions (pr-create / pr-update / merge) have no snapshot-derivable local precondition:
// their readiness (merge readiness, required checks, approvals) lives in the provider-neutral
// contract and is evaluated by the provider gateway in later slices (#477/#478), not by local
// worktree preflight. They return a uniform empty (ok) report so the lifecycle shape is identical.
function preflightNoLocalPrecondition(): readonly GitPreflightFinding[] {
  return [];
}

// ─── Public entry point ───────────────────────────────────────────────────────────────────

// Per-kind dispatch. The mapped type forces an entry for EVERY GitDeliveryActionKind, so a new kind
// is a compile error here rather than a silent skip — the same exhaustiveness an assertNever switch
// gives, with a single-step lookup instead of a long branch.
type PreflightEvaluator<K extends GitDeliveryActionKind> = (
  inputs: Extract<GitDeliveryResolvedInputs, { kind: K }>,
  snapshot: GitWorktreeSnapshot,
) => readonly GitPreflightFinding[];

type PreflightDispatch = { readonly [K in GitDeliveryActionKind]: PreflightEvaluator<K> };

const PREFLIGHT_DISPATCH: PreflightDispatch = {
  "branch-create": preflightBranchCreate,
  stage: preflightStage,
  unstage: preflightUnstage,
  commit: preflightCommit,
  push: preflightPush,
  abort: preflightAbort,
  recovery: preflightRecovery,
  "pr-create": preflightNoLocalPrecondition,
  "pr-update": preflightNoLocalPrecondition,
  merge: preflightNoLocalPrecondition,
};

export function evaluateGitPreflight(
  inputs: GitDeliveryResolvedInputs,
  snapshot: GitWorktreeSnapshot,
): GitPreflightReport {
  // The lookup is keyed by inputs.kind, so the selected evaluator's parameter type matches inputs by
  // construction; the cast bridges the union-to-member variance the indexed access cannot prove.
  const evaluate = PREFLIGHT_DISPATCH[inputs.kind] as PreflightEvaluator<GitDeliveryActionKind>;
  return report(evaluate(inputs, snapshot));
}

// ─── Guards ─────────────────────────────────────────────────────────────────────────────────

export function isGitPreflightFindingCode(value: unknown): value is GitPreflightFindingCode {
  return (
    typeof value === "string" && (GIT_PREFLIGHT_FINDING_CODES as readonly string[]).includes(value)
  );
}
