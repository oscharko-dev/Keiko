import { spawn } from "node:child_process";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  emitSecurityLogEvent,
  resolveWindowsSystemDirectory,
  resolveWindowsSystemExecutable,
  securityErrorKind,
  type SecurityLogSink,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
} from "@oscharko-dev/keiko-security";

/**
 * A desktop double-click gives the portable launcher no terminal: every `io.err` line vanishes and
 * a failed first start looks like the app simply did nothing. This surfaced twice in the 0.3.0
 * beta on macOS — a Gatekeeper-blocked bundle and a refused runtime activation both died without
 * a visible word — and again on Windows when the console-backed Node child was hidden. When a
 * setup or launch command fails under a double-click, this notifier shows the recorded reason in a
 * native alert instead.
 *
 * The double-click is detected by `KEIKO_PORTABLE_UI_LAUNCH=1`, which only the native launcher
 * binary sets. A TTY heuristic is deliberately NOT used: it cannot tell a Finder launch from a
 * test runner or CI pipe, and the first version of this notifier proved it by raising real alert
 * dialogs on the desktop while the test suite exercised its failure paths.
 *
 * The alert runs detached and unreferenced: it waits for the human at its own pace, never blocks
 * or outlives-holds the CLI process, and is strictly best-effort — it must never turn a
 * diagnosable failure into a different one.
 */

const MAX_ALERT_MESSAGE_LENGTH = 400;
const OSASCRIPT_EXECUTABLE = "/usr/bin/osascript";
const WINDOWS_POWERSHELL_PARTS = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"];

export type PortableFailureNotifierFn = (message: string, env: EnvSource) => void;

export interface PortableFailureNotifierDeps {
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly runAlert?: ((script: string) => void) | undefined;
  readonly runWindowsAlert?: ((message: string, env: EnvSource) => void) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly windowsBinaryExists?: WindowsBinaryExistsCheck | undefined;
  readonly windowsSystemDirectoryIdentity?: WindowsSystemDirectoryIdentityCheck | undefined;
  /**
   * Receives one fixed, content-free line when the alert itself cannot be shown. The CLI keeps
   * this stderr fallback for the person who launched it; `securityLogSink` separately carries the
   * correlated machine-reconstruction event for resolver and spawn failures.
   */
  readonly reportAlertFailure?: ((line: string) => void) | undefined;
}

const ALERT_FAILURE_LINE = "keiko portable launch: the failure alert could not be shown\n";

/** Kept to displayable text: platform-quoted, control-free, bounded. */
function displayableAlertMessage(message: string): string {
  return Array.from(message)
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .slice(0, MAX_ALERT_MESSAGE_LENGTH);
}

function alertScript(message: string): string {
  const displayable = displayableAlertMessage(message);
  const quoted = displayable.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
  return (
    `display alert "Keiko could not start" message "${quoted}` +
    ` — start Keiko from the downloaded folder, or reinstall from a fresh download." as critical`
  );
}

interface DetachedAlertChild {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

type DetachedAlertSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly detached: boolean;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide?: boolean;
  },
) => DetachedAlertChild;

