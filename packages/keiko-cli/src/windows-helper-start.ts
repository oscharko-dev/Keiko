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
  /** The process id, once the program has started. */
  readonly pid?: number | undefined;
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

/**
 * What libuv does on Windows: every child that is not detached joins one job object that kills it
 * when the parent ends, and the job lets only the processes libuv itself starts belong to it (their
 * own children do not). So a helper started like the others ends with the keiko process that started
 * it, and one that must outlive that process is started by a first, short-lived PowerShell: the first
 * stage does nothing but start the real helper as its own process (hidden window) and end, and the
 * real helper, a grandchild, is outside the job (#4358). The text below is the first stage's whole
 * command; everything else reaches the real helper through its environment, so no quoting of the
 * helper's text is ever needed.
 */
export const OUTLIVING_STAGE_ONE_SCRIPT =
  "Start-Process -FilePath $env:KEIKO_STAGE2_EXE -ArgumentList $env:KEIKO_STAGE2_ARGS -WindowStyle Hidden";

// The second stage reads its own text from the environment and runs it in its own session, so an
// `exit` in it ends the process with its exit code.
const STAGE_TWO_COMMAND = ["-Command", "Invoke-Expression", "$env:KEIKO_STAGE2_SCRIPT"] as const;

const STAGE_ONE_FLAGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-WindowStyle",
  "Hidden",
] as const;

export interface OutlivingHelperInput {
  readonly system: WindowsHelperSystem;
  readonly env: NodeJS.ProcessEnv;
  /** The real helper's PowerShell flags before its command, e.g. `-Sta` for a WPF window. */
  readonly stageTwoFlags?: readonly string[] | undefined;
  /** The real helper's whole text; it is handed over in an environment variable, never quoted. */
  readonly script: string;
  /** The real helper's own named inputs, besides the system variables. */
  readonly extraEnv?: Readonly<Record<string, string>> | undefined;
}

/**
 * Starts a helper that must outlive the keiko process that starts it: the attached, hidden first
 * PowerShell (the start proven to run) that starts the real one. The returned child is the first
 * stage; it is expected to end quickly, and its end says nothing about the real helper.
 */
export function startOutlivingWindowsHelper(
  input: OutlivingHelperInput,
  spawnFn: WindowsHelperSpawn = spawn,
): WindowsHelperChild {
  const stageTwoArguments = [
    "-NoLogo",
    "-NoProfile",
    ...(input.stageTwoFlags ?? []),
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    ...STAGE_TWO_COMMAND,
  ];
  return startVisibleWindowsHelper(
    input.system.command,
    [...STAGE_ONE_FLAGS, "-Command", OUTLIVING_STAGE_ONE_SCRIPT],
    windowsHelperEnv(input.env, input.system, {
      ...input.extraEnv,
      KEIKO_STAGE2_EXE: input.system.command,
      KEIKO_STAGE2_ARGS: stageTwoArguments.join(" "),
      KEIKO_STAGE2_SCRIPT: input.script,
    }),
    spawnFn,
  );
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
