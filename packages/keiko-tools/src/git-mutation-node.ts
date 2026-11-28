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

import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
export { canonicalGitHubPushUrl } from "./git-push-destination.js";
import type {
  GitCommitSigningDecision,
  GitCommitSigningReadFailure,
  GitDeliveryExecutionErrorCode,
  GitDeliveryExecutionResult,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type { CodingRuntimeGitStageCause } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import {
  buildAbortArgv,
  buildBranchCreateArgv,
  buildBranchSwitchArgv,
  buildCommitArgv,
  buildRecoveryArgv,
  buildStageArgv,
  buildUnbornBranchArgv,
  buildUnstageArgv,
  GIT_MUTATION_COMMAND_RULES,
  type GitBranchCreateExecRequest,
  type GitCommitExecRequest,
  type GitStageExecRequest,
  type GitUnstageExecRequest,
  type GitLocalMutationAdapter,
  type GitMutationArgvPlan,
} from "./git-mutation-adapter.js";
import { CommandCancelledError, CommandDeniedError, CommandTimeoutError } from "./errors.js";
import {
  type CommandTerminationEvidence,
  type ExecutableResolver,
  type HomeProvider,
  nodeSpawnFn,
  runCommand,
  type RunCommandDeps,
  type SpawnFn,
  workspaceFsOf,
} from "./exec.js";
import {
  GOVERNED_GIT_IDENTITY_SANDBOX_POLICY,
  type CommandRule,
  type CommandResult,
  type SandboxPolicy,
} from "./types.js";
import {
  ensureGitLazyFetchGuardSupported,
  readGitFullRef,
  readGitIndexLineBreaks,
  readGitIndexTreeDigest,
  readGitCommitIdentity,
  readGitRevision,
  readGitTreeDigest,
  readGitHeadState,
  readGitCheckoutBranch,
  readGitBaseState,
  readGitWorktreeSnapshot,
  createGitReadSession,
  GitWorktreeReadError as GitWorktreeReadFailure,
  type NodeGitWorktreeReaderDeps,
  type GitReadSession,
  type GitStagedObjectIdPort,
} from "./git-worktree-snapshot-node.js";
import {
  gitHeadStateObjectId,
  gitZeroObjectId,
  sameGitHeadState,
  type GitHeadState,
} from "./git-head-state.js";
import { isSafeGitRefName } from "./git-worktree-adapter.js";
import {
  stageExactFiles,
  gitStageAttributeRefusal,
  gitStageFilesSupported,
  filterDriversOverridable,
  unstageExactFiles,
  gitStagedObjectIdOf,
  gitStagedObjectPortArgvAllowed,
  type GitStageEffectContext,
  type GitStageLineEndings,
} from "./git-stage-node.js";
import type { GitObjectQuarantine } from "@oscharko-dev/keiko-workspace/internal/git-index";
import { gitCommitMessageDigest } from "./git-index-identity.js";
import {
  GIT_REF_LOCK_HELD,
  GIT_REF_LOCK_UNAVAILABLE,
  withGitBranchRefLocks,
} from "@oscharko-dev/keiko-workspace/internal/git-index";

/** A failed `commit.gpgsign` read, reported once with its closed class and the cause. */
export interface GitCommitSigningReadFailureReport {
  readonly readFailure: GitCommitSigningReadFailure;
  readonly error: unknown;
}

export interface NodeGitMutationAdapterDeps {
  /**
   * The trusted branch-protection verdict for the branch a commit lands on: true only when the
   * trusted reader says the branch requires signatures. Supplied by the server, never by model
   * input; unknown, unavailable or no remote is `false`. A rejection propagates, so the commit is
   * not made on a state that could not be proved (ADR-0006).
   */
  readonly signingRequiredByBranchProtection?: (() => Promise<boolean | "unavailable">) | undefined;
  /** Injected log port for a failed `commit.gpgsign` read (frames and cause chain stay with the owner). */
  readonly onSigningReadFailure?: ((report: GitCommitSigningReadFailureReport) => void) | undefined;
  /** Re-proves live server authority immediately before the sole ref-changing effect. */
  readonly beforeCommitRefUpdate?: (() => boolean) | undefined;
  readonly beforeIndexUpdate?: (() => boolean) | undefined;
  /**
   * The checkout an unverified (interactive) commit was prepared on: its signing decision is made
   * for this branch (`undefined` for a detached HEAD). The commit is refused when the checkout is
   * on another branch by the time the decision is made, so a switch during the signing read can
   * never land an unsigned commit on a branch that requires signatures.
   */
  readonly preparedCheckout?: { readonly branchName: string | undefined } | undefined;
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
  // The operation scope the governed reads of this adapter count their processes in.
  readonly readSession?: GitReadSession | undefined;
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
// `precondition-failed`, which the taxonomy routes to recovery-required. Signing failures use their
// own code so the caller never presents them as a generic repository-state issue. When part of a
// multi-step plan already partially applied, the result is `partial` with the attempted/succeeded
// counts.
function failureFromExit(
  durationMs: number,
  stepIndex: number,
  errorCode: GitDeliveryExecutionErrorCode = "precondition-failed",
): GitDeliveryExecutionResult {
  if (stepIndex > 0) {
    return executionResult("partial", durationMs, {
      errorCode,
      partialDetail: { attemptedUnitCount: stepIndex + 1, succeededUnitCount: stepIndex },
    });
  }
  return executionResult("failed", durationMs, { errorCode });
}

const SIGNING_FAILURE_PATTERN =
  /(?:gpg failed to sign|failed to sign|couldn.t sign|couldn.t load public key|no signing key|user\.signingkey|ssh-keygen)/iu;

function failureFromGitExit(
  result: CommandResult,
  durationMs: number,
  stepIndex: number,
  argv: readonly string[],
): GitDeliveryExecutionResult {
  const errorCode = gitSigningFailure(argv, result) ? "signature-failed" : "precondition-failed";
  return failureFromExit(durationMs, stepIndex, errorCode);
}

function gitSigningFailure(argv: readonly string[], result: CommandResult): boolean {
  if (!argv.some((arg) => arg === "--gpg-sign" || arg === "-S")) return false;
  if (result.truncated) return false;
  return SIGNING_FAILURE_PATTERN.test(`${result.stderr}\n${result.stdout}`);
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
  readonly preparedCheckout: { readonly branchName: string | undefined } | undefined;
  readonly readSession: GitReadSession | undefined;
  readonly signingRequiredByBranchProtection: (() => Promise<boolean | "unavailable">) | undefined;
  readonly onSigningReadFailure: ((report: GitCommitSigningReadFailureReport) => void) | undefined;
}

const GOVERNED_GIT_MUTATION_CONFIG_ARGS: readonly string[] = [
  // #4068 (W7): without core.longpaths Git for Windows cannot stage a path of MAX_PATH or more.
  ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
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
  "gpg.program=gpg",
  "-c",
  "gpg.ssh.program=ssh-keygen",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false",
];

const GIT_CONFIG_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "git",
    allowedSubcommands: Object.freeze(["config"]),
    valueFlags: Object.freeze([]),
    denyFlags: Object.freeze(["-c", "-C", "--config-env", "--file", "--blob", "--system"]),
  },
]);

