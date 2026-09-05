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
export { canonicalGitHubPushUrl } from "./git-push-destination.js";
import type { GitDeliveryExecutionResult } from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import {
  buildAbortArgv,
  buildBranchCreateArgv,
  buildBranchSwitchArgv,
  buildCommitArgv,
  buildRecoveryArgv,
  buildStageArgv,
  buildUnstageArgv,
  GIT_MUTATION_COMMAND_RULES,
  type GitCommitExecRequest,
  type GitStageExecRequest,
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
  type CommandTerminationEvidence,
} from "./exec.js";
import {
  GOVERNED_GIT_IDENTITY_SANDBOX_POLICY,
  type CommandRule,
  type CommandResult,
  type SandboxPolicy,
} from "./types.js";
import {
  readGitFullRef,
  readGitIndexTreeDigest,
  readGitCommitIdentity,
  readGitRevision,
  readGitTreeDigest,
} from "./git-worktree-snapshot-node.js";
import { isSafeGitRefName } from "./git-worktree-adapter.js";
import { stageExactFiles, gitStageAttributesSupported } from "./git-stage-node.js";
import { gitCommitMessageDigest } from "./git-index-identity.js";

export interface NodeGitMutationAdapterDeps {
  /** Re-proves live server authority immediately before the sole ref-changing effect. */
  readonly beforeCommitRefUpdate?: (() => boolean) | undefined;
  readonly beforeIndexUpdate?: (() => boolean) | undefined;
  // The repository root the mutations run in. Reused as the spawn-boundary workspace root.
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the governed IDENTITY lane, not the fully isolated default: a governed commit must
  // resolve the local human's own git identity and signing configuration (~/.gitconfig,
  // ~/.gnupg, an SSH signing agent). Under the isolated default the child's HOME is empty, so
  // `user.name`/`user.email` and `commit.gpgsign`/`user.signingkey` are unreadable — the commit
  // then lands under an auto-detected author and UNSIGNED, and a repository that requires a
  // signature is told the commit succeeded. Network stays inherited; local mutations never egress.
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  // The termination-evidence port for every runCommand this lane performs (RunCommandDeps
  // deps-level seam, exec.ts): production composition boundaries wire it once so no call on the
  // lane is silently unobservable (PR #3354 review, comment 3887021650).
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
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
  readonly beforeCommitRefUpdate: (() => boolean) | undefined;
  readonly beforeIndexUpdate: (() => boolean) | undefined;
}

const GOVERNED_GIT_MUTATION_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.pager=cat",
  "-c",
  "pager.commit=false",
  "-c",
  "alias.commit=",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false",
];

const GLOBAL_SIGNING_POLICY_ARGS: readonly string[] = [
  "config",
  "--global",
  "--type=bool",
  "--get",
  "commit.gpgSign",
];
const GLOBAL_SIGNING_POLICY_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: Object.freeze(["config"]),
    valueFlags: Object.freeze([]),
    denyFlags: Object.freeze(["-c", "-C", "--config-env", "--file", "--blob", "--system"]),
  },
]);

