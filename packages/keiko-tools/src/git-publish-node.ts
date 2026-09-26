// Node implementation of the narrow remote publish adapter (Issue #476, Epic #470) — AC3/AC5.
//
// This is the ONLY place a governed `git push` actually executes. It builds the single governed push
// argv from the pure builder (git-publish-gateway.ts) and runs it through the SAME keiko-tools no-shell
// spawn boundary (`runCommand`, exec.ts) with a DEDICATED publish allowlist (`GIT_PUBLISH_COMMAND_RULES`)
// that permits only `push` and denies every force/history-rewrite flag. There is no method that accepts
// an arbitrary command string and no parallel child_process path: the deny-by-default allowlist, env
// isolation, redaction, and cancellation of the shared boundary apply to the publish exactly as to every
// other tool.
//
// A non-zero push exit is classified into a typed GitPublishRejectionReason by matching git's own
// English status phrases in the (already secret-redacted) output. Raw stdout/stderr never leave this
// module — only the typed reason and the content-free contract error code cross the boundary.
//
// Lives on the `./internal/git-mutation` subpath (re-exported by git-mutation-node.ts) because it carries
// the Node execution effect; the pure port, builder, and rules it implements are on the package barrel.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  withGitPublishView,
  type GitPublishView,
} from "@oscharko-dev/keiko-workspace/internal/git-publish";
import { gitEnv } from "@oscharko-dev/keiko-git";
import { canonicalGitHubPushUrl } from "./git-push-destination.js";
import {
  prepareGitHubPushAuthentication,
  type GitHubPushAuthentication,
} from "./git-push-authentication.js";
import type { GitDeliveryExecutionResult } from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import {
  buildPushArgv,
  buildSetUpstreamToArgv,
  classifyGitPublishRejection,
  GIT_PUBLISH_COMMAND_RULES,
  gitPublishRejectionToErrorCode,
  type GitPublishExecRequest,
  type GitPublishExecResult,
  type GitRemotePublishAdapter,
} from "./git-publish-gateway.js";
import { CommandCancelledError, CommandTimeoutError } from "./errors.js";
import {
  nodeSpawnFn,
  nodeHomeProvider,
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type CommandTerminationEvidence,
  type RunCommandDeps,
  type SpawnFn,
} from "./exec.js";
import {
  GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
  type CommandResult,
  type SandboxPolicy,
} from "./types.js";

export interface NodeGitPublishAdapterDeps {
  /** Exact canonical destination approved by the owning run; never supplied by a tool or form. */
  readonly verifiedRemoteUrl?: string;
  readonly beforeRemoteDispatch?: () => boolean;
  /** Owning server logs the failure through its existing structured diagnostic port. */
  readonly onPreparationFailure?: (error: unknown) => void;
  // Best-effort content-free signal for the interactive pinned-push path's post-push
  // `--set-upstream-to` follow-up (`applyUpstreamTrackingIfRequested` below, #3394 review): the push
  // itself already succeeded by the time this can fire, so it is visibility for the owning server's
  // activity log, never a reason to change the push's own reported outcome. Never invoked for the
  // canonical-URL (`runVerifiedPush`) path, which does not perform this follow-up at all.
  readonly onUpstreamTrackingFailure?: (() => void) | undefined;
  // The repository root the push runs in. Reused as the spawn-boundary workspace root.
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the governed REMOTE lane. A push legitimately egresses to the remote and must be
  // able to AUTHENTICATE to it: under the fully isolated default the child gets an empty HOME and no
  // agent, so there is no `~/.ssh`, no SSH agent socket, no credential helper and no
  // `~/.git-credentials` — every push to a real remote fails. The remote lane forwards exactly the
  // account/agent state normal git credentials need and pins every interactive prompt closed.
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
  extra?: Partial<GitPublishExecResult>,
): GitPublishExecResult {
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

const GOVERNED_GIT_PUBLISH_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.pager=cat",
  "-c",
  "pager.push=false",
  "-c",
  "alias.push=",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false",
];