/**
 * The deadline of a run that reads a large file by path: the size-proportional one, but never below
 * the lane's own deadline, which is the lane's `timeoutMs` or else the run policy's default.
 */
export function scaledRunTimeoutMs(
  scaledMs: number,
  laneMs: number | undefined,
  policyDefaultMs: number,
): number {
  return Math.max(scaledMs, laneMs ?? policyDefaultMs);
}
// Every mutating spawn goes through here, so the version-gated lazy-fetch/replace-objects guard
// (git-worktree-snapshot-node.ts, reviewer 3941836280) protects the write lane exactly the way it
// protects the read lane — cached after the first call, so this costs nothing beyond it. This
// REPLACES the CLI-flag prepends this lane used to build at each call site: `buildRunContext`
// below pins GIT_NO_LAZY_FETCH / GIT_NO_REPLACE_OBJECTS into every mutation's env, the equivalent
// per git's own docs, and `ensureGitLazyFetchGuardSupported` refuses the write outright (never
// silently unprotected) for an at-risk repository whose installed git cannot enforce them.
async function runOne(
  ctx: RunContext,
  argv: readonly string[],
  stdin?: string | Uint8Array,
  // A run that reads a large file by path gets time in proportion to the file; never less than the
  // lane's own deadline.
  scaledTimeoutMs?: number,
): Promise<CommandResult> {
  await ensureGitLazyFetchGuardSupported(commitReadDeps(ctx));
  if (ctx.readSession !== undefined) ctx.readSession.spawnCount += 1;
  return runCommand(
    {
      command: "git",
      args: [...GOVERNED_GIT_MUTATION_CONFIG_ARGS, ...argv],
      cwd: undefined,
      timeoutMs:
        scaledTimeoutMs === undefined
          ? ctx.timeoutMs
          : scaledRunTimeoutMs(scaledTimeoutMs, ctx.timeoutMs, ctx.runDeps.policy.defaultTimeoutMs),
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
      return failureFromGitExit(result, totalDuration, stepIndex, argv);
    }
  }
  return executionResult("succeeded", totalDuration);
}

const STAGE_CONFIG_KEYS = String.raw`^(core\.(autocrlf|safecrlf)|filter\..+\.(clean|smudge|process|required))$`;

// One read of the configuration a verified staging depends on: the line-ending mode and every
// configured filter driver name. `undefined` fails closed (an unreadable, cut-short or unparsable
// answer proves nothing).
async function readStageConfig(ctx: RunContext): Promise<StageConfig | undefined> {
  const runDeps = {
    ...ctx.runDeps,
    commandRules: GIT_CONFIG_COMMAND_RULES,
    onTerminated: ctx.runDeps.onTerminated,
  };
  if (ctx.readSession !== undefined) ctx.readSession.spawnCount += 1;
  const result = await runCommand(
    {
      command: "git",
      args: ["config", "-z", "--get-regexp", STAGE_CONFIG_KEYS],
      cwd: undefined,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    },
    runDeps,
  );
  if (result.truncated) return undefined;
  if (result.exitCode === 1 && result.stdout.length === 0)
    return { lineEndings: "exact", filterDrivers: [] };
  return result.exitCode === 0 ? effectiveStageConfig(result.stdout) : undefined;
}

