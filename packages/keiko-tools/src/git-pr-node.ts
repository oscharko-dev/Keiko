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
// `gh` reads its own GitHub token from its keyring or from GH_TOKEN/GITHUB_TOKEN. Those names reach
// the child ONLY because this adapter runs on the governed REMOTE env lane
// (GOVERNED_GIT_REMOTE_SANDBOX_POLICY): the lane forwards the credential NAMES and the real HOME so
// gh can resolve `~/.config/gh`, and the spawn boundary keeps their VALUES in its output scrub set —
// Keiko never reads, stores, or logs the token, and a token echoed back by gh is redacted before it
// leaves this layer. A non-OK HTTP status / non-zero
// exit is classified into a typed GitPullRequestRejectionReason by matching GitHub's own error tokens in
// the (already secret-redacted) output. Raw stdout/stderr never leave this module — only the typed
// reason, the content-free contract error code, and the opaque provider-assigned PR number cross out.
//
// Lives on the `./internal/git-mutation` subpath (re-exported by git-mutation-node.ts) because it
// carries the Node execution effect; the pure port, builders, and rules it implements are on the barrel.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { GitDeliveryExecutionResult } from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import {
  buildPrConvertDraftGraphqlArgv,
  buildPrCreateArgv,
  buildPrMarkReadyGraphqlArgv,
  buildPrReadArgv,
  buildPrReadByHeadArgv,
  buildPrReadBranchHeadArgv,
  buildPrUpdateArgv,
  classifyGitPullRequestRejection,
  GIT_PULL_REQUEST_COMMAND_RULES,
  GIT_PR_IDENTITY_JQ,
  gitPrRejectionToErrorCode,
  type GitPrCreateExecRequest,
  type GitPrExecResult,
  type GitPrMarkReadyExecRequest,
  type GitPrMarkReadyExecResult,
  type GitPrReadRequest,
  type GitPrUpdateExecRequest,
  type GitPullRequestInspectionAdapter,
  type GitPullRequestMarkReadyAdapter,
  type GitPrInspectionResult,
} from "./git-pr-gateway.js";
import {
  parseCreatedGitPrIdentity,
  parseGitPrBranchHead,
  parseGitPrIdentity,
  parseGitPrIdentityList,
} from "./git-pr-identity.js";
import {
  buildPrBodyReadArgv,
  buildPrBodyUpdateArgv,
  parseGitPrBody,
  type GitPullRequestBodyAdapter,
  type GitPrBody,
} from "./git-pr-body.js";
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
  GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
  type CommandResult,
  type SandboxPolicy,
} from "./types.js";

export interface NodeGitPullRequestAdapterDeps {
  // The repository root the operation runs in. Reused as the spawn-boundary workspace root.
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the governed REMOTE lane (as for the publish and merge adapters): a PR operation
  // legitimately egresses to GitHub and must be able to authenticate, which the fully isolated
  // default makes impossible — it forwards no GH_TOKEN/GITHUB_TOKEN and gives the child an empty
  // HOME, so `gh` reaches neither its keyring nor `~/.config/gh`.
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  // The termination-evidence port for every runCommand this lane performs (RunCommandDeps
  // deps-level seam, exec.ts): production composition boundaries wire it once so no call on the
  // lane is silently unobservable (PR #3354 review, comment 3887021650).
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
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
      policy: deps.policy ?? GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
      commandRules: GIT_PULL_REQUEST_COMMAND_RULES,
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
    const projection = req.canonicalGitHubIdentity === true ? GIT_PR_IDENTITY_JQ : ".number";
    argv = [...buildPrCreateArgv(req), "--jq", projection];
  } catch {
    return executionResult("failed", 0, { errorCode: "internal-error" });
  }
  const result = await runGh(ctx, argv);
  if (result instanceof Error) {
    return failureFromThrow(result, 0);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    return rejectionFromExit(result);
  }
  if (result.truncated)
    return executionResult("failed", result.durationMs, { errorCode: "internal-error" });
  if (req.canonicalGitHubIdentity === true) return canonicalCreateResult(req, result);
  const createdPrExternalId = parsePrNumber(result.stdout);
  if (createdPrExternalId === undefined) {
    // Exit 0 with an unparsable number (`--jq .number` emits `null` on an unexpected response
    // shape) means the provider gave us nothing the caller can reference. Reporting success
    // without an id would strand the UI on a PR it cannot open — fail closed instead.
    return executionResult("failed", result.durationMs, { errorCode: "internal-error" });
  }
  return executionResult("succeeded", result.durationMs, { createdPrExternalId });
}

