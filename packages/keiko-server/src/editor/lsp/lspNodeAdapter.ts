// Node spawn adapter for the governed LSP process manager (Issue #1381, Epic #1491, ADR-0069 D2).
// This is the only module in the lsp/ subdir that touches `node:child_process` and the filesystem;
// the manager consumes the injected `LspSpawnFn` port so every lifecycle branch is testable against
// the in-memory fake without a real subprocess.
//
// SECURITY BOUNDARY (FIX 8): the deny-by-default preflight (`isCommandAllowed`, I5), the workspace-root
// containment check (I2), and the copy-only env allowlist (`buildSandboxEnv`) are the MANAGER's
// responsibility — it calls `preflightSpawnEnv` and `resolveExecutableOutsideWorkspace` BEFORE ever
// invoking the injected `LspSpawnFn`. `defaultLspSpawnFn` therefore assumes it is handed an
// already-resolved, ABSOLUTE, allowlisted executable path plus the already-built sandbox env; it adds
// only an ephemeral empty HOME (so the server cannot read or write the operator's real home) and the
// process-group spawn/kill wiring. As defense-in-depth it asserts the executable is an absolute path,
// so a future DIRECT caller that bypassed the manager's resolution cannot spawn a relative/bare name.
// POSIX spawns detached and kills the whole process group; Windows bounds the process TREE with the
// shared taskkill primitive, because a wrapped `.cmd` server runs as a grandchild of cmd.exe (#3350).

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import {
  isCommandAllowed,
  nodeWindowsTreeKill,
  type WindowsTreeKillDisposition,
} from "@oscharko-dev/keiko-tools";
import type { CommandRule, WindowsShellInvocationOptions } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspProcessErrorCode } from "@oscharko-dev/keiko-contracts";
import {
  EditorProcessHardeningError,
  buildCopyOnlyProcessEnv as buildSharedCopyOnlyProcessEnv,
  createIsolatedProcessDirectory as createSharedIsolatedProcessDirectory,
  escalateKill as escalateSharedKill,
  resolveExecutableCandidateOutsideWorkspace as resolveSharedExecutableCandidate,
  resolveWindowsSpawnInvocation,
  type ChildExitRegistration as SharedChildExitRegistration,
  type IsolatedProcessDirectory,
  type KillableChild as SharedKillableChild,
  type KillScheduler as SharedKillScheduler,
  type WorkspaceExternalExecutable as SharedWorkspaceExternalExecutable,
} from "../processHardening.js";
import { UNKNOWN_CORRELATION_ID } from "../../correlation.js";
import { processServerLogSink } from "../../process-log-sink.js";
import { errorKindOf } from "../../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../../observability/stack-frames.js";
import type { LspSpawnHandle } from "./lspTransport.js";

// AGENTS.md §8 Rule 1 (PR reviewer finding): this adapter's two platform-dependent decision
// branches — whether the win32 hardened cmd.exe wrapper engaged at spawn (issue #3350) and
// whether the win32 taskkill.exe tree-kill engaged on termination (same defect/fix as runCommand's
// killGroup, exec.ts) — shipped with no activity-log evidence, so a support bundle could not
// reconstruct which path a hung or failed `.cmd` language server actually took. This module has no
// injected log port of its own (it is a low-level node:child_process adapter the manager depends
// on structurally, per the file header), so — exactly like keiko-tools' own logging-agnostic
// posture — it reaches directly for the SAME process-wide activity-log sink every other server
// composition site uses (processServerLogSink()) rather than growing a second logging mechanism or
// widening `LspSpawnFn`'s public signature. No request-scoped correlation id is available this
// deep in the spawn boundary, so every line carries UNKNOWN_CORRELATION_ID.
// `childPid`, never `pid`: `pid` is a reserved envelope field in the activity-log redaction
// (log-redaction.ts RESERVED_FIELD_NAMES), so an `extra.pid` is silently dropped and the line
// would carry only the SERVER's own process id — the identity loss that makes a support bundle
// unable to join this line to the child tree. Fired on the child's real 'spawn' event, not on
// spawn() returning: dispatch is not success, ENOENT arrives asynchronously via 'error'.
function logLspSpawnCompleted(windowsWrapperEngaged: boolean, childPid: number | undefined): void {
  processServerLogSink().write({
    category: "diagnostic",
    op: "lsp.spawn.completed",
    correlationId: UNKNOWN_CORRELATION_ID,
    extra: {
      windowsWrapperEngaged,
      platform: process.platform,
      ...(childPid !== undefined ? { childPid } : {}),
    },
  });
}