interface StageConfig {
  readonly lineEndings: GitStageLineEndings;
  readonly filterDrivers: readonly string[];
}

async function configuredStageLineEndings(
  ctx: RunContext,
): Promise<GitStageLineEndings | undefined> {
  return (await readStageConfig(ctx))?.lineEndings;
}

// `--get-regexp` lists every scope that sets a key, in Git's own precedence order (system, global,
// local, worktree, command line), and Git resolves a single-valued key to its LAST value. Only the
// effective value counts: judging every scope refused every repository on a stock Git for Windows
// host, whose SYSTEM scope sets `core.autocrlf=true`, even after the repository opts out locally.
// `core.safecrlf` must still resolve to `false`. `core.autocrlf` `false` stages the verified bytes
// as they are; `true` (also a bare key) and `input` admit a file only when Git's built-in conversion
// of it round-trips exactly (`stageExactFiles`). Any other value or unparsable record fails
// closed. `-z` ends each record with NUL and separates its key from its value with the first
// newline, so a value holding a newline (a filter command, say) can never pose as another key
// (PR #4568 review); a record without a newline is a bare key.
const FILTER_DRIVER_KEY = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu;
const CRLF_KEY = /^core\.(?:autocrlf|safecrlf)$/iu;

function effectiveStageConfig(stdout: string): StageConfig | undefined {
  const effective = new Map<string, string>();
  const drivers = new Set<string>();
  if (!stdout.endsWith("\0")) return undefined;
  for (const record of stdout.slice(0, -1).split("\0")) {
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const driver = FILTER_DRIVER_KEY.exec(key)?.[1];
    if (driver !== undefined) {
      drivers.add(driver);
      continue;
    }
    if (!CRLF_KEY.test(key)) return undefined;
    effective.set(
      key.toLowerCase(),
      newline === -1 ? "true" : record.slice(newline + 1).toLowerCase(),
    );
  }
  return stageConfigOf(effective, drivers);
}

function stageConfigOf(
  effective: ReadonlyMap<string, string>,
  drivers: ReadonlySet<string>,
): StageConfig | undefined {
  if ((effective.get("core.safecrlf") ?? "false") !== "false") return undefined;
  const lineEndings = AUTOCRLF_LINE_ENDINGS.get(effective.get("core.autocrlf") ?? "false");
  return lineEndings === undefined ? undefined : { lineEndings, filterDrivers: [...drivers] };
}

const AUTOCRLF_LINE_ENDINGS: ReadonlyMap<string, GitStageLineEndings> = new Map([
  ["false", "exact"],
  ["true", "autocrlf-true"],
  ["input", "autocrlf-input"],
]);

async function execStage(
  ctx: RunContext,
  request: GitStageExecRequest,
): Promise<GitDeliveryExecutionResult> {
  if (request.verified === undefined) return execPlan(ctx, () => buildStageArgv(request));
  try {
    const lineEndings = await configuredStageLineEndings(ctx);
    if (lineEndings === undefined || !(await verifiedFactsMatch(ctx, request)))
      return failureFromExit(0, 0);
    if (ctx.signal.aborted || ctx.beforeIndexUpdate?.() === false) return failureFromExit(0, 0);
    const succeeded = await stageExactFiles(
      verifiedIndexEffect(ctx, request, lineEndings),
      request,
      lineEndings,
    );
    return succeeded ? executionResult("succeeded", 0) : failureFromExit(0, 0);
  } catch (error) {
    return failureFromThrow(error, 0, 0);
  }
}

// #3902 AC2 (PR #4064 review): an unstaging reviewed against a head, base and staged tree changes the
// index only while all three still hold, checked inside the same index transaction as staging and
// again, together with the run's authority, just before the reviewed index replaces the live one.
// A thrown failure (a Git read, the index lock, an authority lapse at the swap) propagates to the
// orchestrator's adapter boundary, which reports the step as failed; the index stays as it was.
async function execUnstage(
  ctx: RunContext,
  request: GitUnstageExecRequest,
): Promise<GitDeliveryExecutionResult> {
  if (request.verified === undefined) return execPlan(ctx, () => buildUnstageArgv(request));
  if (!(await verifiedFactsMatch(ctx, request))) return failureFromExit(0, 0);
  if (ctx.signal.aborted || ctx.beforeIndexUpdate?.() === false) return failureFromExit(0, 0);
  const succeeded = await unstageExactFiles(
    verifiedIndexEffect(ctx, request),
    buildUnstageArgv(request),
  );
  return succeeded ? executionResult("succeeded", 0) : failureFromExit(0, 0);
}

