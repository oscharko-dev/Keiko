// Node implementation of the narrow governed merge adapter (Issue #478, Epic #470) — AC1/AC4/AC5.
//
// This is the ONLY place a governed merge operation actually executes. It builds the governed `gh api`
// argv from the pure builders (git-merge-gateway.ts) and runs them through the SAME keiko-tools no-shell
// spawn boundary (`runCommand`, exec.ts) with a DEDICATED merge allowlist (`GIT_MERGE_COMMAND_RULES`)
// that permits only `gh api` and denies file-input flags. There is no method that accepts an arbitrary
// command string and no parallel child_process path: the deny-by-default allowlist, env isolation,
// redaction, and cancellation of the shared boundary apply to the merge operation exactly as to every
// other tool.
//
// `gh` reads its own GitHub token from its keyring or from GH_TOKEN/GITHUB_TOKEN in the inherited
// process environment; Keiko never reads or handles the token value. The readiness READ maps GitHub's
// content-free PR facts (state / draft / mergeable_state) and repo merge configuration into the
// provider-neutral contract interfaces; a non-OK merge status is classified into a typed
// GitMergeRejectionReason. Raw stdout/stderr never leave this module — only the typed facts, the
// content-free contract error code, and the typed rejection reason cross out.
//
// Lives on the `./internal/git-mutation` subpath (re-exported by git-mutation-node.ts) because it carries
// the Node execution effect; the pure port, builders, and rules it implements are on the barrel.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryChecksState,
  type GitDeliveryExecutionResult,
  type GitDeliveryMergeStrategyHint,
} from "@oscharko-dev/keiko-contracts";
import {
  buildDeleteMergedBranchArgv,
  buildHeadStatusArgv,
  buildMergeArgv,
  buildMergeReadinessArgv,
  buildRepoMergeConfigArgv,
  classifyGitMergeRejection,
  GIT_MERGE_COMMAND_RULES,
  gitMergeRejectionToErrorCode,
  mapRawMergeReadiness,
  type GitMergeAdapter,
  type GitMergeExecRequest,
  type GitMergeExecResult,
  type GitMergeProviderReadiness,
  type GitMergeReadinessRequest,
  type RawMergeReadiness,
} from "./git-merge-gateway.js";
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

export interface NodeGitMergeAdapterDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the shared sandbox policy. A merge legitimately egresses to GitHub, so the default
  // `network: "inherit"` policy is correct here (as for the publish and PR adapters).
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

function executionResult(
  outcome: GitDeliveryExecutionResult["outcome"],
  durationMs: number,
  extra?: Partial<GitMergeExecResult>,
): GitMergeExecResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: Math.max(0, Math.trunc(durationMs)),
    ...extra,
  };
}

interface RunContext {
  readonly runDeps: RunCommandDeps;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
}

