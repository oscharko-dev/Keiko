import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
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
  /**
   * Never the caller's working directory: a helper that inherits it holds that folder for its whole
   * life, and the caller may be running from inside an installation it is about to remove.
   */
  readonly cwd: string;
}

export interface WindowsHelperChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
  /** Set by the platform once the program has ended; absent while it runs. */
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

export type WindowsHelperSpawn = (
  command: string,
  args: readonly string[],
  options: VisibleWindowsHelperSpawnOptions,
) => WindowsHelperChild;

// The system directory when the environment names one, else the temporary folder: places no
// installation of Keiko lies in.
function helperWorkingDirectory(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot;
  return systemRoot !== undefined && win32.isAbsolute(systemRoot) ? systemRoot : tmpdir();
}

export function visibleWindowsHelperSpawnOptions(
  env: NodeJS.ProcessEnv,
): VisibleWindowsHelperSpawnOptions {
  return {
    detached: false,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
    env,
    cwd: helperWorkingDirectory(env),
  };
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