// F2 (PR reviewer finding): the two async/sync spawn-failure call sites below each already catch a
// real Error (ENOENT, EACCES, a resource-limit failure, a hardening rejection, ...) and used to
// discard it, collapsing every distinct cause onto the same generic `code` — a support bundle could
// not tell an unresolvable executable apart from a permission or resource-limit failure. `error` is
// routed through the SAME structured diagnostic machinery every other server call site already uses
// (AGENTS.md §8 Rule 1), never a bespoke shape: `errorKindOf` (the closed-vocabulary classifier —
// reads only a coded `.code`/class name, never `.message`) for `errorKind`, and `keikoStackFrames` /
// `causeChain` (the dist-anchored Keiko-code stack reducer) for `extra.frames` / `extra.causeChain`.
// Both degrade safely to an empty array when the real cause never passes through our own code (a
// raw Node internal spawn failure, e.g. the async ENOENT case, has no Keiko-code frame to report),
// so `frames`/`causeChain` are only ever added when there is real evidence to add (`nonEmpty`
// mirrors diagnostics-log.ts's own `describeError` helper). `code` remains the fallback `errorKind`
// for the ONE call site (the non-absolute-executable guard) that has no underlying Error at all.
//
// BODY-FREE (non-negotiable): none of `errorKindOf`/`keikoStackFrames`/`causeChain` ever reads
// `.message`, `.path`, `.syscall`, `.cmd` or `.spawnargs` — Node's own ENOENT/EINVAL errors put the
// resolved executable PATH on several of exactly those fields, so reading any of them here would
// leak it straight into the activity log. Redaction survival for this exact shape is pinned by
// `lspNodeAdapter.test.ts`'s "AGENTS.md §8 Rule 1" describe block, run through the REAL redactor.
function logLspSpawnFailed(code: LspProcessErrorCode, error?: unknown): void {
  const frames = keikoStackFrames(error);
  const chain = causeChain(error);
  processServerLogSink().write({
    level: "error",
    category: "diagnostic",
    op: "lsp.spawn.failed",
    correlationId: UNKNOWN_CORRELATION_ID,
    errorKind: error === undefined ? code : errorKindOf(error),
    extra: {
      platform: process.platform,
      ...(frames.length > 0 ? { frames } : {}),
      ...(chain.length > 0 ? { causeChain: chain } : {}),
    },
  });
}

// Fires on every kill() call, including the SIGTERM-then-SIGKILL escalation `escalateKill` drives —
// each line is an honest report of one real invocation, carrying the SIGNAL and the VERIFIED
// Windows tree-kill disposition (taskkill's own completed exit status, never
// dispatched-therefore-succeeded). The REASON for the termination lives one layer up: the process
// manager's lifecycle transitions (SHUTDOWN, CRASHED + errorCode, RESTART_THROTTLED, …) reach the
// lifecycle ledger with the same `childPid`, which is the join key between the two records. A
// per-request correlation id does not exist for a long-lived language server, so the line carries
// UNKNOWN_CORRELATION_ID by design.
function logLspProcessTerminated(
  childPid: number,
  signal: NodeJS.Signals,
  windowsTreeKill: WindowsTreeKillDisposition,
): void {
  processServerLogSink().write({
    category: "diagnostic",
    op: "lsp.process.terminated",
    correlationId: UNKNOWN_CORRELATION_ID,
    extra: { childPid, signal, windowsTreeKill },
  });
}

// Typed failure carrying only a content-free `LspProcessErrorCode` — never a path, server output, or
// stack-derived message beyond the code itself (ADR-0069 D6).
export class LspProcessError extends Error {
  public readonly code: LspProcessErrorCode;

  public constructor(code: LspProcessErrorCode) {
    super(code);
    this.name = "LspProcessError";
    this.code = code;
  }
}