function buildRunContext(deps: NodeGitMergeAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_MERGE_COMMAND_RULES,
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

function rejectionFromExit(result: CommandResult): GitMergeExecResult {
  if (result.timedOut) {
    return executionResult("failed", result.durationMs, {
      errorCode: "timeout",
      rejectionReason: "provider-unavailable",
    });
  }
  const reason = classifyGitMergeRejection(`${result.stdout}\n${result.stderr}`);
  return executionResult("failed", result.durationMs, {
    errorCode: gitMergeRejectionToErrorCode(reason),
    rejectionReason: reason,
  });
}

function failureFromThrow(error: unknown, durationMs: number): GitMergeExecResult {
  if (error instanceof CommandTimeoutError) {
    return executionResult("failed", durationMs, {
      errorCode: "timeout",
      rejectionReason: "provider-unavailable",
    });
  }
  if (error instanceof CommandCancelledError) {
    return executionResult("aborted", durationMs);
  }
  return executionResult("failed", durationMs, { errorCode: "internal-error" });
}

async function runGh(ctx: RunContext, argv: readonly string[]): Promise<CommandResult | Error> {
  try {
    return await runCommand(
      { command: "gh", args: argv, cwd: undefined, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
      ctx.runDeps,
    );
  } catch (error) {
    return error instanceof Error ? error : new Error("gh invocation failed");
  }
}

// ─── Readiness read (PR facts + repo merge config + optional head check status) ───────────────────────

interface RawPrFacts {
  readonly state?: unknown;
  readonly merged?: unknown;
  readonly draft?: unknown;
  readonly mergeable_state?: unknown;
  readonly base?: unknown;
  readonly head?: unknown;
  readonly headRef?: unknown;
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rawMergeReadinessFrom(
  facts: RawPrFacts,
  req: GitMergeReadinessRequest,
): RawMergeReadiness {
  return {
    prNumber: req.prExternalId,
    headBranchName: optionalString(facts.headRef) ?? "unknown",
    ...(optionalString(facts.state) !== undefined ? { state: optionalString(facts.state) } : {}),
    ...(typeof facts.merged === "boolean" ? { merged: facts.merged } : {}),
    ...(typeof facts.draft === "boolean" ? { draft: facts.draft } : {}),
    ...(optionalString(facts.mergeable_state) !== undefined
      ? { mergeableState: optionalString(facts.mergeable_state) }
      : {}),
    ...(optionalString(facts.base) !== undefined ? { baseRef: optionalString(facts.base) } : {}),
    ...(optionalString(facts.head) !== undefined ? { headSha: optionalString(facts.head) } : {}),
  };
}

function capableStrategiesFrom(
  cfg: Record<string, unknown>,
): readonly GitDeliveryMergeStrategyHint[] {
  const caps: GitDeliveryMergeStrategyHint[] = [];
  if (cfg.squash === true) caps.push("squash");
  if (cfg.rebase === true) caps.push("rebase");
  if (cfg.merge === true) caps.push("merge-commit");
  return caps;
}

const CHECKS_STATUS_BY_STATE: Readonly<Record<string, GitDeliveryChecksState["overallStatus"]>> = {
  success: "passing",
  pending: "pending",
  failure: "failing",
  error: "failing",
};

// A best-effort combined check-status read. Only the overallStatus drives the contract readiness
// derivation; the per-bucket counts are coarse (the combined state attributed to the matching bucket).
function checksStateFrom(state: string, total: number): GitDeliveryChecksState {
  const overallStatus = CHECKS_STATUS_BY_STATE[state] ?? "skipped";
  return {
    total,
    passing: overallStatus === "passing" ? total : 0,
    failing: overallStatus === "failing" ? total : 0,
    pending: overallStatus === "pending" ? total : 0,
    overallStatus,
  };
}

function shouldReadHeadStatus(mergeableState: string | undefined): boolean {
  return (
    mergeableState === "blocked" || mergeableState === "unstable" || mergeableState === "unknown"
  );
}

async function readHeadChecks(
  ctx: RunContext,
  ownerAndRepo: string,
  headSha: string | undefined,
): Promise<GitDeliveryChecksState | undefined> {
  if (headSha === undefined) {
    return undefined;
  }
  let argv: readonly string[];
  try {
    argv = buildHeadStatusArgv(ownerAndRepo, headSha);
  } catch {
    return undefined;
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error || result.exitCode !== 0) {
    return undefined;
  }
  const state = result.stdout.trim();
  if (state.length === 0) {
    return undefined;
  }
  return checksStateFrom(state, 0);
}

async function readMergeReadiness(
  ctx: RunContext,
  req: GitMergeReadinessRequest,
): Promise<GitMergeProviderReadiness> {
  let prArgv: readonly string[];
  let cfgArgv: readonly string[];
  try {
    prArgv = buildMergeReadinessArgv(req);
    cfgArgv = buildRepoMergeConfigArgv(req);
  } catch {
    return { providerCapableStrategies: [], providerError: true };
  }
  const prResult = await runGh(ctx, prArgv);
  if (prResult instanceof Error || prResult.exitCode !== 0) {
    return { providerCapableStrategies: [], providerError: true };
  }
  const prObj = parseJsonObject(prResult.stdout);
  if (prObj === undefined) {
    return { providerCapableStrategies: [], providerError: true };
  }
  const raw = rawMergeReadinessFrom(prObj, req);
  const pullRequest = mapRawMergeReadiness(raw);

  const cfgResult = await runGh(ctx, cfgArgv);
  const cfgObj =
    cfgResult instanceof Error || cfgResult.exitCode !== 0
      ? undefined
      : parseJsonObject(cfgResult.stdout);
  const providerCapableStrategies = cfgObj !== undefined ? capableStrategiesFrom(cfgObj) : [];

  const checks = shouldReadHeadStatus(raw.mergeableState)
    ? await readHeadChecks(ctx, req.ownerAndRepo, raw.headSha)
    : undefined;

  return {
    pullRequest,
    providerCapableStrategies,
    ...(checks !== undefined ? { checks } : {}),
  };
}

// ─── Merge execute (+ guarded, non-fatal branch deletion) ─────────────────────────────────────────────

function parseMerged(stdout: string): boolean {
  return stdout.trim() === "true";
}

// Deletes the merged head branch best-effort. A failed deletion NEVER fails the merge (the merge already
// succeeded); it only reports branchDeleted=false.
async function deleteMergedBranch(ctx: RunContext, req: GitMergeExecRequest): Promise<boolean> {
  let argv: readonly string[];
  try {
    argv = buildDeleteMergedBranchArgv(req.ownerAndRepo, req.headBranchName);
  } catch {
    return false;
  }
  const result = await runGh(ctx, argv);
  return !(result instanceof Error) && result.exitCode === 0;
}

async function mergePullRequest(
  ctx: RunContext,
  req: GitMergeExecRequest,
): Promise<GitMergeExecResult> {
  let argv: readonly string[];
  try {
    argv = buildMergeArgv(req);
  } catch {
    return executionResult("failed", 0, { errorCode: "internal-error" });
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error) {
    return failureFromThrow(result, 0);
  }
  if (result.exitCode !== 0) {
    return rejectionFromExit(result);
  }
  const merged = parseMerged(result.stdout);
  if (!req.deleteBranchAfterMerge || !merged) {
    return executionResult("succeeded", result.durationMs, { merged });
  }
  const branchDeleted = await deleteMergedBranch(ctx, req);
  return executionResult("succeeded", result.durationMs, { merged, branchDeleted });
}

export function createNodeGitMergeAdapter(deps: NodeGitMergeAdapterDeps): GitMergeAdapter {
  const ctx = buildRunContext(deps);
  return {
    readMergeReadiness: (req: GitMergeReadinessRequest): Promise<GitMergeProviderReadiness> =>
      readMergeReadiness(ctx, req),
    mergePullRequest: (req: GitMergeExecRequest): Promise<GitMergeExecResult> =>
      mergePullRequest(ctx, req),
  };
}