// The index effect of a verified staging or unstaging: the reviewed facts, the run's authority, and
// Git runs that may target the transaction's private index copy.
function verifiedIndexEffect(
  ctx: RunContext,
  request: Pick<GitCommitExecRequest, "verified">,
  stagedLineEndings?: GitStageLineEndings,
): GitStageEffectContext {
  let filterDrivers: Promise<readonly string[] | undefined> | undefined;
  return {
    workspaceRoot: ctx.runDeps.workspace.root,
    fs: workspaceFsOf(ctx.runDeps),
    // A staging also re-reads the effective line-ending mode its objects were hashed under: a
    // change after the selection stops the stage before the index is promoted.
    check: async () =>
      (await verifiedFactsMatch(ctx, request)) &&
      (stagedLineEndings === undefined ||
        (await configuredStageLineEndings(ctx)) === stagedLineEndings),
    // Read once per staging, not once per hashed file (PR #4568 audit: Windows spawn cost).
    filterDriverNames: () => (filterDrivers ??= readStageConfig(ctx).then((c) => c?.filterDrivers)),
    authorized: () => !ctx.signal.aborted && ctx.beforeIndexUpdate?.() !== false,
    signal: ctx.signal,
    run: (argv, stdin, indexPath, timeoutMs, quarantine) =>
      runOne(
        withObjectQuarantine(
          indexPath === undefined ? ctx : withIndexPath(ctx, indexPath),
          quarantine,
        ),
        argv,
        stdin,
        timeoutMs,
      ),
    indexLineBreaks: (paths) => readGitIndexLineBreaks(commitReadDeps(ctx), paths),
  };
}

// Objects the run writes go to the quarantine; the live store stays readable as an alternate so an
// object that already exists is recognised and not written again.
function withObjectQuarantine(
  ctx: RunContext,
  quarantine: GitObjectQuarantine | undefined,
): RunContext {
  if (quarantine === undefined) return ctx;
  return {
    ...ctx,
    runDeps: {
      ...ctx.runDeps,
      policy: {
        ...ctx.runDeps.policy,
        pinnedEnv: {
          ...ctx.runDeps.policy.pinnedEnv,
          GIT_OBJECT_DIRECTORY: quarantine.directory,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: quarantine.liveDirectory,
        },
      },
    },
  };
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
  // Contradictory verified operands are refused before any Git process starts, the signing read
  // included; such a refusal carries no `signing` field because no signing decision was made.
  if (request.verified !== undefined && !validVerifiedOperands(request))
    return failureFromExit(0, 0);
  const read = await readCommitSigning(ctx);
  const signing = {
    signing: read.decision,
    ...(read.failure === undefined ? {} : { signingReadFailure: read.failure.readFailure }),
  };
  const sign = !UNSIGNED_SIGNING_DECISIONS.has(read.decision);
  if (request.verified !== undefined) {
    return { ...(await execVerifiedCommit(ctx, request, sign)), ...signing };
  }
  // The decision above was made for the prepared branch: a checkout that moved on while it was made
  // is refused before any commit exists. This narrows the window rather than closing it: a switch
  // between this read and the commit's own start cannot be seen (an unverified commit has no
  // explicit ref update to bind). A failed read is a failed commit, never a pass.
  const prepared = await checkoutStillPrepared(ctx).catch((error: unknown) => error);
  if (prepared !== true)
    return {
      ...(prepared === false ? failureFromExit(0, 0) : failureFromThrow(prepared, 0, 0)),
      ...signing,
    };
  const result = await execPlan(ctx, () => buildCommitArgv(request, sign));
  if (result.outcome !== "succeeded") return { ...result, ...signing };
  try {
    return {
      ...result,
      ...signing,
      externalId: await readGitRevision(commitReadDeps(ctx), "HEAD"),
    };
  } catch (error) {
    return { ...failureFromThrow(error, result.durationMs, 1), ...signing };
  }
}

// The decisions that commit exactly as Git would, with neither `--gpg-sign` nor `--no-gpg-sign`.
const UNSIGNED_SIGNING_DECISIONS: ReadonlySet<GitCommitSigningDecision> = new Set([
  "not-configured",
  "not-configured-protection-unavailable",
]);

async function checkoutStillPrepared(ctx: RunContext): Promise<boolean> {
  if (ctx.preparedCheckout === undefined) return true;
  return (await readGitCheckoutBranch(commitReadDeps(ctx))) === ctx.preparedCheckout.branchName;
}

interface CommitSigningRead {
  readonly decision: GitCommitSigningDecision;
  readonly failure?: GitCommitSigningReadFailureReport;
}

class GitSigningReadError extends Error {
  public readonly readFailure: GitCommitSigningReadFailure;

  public constructor(readFailure: GitCommitSigningReadFailure) {
    super(`git-signing-read-${readFailure}`);
    this.name = "GitSigningReadError";
    this.readFailure = readFailure;
  }
}

function failedSigningRead(
  readFailure: GitCommitSigningReadFailure,
  error: unknown = new GitSigningReadError(readFailure),
): CommitSigningRead {
  return { decision: "unknown-fail-closed", failure: { readFailure, error } };
}