// The spawn port the manager depends on. The default adapter wraps `child_process.spawn`; tests
// inject the in-memory fake. The returned handle adds lifecycle hooks to the structural stdio handle.
export type LspSpawnFn = (
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
) => LspSpawnHandle & {
  kill(signal: NodeJS.Signals): void;
  onExit(callback: (code: number | null) => void): void;
  onError(callback: (error: Error) => void): void;
};

export type EphemeralHome = IsolatedProcessDirectory;

export interface ApprovedExecutablePath {
  readonly path: string;
  cleanup(): void;
}

// Minimal child surface `escalateKill` needs. Both a real `ChildProcess` and the in-memory fake
// satisfy it, so the escalation sequence is unit-testable with an injected kill tracker.
export type KillableChild = SharedKillableChild;
type WorkspaceExternalExecutable = SharedWorkspaceExternalExecutable;

// Resolves a bare executable name on the operator's PATH to an absolute real path that lies OUTSIDE
// the workspace root (ADR-0069 I2/I5). Throws `EXECUTABLE_NOT_FOUND` when the name has a separator,
// is absent from PATH, or resolves inside the workspace.
export function resolveExecutableOutsideWorkspace(
  name: string,
  workspace: WorkspaceInfo,
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveExecutableCandidateOutsideWorkspace(name, workspace, processEnv, platform).real;
}

function resolveExecutableCandidateOutsideWorkspace(
  name: string,
  workspace: WorkspaceInfo,
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): WorkspaceExternalExecutable {
  try {
    return resolveSharedExecutableCandidate(name, workspace, processEnv, platform);
  } catch (error: unknown) {
    if (error instanceof EditorProcessHardeningError) {
      throw new LspProcessError("EXECUTABLE_NOT_FOUND");
    }
    throw error;
  }
}

// Creates an empty per-process HOME directory. The server child receives this as HOME/USERPROFILE so
// it cannot read or write the operator's real home; `cleanup` removes it best-effort on dispose.
export function createEphemeralHome(): EphemeralHome {
  return createIsolatedProcessDirectory("keiko-lsp-home-");
}

function createIsolatedProcessDirectory(prefix: string): EphemeralHome {
  return createSharedIsolatedProcessDirectory(prefix);
}

function privateExecutableName(name: string, resolved: string): string {
  return process.platform === "win32" ? `${name}${extname(resolved)}` : name;
}

// Builds a private PATH containing only reviewed, workspace-external executable links. This closes
// the descendant-tool gap left by resolving only the top-level language server: a managed server
// can launch an approved helper by name, but cannot discover a planted workspace binary or an
// unrelated executable that happens to share the operator tool directory.
export function createApprovedExecutablePath(
  names: readonly string[],
  rules: readonly CommandRule[],
  workspace: WorkspaceInfo,
  processEnv: NodeJS.ProcessEnv,
): ApprovedExecutablePath {
  const path = mkdtempSync(join(tmpdir(), "keiko-lsp-tools-"));
  const cleanup = (): void => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; process containment does not depend on retaining the directory.
    }
  };
  try {
    for (const name of names) {
      if (!isCommandAllowed(rules, name, []).allowed) {
        throw new LspProcessError("EXECUTABLE_NOT_FOUND");
      }
      const resolved = resolveExecutableOutsideWorkspace(name, workspace, processEnv);
      symlinkSync(resolved, join(path, privateExecutableName(name, resolved)), "file");
    }
    return { path, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// POSIX group kill: signals the whole process group (`-pid`) so the LSP server's grandchildren are
// included (ADR-0069 D2). Windows has no process groups here, so the tree is bounded with the shared
// taskkill primitive instead: since issue #3350 routed a resolved `.cmd` language server through the
// hardened cmd.exe wrapper, the immediate child is cmd.exe and the SERVER (node.exe running
// typescript-language-server) is a grandchild that `child.kill()` cannot reach — it would survive
// dispose, holding its stdio handles and the workspace files it indexed. The same defect and the same
// fix as runCommand's killGroup (keiko-tools exec.ts); the primitive is imported rather than
// re-derived so both spawn boundaries terminate identically. A failed kill (process already gone) is
// swallowed; the escalation timer still owns the SIGKILL fallback.
function nodeGroupKill(
  pid: number,
  child: KillableChild,
  signal: NodeJS.Signals,
): WindowsTreeKillDisposition {
  let disposition: WindowsTreeKillDisposition = "not-attempted";
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return disposition;
    } catch {
      // Group may already be gone; fall through to a direct child kill.
    }
  } else {
    // Synchronous and verified (see nodeWindowsTreeKill in keiko-tools): taskkill has COMPLETED
    // against the live tree before the immediate child is signalled below.
    disposition = nodeWindowsTreeKill(pid, process.env);
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have already exited.
  }
  return disposition;
}

