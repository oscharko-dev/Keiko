// The narrow local Git mutation adapter contract (Issue #472, Epic #470) — AC3.
//
// This module defines WHAT the governed local Git adapter may do, as data and pure functions:
//
//   1. `GitLocalMutationAdapter` — the port. One typed method per local mutation kind. There is NO
//      method that accepts an arbitrary argument vector, so there is no path from the kernel to
//      "run this git command string". Local Git write authority is reachable only through these
//      typed operations.
//   2. `GIT_MUTATION_ALLOWED_SUBCOMMANDS` / `GIT_MUTATION_COMMAND_RULES` — the closed allowlist the
//      Node adapter (git-mutation-node.ts) hands to the keiko-tools no-shell spawn boundary. It is a
//      SEPARATE, dedicated rule set from both the read-only terminal policy and the harness default,
//      and it permits only the governed mutation subcommands.
//   3. The pure argv builders — each maps validated, typed operands to a fixed argument vector whose
//      first token is always one of the allowed subcommands. Operands are validated (no NUL, no
//      flag-injection via a leading "-" on refs) and file pathspecs are placed after a "--" sentinel
//      so a path can never be reinterpreted as an option.
//
// Pure module: types, frozen tables, and total pure functions. No IO, no spawn, no child_process —
// the actual execution adapter is git-mutation-node.ts on the `./internal/git-mutation` subpath.

import type {
  GitDeliveryAbortableOperation,
  GitDeliveryExecutionResult,
  GitDeliveryRecoveryStrategyHint,
} from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "./types.js";

// ─── Concrete execution operands ──────────────────────────────────────────────────────────
// These carry the concrete operands (paths, message, refs) the content-free contract inputs
// deliberately omit. They live in the execution layer (keiko-tools), never in the contract leaf.

export interface GitBranchCreateExecRequest {
  readonly branchName: string;
  readonly startPointRefHash: string;
}

export interface GitStageExecRequest {
  readonly pathspecs: readonly string[];
}

export interface GitUnstageExecRequest {
  readonly pathspecs: readonly string[];
}

export interface GitCommitExecRequest {
  readonly message: string;
  readonly allowEmpty: boolean;
}

export interface GitAbortExecRequest {
  readonly operationToAbort: GitDeliveryAbortableOperation;
}

export interface GitRecoveryExecRequest {
  readonly recoveryStrategyHint: GitDeliveryRecoveryStrategyHint;
  readonly targetRefHash: string;
  // Used only by the restore-index strategy; ignored by the reset strategies.
  readonly pathspecs: readonly string[];
}

// ─── The narrow adapter port (no generic exec) ────────────────────────────────────────────
// Every method is typed to one mutation kind and returns a structured execution result. There is
// intentionally no `run(args: string[])` escape hatch: that absence is the AC3 guarantee that local
// Git writes cannot fall through to unrestricted command execution.

export interface GitLocalMutationAdapter {
  createBranch(req: GitBranchCreateExecRequest): Promise<GitDeliveryExecutionResult>;
  stage(req: GitStageExecRequest): Promise<GitDeliveryExecutionResult>;
  unstage(req: GitUnstageExecRequest): Promise<GitDeliveryExecutionResult>;
  commit(req: GitCommitExecRequest): Promise<GitDeliveryExecutionResult>;
  abort(req: GitAbortExecRequest): Promise<GitDeliveryExecutionResult>;
  recover(req: GitRecoveryExecRequest): Promise<GitDeliveryExecutionResult>;
}

// ─── Closed subcommand allowlist + dedicated command rules ────────────────────────────────
// The exact git subcommands the governed adapter may run. No read-only inspection subcommand and no
// network subcommand (push/fetch/pull/clone) appears here; remote and provider execution is a later
// slice (#476–#478) behind a separate gateway, never this local adapter.

export const GIT_MUTATION_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze([
  "branch",
  "add",
  "restore",
  "commit",
  "reset",
  "stash",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "bisect",
]);

// The dedicated allowlist handed to the keiko-tools spawn boundary by the Node adapter. Mirrors the
// terminal policy's defense-in-depth flag denials (global config/cwd-shifting/code-execution flags)
// so that even though the adapter only ever builds argv from typed operands, a smuggled global flag
// would still be rejected before spawn.
export const GIT_MUTATION_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: GIT_MUTATION_ALLOWED_SUBCOMMANDS,
    valueFlags: Object.freeze([
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
    ]),
    denyFlags: Object.freeze([
      "-C",
      "-c",
      "--config-env",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--contents",
      "--output",
    ]),
  },
]);

// ─── Operand validation ───────────────────────────────────────────────────────────────────

// Thrown when typed operands cannot be turned into a safe argv (empty, NUL-bearing, or a ref/branch
// that would be read as a flag). The Node adapter maps this to an `internal-error` execution result;
// it never reaches a spawn.
export class GitMutationArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitMutationArgvError";
  }
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

