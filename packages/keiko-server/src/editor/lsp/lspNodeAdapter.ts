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
// POSIX spawns detached and kills the whole process group; Windows kills the single child.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { isCommandAllowed } from "@oscharko-dev/keiko-tools";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { LspProcessErrorCode } from "@oscharko-dev/keiko-contracts";
import {
  EditorProcessHardeningError,
  buildCopyOnlyProcessEnv as buildSharedCopyOnlyProcessEnv,
  createIsolatedProcessDirectory as createSharedIsolatedProcessDirectory,
  escalateKill as escalateSharedKill,
  resolveExecutableCandidateOutsideWorkspace as resolveSharedExecutableCandidate,
  type ChildExitRegistration as SharedChildExitRegistration,
  type IsolatedProcessDirectory,
  type KillableChild as SharedKillableChild,
  type KillScheduler as SharedKillScheduler,
  type WorkspaceExternalExecutable as SharedWorkspaceExternalExecutable,
} from "../processHardening.js";
import type { LspSpawnHandle } from "./lspTransport.js";

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
export type WorkspaceExternalExecutable = SharedWorkspaceExternalExecutable;

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

export function resolveExecutableCandidateOutsideWorkspace(
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

export function createIsolatedProcessDirectory(prefix: string): EphemeralHome {
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
// included (ADR-0069 D2). Windows has no process groups here, so the single child is killed. A failed
// kill (process already gone) is swallowed; the escalation timer still owns the SIGKILL fallback.
function nodeGroupKill(pid: number, child: KillableChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to a direct child kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have already exited.
  }
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
    stdin: { write: (chunk: Buffer): void => void stdin.write(chunk) },
    stdout,
    stderr,
    pid: child.pid,
    kill: (signal): void => {
      const pid = child.pid;
      if (pid === undefined) {
        safeKill(child, signal);
        return;
      }
      nodeGroupKill(pid, child, signal);
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
export const defaultLspSpawnFn: LspSpawnFn = (executable, args, env, cwd) => {
  if (!isAbsolute(executable)) {
    throw new LspProcessError("EXECUTABLE_NOT_FOUND");
  }
  const home = createEphemeralHome();
  const childEnv = { ...env, HOME: home.path, USERPROFILE: home.path };
  const child = spawn(executable, [...args], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const wrapped = wrapChild(child);
  wrapped.onExit(() => {
    home.cleanup();
  });
  return wrapped;
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

export function buildCopyOnlyProcessEnv(
  processEnv: NodeJS.ProcessEnv,
  envAllowlist: readonly string[],
): Record<string, string> {
  return buildSharedCopyOnlyProcessEnv(processEnv, envAllowlist);
}
