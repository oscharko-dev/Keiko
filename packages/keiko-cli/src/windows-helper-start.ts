import { spawn } from "node:child_process";
import {
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemDirectory,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
} from "@oscharko-dev/keiko-security";

/**
 * The one way the launcher starts a helper program on Windows that has to actually run: the browser
 * opener, the setup notice box, the failure alert and the uninstall helper. A helper started
 * detached owns no console, and on the Windows guest such a PowerShell exited 0 without doing
 * anything (#4358: no browser, no box); the same program started attached with a hidden window ran.
 * Callers that must not wait for the helper `unref()` it; the opener awaits its own result.
 */
export interface VisibleWindowsHelperSpawnOptions {
  readonly detached: false;
  readonly windowsHide: true;
  readonly stdio: "ignore";
  readonly shell: false;
  readonly env: NodeJS.ProcessEnv;
}

export interface WindowsHelperChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export type WindowsHelperSpawn = (
  command: string,
  args: readonly string[],
  options: VisibleWindowsHelperSpawnOptions,
) => WindowsHelperChild;

export function visibleWindowsHelperSpawnOptions(
  env: NodeJS.ProcessEnv,
): VisibleWindowsHelperSpawnOptions {
  return { detached: false, windowsHide: true, stdio: "ignore", shell: false, env };
}

export function startVisibleWindowsHelper(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  spawnFn: WindowsHelperSpawn = spawn,
): WindowsHelperChild {
  return spawnFn(command, args, visibleWindowsHelperSpawnOptions(env));
}

export interface WindowsHelperSystem {
  readonly command: string;
  readonly systemRoot: string;
}

/** The trusted System32 PowerShell and system root; a hostile or missing one throws. */
export function resolveWindowsPowerShellHelper(
  env: NodeJS.ProcessEnv,
  identityCheck?: WindowsSystemDirectoryIdentityCheck,
  existsAsFile?: WindowsBinaryExistsCheck,
): WindowsHelperSystem {
  return {
    systemRoot: resolveWindowsSystemDirectory(env, identityCheck),
    command: resolveWindowsPowerShellExecutable(env, existsAsFile, identityCheck),
  };
}

/**
 * The minimal environment a PowerShell/WPF helper needs: the core system variables and the
 * temporary folders the caller itself has, plus the helper's own named inputs. Nothing else of the
 * caller's environment reaches it.
 */
export function windowsHelperEnv(
  env: NodeJS.ProcessEnv,
  system: WindowsHelperSystem,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    SystemRoot: system.systemRoot,
    WINDIR: system.systemRoot,
    ...(env.TEMP === undefined ? {} : { TEMP: env.TEMP }),
    ...(env.TMP === undefined ? {} : { TMP: env.TMP }),
    ...extra,
  };
}