function canonicalCreateResult(
  req: GitPrCreateExecRequest,
  result: CommandResult,
): GitPrExecResult {
  const createdPrIdentity = parseCreatedGitPrIdentity(result.stdout, req);
  return createdPrIdentity === undefined
    ? executionResult("failed", result.durationMs, { errorCode: "internal-error" })
    : executionResult("succeeded", result.durationMs, {
        createdPrExternalId: String(createdPrIdentity.number),
        createdPrIdentity,
      });
}

// Looks up a PR's GraphQL node id — the shared first step of every draft-state transition (the REST
// update endpoint cannot toggle it). Returns the node id, or the failed exec result to propagate as-is.
type NodeIdLookup =
  | { readonly ok: true; readonly nodeId: string }
  | { readonly ok: false; readonly failure: GitPrExecResult };

async function fetchPrNodeId(
  ctx: RunContext,
  ownerAndRepo: string,
  prExternalId: string,
): Promise<NodeIdLookup> {
  const idResult = await runGh(ctx, [
    "api",
    `/repos/${ownerAndRepo}/pulls/${prExternalId}`,
    "--jq",
    ".node_id",
  ]);
  if (idResult instanceof Error) {
    return { ok: false, failure: failureFromThrow(idResult, 0) };
  }
  if (idResult.exitCode !== 0) {
    return { ok: false, failure: rejectionFromExit(idResult) };
  }
  const nodeId = parseNodeId(idResult.stdout);
  if (nodeId === undefined) {
    return {
      ok: false,
      failure: executionResult("failed", idResult.durationMs, { errorCode: "internal-error" }),
    };
  }
  return { ok: true, nodeId };
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
  const node = await fetchPrNodeId(ctx, req.ownerAndRepo, req.prExternalId);
  if (!node.ok) {
    return node.failure;
  }
  const mutation = req.convertToDraft
    ? buildPrConvertDraftGraphqlArgv(node.nodeId)
    : buildPrMarkReadyGraphqlArgv(node.nodeId);
  const mutationResult = await runGh(ctx, mutation);
  if (mutationResult instanceof Error) {
    return failureFromThrow(mutationResult, totalDuration);
  }
  return mutationResult.exitCode === 0 ? undefined : rejectionFromExit(mutationResult);
}

// #3389: reads the live PR identity (head/base SHA, draft state) through the SAME governed read used
// by the public `readPullRequest` adapter method — factored out so `markPullRequestReady` can re-read
// the identical facts immediately before and after the mutation without a second implementation.
function readPrIdentity(
  ctx: RunContext,
  req: GitPrReadRequest,
): Promise<GitPrInspectionResult<GitPullRequestIdentity>> {
  const input = { ...req };
  return inspectRemote(
    ctx,
    () => buildPrReadArgv(input),
    (value) => {
      const identity = parseGitPrIdentity(value, input.ownerAndRepo);
      return String(identity?.number) === input.prExternalId ? identity : undefined;
    },
    // #3389 repair (review finding): this exact read backs BOTH the public readPullRequest
    // inspection AND markPullRequestReady's pre/post-mutation drift gate, matching the fail-closed
    // treatment readPullRequestBody already gets for a comparable governed read. Defense-in-depth,
    // not independently black-box-testable here: every GitPullRequestIdentity field is
    // format-validated (isGitPullRequestIdentity), and the redactor's literal "[REDACTED]" marker
    // cannot satisfy any of those formats — a redacted read on THIS endpoint already fails the
    // existing field validation before this flag is ever consulted. It still matters as the
    // structural invariant "a governed mutation gate never trusts an altered read" rather than
    // relying on incidental format strictness to keep that true.
    true,
  );
}