// A ref/branch operand passed as a bare positional. Rejects empty, NUL, and a leading "-" so it can
// never be reinterpreted as a git option.
function assertRef(value: string, label: string): string {
  if (value.length === 0) {
    throw new GitMutationArgvError(`${label} must not be empty`);
  }
  if (hasNul(value)) {
    throw new GitMutationArgvError(`${label} must not contain a NUL byte`);
  }
  if (value.startsWith("-")) {
    throw new GitMutationArgvError(`${label} must not start with "-" (flag-injection guard)`);
  }
  return value;
}

// A commit message passed as the value of `--message`. May start with "-" (git consumes it as the
// flag's value), but must be non-empty and NUL-free.
function assertMessage(value: string): string {
  if (value.length === 0) {
    throw new GitMutationArgvError("commit message must not be empty");
  }
  if (hasNul(value)) {
    throw new GitMutationArgvError("commit message must not contain a NUL byte");
  }
  return value;
}

// File pathspecs placed after the "--" sentinel. May start with "-" (the sentinel disarms option
// parsing), but must be non-empty and NUL-free, and the list must be non-empty.
function assertPathspecs(values: readonly string[]): readonly string[] {
  if (values.length === 0) {
    throw new GitMutationArgvError("at least one pathspec is required");
  }
  for (const value of values) {
    if (value.length === 0) {
      throw new GitMutationArgvError("pathspec must not be empty");
    }
    if (hasNul(value)) {
      throw new GitMutationArgvError("pathspec must not contain a NUL byte");
    }
  }
  return values;
}

// ─── Pure argv builders ───────────────────────────────────────────────────────────────────
// Each returns a "plan": a sequence of one or more argument vectors to run in order through the
// spawn boundary. Most kinds are a single command; stash-and-reset is two (stash first so the dirty
// worktree is preserved before the hard reset). The uniform sequence shape lets the Node adapter run
// any plan with one loop.

export type GitMutationArgvPlan = readonly (readonly string[])[];

export function buildBranchCreateArgv(req: GitBranchCreateExecRequest): GitMutationArgvPlan {
  return [
    [
      "branch",
      assertRef(req.branchName, "branchName"),
      assertRef(req.startPointRefHash, "startPointRefHash"),
    ],
  ];
}

export function buildStageArgv(req: GitStageExecRequest): GitMutationArgvPlan {
  return [["add", "--", ...assertPathspecs(req.pathspecs)]];
}

export function buildUnstageArgv(req: GitUnstageExecRequest): GitMutationArgvPlan {
  return [["restore", "--staged", "--", ...assertPathspecs(req.pathspecs)]];
}

export function buildCommitArgv(req: GitCommitExecRequest): GitMutationArgvPlan {
  const argv: string[] = ["commit"];
  if (req.allowEmpty) {
    argv.push("--allow-empty");
  }
  argv.push("--message", assertMessage(req.message));
  return [argv];
}

export function buildAbortArgv(req: GitAbortExecRequest): GitMutationArgvPlan {
  switch (req.operationToAbort) {
    case "merge":
      return [["merge", "--abort"]];
    case "rebase":
      return [["rebase", "--abort"]];
    case "cherry-pick":
      return [["cherry-pick", "--abort"]];
    case "revert":
      return [["revert", "--abort"]];
    case "bisect":
      // A bisect has no `--abort`; `git bisect reset` is its termination form.
      return [["bisect", "reset"]];
    default:
      return assertNeverAbort(req.operationToAbort);
  }
}

function assertNeverAbort(operation: never): never {
  throw new GitMutationArgvError(`unhandled abortable operation: ${JSON.stringify(operation)}`);
}

export function buildRecoveryArgv(req: GitRecoveryExecRequest): GitMutationArgvPlan {
  const target = assertRef(req.targetRefHash, "targetRefHash");
  switch (req.recoveryStrategyHint) {
    case "soft-reset":
      return [["reset", "--soft", target]];
    case "mixed-reset":
      return [["reset", "--mixed", target]];
    case "stash-and-reset":
      // Stash (including untracked) FIRST so no local work is lost, then hard-reset to the target.
      // The stash is the guided recovery point; the hard reset is safe because the work is preserved.
      return [
        ["stash", "push", "--include-untracked"],
        ["reset", "--hard", target],
      ];
    case "restore-index":
      return [["restore", "--source", target, "--staged", "--", ...assertPathspecs(req.pathspecs)]];
    default:
      return assertNeverRecovery(req.recoveryStrategyHint);
  }
}

function assertNeverRecovery(hint: never): never {
  throw new GitMutationArgvError(`unhandled recovery strategy: ${JSON.stringify(hint)}`);
}

// True iff every command in the plan begins with an allowed governed mutation subcommand. Used by
// tests (and available to callers) to prove the no-generic-fallback property structurally: there is
// no producible plan whose first token is outside GIT_MUTATION_ALLOWED_SUBCOMMANDS.
export function gitMutationPlanIsGoverned(plan: GitMutationArgvPlan): boolean {
  return plan.every(
    (argv) => argv.length > 0 && GIT_MUTATION_ALLOWED_SUBCOMMANDS.includes(argv[0] ?? ""),
  );
}