// The signing decision (ADR-0006). Git's effective `commit.gpgsign` read as a Git boolean through
// the identity lane the commit itself runs in (system, global, repository and included scopes):
// true signs; unset or false means the person has not asked for signing, so the commit is made
// exactly as Git would make it, unless the trusted branch-protection verdict for the target branch
// requires signatures, which signs it too. A failed, cut-short or malformed read fails closed toward
// the strict behaviour: the commit attempts to sign, so any failure stays a visible
// `signature-failed`, and the cause is reported through the injected port.
async function readCommitSigning(ctx: RunContext): Promise<CommitSigningRead> {
  const configured = await readConfiguredCommitSigning(ctx);
  if (configured.failure !== undefined) ctx.onSigningReadFailure?.(configured.failure);
  if (configured.decision !== "not-configured") return configured;
  const protection = await ctx.signingRequiredByBranchProtection?.();
  if (protection === true) return { decision: "required-by-branch-protection" };
  return protection === "unavailable"
    ? { decision: "not-configured-protection-unavailable" }
    : configured;
}

function readConfiguredCommitSigning(ctx: RunContext): Promise<CommitSigningRead> {
  const runDeps = { ...ctx.runDeps, commandRules: GIT_CONFIG_COMMAND_RULES };
  if (ctx.readSession !== undefined) ctx.readSession.spawnCount += 1;
  // A read that throws (spawn failure, denial, timeout, cancellation) is not swallowed: its closed
  // class and the error itself travel with the decision to the injected port, and the commit that
  // follows attempts to sign (a cancellation is reported by that commit as an abort).
  return runCommand(
    {
      command: "git",
      args: ["config", "--type=bool", "--get", "commit.gpgsign"],
      cwd: undefined,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    },
    runDeps,
  ).then(commitSigningOfConfigRead, signingReadRejected);
}

function signingReadRejected(error: unknown): CommitSigningRead {
  if (error instanceof CommandTimeoutError) return failedSigningRead("timeout", error);
  if (error instanceof CommandCancelledError) return failedSigningRead("cancelled", error);
  if (error instanceof CommandDeniedError) return failedSigningRead("denied", error);
  return failedSigningRead("spawn", error);
}

const MALFORMED_CONFIG_PATTERN = /bad (?:boolean )?config (?:value|line)|bad numeric config/iu;

function commitSigningOfConfigRead(result: CommandResult): CommitSigningRead {
  if (result.truncated) return failedSigningRead("truncated");
  if (result.exitCode === 1) return { decision: "not-configured" };
  if (result.exitCode !== 0) {
    return failedSigningRead(MALFORMED_CONFIG_PATTERN.test(result.stderr) ? "malformed" : "exit");
  }
  const value = result.stdout.trim();
  if (value === "true") return { decision: "configured" };
  return value === "false" ? { decision: "not-configured" } : failedSigningRead("malformed");
}

function commitReadDeps(
  ctx: RunContext,
): import("./git-worktree-snapshot-node.js").NodeGitWorktreeReaderDeps {
  return {
    ...ctx.runDeps,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    readSession: ctx.readSession,
  };
}

type VerifiedCommitExecRequest = GitCommitExecRequest & {
  readonly verified: NonNullable<GitCommitExecRequest["verified"]>;
};

function validRevisionState(state: GitHeadState): boolean {
  if (state.kind === "born") return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(state.sha);
  return isSafeGitRefName(state.branch);
}

function validVerifiedOperands(
  request: GitCommitExecRequest,
): request is VerifiedCommitExecRequest {
  const v = request.verified;
  if (v === undefined) return false;
  return [
    validRevisionState(v.head),
    validRevisionState(v.base),
    // An unborn head is the branch being committed to. An unborn base is the base the run names:
    // the same branch, or the protected branch a task branch was cut from, which stays unborn
    // while the task branch gains commits (#4491).
    v.head.kind === "born" || v.head.branch === v.branchName,
    v.base.kind === "born" || v.base.branch === v.baseRef,
    /^[a-f0-9]{64}$/u.test(v.stagedTreeDigest),
    isSafeGitRefName(v.branchName),
    isSafeGitRefName(v.baseRef),
    request.message.length > 0,
    !request.message.includes("\0"),
  ].every(Boolean);
}

class GitObjectCommandFailure extends Error {
  public readonly result: CommandResult;
  public readonly argv: readonly string[];

  public constructor(result: CommandResult, argv: readonly string[]) {
    super("git-object-command-failed");
    this.name = "GitObjectCommandFailure";
    this.result = result;
    this.argv = argv;
  }
}

async function verifiedFactsMatch(
  ctx: RunContext,
  request: Pick<GitCommitExecRequest, "verified">,
): Promise<boolean> {
  const expected = request.verified;
  if (expected === undefined || ctx.signal.aborted || ctx.beforeCommitRefUpdate?.() === false)
    return false;
  const deps = commitReadDeps(ctx);
  // A head that was unborn and is born now (or the reverse) is drift like any moved head: the
  // comparison is on the whole state, branch included.
  const head = await readGitHeadState(deps);
  const branch = head.kind === "unborn" ? head.branch : await headBranchName(deps);
  const indexDigest = await readGitIndexTreeDigest(deps);
  // The review-time fact is the record: a base that was never born then may still be absent now.
  const base = await readGitBaseState(
    deps,
    expected.baseRef,
    head,
    expected.base.kind === "unborn",
  );
  return (
    sameGitHeadState(head, expected.head) &&
    branch === expected.branchName &&
    indexDigest === expected.stagedTreeDigest &&
    sameGitHeadState(base, expected.base)
  );
}