function markReadyResult(
  outcome: GitDeliveryExecutionResult["outcome"],
  durationMs: number,
  extra?: Partial<GitPrMarkReadyExecResult>,
): GitPrMarkReadyExecResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: Math.max(0, Math.trunc(durationMs)),
    ...extra,
  };
}

// Projects a `GitPrExecResult` failure (from `fetchPrNodeId` / `runGh`) onto the narrower mark-ready
// result shape — never carries the create-specific `createdPrExternalId`/`createdPrIdentity` fields.
function asMarkReadyFailure(result: GitPrExecResult): GitPrMarkReadyExecResult {
  return markReadyResult(result.outcome, result.durationMs, {
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
  });
}

// #3389 (epic #3384 corrections 1/2/7): the draft->ready transition, deliberately isolated from
// `updatePullRequest` — no title/body/base PATCH is ever bundled with it. Re-reads the live PR
// identity immediately before AND after the mutation and refuses (never spawns the mutation, or
// reports the observed drift) on any mismatch against the caller's expected head/base SHA — the
// governed caller's one-use approval binds exactly those facts, so a claim minted against a PR that
// has since moved can never be redeemed.
// True when the live PR facts no longer match what the mark-ready claim was minted against — the
// PR must still be exactly the draft the approval bound (same head/base SHA).
function isPreMutationDrift(
  identity: GitPullRequestIdentity,
  req: GitPrMarkReadyExecRequest,
): boolean {
  return (
    identity.headSha !== req.expectedHeadSha ||
    identity.baseSha !== req.expectedBaseSha ||
    !identity.isDraft
  );
}

// True when the mutation reported success but the read-back does not confirm it: still a draft, or
// the head moved during the call. A `mutationResult.exitCode === 0` alone never proves the transition.
function isPostMutationDrift(
  identity: GitPullRequestIdentity,
  req: GitPrMarkReadyExecRequest,
): boolean {
  return identity.isDraft || identity.headSha !== req.expectedHeadSha;
}

type MarkReadyMutationOutcome =
  | { readonly ok: true; readonly durationMs: number }
  | { readonly ok: false; readonly failure: GitPrMarkReadyExecResult };

async function runMarkReadyMutation(
  ctx: RunContext,
  req: GitPrMarkReadyExecRequest,
): Promise<MarkReadyMutationOutcome> {
  const node = await fetchPrNodeId(ctx, req.ownerAndRepo, req.prExternalId);
  if (!node.ok) {
    return { ok: false, failure: asMarkReadyFailure(node.failure) };
  }
  const mutationResult = await runGh(ctx, buildPrMarkReadyGraphqlArgv(node.nodeId));
  if (mutationResult instanceof Error) {
    return { ok: false, failure: asMarkReadyFailure(failureFromThrow(mutationResult, 0)) };
  }
  if (mutationResult.exitCode !== 0) {
    return { ok: false, failure: asMarkReadyFailure(rejectionFromExit(mutationResult)) };
  }
  return { ok: true, durationMs: mutationResult.durationMs };
}