/** Exported for its direct test; production callers go through notifyPortableLaunchFailure. */
export function runDetachedAlert(
  script: string,
  spawnFn: DetachedAlertSpawn = spawn,
  reportAlertFailure: (line: string) => void = defaultAlertFailureReport,
): void {
  const child = spawnFn(OSASCRIPT_EXECUTABLE, ["-e", script], {
    detached: true,
    env: {},
    shell: false,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort by contract: the launch failure already carries the diagnosis on stderr, and a
    // notifier that cannot spawn (no osascript, denied automation) must not replace it — but its
    // own failure is recorded with a fixed, content-free line rather than swallowed.
    reportAlertFailure(ALERT_FAILURE_LINE);
  });
  child.unref();
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsAlertCommand(message: string): string {
  const text = powershellSingleQuoted(displayableAlertMessage(message));
  return [
    "Add-Type -AssemblyName PresentationFramework",
    `[System.Windows.MessageBox]::Show(${text}, 'Keiko could not start', 'OK', 'Error') | Out-Null`,
  ].join("; ");
}

export function runDetachedWindowsAlert(
  message: string,
  env: EnvSource,
  spawnFn: DetachedAlertSpawn = spawn,
  reportAlertFailure: (line: string) => void = defaultAlertFailureReport,
  identityCheck?: WindowsSystemDirectoryIdentityCheck,
  securityLogSink?: SecurityLogSink,
  existsAsFile?: WindowsBinaryExistsCheck,
): void {
  const system = resolveWindowsAlertSystem(env, identityCheck, existsAsFile, securityLogSink);
  const child = spawnWindowsAlertChild(message, env, system, spawnFn, securityLogSink);
  child.on("error", (error) => {
    logWindowsAlertSpawnFailure(error, securityLogSink);
    reportAlertFailure(ALERT_FAILURE_LINE);
  });
  child.unref();
}

interface WindowsAlertSystem {
  readonly command: string;
  readonly systemRoot: string;
}

function resolveWindowsAlertSystem(
  env: EnvSource,
  identityCheck: WindowsSystemDirectoryIdentityCheck | undefined,
  existsAsFile: WindowsBinaryExistsCheck | undefined,
  securityLogSink: SecurityLogSink | undefined,
): WindowsAlertSystem {
  try {
    return {
      systemRoot: resolveWindowsSystemDirectory(env, identityCheck),
      command: resolveWindowsSystemExecutable(
        WINDOWS_POWERSHELL_PARTS,
        env,
        existsAsFile,
        identityCheck,
      ),
    };
  } catch (error) {
    logWindowsAlertSystemFailure(error, securityLogSink);
    throw error;
  }
}

function spawnWindowsAlertChild(
  message: string,
  env: EnvSource,
  system: WindowsAlertSystem,
  spawnFn: DetachedAlertSpawn,
  securityLogSink: SecurityLogSink | undefined,
): DetachedAlertChild {
  try {
    return spawnFn(
      system.command,
      [
        "-NoLogo",
        "-NoProfile",
        "-Sta",
        "-WindowStyle",
        "Hidden",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsAlertCommand(message),
      ],
      {
        detached: true,
        env: {
          SystemRoot: system.systemRoot,
          WINDIR: system.systemRoot,
          ...(env.TEMP === undefined ? {} : { TEMP: env.TEMP }),
          ...(env.TMP === undefined ? {} : { TMP: env.TMP }),
        },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  } catch (error) {
    logWindowsAlertSpawnFailure(error, securityLogSink);
    throw error;
  }
}

function logWindowsAlertSystemFailure(error: unknown, sink: SecurityLogSink | undefined): void {
  if (error instanceof WindowsSystemDirectoryError) {
    emitSecurityLogEvent(sink, {
      level: "warn",
      category: "security",
      op: "security.windows-portable-alert.system-root-refused",
      errorKind: securityErrorKind(error),
      extra: { surface: "portable-failure-alert" },
    });
  } else if (error instanceof WindowsSystemBinaryMissingError) {
    emitSecurityLogEvent(sink, {
      level: "error",
      category: "diagnostic",
      op: "security.windows-portable-alert.system-binary-missing",
      errorKind: securityErrorKind(error),
      extra: { surface: "portable-failure-alert" },
    });
  }
}

function logWindowsAlertSpawnFailure(error: unknown, sink: SecurityLogSink | undefined): void {
  emitSecurityLogEvent(sink, {
    level: "error",
    category: "diagnostic",
    op: "portable.windows-alert.spawn-failed",
    errorKind: securityErrorKind(error),
    extra: { surface: "portable-failure-alert" },
  });
}

function defaultAlertFailureReport(line: string): void {
  process.stderr.write(line);
}

function launchFailureMessage(message: string): string {
  return message.trim() === "" ? "The portable launch failed without a reason." : message;
}

function notifyMacosLaunchFailure(
  text: string,
  deps: PortableFailureNotifierDeps,
  reportAlertFailure: (line: string) => void,
): void {
  const runAlert =
    deps.runAlert ??
    ((script: string): void => {
      runDetachedAlert(script, undefined, reportAlertFailure);
    });
  runAlert(alertScript(text));
}

function notifyWindowsLaunchFailure(
  text: string,
  env: EnvSource,
  deps: PortableFailureNotifierDeps,
  reportAlertFailure: (line: string) => void,
): void {
  const runWindowsAlert =
    deps.runWindowsAlert ??
    ((alertMessage: string, notifyEnv: EnvSource): void => {
      runDetachedWindowsAlert(
        alertMessage,
        notifyEnv,
        undefined,
        reportAlertFailure,
        deps.windowsSystemDirectoryIdentity,
        deps.securityLogSink,
        deps.windowsBinaryExists,
      );
    });
  runWindowsAlert(text, env);
}

function notifySupportedPlatformLaunchFailure(
  hostPlatform: NodeJS.Platform,
  text: string,
  env: EnvSource,
  deps: PortableFailureNotifierDeps,
  reportAlertFailure: (line: string) => void,
): void {
  if (hostPlatform === "darwin") {
    notifyMacosLaunchFailure(text, deps, reportAlertFailure);
  }
  if (hostPlatform === "win32") {
    notifyWindowsLaunchFailure(text, env, deps, reportAlertFailure);
  }
}

export function notifyPortableLaunchFailure(
  message: string,
  env: EnvSource,
  deps: PortableFailureNotifierDeps = {},
): void {
  if (env.KEIKO_PORTABLE_UI_LAUNCH !== "1") return;
  const platform = deps.platform ?? ((): NodeJS.Platform => process.platform);
  const hostPlatform = platform();
  if (hostPlatform !== "darwin" && hostPlatform !== "win32") return;
  const text = launchFailureMessage(message);
  const reportAlertFailure = deps.reportAlertFailure ?? defaultAlertFailureReport;
  try {
    notifySupportedPlatformLaunchFailure(hostPlatform, text, env, deps, reportAlertFailure);
  } catch {
    // Best-effort by contract — see runDetachedAlert; the fixed line below is the evidence.
    reportAlertFailure(ALERT_FAILURE_LINE);
  }
}