function buildRunContext(deps: NodeGitPublishAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? GOVERNED_GIT_REMOTE_SANDBOX_POLICY,
      commandRules: GIT_PUBLISH_COMMAND_RULES,
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

// A non-zero push exit means the remote (or a local precondition) rejected the push. The reason is
// classified from the combined, already-redacted output; only the typed reason + content-free error
// code are returned. A `timedOut` run is a transient network timeout, not a remote rejection.
function rejectionFromExit(result: CommandResult): GitPublishExecResult {
  if (result.timedOut) {
    return executionResult("failed", result.durationMs, {
      errorCode: "timeout",
      rejectionReason: "remote-unavailable",
    });
  }
  const reason = classifyGitPublishRejection(`${result.stdout}\n${result.stderr}`);
  return executionResult("failed", result.durationMs, {
    errorCode: gitPublishRejectionToErrorCode(reason),
    rejectionReason: reason,
  });
}

function failureFromThrow(error: unknown, durationMs: number): GitPublishExecResult {
  if (error instanceof CommandTimeoutError) {
    return executionResult("failed", durationMs, {
      errorCode: "timeout",
      rejectionReason: "remote-unavailable",
    });
  }
  if (error instanceof CommandCancelledError) {
    return executionResult("aborted", durationMs);
  }
  // A denied command (our own argv hit the allowlist), an argv-construction fault, or any other throw
  // is an internal gateway error — it never means the remote is at fault.
  return executionResult("failed", durationMs, { errorCode: "internal-error" });
}

async function runPush(ctx: RunContext, argv: readonly string[]): Promise<GitPublishExecResult> {
  let result: CommandResult;
  try {
    result = await runCommand(
      {
        command: "git",
        args: [...GOVERNED_GIT_PUBLISH_CONFIG_ARGS, ...argv],
        cwd: undefined,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      },
      ctx.runDeps,
    );
  } catch (error) {
    return failureFromThrow(error, 0);
  }
  if (result.exitCode === 0) {
    return executionResult("succeeded", result.durationMs);
  }
  return rejectionFromExit(result);
}

export function createNodeGitPublishAdapter(
  deps: NodeGitPublishAdapterDeps,
): GitRemotePublishAdapter {
  const ctx = buildRunContext(deps);
  const remoteUrl = canonicalGitHubPushUrl(deps.verifiedRemoteUrl);
  const beforeRemoteDispatch = deps.beforeRemoteDispatch;
  const onPreparationFailure = deps.onPreparationFailure;
  const onUpstreamTrackingFailure = deps.onUpstreamTrackingFailure;
  return {
    publish: (req: GitPublishExecRequest): Promise<GitPublishExecResult> => {
      let argv: readonly string[];
      try {
        // forcePush is hard-false and LAST so it can never be overridden by the request: a force
        // operand never reaches this executor (AC4 defence-in-depth above the gateway gate).
        argv = buildPushArgv({ ...req, kind: "push", forcePush: false });
      } catch {
        return Promise.resolve(executionResult("failed", 0, { errorCode: "internal-error" }));
      }
      // Decision Point A (#3394 review): a canonical GitHub URL is wired only for the issue-bound
      // workbench delivery path (verifiedRemoteUrl resolved from the task-accepted repository
      // identity). The interactive route never supplies one, so routing every pinned push through
      // `runVerifiedPush` (GitHub-only, dispatches to a literal URL rather than the user's own
      // `remoteAlias`) would silently narrow every non-GitHub interactive push to a hard failure.
      // When no canonical URL is wired, dispatch the SAME pinned-SHA argv through the ordinary,
      // remote-host-agnostic transport instead — `buildPushArgv` already pins the exact commit
      // regardless of which branch this fires through.
      return remoteUrl === undefined
        ? runPinnedPush(ctx, argv, req, onUpstreamTrackingFailure)
        : runVerifiedPush(ctx, { ...req }, remoteUrl, beforeRemoteDispatch, onPreparationFailure);
    },
  };
}

// The interactive (non-GitHub-canonical) pinned-push path: run the pinned argv through the ordinary
// transport, then — only after a SUCCESSFUL push and only when tracking was requested — best-effort
// establish upstream tracking as a separate, local-only, no-network step. A raw commit SHA is not "a
// branch" from `push --set-upstream`'s point of view (verified empirically: `-u` silently no-ops on
// a raw-SHA source), so tracking cannot be folded into the push argv itself; the remote-tracking ref
// (`refs/remotes/<alias>/<target>`) already exists locally immediately after a successful push, so
// this needs no extra fetch.
async function runPinnedPush(
  ctx: RunContext,
  argv: readonly string[],
  req: GitPublishExecRequest,
  onUpstreamTrackingFailure: (() => void) | undefined,
): Promise<GitPublishExecResult> {
  const result = await runPush(ctx, argv);
  if (result.outcome === "succeeded" && req.setUpstreamTracking) {
    await applyUpstreamTrackingIfRequested(ctx, req, onUpstreamTrackingFailure);
  }
  return result;
}

// Best-effort only: a failure here never changes the push's own outcome (the governed,
// security-relevant action already succeeded — only a local convenience config write did not).
// `onTerminated` does NOT cover this: it fires only when the harness itself force-terminates a run
// (timeout/abort/output-cap — exec.ts's `terminate()`), never on an ordinary non-zero exit, which is
// the realistic failure shape here (e.g. the remote-tracking ref is not yet present, or `.git/config`
// is transiently locked). Both a thrown error and a plain non-zero exit are therefore reported
// through the dedicated, content-free `onUpstreamTrackingFailure` seam instead (AGENTS.md §7/§8: no
// silent failures — the owning server logs this through its existing activity-log port, same as
// `onPreparationFailure` above).
async function applyUpstreamTrackingIfRequested(
  ctx: RunContext,
  req: GitPublishExecRequest,
  onUpstreamTrackingFailure: (() => void) | undefined,
): Promise<void> {
  let argv: readonly string[];
  try {
    argv = buildSetUpstreamToArgv(req.remoteAlias, req.remoteBranchName, req.sourceBranchName);
  } catch {
    onUpstreamTrackingFailure?.();
    return;
  }
  // Reuses `runPush`, this file's ONE governed git invocation (the run-command evidence-wiring pin
  // counts it as the file's single soft-verdict call site): the same sandboxed executor, command
  // rules and termination evidence, and no second call site to justify. Every non-succeeded
  // outcome -- a thrown spawn, a non-zero exit, a harness termination -- is the same best-effort
  // tracking failure and is never propagated to the push's own result.
  const result = await runPush(ctx, argv);
  if (result.outcome !== "succeeded") onUpstreamTrackingFailure?.();
}

async function runVerifiedPush(
  ctx: RunContext,
  request: GitPublishExecRequest,
  remoteUrl: string | undefined,
  beforeRemoteDispatch: (() => boolean) | undefined,
  onPreparationFailure: ((error: unknown) => void) | undefined,
): Promise<GitPublishExecResult> {
  const commit = request.verifiedCommitSha;
  if (remoteUrl === undefined)
    return executionResult("failed", 0, { errorCode: "precondition-failed" });
  try {
    return await withPrivatePublishMetadata(ctx.runDeps.workspace, commit, async (view) => {
      if (ctx.signal.aborted || !view.isCurrent() || beforeRemoteDispatch?.() === false)
        return executionResult("aborted", 0);
      const authentication = prepareGitHubPushAuthentication(remoteUrl, ctx.runDeps);
      if (!view.isCurrent() || beforeRemoteDispatch?.() === false)
        return executionResult("aborted", 0);
      return runPush(verifiedRunContext(ctx, view, authentication), [
        ...authentication.configArgs,
        "-c",
        "http.followRedirects=false",
        "push",
        remoteUrl,
        `${commit}:refs/heads/${request.remoteBranchName}`,
      ]);
    });
  } catch (error) {
    onPreparationFailure?.(error);
    return failureFromThrow(error, 0);
  }
}

async function withPrivatePublishMetadata<T>(
  workspace: WorkspaceInfo,
  commit: string,
  publish: (view: GitPublishView) => Promise<T>,
): Promise<T> {
  const privateRoot = nodeHomeProvider.make();
  try {
    return await withGitPublishView(workspace, commit, publish, privateRoot);
  } finally {
    nodeHomeProvider.cleanup(privateRoot);
  }
}

function verifiedRunContext(
  ctx: RunContext,
  view: GitPublishView,
  authentication: GitHubPushAuthentication,
): RunContext {
  const policy = ctx.runDeps.policy;
  const pinnedEnv = {
    ...policy.pinnedEnv,
    ...Object.fromEntries(
      Object.entries(gitEnv({})).filter(([key]) => key.startsWith("GIT_CONFIG_")),
    ),
    ...authentication.pinnedEnv,
    GIT_DIR: view.gitDirectory,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_COMMON_DIR: view.gitDirectory,
    GIT_OBJECT_DIRECTORY: view.objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  return { ...ctx, runDeps: { ...ctx.runDeps, policy: { ...policy, pinnedEnv } } };
}
