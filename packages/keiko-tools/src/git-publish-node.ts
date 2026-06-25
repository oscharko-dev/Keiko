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
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryExecutionResult,
} from "@oscharko-dev/keiko-contracts";
import {
  buildPushArgv,
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
  runCommand,
  type ExecutableResolver,
  type HomeProvider,
  type RunCommandDeps,
  type SpawnFn,
} from "./exec.js";
import { DEFAULT_SANDBOX_POLICY, type CommandResult, type SandboxPolicy } from "./types.js";

export interface NodeGitPublishAdapterDeps {
  // The repository root the push runs in. Reused as the spawn-boundary workspace root.
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  // Defaults to the shared sandbox policy. Unlike the LOCAL mutation adapter, a push legitimately
  // egresses to the remote, so the default `network: "inherit"` policy is correct here.
  readonly policy?: SandboxPolicy | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
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

function buildRunContext(deps: NodeGitPublishAdapterDeps): RunContext {
  return {
    runDeps: {
      workspace: deps.workspace,
      policy: deps.policy ?? DEFAULT_SANDBOX_POLICY,
      commandRules: GIT_PUBLISH_COMMAND_RULES,
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
      { command: "git", args: argv, cwd: undefined, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
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
      return runPush(ctx, argv);
    },
  };
}