async function headBranchName(deps: NodeGitWorktreeReaderDeps): Promise<string> {
  return (await readGitFullRef(deps, "HEAD")).replace(/^refs\/heads\//u, "");
}

async function checkedObjectCommand(ctx: RunContext, argv: readonly string[]): Promise<string> {
  const result = await runOne(ctx, argv);
  const objectId = result.stdout.trim();
  if (
    result.exitCode !== 0 ||
    result.truncated ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId)
  ) {
    throw new GitObjectCommandFailure(result, argv);
  }
  return objectId;
}

interface PreparedVerifiedCommit {
  readonly baseRef: string;
  readonly head: string;
}

async function prepareVerifiedCommit(
  ctx: RunContext,
  request: VerifiedCommitExecRequest,
  sign: boolean,
): Promise<PreparedVerifiedCommit | undefined> {
  if (!(await verifiedFactsMatch(ctx, request))) return undefined;
  const tree = await checkedObjectCommand(ctx, ["write-tree"]);
  const deps = commitReadDeps(ctx);
  // An unborn base has no ref to resolve yet; its full name is the branch's own.
  const baseRef =
    request.verified.base.kind === "unborn"
      ? `refs/heads/${request.verified.base.branch}`
      : await readGitFullRef(deps, request.verified.baseRef);
  if ((await readGitTreeDigest(deps, tree)) !== request.verified.stagedTreeDigest) return undefined;
  // The first commit of an unborn branch is a root commit: no parent.
  const parent = request.verified.head.kind === "born" ? ["-p", request.verified.head.sha] : [];
  const head = await checkedObjectCommand(ctx, [
    "commit-tree",
    tree,
    ...(sign ? ["-S"] : []),
    ...parent,
    "-m",
    request.message,
  ]);
  if (!(await createdCommitMatches(ctx, request, head))) return undefined;
  if (!(await verifiedEffectReady(ctx, request))) return undefined;
  return { baseRef, head };
}

// Git refuses a transaction that names one ref twice ("multiple updates for ref"). A branch that is
// its own base (a human's local checkout of the task branch, #3907) is therefore guarded by the
// update's own old value alone, which is only sound while the verified base and head agree.
function verifiedCommitRefTransaction(
  verified: VerifiedCommitExecRequest["verified"],
  prepared: PreparedVerifiedCommit,
): string | undefined {
  const branchRef = `refs/heads/${verified.branchName}`;
  // An unborn branch is created with the all-zero old value, so a branch that appeared since the
  // review fails the compare-and-swap instead of being overwritten.
  const update =
    verified.head.kind === "born"
      ? `update ${branchRef} ${prepared.head} ${verified.head.sha}\n`
      : `update ${branchRef} ${prepared.head} ${gitZeroObjectId(verified.head.objectIdLength)}\n`;
  if (prepared.baseRef !== branchRef) {
    // An unborn base (the protected branch a task branch was cut from, #4491) must still not exist.
    return `start\nverify ${prepared.baseRef} ${gitHeadStateObjectId(verified.base)}\n${update}prepare\ncommit\n`;
  }
  return sameGitHeadState(verified.base, verified.head)
    ? `start\n${update}prepare\ncommit\n`
    : undefined;
}

async function updateVerifiedCommitRef(
  ctx: RunContext,
  request: VerifiedCommitExecRequest,
  prepared: PreparedVerifiedCommit,
): Promise<GitDeliveryExecutionResult> {
  const transaction = verifiedCommitRefTransaction(request.verified, prepared);
  if (transaction === undefined) return failureFromExit(0, 0);
  const result = await runOne(ctx, ["update-ref", "--stdin"], transaction);
  if (result.exitCode !== 0) return failureFromExit(result.durationMs, 0);
  return executionResult("succeeded", result.durationMs, { externalId: prepared.head });
}

function failureFromVerifiedCommitError(
  error: unknown,
  refAttempted: boolean,
): GitDeliveryExecutionResult {
  if (error instanceof GitObjectCommandFailure) {
    return failureFromGitExit(
      error.result,
      error.result.durationMs,
      refAttempted ? 1 : 0,
      error.argv,
    );
  }
  return failureFromThrow(error, 0, refAttempted ? 1 : 0);
}

