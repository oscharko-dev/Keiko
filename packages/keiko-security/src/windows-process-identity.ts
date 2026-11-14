// A Windows process's command line, which Node cannot read for another process (#4358). The CLI
// uses it to prove that a tracked pid is still the UI it launched before it stops or adopts it.
//
// The read used to run under one 3 s limit that also covered the inbox PowerShell host coming up.
// Under x64 emulation that host needs 6.5 to 20 s, so the read never answered: `keiko stop` could
// not confirm the process it was about to end, and `keiko start` refused a healthy tracked UI as an
// identity mismatch. The query keeps its own limit; the host start is bounded separately
// (windows-powershell-program.ts). An unanswered read still proves nothing and stays `undefined`.
import { spawnSync } from "node:child_process";
import type { SecurityLogSink } from "./log-port.js";
import {
  emitWindowsProgramUnavailable,
  runBoundedPowerShellProgram,
  WindowsProgramHostStartError,
  WindowsProgramWorkTimeoutError,
  type WindowsProgramRunner,
} from "./windows-powershell-program.js";
import { resolveWindowsPowerShellExecutable } from "./windows-system-directory.js";

/** The limit on the process query itself, counted from the program's first statement. */
export const WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS = 3_000;
// A Windows command line is at most 32,767 UTF-16 units; UTF-8 needs up to three bytes for each.
export const WINDOWS_PROCESS_IDENTITY_MAX_OUTPUT_BYTES = 3 * 32_768;
const MAX_PID = 0xff_ff_ff_fc;

// Loading the CIM cmdlets is the host getting ready, not the query: under x64 emulation it alone
// took longer than the query's 3 s limit, so every read ran into the limit although the query is
// quick (measured 2026-11-13 on the Windows cross-test machine). It therefore runs before the start
// marker, under the host start allowance; the limit bounds the query alone. A module that cannot be
// loaded ends the program before the marker, which is a failed run: nothing was learned.
const PREPARATION = "Import-Module CimCmdlets -ErrorAction Stop";

// The pid arrives as one decimal line on standard input and is checked again here, so nothing is
// ever interpolated into this fixed program. A process that does not exist answers with no output.
const QUERY = `
$line = [Console]::In.ReadLine()
if ($line -notmatch '^[0-9]{1,10}$') { exit 1 }
try {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $line) -ErrorAction Stop
  if ($null -ne $process -and $null -ne $process.CommandLine) { [Console]::Out.Write($process.CommandLine) }
} catch { exit 1 }`;

/** Hermetic seams, plus the one sink every caller must name. */
export interface WindowsProcessIdentityOptions {
  readonly runner?: WindowsProgramRunner | undefined;
  readonly resolvePowerShell?: (() => string) | undefined;
  /** Required: the slow-run and unavailable lines go here. A seam passes the null sink. */
  readonly securityLogSink: SecurityLogSink;
}

function queryCommandLine(pid: number, options: WindowsProcessIdentityOptions): string | undefined {
  const result = runBoundedPowerShellProgram({
    program: "process-identity",
    executable: options.resolvePowerShell?.() ?? resolveWindowsPowerShellExecutable(),
    source: QUERY,
    preparation: PREPARATION,
    input: `${String(pid)}\n`,
    workTimeoutMs: WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS,
    maxOutputBytes: WINDOWS_PROCESS_IDENTITY_MAX_OUTPUT_BYTES,
    runner: options.runner ?? spawnSync,
    securityLogSink: options.securityLogSink,
  });
  const answered = result.started && result.error === undefined && result.status === 0;
  return answered && result.stdout !== "" ? result.stdout : undefined;
}

/**
 * The command line of process `pid`, or `undefined` when it could not be read: no such process, a
 * host that did not start, a query that ran out of time, or a blocked PowerShell. Never throws.
 */
export function readWindowsProcessCommandLine(
  pid: number,
  options: WindowsProcessIdentityOptions,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) return undefined;
  try {
    return queryCommandLine(pid, options);
  } catch (error) {
    // A time limit was hit and already recorded, or PowerShell could not be resolved, which is
    // recorded here. Either way nothing was learned about the process.
    const timedOut =
      error instanceof WindowsProgramHostStartError ||
      error instanceof WindowsProgramWorkTimeoutError;
    if (!timedOut) emitWindowsProgramUnavailable(options.securityLogSink, "process-identity");
    return undefined;
  }
}
