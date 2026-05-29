// Command execution — the spawn boundary. Deny-by-default allowlist is checked BEFORE any
// spawn; the child runs with a clean name-allowlisted env, no shell, and a resolved-in-workspace
// cwd. Timeout and abort both kill the process group (SIGTERM→SIGKILL after the grace period).
// stdout/stderr are byte-capped and redacted before they leave this layer (ADR-0006 D3/D5).
//
// node:child_process is imported ONLY for the default SpawnFn adapter; all decision logic lives
// in sandbox.ts (pure). Tests inject a fake SpawnFn for the allowlist/timeout/cancel paths and a
// real `node`-spawn for the env-isolation / no-shell / real-cancellation integration cases.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../gateway/redaction.js";
import { resolveWithinWorkspace } from "../workspace/paths.js";
import { assertContainedRealPath } from "../workspace/realpath.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "../workspace/fs.js";
import type { WorkspaceInfo } from "../workspace/types.js";
import { CommandCancelledError, CommandDeniedError, CommandTimeoutError } from "./errors.js";
import { buildSandboxEnv, collectSensitiveEnvValues, isCommandAllowed } from "./sandbox.js";
import type { CommandResult, CommandRule, SandboxPolicy } from "./types.js";

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly detached: boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export const nodeSpawnFn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], options);

// Supplies the child's HOME/USERPROFILE as an EPHEMERAL, EMPTY per-run directory instead of the
// developer's real home (C5). `make` returns a fresh empty dir; `cleanup` removes it after the
// command settles (best-effort). Injectable so tests can use a recording/fake provider.
export interface HomeProvider {
  readonly make: () => string;
  readonly cleanup: (dir: string) => void;
}

export const nodeHomeProvider: HomeProvider = {
  make: (): string => mkdtempSync(join(tmpdir(), "keiko-home-")),
  cleanup: (dir): void => {
    // Best-effort: a leftover temp dir is not worth failing or rejecting the command over.
    rmSync(dir, { recursive: true, force: true });
  },
};

export interface RunCommandDeps {
  readonly workspace: WorkspaceInfo;
  readonly policy: SandboxPolicy;
  readonly commandRules: readonly CommandRule[];
  readonly spawn: SpawnFn;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now: () => number;
  // Read-only port used solely for the cwd symlink-containment check. Defaults to nodeWorkspaceFs.
  readonly fs?: WorkspaceFs | undefined;
  // Supplies the ephemeral empty HOME/USERPROFILE for the child (C5). Defaults to nodeHomeProvider.
  readonly home?: HomeProvider | undefined;
}

export interface RunCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly signal: AbortSignal;
}

const POSIX = process.platform !== "win32";

// Kills the whole process group on POSIX (negative pid) so orphaned grandchildren die too;
// on Windows, best-effort child.kill() (a tree-kill needs a dependency we cannot add).
function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (POSIX) {
      process.kill(-pid, sig);
    } else {
      child.kill(sig);
    }
  } catch {
    // The child already exited; nothing to signal. Swallowing here keeps termination idempotent.
  }
}

interface Buffers {
  out: Buffer[];
  err: Buffer[];
  total: number;
  truncated: boolean;
}

function appendCapped(buffers: Buffers, sink: Buffer[], chunk: Buffer, max: number): boolean {
  if (buffers.truncated) {
    return false;
  }
  const remaining = max - buffers.total;
  if (chunk.length <= remaining) {
    sink.push(chunk);
    buffers.total += chunk.length;
    return false;
  }
  if (remaining > 0) {
    sink.push(chunk.subarray(0, remaining));
    buffers.total = max;
  }
  buffers.truncated = true;
  return true; // signals the caller to kill the child (flood protection)
}

interface RunState {
  settled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout | undefined;
  graceTimer: NodeJS.Timeout | undefined;
  onAbort: (() => void) | undefined;
  // The ephemeral HOME dir to remove once after the command settles, and the provider that owns
  // its removal. `homeCleaned` makes the cleanup idempotent (close AND error both call cleanup()).
  home: HomeProvider | undefined;
  homeDir: string | undefined;
  homeCleaned: boolean;
}

