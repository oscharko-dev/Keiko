// Node implementation of the narrow local Git mutation adapter (Issue #472, Epic #470) — AC3.
//
// This is the ONLY place governed local Git writes actually execute. Each typed adapter method
// builds a fixed argv plan from the pure builders (git-mutation-adapter.ts) and runs it through the
// single keiko-tools no-shell spawn boundary (`runCommand`, exec.ts) with a dedicated mutation
// allowlist. There is no method that accepts an arbitrary command string, and no parallel
// child_process path: the deny-by-default allowlist, env isolation, redaction, and cancellation of
// the shared boundary apply to every governed mutation exactly as they do to every other tool.
//
// Lives on the `./internal/git-mutation` subpath (mirroring `./internal/exec` and `./internal/writer`)
// because it carries the Node execution effect; the pure port, builders, and rules it implements are
// re-exported from the package's main barrel.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryExecutionResult,
} from "@oscharko-dev/keiko-contracts";
import {
  buildAbortArgv,
  buildBranchCreateArgv,
  buildBranchSwitchArgv,
  buildCommitArgv,
  buildRecoveryArgv,
  buildStageArgv,
  buildUnstageArgv,
  GIT_MUTATION_COMMAND_RULES,
  type GitLocalMutationAdapter,
  type GitMutationArgvPlan,
} from "./git-mutation-adapter.js";
import { CommandCancelledError, CommandTimeoutError } from "./errors.js";
import {
  nodeSpawnFn,
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
} from "./exec.js";
import { DEFAULT_SANDBOX_POLICY, type CommandResult, type SandboxPolicy } from "./types.js";

export interface NodeGitMutationAdapterDeps {
  // The repository root the mutations run in. Reused as the spawn-boundary workspace root.
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the shared sandbox policy (network inherited — local git mutations never egress).
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  // Optional cancellation signal threaded into every governed git invocation.
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

function executionResult(
  outcome: GitDeliveryExecutionResult["outcome"],
  durationMs: number,
  extra?: Partial<GitDeliveryExecutionResult>,
): GitDeliveryExecutionResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: Math.max(0, Math.trunc(durationMs)),
    ...extra,
  };
}

// A non-zero git exit at execution time means a precondition that the preflight snapshot did not
// capture failed against the live repository (a time-of-check/time-of-use gap) — classified as
// `precondition-failed`, which the taxonomy routes to recovery-required. When part of a multi-step
// plan already partially applied, the result is `partial` with the attempted/succeeded counts.
function failureFromExit(durationMs: number, stepIndex: number): GitDeliveryExecutionResult {
  if (stepIndex > 0) {
    return executionResult("partial", durationMs, {
      errorCode: "precondition-failed",
      partialDetail: { attemptedUnitCount: stepIndex + 1, succeededUnitCount: stepIndex },
    });
  }
  return executionResult("failed", durationMs, { errorCode: "precondition-failed" });
}

function failureFromThrow(
  error: unknown,
  durationMs: number,
  stepIndex: number,
): GitDeliveryExecutionResult {
  const partial =
    stepIndex > 0
      ? { partialDetail: { attemptedUnitCount: stepIndex + 1, succeededUnitCount: stepIndex } }
      : {};
  if (error instanceof CommandTimeoutError) {
    return executionResult(stepIndex > 0 ? "partial" : "failed", durationMs, {
      errorCode: "timeout",
      ...partial,
    });
  }
  if (error instanceof CommandCancelledError) {
    return executionResult("aborted", durationMs, partial);
  }
  // A denied command (our own argv hit the allowlist), an argv-construction fault, or any other
  // throw is an internal kernel error — it never means the user's repository is at fault.
  return executionResult(stepIndex > 0 ? "partial" : "failed", durationMs, {
    errorCode: "internal-error",
    ...partial,
  });
}

// The per-adapter run context: the resolved spawn-boundary deps, the cancellation signal, and the
// per-command timeout. Threaded into the module-level runners so the factory stays small.
interface RunContext {
  readonly runDeps: RunCommandDeps;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
}