function runOne(
  ctx: RunContext,
  argv: readonly string[],
  stdin?: string | Uint8Array,
): Promise<CommandResult> {
  return runCommand(
    {
      command: "git",
      args: [...GOVERNED_GIT_MUTATION_CONFIG_ARGS, ...argv],
      cwd: undefined,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      stdin,
    },
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

async function configuredSigningRequired(
  ctx: RunContext,
  scope: "--global" | "--local",
): Promise<boolean | undefined> {
  const runDeps = {
    ...ctx.runDeps,
    commandRules: GLOBAL_SIGNING_POLICY_COMMAND_RULES,
    onTerminated: ctx.runDeps.onTerminated,
  };
  const result = await runCommand(
    {
      command: "git",
      args:
        scope === "--global"
          ? GLOBAL_SIGNING_POLICY_ARGS
          : ["config", "--local", "--type=bool", "--get", "commit.gpgSign"],
      cwd: undefined,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    },
    runDeps,
  );
  if (result.exitCode === 1 && result.stdout.trim().length === 0) return false;
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

async function configuredStageNormalizationSupported(ctx: RunContext): Promise<boolean> {
  const runDeps = {
    ...ctx.runDeps,
    commandRules: GLOBAL_SIGNING_POLICY_COMMAND_RULES,
    onTerminated: ctx.runDeps.onTerminated,
  };
  const result = await runCommand(
    {
      command: "git",
      args: ["config", "--get-regexp", String.raw`^core\.(autocrlf|safecrlf)$`],
      cwd: undefined,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    },
    runDeps,
  );
  if (result.truncated) return false;
  if (result.exitCode === 1 && result.stdout.length === 0) return true;
  return (
    result.exitCode === 0 &&
    result.stdout
      .trim()
      .split("\n")
      .every((line) => /^core\.(?:autocrlf|safecrlf) false$/iu.test(line))
  );
}

async function execStage(
  ctx: RunContext,
  request: GitStageExecRequest,
): Promise<GitDeliveryExecutionResult> {
  if (request.verified === undefined) return execPlan(ctx, () => buildStageArgv(request));
  try {
    if (
      !(await configuredStageNormalizationSupported(ctx)) ||
      !(await verifiedFactsMatch(ctx, request))
    )
      return failureFromExit(0, 0);
    if (ctx.signal.aborted || ctx.beforeIndexUpdate?.() === false) return failureFromExit(0, 0);
    const succeeded = await stageExactFiles(
      {
        workspaceRoot: ctx.runDeps.workspace.root,
        check: () => verifiedFactsMatch(ctx, request),
        authorized: () => !ctx.signal.aborted && ctx.beforeIndexUpdate?.() !== false,
        run: (argv, stdin, indexPath) =>
          runOne(
            indexPath === undefined ? ctx : withIndexPath(ctx, indexPath),
            ["--no-lazy-fetch", "--no-replace-objects", ...argv],
            stdin,
          ),
      },
      request,
    );
    return succeeded ? executionResult("succeeded", 0) : failureFromExit(0, 0);
  } catch (error) {
    return failureFromThrow(error, 0, 0);
  }
}

function withIndexPath(ctx: RunContext, indexPath: string): RunContext {
  return {
    ...ctx,
    runDeps: {
      ...ctx.runDeps,
      policy: {
        ...ctx.runDeps.policy,
        pinnedEnv: { ...ctx.runDeps.policy.pinnedEnv, GIT_INDEX_FILE: indexPath },
      },
    },
  };
}

async function execCommit(
  ctx: RunContext,
  request: GitCommitExecRequest,
): Promise<GitDeliveryExecutionResult> {
  let signingRequired: boolean | undefined;
  try {
    signingRequired = await configuredSigningRequired(ctx, "--global");
    if (signingRequired === false && request.verified !== undefined)
      signingRequired = await configuredSigningRequired(ctx, "--local");
  } catch (error) {
    return failureFromThrow(error, 0, 0);
  }
  if (signingRequired !== false) {
    return executionResult("failed", 0, { errorCode: "precondition-failed" });
  }
  if (request.verified !== undefined) return execVerifiedCommit(ctx, request);
  const result = await execPlan(ctx, () => buildCommitArgv(request));
  if (result.outcome !== "succeeded") return result;
  try {
    return { ...result, externalId: await readGitRevision(commitReadDeps(ctx), "HEAD") };
  } catch (error) {
    return failureFromThrow(error, result.durationMs, 1);
  }
}

function commitReadDeps(
  ctx: RunContext,
): import("./git-worktree-snapshot-node.js").NodeGitWorktreeReaderDeps {
  return { ...ctx.runDeps, signal: ctx.signal, timeoutMs: ctx.timeoutMs };
}

function validVerifiedOperands(request: GitCommitExecRequest): boolean {
  const v = request.verified;
  if (v === undefined) return false;
  return [
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(v.headSha),
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(v.baseSha),
    /^[a-f0-9]{64}$/u.test(v.stagedTreeDigest),
    isSafeGitRefName(v.branchName),
    isSafeGitRefName(v.baseRef),
    request.message.length > 0,
    !request.message.includes("\0"),
  ].every(Boolean);
}

async function verifiedFactsMatch(
  ctx: RunContext,
  request: Pick<GitCommitExecRequest, "verified">,
): Promise<boolean> {
  const expected = request.verified;
  if (expected === undefined || ctx.signal.aborted || ctx.beforeCommitRefUpdate?.() === false)
    return false;
  const deps = commitReadDeps(ctx);
  const headSha = await readGitRevision(deps, "HEAD");
  const branch = await readGitFullRef(deps, "HEAD");
  const indexDigest = await readGitIndexTreeDigest(deps);
  const baseSha = await readGitRevision(deps, expected.baseRef);
  return (
    headSha === expected.headSha &&
    branch === `refs/heads/${expected.branchName}` &&
    indexDigest === expected.stagedTreeDigest &&
    baseSha === expected.baseSha
  );
}

async function checkedObjectCommand(ctx: RunContext, argv: readonly string[]): Promise<string> {
  const result = await runOne(ctx, ["--no-lazy-fetch", "--no-replace-objects", ...argv]);
  const objectId = result.stdout.trim();
  if (
    result.exitCode !== 0 ||
    result.truncated ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId)
  ) {
    throw new TypeError("verified-commit-object-unavailable");
  }
  return objectId;
}

async function execVerifiedCommit(
  ctx: RunContext,
  request: GitCommitExecRequest,
): Promise<GitDeliveryExecutionResult> {
  if (!validVerifiedOperands(request) || request.verified === undefined)
    return failureFromExit(0, 0);
  let refAttempted = false;
  try {
    if (!(await verifiedFactsMatch(ctx, request))) return failureFromExit(0, 0);
    const tree = await checkedObjectCommand(ctx, ["write-tree"]);
    const baseRef = await readGitFullRef(commitReadDeps(ctx), request.verified.baseRef);
    if ((await readGitTreeDigest(commitReadDeps(ctx), tree)) !== request.verified.stagedTreeDigest)
      return failureFromExit(0, 0);
    const head = await checkedObjectCommand(ctx, [
      "commit-tree",
      tree,
      "-p",
      request.verified.headSha,
      "-m",
      request.message,
    ]);
    if (!(await createdCommitMatches(ctx, request, head))) return failureFromExit(0, 0);
    if (!(await verifiedEffectReady(ctx, request))) return failureFromExit(0, 0);
    refAttempted = true;
    const result = await runOne(
      ctx,
      ["--no-lazy-fetch", "--no-replace-objects", "update-ref", "--stdin"],
      `start\nverify ${baseRef} ${request.verified.baseSha}\nupdate refs/heads/${request.verified.branchName} ${head} ${request.verified.headSha}\nprepare\ncommit\n`,
    );
    if (result.exitCode !== 0) return failureFromExit(result.durationMs, 0);
    return executionResult("succeeded", result.durationMs, { externalId: head });
  } catch (error) {
    return failureFromThrow(error, 0, refAttempted ? 1 : 0);
  }
}

async function verifiedEffectReady(
  ctx: RunContext,
  request: GitCommitExecRequest,
): Promise<boolean> {
  return (await verifiedFactsMatch(ctx, request)) && commitEffectAuthorized(ctx);
}

function commitEffectAuthorized(ctx: RunContext): boolean {
  return !ctx.signal.aborted && ctx.beforeCommitRefUpdate?.() !== false;
}

async function createdCommitMatches(
  ctx: RunContext,
  request: GitCommitExecRequest,
  head: string,
): Promise<boolean> {
  const expected = request.verified;
  if (expected === undefined) return false;
  const actual = await readGitCommitIdentity(commitReadDeps(ctx), head);
  return (
    actual.parentShas.length === 1 &&
    actual.parentShas[0] === expected.headSha &&
    actual.treeDigest === expected.stagedTreeDigest &&
    actual.messageDigest === gitCommitMessageDigest(request.message)
  );
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
      policy: deps.policy ?? GOVERNED_GIT_IDENTITY_SANDBOX_POLICY,
      commandRules: GIT_MUTATION_COMMAND_RULES,
      spawn: deps.spawn ?? nodeSpawnFn,
      processEnv: deps.processEnv ?? process.env,
      now: deps.now ?? Date.now,
      ...(deps.resolveExecutable !== undefined
        ? { resolveExecutable: deps.resolveExecutable }
        : {}),
      ...(deps.home !== undefined ? { home: deps.home } : {}),
      ...(deps.onTerminated !== undefined ? { onTerminated: deps.onTerminated } : {}),
    },
    signal: deps.signal ?? new AbortController().signal,
    timeoutMs: deps.timeoutMs,
    beforeCommitRefUpdate: deps.beforeCommitRefUpdate,
    beforeIndexUpdate: deps.beforeIndexUpdate,
  };
}