// Resolves the validated cwd. Lexical containment first, then symlink containment via realpath
// (S-H1): a cwd that is a symlink escaping the root must not become the spawn cwd. Both escapes
// surface as PathEscapeError, which the host maps to a tool error — the command never spawns.
function resolveCwd(deps: RunCommandDeps, cwd: string | undefined): string {
  const lexical = resolveWithinWorkspace(deps.workspace.root, cwd ?? ".");
  const fs = deps.fs ?? nodeWorkspaceFs;
  return assertContainedRealPath(fs, deps.workspace.root, lexical, cwd ?? ".");
}

function buildResult(
  input: RunCommandInput,
  buffers: Buffers,
  state: RunState,
  exitCode: number | null,
  termSignal: NodeJS.Signals | null,
  deps: RunCommandDeps,
  startedAt: number,
): CommandResult {
  const secrets = collectSensitiveEnvValues(deps.processEnv, deps.policy.envAllowlist);
  return {
    command: input.command,
    args: input.args,
    exitCode,
    signal: termSignal,
    stdout: redact(Buffer.concat(buffers.out).toString("utf8"), secrets),
    stderr: redact(Buffer.concat(buffers.err).toString("utf8"), secrets),
    durationMs: deps.now() - startedAt,
    timedOut: state.timedOut,
    truncated: buffers.truncated,
  };
}

function cleanup(state: RunState, signal: AbortSignal): void {
  if (state.timer !== undefined) {
    clearTimeout(state.timer);
  }
  if (state.graceTimer !== undefined) {
    clearTimeout(state.graceTimer);
  }
  if (state.onAbort !== undefined) {
    signal.removeEventListener("abort", state.onAbort);
  }
  // Remove the ephemeral HOME exactly once, on whichever settle path fires first (C5).
  if (!state.homeCleaned && state.home !== undefined && state.homeDir !== undefined) {
    state.homeCleaned = true;
    state.home.cleanup(state.homeDir);
  }
}

// Escalates from SIGTERM to SIGKILL after the grace period so a child ignoring SIGTERM is still
// guaranteed to terminate within terminationGraceMs of the trigger.
function terminate(child: ChildProcess, policy: SandboxPolicy, state: RunState): void {
  killGroup(child, "SIGTERM");
  state.graceTimer = setTimeout(() => {
    killGroup(child, "SIGKILL");
  }, policy.terminationGraceMs);
  state.graceTimer.unref();
}

function wireStreams(
  child: ChildProcess,
  buffers: Buffers,
  policy: SandboxPolicy,
  state: RunState,
): void {
  const onData =
    (sink: Buffer[]) =>
    (chunk: Buffer): void => {
      if (appendCapped(buffers, sink, chunk, policy.maxOutputBytes)) {
        terminate(child, policy, state); // output flood → kill
      }
    };
  child.stdout?.on("data", onData(buffers.out));
  child.stderr?.on("data", onData(buffers.err));
}

interface ExecContext {
  readonly child: ChildProcess;
  readonly input: RunCommandInput;
  readonly deps: RunCommandDeps;
  readonly buffers: Buffers;
  readonly state: RunState;
  readonly startedAt: number;
}

function settleOnClose(
  ctx: ExecContext,
  resolve: (r: CommandResult) => void,
  reject: (e: unknown) => void,
): void {
  ctx.child.on("close", (code, signalName) => {
    if (ctx.state.settled) {
      return;
    }
    ctx.state.settled = true;
    cleanup(ctx.state, ctx.input.signal);
    if (ctx.state.timedOut) {
      reject(new CommandTimeoutError("command timed out", timeoutOf(ctx)));
      return;
    }
    if (ctx.input.signal.aborted) {
      reject(new CommandCancelledError("command cancelled"));
      return;
    }
    resolve(
      buildResult(ctx.input, ctx.buffers, ctx.state, code, signalName, ctx.deps, ctx.startedAt),
    );
  });
  ctx.child.on("error", (error) => {
    if (ctx.state.settled) {
      return;
    }
    ctx.state.settled = true;
    cleanup(ctx.state, ctx.input.signal);
    reject(error);
  });
}