function safeKill(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The child may have already exited; the escalation timer owns the SIGKILL fallback.
  }
}

// Registers a one-shot callback fired when the child exits, so `escalateKill` can resolve before the
// grace timer elapses. The manager wires this from the child's exit event (a prompt exit during
// dispose then short-circuits the wait, FIX 2); callers without an exit event omit it.
export type ChildExitRegistration = SharedChildExitRegistration;

// Escalates termination: SIGTERM, then SIGKILL after `gracePeriodMs` measured on the injected clock.
// Resolves immediately if the child has already exited, or as soon as it exits during the grace
// window (via the optional `whenExited` registration), or when the window elapses and SIGKILL is sent.
// Resolving early on a mid-window exit is what lets a prompt shutdown avoid waiting the full grace
// (ADR-0069 D4 / FIX 2). The child's own `kill` carries the POSIX-group-vs-Windows distinction (see
// `defaultLspSpawnFn`), so this stays platform-agnostic and test-safe.
export function escalateKill(
  child: KillableChild,
  gracePeriodMs: number,
  exited: () => boolean,
  scheduler?: KillScheduler,
  whenExited?: ChildExitRegistration,
): Promise<void> {
  return escalateSharedKill(child, gracePeriodMs, exited, scheduler, whenExited);
}

export type KillScheduler = SharedKillScheduler;

function wrapChild(child: ChildProcess): ReturnType<LspSpawnFn> {
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdin === null || stdout === null || stderr === null) {
    throw new LspProcessError("SPAWN_FAILED");
  }
  // A crashing or already-disposed language server may close stdin while the JSON-RPC client is
  // settling an in-flight request. The manager observes the child exit separately; the write-side
  // broken pipe must not escape as an unhandled process error.
  stdin.on("error", () => undefined);
  return {
    stdin: {
      write: (chunk: Buffer): void => {
        stdin.write(chunk);
      },
    },
    stdout,
    stderr,
    pid: child.pid,
    kill: (signal): void => {
      const pid = child.pid;
      if (pid === undefined) {
        safeKill(child, signal);
        return;
      }
      // The SAME guard `killGroup` carries in keiko-tools' exec.ts, and this twin was missing it
      // even though the comment on nodeGroupKill above already claims "the same defect and the same
      // fix". Node releases the child handle at 'exit', so once the child has left the process table
      // the OS may REUSE its pid — and on win32 nodeGroupKill's first act is
      // `taskkill /PID <pid> /T /F`, which would then tear down an unrelated process tree on the
      // customer's machine. Every crash-then-dispose sequence reaches this path.
      //
      // `!= null` (not `!== null`) so a test double lacking these fields still reads as running,
      // matching exec.ts's childExited().
      if (child.exitCode != null || child.signalCode != null) {
        logLspProcessTerminated(pid, signal, "not-attempted");
        return;
      }
      logLspProcessTerminated(pid, signal, nodeGroupKill(pid, child, signal));
    },
    onExit: (callback): void => {
      child.on("exit", (code) => {
        callback(code);
      });
    },
    onError: (callback): void => {
      child.on("error", callback);
    },
  };
}

// Default spawn adapter (ADR-0069 D2). The manager has already run the deny-by-default preflight (I5),
// resolved the executable to an absolute workspace-external path (I2), and built the copy-only env;
// this adapter substitutes an ephemeral HOME/USERPROFILE and spawns detached on POSIX so the manager
// can group-kill grandchildren. As defense-in-depth (FIX 8) it rejects a non-absolute executable, so a
// future caller that bypassed `resolveExecutableOutsideWorkspace` cannot spawn a bare/relative name.
export interface LspSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
}

