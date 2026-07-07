// Node implementation of the narrow GitHub pull request adapter (Issue #477, Epic #470) — AC1/AC4/AC5.
//
// This is the ONLY place a governed pull request operation actually executes. It builds the governed
// `gh api` argv from the pure builders (git-pr-gateway.ts) and runs it through the SAME keiko-tools
// no-shell spawn boundary (`runCommand`, exec.ts) with a DEDICATED PR allowlist
// (`GIT_PULL_REQUEST_COMMAND_RULES`) that permits only `gh api` and denies file-input flags. There is
// no method that accepts an arbitrary command string and no parallel child_process path: the
// deny-by-default allowlist, env isolation, redaction, and cancellation of the shared boundary apply to
// the PR operation exactly as to every other tool.
//
// `gh` reads its own GitHub token from its keyring or from GH_TOKEN/GITHUB_TOKEN in the inherited
// process environment; Keiko never reads or handles the token value. A non-OK HTTP status / non-zero
// exit is classified into a typed GitPullRequestRejectionReason by matching GitHub's own error tokens in
// the (already secret-redacted) output. Raw stdout/stderr never leave this module — only the typed
// reason, the content-free contract error code, and the opaque provider-assigned PR number cross out.
//
// Lives on the `./internal/git-mutation` subpath (re-exported by git-mutation-node.ts) because it
// carries the Node execution effect; the pure port, builders, and rules it implements are on the barrel.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryExecutionResult,
} from "@oscharko-dev/keiko-contracts";
import {
  buildPrConvertDraftGraphqlArgv,
  buildPrCreateArgv,
  buildPrMarkReadyGraphqlArgv,
  buildPrUpdateArgv,
  classifyGitPullRequestRejection,
  GIT_PULL_REQUEST_COMMAND_RULES,
  gitPrRejectionToErrorCode,
  type GitPrCreateExecRequest,
  type GitPrExecResult,
  type GitPrUpdateExecRequest,
  type GitPullRequestAdapter,
} from "./git-pr-gateway.js";
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

export interface NodeGitPullRequestAdapterDeps {
  // The repository root the operation runs in. Reused as the spawn-boundary workspace root.
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the shared sandbox policy. A PR operation legitimately egresses to GitHub, so the
  // default `network: "inherit"` policy is correct here (as for the publish adapter).
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

function executionResult(
  outcome: GitDeliveryExecutionResult["outcome"],
  durationMs: number,
  extra?: Partial<GitPrExecResult>,
): GitPrExecResult {
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

function buildRunContext(deps: NodeGitPullRequestAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_PULL_REQUEST_COMMAND_RULES,
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

function rejectionFromExit(result: CommandResult): GitPrExecResult {
  if (result.timedOut) {
    return executionResult("failed", result.durationMs, {
      errorCode: "timeout",
      rejectionReason: "provider-unavailable",
    });
  }
  const reason = classifyGitPullRequestRejection(`${result.stdout}\n${result.stderr}`);
  return executionResult("failed", result.durationMs, {
    errorCode: gitPrRejectionToErrorCode(reason),
    rejectionReason: reason,
  });
}

function failureFromThrow(error: unknown, durationMs: number): GitPrExecResult {
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

// Extracts the leading run of digits from `gh api … --jq .number` output (a single value, already
// redacted). Returns undefined when the output is empty or non-numeric.
function parsePrNumber(stdout: string): string | undefined {
  const match = /^\s*(\d{1,10})\s*$/.exec(stdout);
  return match?.[1];
}

function parseNodeId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  return /^[A-Za-z0-9_=-]+$/.test(trimmed) ? trimmed : undefined;
}

async function createPullRequest(
  ctx: RunContext,
  req: GitPrCreateExecRequest,
): Promise<GitPrExecResult> {
  let argv: readonly string[];
  try {
    // Append `--jq .number` so the success stdout is just the provider-assigned PR number (a clean,
    // parse-robust value rather than the full PR JSON, which redaction or the output cap could disturb).
    argv = [...buildPrCreateArgv(req), "--jq", ".number"];
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
  const createdPrExternalId = parsePrNumber(result.stdout);
  if (createdPrExternalId === undefined) {
    // Exit 0 with an unparsable number (`--jq .number` emits `null` on an unexpected response
    // shape) means the provider gave us nothing the caller can reference. Reporting success
    // without an id would strand the UI on a PR it cannot open — fail closed instead.
    return executionResult("failed", result.durationMs, { errorCode: "internal-error" });
  }
  return executionResult("succeeded", result.durationMs, { createdPrExternalId });
}

// Performs the draft↔ready transition the REST update endpoint cannot: looks up the PR's GraphQL node
// id, then runs the appropriate mutation. Returns undefined on success, or the failed exec result.
async function runDraftTransition(
  ctx: RunContext,
  req: GitPrUpdateExecRequest,
  totalDuration: number,
): Promise<GitPrExecResult | undefined> {
  if (!req.convertToDraft && !req.convertFromDraft) {
    return undefined;
  }
  const idResult = await runGh(ctx, [
    "api",
    `/repos/${req.ownerAndRepo}/pulls/${req.prExternalId}`,
    "--jq",
    ".node_id",
  ]);
  if (idResult instanceof Error) {
    return failureFromThrow(idResult, totalDuration);
  }
  if (idResult.exitCode !== 0) {
    return rejectionFromExit(idResult);
  }
  const nodeId = parseNodeId(idResult.stdout);
  if (nodeId === undefined) {
    return executionResult("failed", totalDuration, { errorCode: "internal-error" });
  }
  const mutation = req.convertToDraft
    ? buildPrConvertDraftGraphqlArgv(nodeId)
    : buildPrMarkReadyGraphqlArgv(nodeId);
  const mutationResult = await runGh(ctx, mutation);
  if (mutationResult instanceof Error) {
    return failureFromThrow(mutationResult, totalDuration);
  }
  return mutationResult.exitCode === 0 ? undefined : rejectionFromExit(mutationResult);
}

async function updatePullRequest(
  ctx: RunContext,
  req: GitPrUpdateExecRequest,
): Promise<GitPrExecResult> {
  let argv: readonly string[];
  try {
    argv = buildPrUpdateArgv(req);
  } catch {
    return executionResult("failed", 0, { errorCode: "internal-error" });
  }
  const patch = await runGh(ctx, argv);
  if (patch instanceof Error) {
    return failureFromThrow(patch, 0);
  }
  if (patch.exitCode !== 0) {
    return rejectionFromExit(patch);
  }
  const transition = await runDraftTransition(ctx, req, patch.durationMs);
  if (transition !== undefined) {
    return transition;
  }
  return executionResult("succeeded", patch.durationMs, { createdPrExternalId: req.prExternalId });
}

export function createNodeGitPullRequestAdapter(
  deps: NodeGitPullRequestAdapterDeps,
): GitPullRequestAdapter {
  const ctx = buildRunContext(deps);
  return {
    createPullRequest: (req: GitPrCreateExecRequest): Promise<GitPrExecResult> =>
      createPullRequest(ctx, req),
    updatePullRequest: (req: GitPrUpdateExecRequest): Promise<GitPrExecResult> =>
      updatePullRequest(ctx, req),
  };
}