async function markPullRequestReady(
  ctx: RunContext,
  req: GitPrMarkReadyExecRequest,
): Promise<GitPrMarkReadyExecResult> {
  const before = await readPrIdentity(ctx, req);
  if (!before.ok) {
    return markReadyResult("failed", 0, { errorCode: "precondition-failed" });
  }
  if (isPreMutationDrift(before.value, req)) {
    return markReadyResult("failed", 0, {
      errorCode: "precondition-failed",
      observedIdentity: before.value,
    });
  }
  const mutation = await runMarkReadyMutation(ctx, req);
  if (!mutation.ok) {
    return mutation.failure;
  }
  const after = await readPrIdentity(ctx, req);
  if (!after.ok) {
    return markReadyResult("failed", mutation.durationMs, { errorCode: "precondition-failed" });
  }
  if (isPostMutationDrift(after.value, req)) {
    return markReadyResult("failed", mutation.durationMs, {
      errorCode: "precondition-failed",
      observedIdentity: after.value,
    });
  }
  return markReadyResult("succeeded", mutation.durationMs, { observedIdentity: after.value });
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
): GitPullRequestInspectionAdapter & GitPullRequestBodyAdapter & GitPullRequestMarkReadyAdapter {
  const ctx = buildRunContext(deps);
  return {
    ...bodyAdapter(ctx),
    createPullRequest: (req: GitPrCreateExecRequest): Promise<GitPrExecResult> =>
      createPullRequest(ctx, { ...req }),
    updatePullRequest: (req: GitPrUpdateExecRequest): Promise<GitPrExecResult> =>
      updatePullRequest(ctx, req),
    markPullRequestReady: (req: GitPrMarkReadyExecRequest): Promise<GitPrMarkReadyExecResult> =>
      markPullRequestReady(ctx, { ...req }),
    readPullRequest: (req): Promise<GitPrInspectionResult<GitPullRequestIdentity>> =>
      readPrIdentity(ctx, { ...req }),
    findPullRequestsByHead: (
      req,
    ): Promise<GitPrInspectionResult<readonly GitPullRequestIdentity[]>> => {
      const input = { ...req };
      return inspectRemote(
        ctx,
        () => buildPrReadByHeadArgv(input),
        (value) => parseGitPrIdentityList(value, input.ownerAndRepo, input.headBranchName),
      );
    },
    readBranchHead: (req): Promise<GitPrInspectionResult<string>> => {
      const input = { ...req };
      return inspectRemote(
        ctx,
        () => buildPrReadBranchHeadArgv(input),
        (value) => parseGitPrBranchHead(value, input.headBranchName),
      );
    },
  };
}

async function inspectRemote<T>(
  ctx: RunContext,
  argv: () => readonly string[],
  parse: (value: unknown) => T | undefined,
  exactOutput = false,
): Promise<GitPrInspectionResult<T>> {
  try {
    const result = await runGh(ctx, argv());
    if (result instanceof Error) return { ok: false, reason: "provider-unavailable" };
    if (exactOutput && result.outputRedacted === true)
      return { ok: false, reason: "invalid-response" };
    if (result.timedOut || result.truncated) return { ok: false, reason: "provider-unavailable" };
    if (result.exitCode !== 0)
      return {
        ok: false,
        reason: classifyGitPullRequestRejection(`${result.stdout}\n${result.stderr}`),
      };
    const value = parse(JSON.parse(result.stdout) as unknown);
    return value === undefined ? { ok: false, reason: "invalid-response" } : { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid-response" };
  }
}

function bodyAdapter(ctx: RunContext): GitPullRequestBodyAdapter {
  return {
    readPullRequestBody: (request): Promise<GitPrInspectionResult<GitPrBody>> => {
      const input = { ...request };
      return inspectRemote(
        ctx,
        () => buildPrBodyReadArgv(input),
        (value) => parseGitPrBody(value, input),
        true,
      );
    },
    updatePullRequestBody: async (request): Promise<GitPrExecResult> => {
      try {
        const result = await runGh(ctx, buildPrBodyUpdateArgv({ ...request }));
        if (result instanceof Error) return failureFromThrow(result, 0);
        if (result.exitCode !== 0 || result.timedOut) return rejectionFromExit(result);
        return executionResult("succeeded", result.durationMs);
      } catch (error) {
        return failureFromThrow(error, 0);
      }
    },
  };
}
