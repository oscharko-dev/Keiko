// The one Windows command that hands a URL to a browser (#4358). `keiko start --open`, the running
// UI's browser request and the server's one-click connection each built this command themselves and
// each waited 5 s for it, a limit that also covered the inbox PowerShell host coming up. With a host
// that needs 6.5 to 20 s to start, the launcher reported a failed hand-off (and the server killed
// the opener before it ran) although nothing was wrong with the browser.
//
// `cmd /c start` percent-expands its argument and would corrupt a percent-encoded pairing fragment
// (#2478), so the URL travels only inside the Base64-encoded program, never through cmd.exe. The
// program is framed like every other fixed program: `Start-Process` keeps its own limit, counted
// from the program's first statement, and the host start is bounded separately.
import {
  boundedPowerShellProgram,
  boundedPowerShellTimeoutMs,
  encodePowerShellProgram,
} from "./windows-powershell-program.js";
import { resolveWindowsPowerShellExecutable } from "./windows-system-directory.js";

/** The limit on `Start-Process` itself, counted from the program's first statement. */
export const WINDOWS_URL_OPENER_TIMEOUT_MS = 5_000;

export type WindowsBrowserApp = "chrome.exe" | "firefox.exe" | "msedge.exe";

export interface WindowsUrlOpener {
  readonly command: string;
  readonly args: readonly string[];
  /** How long a caller waits for the opener to end: host start allowance plus its own limit. */
  readonly timeoutMs: number;
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The identity-validated inbox PowerShell command that opens `url` in the default browser, or in
 * `app` when one of the fixed browser executables is named.
 */
export function resolveWindowsUrlOpener(
  url: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  app?: WindowsBrowserApp,
): WindowsUrlOpener {
  const start =
    app === undefined
      ? `Start-Process ${quoted(url)}`
      : `Start-Process ${quoted(app)} -ArgumentList ${quoted(url)}`;
  return {
    command: resolveWindowsPowerShellExecutable(env),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellProgram(boundedPowerShellProgram(start, WINDOWS_URL_OPENER_TIMEOUT_MS)),
    ],
    timeoutMs: boundedPowerShellTimeoutMs(WINDOWS_URL_OPENER_TIMEOUT_MS),
  };
}
