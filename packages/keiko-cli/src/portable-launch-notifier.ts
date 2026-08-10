import { spawn } from "node:child_process";
import { isAbsolute as isAbsoluteWindowsPath, join as joinWindowsPath } from "node:path/win32";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

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
const DEFAULT_WINDOWS_ROOT = String.raw`C:\Windows`;
const WINDOWS_POWERSHELL_PARTS = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"];

export type PortableFailureNotifierFn = (message: string, env: EnvSource) => void;

export interface PortableFailureNotifierDeps {
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly runAlert?: ((script: string) => void) | undefined;
  readonly runWindowsAlert?: ((message: string, env: EnvSource) => void) | undefined;
  /**
   * Receives one fixed, content-free line when the alert itself cannot be shown. The CLI wires
   * this to stderr: there is no operator diagnostic sink on this pre-server surface, and the
   * primary launch diagnosis is already on stderr — this line only keeps the notifier's own
   * failure from being silent.
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

function windowsSystemRoot(env: EnvSource): string {
  const value = env.SystemRoot ?? env.WINDIR;
  if (value !== undefined && isAbsoluteWindowsPath(value)) return value;
  return DEFAULT_WINDOWS_ROOT;
}

function windowsPowerShellExecutable(env: EnvSource): string {
  return joinWindowsPath(windowsSystemRoot(env), ...WINDOWS_POWERSHELL_PARTS);
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
): void {
  const child = spawnFn(
    windowsPowerShellExecutable(env),
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
      env: {},
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.on("error", () => {
    reportAlertFailure(ALERT_FAILURE_LINE);
  });
  child.unref();
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
      runDetachedWindowsAlert(alertMessage, notifyEnv, undefined, reportAlertFailure);
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