function timeoutOf(ctx: ExecContext): number {
  return ctx.input.timeoutMs ?? ctx.deps.policy.defaultTimeoutMs;
}

function armTimersAndAbort(ctx: ExecContext): void {
  const ms = timeoutOf(ctx);
  ctx.state.timer = setTimeout(() => {
    ctx.state.timedOut = true;
    terminate(ctx.child, ctx.deps.policy, ctx.state);
  }, ms);
  ctx.state.timer.unref();
  const onAbort = (): void => {
    terminate(ctx.child, ctx.deps.policy, ctx.state);
  };
  ctx.state.onAbort = onAbort;
  if (ctx.input.signal.aborted) {
    onAbort();
  } else {
    ctx.input.signal.addEventListener("abort", onAbort, { once: true });
  }
}

// Runs an allowlisted command. Rejects with CommandDeniedError (before spawn) for a denied
// command or a workspace-escaping cwd (PathEscapeError), CommandTimeoutError on timeout, and
// CommandCancelledError on abort; otherwise resolves a redacted, byte-capped CommandResult. All
// failure paths are Promise rejections — the function never throws synchronously.
export function runCommand(input: RunCommandInput, deps: RunCommandDeps): Promise<CommandResult> {
  // Defensive: an empty/non-array envAllowlist would make buildSandboxEnv produce an empty child
  // env (no PATH → spawn ENOENT, or worse a misconfiguration). Reject cleanly so the "never throws
  // synchronously" contract holds even under a malformed config (S-M2).
  if (!Array.isArray(deps.policy.envAllowlist) || deps.policy.envAllowlist.length === 0) {
    return Promise.reject(
      new CommandDeniedError("sandbox envAllowlist must be a non-empty array", input.command),
    );
  }
  const decision = isCommandAllowed(deps.commandRules, input.command, input.args);
  if (!decision.allowed) {
    return Promise.reject(
      new CommandDeniedError(decision.reason ?? "command denied", input.command),
    );
  }
  // Resolve cwd inside the workspace BEFORE spawning; a PathEscapeError here means no spawn.
  let cwd: string;
  try {
    cwd = resolveCwd(deps, input.cwd);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("cwd resolution failed"));
  }
  const env = buildSandboxEnv(deps.processEnv, deps.policy.envAllowlist);
  // C5: the child gets an ephemeral, EMPTY HOME/USERPROFILE — never the developer's real home — so
  // ~/.npmrc, ~/.git-credentials, ~/.aws/… are out of reach. Created only after the deny/cwd gates
  // pass (a denied command allocates nothing); removed once after settle via cleanup().
  const home = deps.home ?? nodeHomeProvider;
  const homeDir = home.make();
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  const state: RunState = {
    settled: false,
    timedOut: false,
    timer: undefined,
    graceTimer: undefined,
    onAbort: undefined,
    home,
    homeDir,
    homeCleaned: false,
  };
  let child: ChildProcess;
  try {
    child = deps.spawn(input.command, input.args, { cwd, env, shell: false, detached: POSIX });
  } catch (error) {
    // A synchronous spawn failure must still clean the ephemeral home and reject (never throw):
    // the "never throws synchronously" contract holds and no temp dir leaks.
    cleanup(state, input.signal);
    return Promise.reject(error instanceof Error ? error : new Error("spawn failed"));
  }
  const buffers: Buffers = { out: [], err: [], total: 0, truncated: false };
  const ctx: ExecContext = { child, input, deps, buffers, state, startedAt: deps.now() };
  return new Promise<CommandResult>((resolve, reject) => {
    wireStreams(child, buffers, deps.policy, state);
    settleOnClose(ctx, resolve, reject);
    armTimersAndAbort(ctx);
  });
}
