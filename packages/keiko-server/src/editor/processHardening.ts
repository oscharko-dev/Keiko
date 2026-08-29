import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { buildSandboxEnv, buildWindowsShellInvocation } from "@oscharko-dev/keiko-tools";
import { isWithinWorkspace, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

export class EditorProcessHardeningError extends Error {
  public readonly code = "EXECUTABLE_NOT_FOUND" as const;

  public constructor() {
    super("EXECUTABLE_NOT_FOUND");
    this.name = "EditorProcessHardeningError";
  }
}

export interface WorkspaceExternalExecutable {
  readonly path: string;
  readonly real: string;
}

export interface IsolatedProcessDirectory {
  readonly path: string;
  cleanup(): void;
}

export interface KillableChild {
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): void;
}

export type ChildExitRegistration = (onExit: () => void) => void;

export interface KillScheduler {
  setTimer(callback: () => void, delayMs: number): unknown;
}

export function splitProcessPath(
  pathValue: string | undefined,
  separator: string = delimiter,
): readonly string[] {
  if (pathValue === undefined) return [];
  return pathValue.split(separator).filter((value) => value.length > 0);
}

export function executableExtensions(
  pathExtensions: string | undefined,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32") return [""];
  return (pathExtensions ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((value) => value.length > 0);
}

function probeCandidate(
  directory: string,
  name: string,
  extension: string,
): WorkspaceExternalExecutable | undefined {
  const candidate = resolvePath(resolvePath(directory), name + extension);
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    return undefined;
  }
  return { path: candidate, real: realpathSync(candidate) };
}

function workspaceRoot(root: string): string {
  return existsSync(root) ? realpathSync(root) : root;
}

function isWorkspaceCandidate(
  candidate: WorkspaceExternalExecutable,
  lexicalRoot: string,
  realRoot: string,
): boolean {
  return (
    isWithinWorkspace(lexicalRoot, candidate.path) || isWithinWorkspace(realRoot, candidate.real)
  );
}

function assertBareExecutableName(name: string): void {
  if (name.length === 0 || name.includes("/") || name.includes("\\") || name.includes(" ")) {
    throw new EditorProcessHardeningError();
  }
}

export function resolveExecutableCandidateOutsideWorkspace(
  name: string,
  workspace: WorkspaceInfo,
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): WorkspaceExternalExecutable {
  assertBareExecutableName(name);
  const lexicalRoot = workspace.root;
  const realRoot = workspaceRoot(lexicalRoot);
  for (const directory of splitProcessPath(processEnv.PATH)) {
    for (const extension of executableExtensions(processEnv.PATHEXT, platform)) {
      const candidate = probeCandidate(directory, name, extension);
      if (candidate === undefined) continue;
      if (isWorkspaceCandidate(candidate, lexicalRoot, realRoot)) {
        throw new EditorProcessHardeningError();
      }
      return candidate;
    }
  }
  throw new EditorProcessHardeningError();
}

export function resolveExecutableOutsideWorkspace(
  name: string,
  workspace: WorkspaceInfo,
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveExecutableCandidateOutsideWorkspace(name, workspace, processEnv, platform).real;
}

export function createIsolatedProcessDirectory(prefix: string): IsolatedProcessDirectory {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: (): void => {
      try {
        rmSync(path, { recursive: true });
      } catch {
        // Best-effort cleanup must never weaken process-scope termination.
      }
    },
  };
}

export function buildCopyOnlyProcessEnv(
  processEnv: NodeJS.ProcessEnv,
  envAllowlist: readonly string[],
): Record<string, string> {
  return buildSandboxEnv(processEnv, envAllowlist);
}

export interface WindowsSpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

// Wraps a resolved executable for Windows-safe spawning (issue #3350 / Node CVE-2024-27980): a
// `.cmd`/`.bat` resolved by resolveExecutableOutsideWorkspace cannot be spawned with `shell:false`
// on Windows without raising EINVAL. Delegates to keiko-tools' pure hardened cmd.exe wrapper — the
// SAME implementation exec.ts's runCommand spawn boundary uses — so every editor-tree Node process
// adapter that resolves an executable through this module shares one escaping implementation
// instead of re-deriving it. A no-op on every non-`.cmd`/`.bat` resolved path and on every
// non-Windows platform (pass-through, `windowsVerbatimArguments: false`).
export function resolveWindowsSpawnInvocation(
  executable: string,
  args: readonly string[],
): WindowsSpawnInvocation {
  return buildWindowsShellInvocation(executable, args);
}

function safeKill(child: KillableChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // An already-exited process is equivalent to confirmed signal delivery at this boundary.
  }
}

export const productionKillScheduler: KillScheduler = Object.freeze({
  setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs).unref(),
});

export function escalateKill(
  child: KillableChild,
  gracePeriodMs: number,
  exited: () => boolean,
  scheduler: KillScheduler = productionKillScheduler,
  whenExited?: ChildExitRegistration,
): Promise<void> {
  safeKill(child, "SIGTERM");
  if (exited()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (sendKill: boolean): void => {
      if (settled) return;
      settled = true;
      if (sendKill && !exited()) safeKill(child, "SIGKILL");
      resolve();
    };
    whenExited?.(() => {
      finish(false);
    });
    scheduler.setTimer(() => {
      finish(true);
    }, gracePeriodMs);
  });
}
