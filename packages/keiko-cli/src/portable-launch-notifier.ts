import { spawn } from "node:child_process";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

/**
 * A Finder double-click gives the portable launcher no terminal: every `io.err` line vanishes and
 * a failed first start looks like the app simply did nothing. This surfaced twice in the 0.3.0
 * beta — a Gatekeeper-blocked bundle and a refused runtime activation both died without a visible
 * word. When a setup or launch command fails under a double-click, this notifier shows the
 * recorded reason in a native alert instead.
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

export type PortableFailureNotifierFn = (message: string, env: EnvSource) => void;

export interface PortableFailureNotifierDeps {
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly runAlert?: ((script: string) => void) | undefined;
}

/** Kept to displayable text: AppleScript-quoted, control-free, bounded. */
function alertScript(message: string): string {
  const displayable = Array.from(message)
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .slice(0, MAX_ALERT_MESSAGE_LENGTH);
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
export function runDetachedAlert(script: string, spawnFn: DetachedAlertSpawn = spawn): void {
  const child = spawnFn(OSASCRIPT_EXECUTABLE, ["-e", script], {
    detached: true,
    env: {},
    shell: false,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort by contract: the launch failure already carries the diagnosis on stderr, and a
    // notifier that cannot spawn (no osascript, denied automation) must not replace it.
  });
  child.unref();
}

export function notifyPortableLaunchFailure(
  message: string,
  env: EnvSource,
  deps: PortableFailureNotifierDeps = {},
): void {
  if (env.KEIKO_PORTABLE_UI_LAUNCH !== "1") return;
  const platform = deps.platform ?? ((): NodeJS.Platform => process.platform);
  if (platform() !== "darwin") return;
  const text = message.trim() === "" ? "The portable launch failed without a reason." : message;
  try {
    (deps.runAlert ?? runDetachedAlert)(alertScript(text));
  } catch {
    // Best-effort by contract — see runDetachedAlert.
  }
}
