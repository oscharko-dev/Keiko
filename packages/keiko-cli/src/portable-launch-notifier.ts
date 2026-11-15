import { spawn } from "node:child_process";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

/**
 * A desktop double-click gives the portable launcher no terminal: every `io.err` line vanishes and
 * a failed first start looks like the app simply did nothing. This surfaced twice in the 0.3.0
 * beta on macOS — a Gatekeeper-blocked bundle and a refused runtime activation both died without
 * a visible word. When a setup or launch command fails under a double-click on macOS, this
 * notifier shows the recorded reason in a native alert instead.
 *
 * Windows has no notifier process (#4358): the native launcher outlives its `portable launch`
 * child and shows the failure box itself, from the closed reason the CLI leaves in a note
 * (launch-failure-note.ts). A PowerShell started for it from here ended with the CLI process on a
 * slow machine, before it could show anything.
 *
 * The double-click is detected by `KEIKO_PORTABLE_UI_LAUNCH=1`, which only the native launcher
 * binary sets. A TTY heuristic is deliberately NOT used: it cannot tell a Finder launch from a
 * test runner or CI pipe, and the first version of this notifier proved it by raising real alert
 * dialogs on the desktop while the test suite exercised its failure paths.
 *
 * The alert runs detached and unreferenced: it waits for the human at its own pace and never blocks
 * the CLI process, and is strictly best-effort — it must never turn a diagnosable failure into a
 * different one.
 */

const MAX_ALERT_MESSAGE_LENGTH = 400;
const OSASCRIPT_EXECUTABLE = "/usr/bin/osascript";

export type PortableFailureNotifierFn = (message: string, env: EnvSource) => void;

export interface PortableFailureNotifierDeps {
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly runAlert?: ((script: string) => void) | undefined;
  /**
   * Receives one fixed, content-free line when the alert itself cannot be shown. The CLI keeps
   * this stderr fallback for the person who launched it.
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

function defaultAlertFailureReport(line: string): void {
  process.stderr.write(line);
}

function launchFailureMessage(message: string): string {
  return message.trim() === "" ? "The portable launch failed without a reason." : message;
}

export function notifyPortableLaunchFailure(
  message: string,
  env: EnvSource,
  deps: PortableFailureNotifierDeps = {},
): void {
  if (env.KEIKO_PORTABLE_UI_LAUNCH !== "1") return;
  const platform = deps.platform ?? ((): NodeJS.Platform => process.platform);
  if (platform() !== "darwin") return;
  const reportAlertFailure = deps.reportAlertFailure ?? defaultAlertFailureReport;
  const runAlert =
    deps.runAlert ??
    ((script: string): void => {
      runDetachedAlert(script, undefined, reportAlertFailure);
    });
  try {
    runAlert(alertScript(launchFailureMessage(message)));
  } catch {
    // Best-effort by contract — see runDetachedAlert; the fixed line below is the evidence.
    reportAlertFailure(ALERT_FAILURE_LINE);
  }
}