export async function readGitStageSupport(
  deps: NodeGitMutationAdapterDeps,
  paths: readonly string[],
): Promise<boolean> {
  const ctx = buildRunContext(deps);
  if (!(await configuredStageNormalizationSupported(ctx))) return false;
  return gitStageAttributesSupported(
    {
      workspaceRoot: deps.workspace.root,
      authorized: () => !ctx.signal.aborted,
      check: () => Promise.resolve(!ctx.signal.aborted),
      run: (argv, stdin) =>
        runOne(ctx, ["--no-lazy-fetch", "--no-replace-objects", ...argv], stdin),
    },
    paths,
  );
}

export function createNodeGitMutationAdapter(
  deps: NodeGitMutationAdapterDeps,
): GitLocalMutationAdapter {
  const ctx = buildRunContext(deps);
  return {
    createBranch: (req) => execPlan(ctx, () => buildBranchCreateArgv(req)),
    switchBranch: (req) => execPlan(ctx, () => buildBranchSwitchArgv(req)),
    stage: (req) => execStage(ctx, req),
    unstage: (req) => execPlan(ctx, () => buildUnstageArgv(req)),
    commit: (req) => execCommit(ctx, req),
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
  readGitRemoteUrl,
  readGitPushRemoteUrls,
  readGitRemoteAliases,
  readGitIndexTreeDigest,
  readGitIndexEntries,
  readGitTreeEntries,
  readGitUntrackedPaths,
  readGitBlobText,
  readGitCommitIdentity,
  readGitRevision,
  readGitTreeDigest,
  readGitWorktreeSnapshot,
  readGitStagedDiff,
  readStagedConflictMarkerFileCount,
  readStagedPaths,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";
export { readGitStageCandidate } from "./git-stage-node.js";
export { gitCommitMessageDigest } from "./git-index-identity.js";

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
  buildWorktreeStatusArgv,
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
  type WorktreeStatusResult,
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
export {
  createNodeGitMergeAdapter,
  createNodeGitCiReader,
  createNodeGitJourneyReader,
  type NodeGitCiReaderDeps,
  readNodeGitBranchProtection,
  type GitBranchProtectionReadResult,
  type NodeGitMergeAdapterDeps,
} from "./git-merge-node.js";

export { readGitRawWorktreeSnapshot, readGitRawChanges } from "./git-raw-worktree-node.js";

export { gitBlobObjectId } from "./git-index-identity.js";

export type { GitCiProviderReader, GitCiFactsResult, GitCiProviderFacts } from "./git-ci-facts.js";

export { assessGitCiFacts, gitCiCheckCounts, type GitCiAssessment } from "./git-ci-assessment.js";

export type {
  GitJourneyReader,
  GitJourneyFacts,
  GitJourneyFactsResult,
  GitJourneyReadTarget,
} from "./git-journey-facts.js";
