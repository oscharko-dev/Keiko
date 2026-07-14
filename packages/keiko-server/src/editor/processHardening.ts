import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { buildSandboxEnv } from "@oscharko-dev/keiko-tools";
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
  if (!existsSync(candidate)) return undefined;
  if ((statSync(candidate).mode & 0o111) === 0) return undefined;
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