async function execVerifiedCommit(
  ctx: RunContext,
  request: GitCommitExecRequest,
  sign: boolean,
): Promise<GitDeliveryExecutionResult> {
  if (!validVerifiedOperands(request)) return failureFromExit(0, 0);
  let refAttempted = false;
  try {
    const prepared = await prepareVerifiedCommit(ctx, request, sign);
    if (prepared === undefined) return failureFromExit(0, 0);
    refAttempted = true;
    return await updateVerifiedCommitRef(ctx, request, prepared);
  } catch (error) {
    return failureFromVerifiedCommitError(error, refAttempted);
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
  // Exactly the reviewed parent: one for a born head, none for the root commit of an unborn one.
  const parents = expected.head.kind === "born" ? [expected.head.sha] : [];
  return (
    actual.parentShas.length === parents.length &&
    actual.parentShas.every((sha, index) => sha === parents[index]) &&
    actual.treeDigest === expected.stagedTreeDigest &&
    actual.messageDigest === gitCommitMessageDigest(request.message)
  );
}

// A branch from an unborn HEAD re-points HEAD instead of branching from a commit. The unborn state
// and the absence of the new branch are proved again right before the write, while Git's own lock on
// the old and the new branch is held: a commit or branch another process creates meanwhile fails on
// that lock instead of being switched away from or onto. A state that cannot be proved, or a lock
// that cannot be taken, writes nothing.
async function execUnbornBranch(
  ctx: RunContext,
  req: GitBranchCreateExecRequest,
): Promise<GitDeliveryExecutionResult> {
  const fromBranch = req.fromUnbornBranch;
  if (fromBranch === undefined) return failureFromExit(0, 0);
  try {
    return await withGitBranchRefLocks(
      ctx.runDeps.workspace.root,
      [fromBranch, req.branchName],
      async () => {
        const deps = commitReadDeps(ctx);
        const head = await readGitHeadState(deps);
        if (head.kind !== "unborn" || head.branch !== fromBranch) return failureFromExit(0, 0);
        const snapshot = await readGitWorktreeSnapshot(deps);
        if (snapshot.existingLocalBranchNames.includes(req.branchName))
          return failureFromExit(0, 0);
        return await execPlan(ctx, () => buildUnbornBranchArgv(req));
      },
      workspaceFsOf(ctx.runDeps),
    );
  } catch (error) {
    return failureFromUnbornBranchThrow(error);
  }
}

// Nothing was written when the lock or a state read throws. A branch ref lock another process holds
// is a `conflict`; a lock that cannot be created or a state that cannot be read or proved is
// `precondition-failed`; a timeout or cancellation keeps its own closed result; any other throw
// (a denied command, an argv fault) is an internal error, never a statement about the repository.
export function failureFromUnbornBranchThrow(error: unknown): GitDeliveryExecutionResult {
  if (error instanceof CommandTimeoutError || error instanceof CommandCancelledError)
    return failureFromThrow(error, 0, 0);
  if (error instanceof Error && error.message === GIT_REF_LOCK_HELD)
    return failureFromExit(0, 0, "conflict");
  const unproven =
    error instanceof GitWorktreeReadFailure ||
    (error instanceof Error && error.message === GIT_REF_LOCK_UNAVAILABLE);
  return unproven ? failureFromExit(0, 0, "precondition-failed") : failureFromThrow(error, 0, 0);
}

function execBranchCreate(
  ctx: RunContext,
  req: GitBranchCreateExecRequest,
): Promise<GitDeliveryExecutionResult> {
  return req.fromUnbornBranch === undefined
    ? execPlan(ctx, () => buildBranchCreateArgv(req))
    : execUnbornBranch(ctx, req);
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

// The equivalent of the `--no-lazy-fetch --no-replace-objects` CLI flags this lane used to prepend
// to every argv (git's own docs: each flag "is equivalent to setting the GIT_NO_(LAZY_FETCH|
// REPLACE_OBJECTS) environment variable"). Pinned once here rather than per call site so `runOne`
// need only decide WHETHER the guard can be trusted (`ensureGitLazyFetchGuardSupported`), not build
// it into every argv.
function immutableMutationPolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    ...policy,
    pinnedEnv: {
      ...policy.pinnedEnv,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    },
  };
}

function buildRunContext(deps: NodeGitMutationAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: immutableMutationPolicy(deps.policy ?? GOVERNED_GIT_IDENTITY_SANDBOX_POLICY),
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
    preparedCheckout: deps.preparedCheckout,
    readSession: deps.readSession,
    signingRequiredByBranchProtection: deps.signingRequiredByBranchProtection,
    onSigningReadFailure: deps.onSigningReadFailure,
  };
}

/**
 * What a verified staging of `paths` can do: `supported`, or the one closed cause it refuses for
 * (the first found, in the order configuration, filter driver, attribute rule, file content).
 */
export type GitStageSupport = "supported" | CodingRuntimeGitStageCause;