// Builds EXACTLY what defaultLspSpawnFn hands to `spawn`, as a pure function so the Windows branch is
// reachable from a test on any host (issue #3350). Without this seam the `.cmd` wrapping below is
// unpinned: `resolveWindowsSpawnInvocation` and the `windowsVerbatimArguments` spread could both be
// deleted and every LSP test would stay green, because they all inject `deps.spawn` and bypass this
// adapter entirely — silently reintroducing EINVAL for npm-installed `.cmd` language servers
// (typescript-language-server, pyright, bash-language-server).
export function buildLspSpawnPlan(
  executable: string,
  args: readonly string[],
  childEnv: NodeJS.ProcessEnv,
  cwd: string,
  opts?: WindowsShellInvocationOptions,
): LspSpawnPlan {
  const platform = opts?.platform ?? process.platform;
  // A resolved `.cmd`/`.bat` language server (routine on Windows for npm-installed servers) cannot be
  // spawned with shell:false without EINVAL; the hardened cmd.exe wrapper is a no-op for every other
  // resolved path and on every other platform.
  const invocation = resolveWindowsSpawnInvocation(executable, args, opts);
  return {
    command: invocation.command,
    args: [...invocation.args],
    options: {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX spawns detached so the manager can group-kill grandchildren (ADR-0069 D2); Windows has
      // no process groups here.
      detached: platform !== "win32",
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    },
  };
}

export const defaultLspSpawnFn: LspSpawnFn = (executable, args, env, cwd) => {
  if (!isAbsolute(executable)) {
    logLspSpawnFailed("EXECUTABLE_NOT_FOUND");
    throw new LspProcessError("EXECUTABLE_NOT_FOUND");
  }
  const home = createEphemeralHome();
  // Removes the ephemeral HOME exactly once, on whichever failure/exit path fires first. Every
  // path after createEphemeralHome() must run it: a SYNCHRONOUS throw (buildLspSpawnPlan rejecting
  // a control character or an untrusted SystemRoot, spawn itself, wrapChild's null-stdio check),
  // an ASYNCHRONOUS spawn failure ('error' with no 'exit' following — ENOENT's normal shape), and
  // the ordinary exit. Before this guard, the sync throws leaked one keiko-lsp-home-* directory
  // per spawn attempt and emitted no lsp.spawn.failed line.
  let homeCleaned = false;
  const cleanupHomeOnce = (): void => {
    if (!homeCleaned) {
      homeCleaned = true;
      home.cleanup();
    }
  };
  const childEnv = { ...env, HOME: home.path, USERPROFILE: home.path };
  try {
    const plan = buildLspSpawnPlan(executable, args, childEnv, cwd);
    const child = spawn(plan.command, [...plan.args], plan.options);
    const wrapped = wrapChild(child);
    // Spawn SUCCESS is the child's real 'spawn' event, not spawn() returning: dispatch always
    // returns, while ENOENT and friends arrive asynchronously via 'error'. One-shot handlers keep
    // the success/failure lines mutually consistent and the HOME cleanup exact.
    child.once("spawn", () => {
      logLspSpawnCompleted(plan.options.windowsVerbatimArguments === true, child.pid);
    });
    child.once("error", (spawnError) => {
      cleanupHomeOnce();
      logLspSpawnFailed("SPAWN_FAILED", spawnError);
    });
    wrapped.onExit(() => {
      cleanupHomeOnce();
    });
    return wrapped;
  } catch (error) {
    cleanupHomeOnce();
    logLspSpawnFailed("SPAWN_FAILED", error);
    throw error;
  }
};

// Convenience preflight used by the manager before it calls the injected spawn fn: proves the command
// is allowlisted (I5) and builds the copy-only child env (no parent secrets leak). Returns the env on
// success; throws `EXECUTABLE_NOT_FOUND` on a denied command.
export function preflightSpawnEnv(
  rules: readonly CommandRule[],
  executable: string,
  args: readonly string[],
  processEnv: NodeJS.ProcessEnv,
  envAllowlist: readonly string[],
): Record<string, string> {
  const decision = isCommandAllowed(rules, executable, args);
  if (!decision.allowed) {
    throw new LspProcessError("EXECUTABLE_NOT_FOUND");
  }
  return buildSharedCopyOnlyProcessEnv(processEnv, envAllowlist);
}