function runOne(ctx: RunContext, argv: readonly string[]): Promise<CommandResult> {
  return runCommand(
    { command: "git", args: argv, cwd: undefined, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    ctx.runDeps,
  );
}

async function runPlan(
  ctx: RunContext,
  plan: GitMutationArgvPlan,
): Promise<GitDeliveryExecutionResult> {
  let totalDuration = 0;
  for (const [stepIndex, argv] of plan.entries()) {
    let result: CommandResult;
    try {
      result = await runOne(ctx, argv);
    } catch (error) {
      return failureFromThrow(error, totalDuration, stepIndex);
    }
    totalDuration += result.durationMs;
    if (result.exitCode !== 0) {
      return failureFromExit(totalDuration, stepIndex);
    }
  }
  return executionResult("succeeded", totalDuration);
}

// Builds the argv plan, then runs it. A builder throw (invalid operand) is an internal error that
// never reaches a spawn.
async function execPlan(
  ctx: RunContext,
  build: () => GitMutationArgvPlan,
): Promise<GitDeliveryExecutionResult> {
  let plan: GitMutationArgvPlan;
  try {
    plan = build();
  } catch {
    return executionResult("failed", 0, { errorCode: "internal-error" });
  }
  return runPlan(ctx, plan);
}

function buildRunContext(deps: NodeGitMutationAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_MUTATION_COMMAND_RULES,
      spawn: deps.spawn ?? nodeSpawnFn,
      processEnv: deps.processEnv ?? process.env,
      now: deps.now ?? Date.now,
      ...(deps.resolveExecutable !== undefined
        ? { resolveExecutable: deps.resolveExecutable }
        : {}),
      ...(deps.home !== undefined ? { home: deps.home } : {}),
    },
    signal: deps.signal ?? new AbortController().signal,
    timeoutMs: deps.timeoutMs,
  };
}

export function createNodeGitMutationAdapter(
  deps: NodeGitMutationAdapterDeps,
): GitLocalMutationAdapter {
  const ctx = buildRunContext(deps);
  return {
    createBranch: (req) => execPlan(ctx, () => buildBranchCreateArgv(req)),
    switchBranch: (req) => execPlan(ctx, () => buildBranchSwitchArgv(req)),
    stage: (req) => execPlan(ctx, () => buildStageArgv(req)),
    unstage: (req) => execPlan(ctx, () => buildUnstageArgv(req)),
    commit: (req) => execPlan(ctx, () => buildCommitArgv(req)),
    abort: (req) => execPlan(ctx, () => buildAbortArgv(req)),
    recover: (req) => execPlan(ctx, () => buildRecoveryArgv(req)),
  };
}

// The read-only worktree snapshot reader (Issue #475) carries the same Node spawn effect as this
// adapter, so it is exposed on the SAME `./internal/git-mutation` subpath rather than the pure barrel.
// Its inspection allowlist is structurally separate from the mutation rules.
export {
  GIT_WORKTREE_READ_COMMAND_RULES,
  GitWorktreeReadError,
  readGitWorktreeSnapshot,
  readStagedPaths,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";

// The narrow managed-worktree lifecycle adapter (Issue #445, Epic #443) carries the same Node spawn
// effect through the same governed `runCommand` boundary with its OWN dedicated allowlist
// (`GIT_WORKTREE_COMMAND_RULES`: worktree/rev-parse/show-ref only — structurally separate from the
// mutation, read-inspection, publish, PR, and merge rule sets). It is exposed on the SAME
// `./internal/git-mutation` subpath. The pure argv builders, operand validators, and porcelain parser
// are re-exported alongside the node factory so the server can pre-validate operands without spawning.
export {
  buildAddExistingBranchArgv,
  buildAddWorktreeArgv,
  buildListWorktreesArgv,
  buildLocalBranchExistsArgv,
  buildPruneWorktreesArgv,
  buildRefResolvesArgv,
  buildRemoveWorktreeArgv,
  buildShowToplevelArgv,
  createNodeGitWorktreeAdapter,
  GIT_WORKTREE_COMMAND_RULES,
  GitWorktreeOperandError,
  GitWorktreeSpawnError,
  isSafeGitRefName,
  isSafeWorktreePathOperand,
  parseWorktreeListPorcelain,
  type AddExistingBranchOperands,
  type AddWorktreeOperands,
  type GitWorktreeAdapter,
  type NodeGitWorktreeAdapterDeps,
  type RemoveWorktreeOperands,
  type WorktreeListEntry,
  type WorktreeOperationResult,
} from "./git-worktree-adapter.js";

// The Node remote publish executor (Issue #476) carries the same Node spawn effect and a DEDICATED
// push allowlist; it is exposed on the SAME `./internal/git-mutation` subpath. Its allowlist is
// structurally separate from both the mutation and the read-only inspection rules.
export { createNodeGitPublishAdapter, type NodeGitPublishAdapterDeps } from "./git-publish-node.js";

// The Node GitHub pull request executor (Issue #477) shells `gh api` through the same spawn boundary
// with its OWN dedicated PR allowlist (create / update / draft-toggle GraphQL — no merge, no delete);
// it is exposed on the SAME `./internal/git-mutation` subpath. The GitHub token is read by gh itself,
// never by Keiko.
export {
  createNodeGitPullRequestAdapter,
  type NodeGitPullRequestAdapterDeps,
} from "./git-pr-node.js";

// The Node governed merge executor (Issue #478) shells `gh api` through the same spawn boundary with its
// OWN dedicated merge allowlist (the merge PUT, the readiness GETs, and the guarded branch DELETE — no
// generic exec); it is exposed on the SAME `./internal/git-mutation` subpath. The GitHub token is read by
// gh itself, never by Keiko.
export { createNodeGitMergeAdapter, type NodeGitMergeAdapterDeps } from "./git-merge-node.js";