export async function readGitStageSupport(
  deps: NodeGitMutationAdapterDeps,
  paths: readonly string[],
  fs?: WorkspaceFs,
): Promise<GitStageSupport> {
  const ctx = buildRunContext(deps);
  // One configuration read for the whole admission; a driver that cannot be neutralized refuses
  // here as an unsupported transformation instead of failing a hash (PR #4568 audit).
  const config = await readStageConfig(ctx);
  if (config === undefined) return "config-unsupported";
  if (!filterDriversOverridable(config.filterDrivers)) return "filter-driver";
  const { lineEndings, filterDrivers } = config;
  const effect: GitStageEffectContext = {
    workspaceRoot: deps.workspace.root,
    fs: fs ?? workspaceFsOf(ctx.runDeps),
    authorized: () => !ctx.signal.aborted,
    check: () => Promise.resolve(!ctx.signal.aborted),
    filterDriverNames: () => Promise.resolve(filterDrivers),
    signal: ctx.signal,
    run: (argv, stdin, _indexPath, timeoutMs) => runOne(ctx, argv, stdin, timeoutMs),
    indexLineBreaks: (paths) => readGitIndexLineBreaks(commitReadDeps(ctx), paths),
  };
  const attribute = await gitStageAttributeRefusal(effect, paths);
  if (attribute !== undefined) return attribute;
  return (await gitStageFilesSupported(effect, paths, lineEndings))
    ? "supported"
    : "content-conversion";
}

/**
 * The raw reader's staged-object port (#4491): what Git's staging would store for a file's bytes,
 * computed by the very conversion the verified staging uses (`gitStagedObjectIdOf`), under the same
 * governed lane, effective `core.autocrlf` and filter-driver neutralisation. It writes no object and
 * never touches the index, so "staged as X" and "the working tree reads as X" agree.
 */
export function createGitStagedObjectIdPort(
  deps: NodeGitWorktreeReaderDeps,
): GitStagedObjectIdPort {
  const ctx = buildRunContext({ ...deps, policy: deps.policy });
  return async (files, stats) => {
    const config = await readStageConfig(ctx);
    if (config === undefined) return "config-unreadable";
    const effect: GitStageEffectContext = {
      workspaceRoot: deps.workspace.root,
      fs: workspaceFsOf(ctx.runDeps),
      authorized: () => !ctx.signal.aborted,
      check: () => Promise.resolve(!ctx.signal.aborted),
      filterDriverNames: () => Promise.resolve(config.filterDrivers),
      signal: ctx.signal,
      run: (argv, stdin, _indexPath, timeoutMs) => {
        if (!gitStagedObjectPortArgvAllowed(argv)) throw new Error("git-staged-object-port-denied");
        return runOne(ctx, argv, stdin, timeoutMs);
      },
      indexLineBreaks: (paths) => readGitIndexLineBreaks(commitReadDeps(ctx), paths),
    };
    return gitStagedObjectIdOf(effect, config.lineEndings, files, stats);
  };
}

/**
 * The adapter's operations each run in a Git read session of their own unless the caller scopes one
 * (`deps.readSession`, a caller that owns one logical operation): the promisor probe that guards
 * every governed Git process runs once per operation instead of once per process, and the session
 * ends with the operation, so an earlier verdict never authorizes a later, riskier one (#4491).
 */
export function createNodeGitMutationAdapter(
  deps: NodeGitMutationAdapterDeps,
): GitLocalMutationAdapter {
  const scoped = (): RunContext =>
    buildRunContext({ ...deps, readSession: deps.readSession ?? createGitReadSession() });
  return {
    createBranch: (req) => execBranchCreate(scoped(), req),
    switchBranch: (req) => execPlan(scoped(), () => buildBranchSwitchArgv(req)),
    stage: (req) => execStage(scoped(), req),
    unstage: (req) => execUnstage(scoped(), req),
    commit: (req) => execCommit(scoped(), req),
    abort: (req) => execPlan(scoped(), () => buildAbortArgv(req)),
    recover: (req) => execPlan(scoped(), () => buildRecoveryArgv(req)),
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
  readGitBlobTextWithin,
  readGitBlobTextsWithin,
  type GitReadFailureReason,
  readGitCommitIdentity,
  readGitRevision,
  readGitLocalBranchTip,
  readGitHeadState,
  readGitBaseState,
  readGitTreeDigest,
  readGitWorktreeSnapshot,
  readGitStagedDiff,
  readGitStagedChangeSummary,
  type GitStagedChangeEntry,
  readStagedConflictMarkerFileCount,
  readStagedPaths,
  createGitReadSession,
  type NodeGitWorktreeReaderDeps,
  type GitReadSession,
  type GitStagedObjectIdPort,
  type GitStagedConversionEvidence,
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

export {
  GitRawWorktreeReadError,
  readGitRawWorktreeSnapshot,
  readGitRawWorktreeSnapshotAtHead,
  readGitRawChanges,
  readGitRawChangesAtHead,
  type GitRawChangesAtHead,
} from "./git-raw-worktree-node.js";

export {
  gitHeadStateObjectId,
  gitZeroObjectId,
  isGitZeroObjectId,
  sameGitHeadState,
  type GitHeadState,
  type GitObjectIdLength,
} from "./git-head-state.js";

export { gitBlobObjectId } from "./git-index-identity.js";
export { blobIdOfLargeFile } from "./git-stage-stream.js";

export type { GitCiProviderReader, GitCiFactsResult, GitCiProviderFacts } from "./git-ci-facts.js";

export { assessGitCiFacts, gitCiCheckCounts, type GitCiAssessment } from "./git-ci-assessment.js";

export type {
  GitJourneyReader,
  GitJourneyFacts,
  GitJourneyFactsResult,
  GitJourneyReadTarget,
} from "./git-journey-facts.js";
