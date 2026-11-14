// Windows managed roots must remain on a local volume. This intentionally uses the already
// identity-validated inbox PowerShell resolver rather than a candidate-provided helper: evaluation
// archives do not carry the production attestor and an archive must never vouch for its own root.
import { spawnSync } from "node:child_process";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts";
import { emitSecurityLogEvent, securityErrorKind, type SecurityLogSink } from "./log-port.js";
import {
  kernel32PInvokePrelude,
  runBoundedPowerShellProgram,
  WindowsProgramHostStartError,
  WindowsProgramWorkTimeoutError,
  type BoundedPowerShellResult,
  type WindowsProgramRunner,
} from "./windows-powershell-program.js";
import { resolveWindowsPowerShellExecutable } from "./windows-system-directory.js";

/**
 * The limit on the volume query itself, counted from the program's first statement (#4358). It is
 * what cuts off a query against an unreachable or stalled path. The inbox PowerShell host coming up
 * is bounded separately, see windows-powershell-program.ts.
 */
export const WINDOWS_LOCAL_VOLUME_TIMEOUT_MS = 10_000;
export const WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES = 256;
const SUCCESS = "KEIKO_LOCAL_VOLUME_OK";

const SECURITY_WINDOWS_LOCAL_VOLUME_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-local-volume.refused",
  category: "security",
  owner: "keiko-security",
  emitter: "windows-local-volume.assertWindowsLocalVolume",
  fields: {
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["input", "resolve", "host-start", "verify"],
    },
    verdict: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["not-local", "unverifiable"],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-local-volume"],
  proofIds: ["security.windows-local-volume.refused.phase"],
  releaseImpact: "patch",
});

export type WindowsLocalVolumeRunner = WindowsProgramRunner;

/** Hermetic command seam; production callers never supply a locality verdict. */
export interface WindowsLocalVolumeOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly runner?: WindowsLocalVolumeRunner | undefined;
  readonly resolvePowerShell?: (() => string) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

// The path is supplied as bounded Base64 standard-input data. Keep this source fixed: interpolating a path into this
// P/Invoke program would turn a root-policy check into a PowerShell command-injection surface.
const QUERY = String.raw`
$encoded = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($encoded) -or $encoded.Length -gt 65536) { exit 1 }
try { $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) } catch { exit 1 }
if ([string]::IsNullOrWhiteSpace($p) -or $p.StartsWith('\\') -or $p.StartsWith('//')) { exit 1 }
$p = [IO.Path]::GetFullPath($p)
while (-not [IO.Directory]::Exists($p)) {
  $parent = [IO.Path]::GetDirectoryName($p)
  if ([string]::IsNullOrEmpty($parent) -or $parent -eq $p) { exit 1 }
  $p = $parent
}
try {
${kernel32PInvokePrelude("KeikoLocalVolume")}  $create = pinvoke 'CreateFileW' ([Microsoft.Win32.SafeHandles.SafeFileHandle]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
  $tagInfo = pinvoke 'GetFileInformationByHandleEx' ([bool]) @([Microsoft.Win32.SafeHandles.SafeFileHandle], [int], [IntPtr], [uint32])
  $finalName = pinvoke 'GetFinalPathNameByHandleW' ([uint32]) @([Microsoft.Win32.SafeHandles.SafeFileHandle], [Text.StringBuilder], [uint32], [uint32])
  $volumePath = pinvoke 'GetVolumePathNameW' ([bool]) @([string], [Text.StringBuilder], [uint32])
  $driveType = pinvoke 'GetDriveTypeW' ([uint32]) @([string])
  $api = $type.CreateType()
  $create = $api.GetMethod('CreateFileW')
  $tagInfo = $api.GetMethod('GetFileInformationByHandleEx')
  $finalName = $api.GetMethod('GetFinalPathNameByHandleW')
  $volumePath = $api.GetMethod('GetVolumePathNameW')
  $driveType = $api.GetMethod('GetDriveTypeW')
  $handle = $create.Invoke($null, @($p, [uint32]0x80, [uint32]7, [IntPtr]::Zero, [uint32]3, [uint32]0x2200000, [IntPtr]::Zero))
  if ($handle.IsInvalid) { exit 1 }
  try {
    $tag = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
    try {
      if (-not $tagInfo.Invoke($null, @($handle, [int]9, $tag, [uint32]8)) -or (([Runtime.InteropServices.Marshal]::ReadInt32($tag, 0) -band 0x400) -ne 0)) { exit 1 }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($tag) }
    $final = [Text.StringBuilder]::new(32768)
    $length = $finalName.Invoke($null, @($handle, $final, [uint32]$final.Capacity, [uint32]0))
    if ($length -eq 0 -or $length -ge $final.Capacity) { exit 1 }
    $canonical = $final.ToString()
    if ($canonical.StartsWith('\\?\')) { $canonical = $canonical.Substring(4) }
    if (-not $canonical.TrimEnd('\').Equals($p.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
    $volume = [Text.StringBuilder]::new(32768)
    if (-not $volumePath.Invoke($null, @($p, $volume, [uint32]$volume.Capacity))) { exit 1 }
    $kind = $driveType.Invoke($null, @($volume.ToString()))
    if ($kind -ne 2 -and $kind -ne 3 -and $kind -ne 6) { exit 1 }
    [Console]::Out.Write('KEIKO_LOCAL_VOLUME_OK')
  } finally { $handle.Dispose() }
} catch { exit 1 }`;

function assertUsablePath(path: string): void {
  if (path.length === 0 || /[\0\r\n]/u.test(path)) {
    throw new Error("Windows managed root locality is unavailable");
  }
}

function commandFailed(result: BoundedPowerShellResult): boolean {
  return [
    !result.started,
    result.error !== undefined,
    result.status !== 0,
    result.stderr !== "",
    result.stdout !== SUCCESS,
  ].some(Boolean);
}

export type WindowsLocalVolumePhase = "input" | "resolve" | "host-start" | "verify";

/**
 * What a refusal says about the folder. `not-local`: the query ran to its answer and denied it, or
 * the input can never be accepted. `unverifiable`: nothing was learned about the volume, because
 * Windows PowerShell could not be resolved, did not start in time, never ran the query (it could
 * not be started, or was ended), or the query did not finish in time. Both deny; only the second
 * one can pass a moment later.
 */
export type WindowsLocalVolumeVerdict = "not-local" | "unverifiable";

/**
 * A refusal of the check in the `input`, `host-start` and `verify` phases. The message and the
 * cause are those of the refusal itself. A `resolve`-phase failure keeps its own error class (the
 * launcher matches it), and `windowsLocalVolumeVerdict` reads it as `unverifiable`.
 */
export class WindowsLocalVolumeError extends Error {
  readonly verdict: WindowsLocalVolumeVerdict;
  readonly phase: WindowsLocalVolumePhase;

  constructor(
    message: string,
    verdict: WindowsLocalVolumeVerdict,
    phase: WindowsLocalVolumePhase,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "WindowsLocalVolumeError";
    this.verdict = verdict;
    this.phase = phase;
  }
}

/** The verdict of any error a caller caught around the check; a foreign error learned nothing. */
export function windowsLocalVolumeVerdict(error: unknown): WindowsLocalVolumeVerdict {
  return error instanceof WindowsLocalVolumeError ? error.verdict : "unverifiable";
}

// The process answered without running the query to its end: it could not be started, was ended,
// or never reached the program. Nothing about the volume was learned.
class WindowsLocalVolumeQueryNotRunError extends Error {
  public override readonly name = "WindowsLocalVolumeQueryNotRunError";
  public readonly code = "query-not-run";
  public constructor(cause: unknown) {
    super("Windows managed root could not be verified as a local volume: the check did not run", {
      cause,
    });
  }
}

function learnedNothing(error: unknown): boolean {
  return (
    error instanceof WindowsProgramWorkTimeoutError ||
    error instanceof WindowsLocalVolumeQueryNotRunError
  );
}

function refusalVerdict(phase: WindowsLocalVolumePhase, error: unknown): WindowsLocalVolumeVerdict {
  if (phase === "resolve" || phase === "host-start") return "unverifiable";
  return learnedNothing(error) ? "unverifiable" : "not-local";
}

function localVolumeErrorKind(
  phase: WindowsLocalVolumePhase,
  error: unknown,
): ActivityLogErrorKind {
  if (phase === "input") return "invalid-request";
  if (phase === "resolve") return "unavailable";
  if (phase === "host-start" || error instanceof WindowsProgramWorkTimeoutError) return "timeout";
  if (error instanceof WindowsLocalVolumeQueryNotRunError) return "unavailable";
  return "unsafe-target";
}

// Both messages keep "local volume": the launcher prints them, and a person must be able to tell a
// volume that is not local from a check that could not be made.
const HOST_START_MESSAGE =
  "Windows managed root could not be verified as a local volume: Windows PowerShell did not start in time";
const NOT_LOCAL_MESSAGE = "Windows managed root must be on a local volume";

function refusalMessage(error: unknown): string {
  if (error instanceof WindowsProgramHostStartError) return HOST_START_MESSAGE;
  if (error instanceof WindowsProgramWorkTimeoutError) return NOT_LOCAL_MESSAGE;
  return error instanceof Error ? error.message : NOT_LOCAL_MESSAGE;
}

function reportLocalVolumeRefusal(
  sink: SecurityLogSink | undefined,
  detected: WindowsLocalVolumePhase,
  error: unknown,
): never {
  // The host never reached the program: nothing about the volume was learned.
  const phase = error instanceof WindowsProgramHostStartError ? "host-start" : detected;
  const verdict = refusalVerdict(phase, error);
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      SECURITY_WINDOWS_LOCAL_VOLUME_REFUSED_OPERATION,
      { level: "error", errorKind: localVolumeErrorKind(phase, error) },
      { failureKind: securityErrorKind(error), phase, verdict },
    ),
  );
  // The resolver's own error classes are matched by the launcher (its "trusted helper
  // unavailable" handling); they keep their identity. Nothing about the volume was learned.
  if (phase === "resolve") throw error;
  throw new WindowsLocalVolumeError(refusalMessage(error), verdict, phase, error);
}

function verifyLocalVolume(
  path: string,
  executable: string,
  options: WindowsLocalVolumeOptions,
): void {
  const result = runBoundedPowerShellProgram({
    program: "local-volume",
    executable,
    source: QUERY,
    input: `${Buffer.from(path, "utf8").toString("base64")}\n`,
    workTimeoutMs: WINDOWS_LOCAL_VOLUME_TIMEOUT_MS,
    maxOutputBytes: WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES,
    runner: options.runner ?? spawnSync,
    securityLogSink: options.securityLogSink,
  });
  if (!result.started || result.error !== undefined || result.status === null) {
    throw new WindowsLocalVolumeQueryNotRunError(result.error);
  }
  if (commandFailed(result)) throw new Error(NOT_LOCAL_MESSAGE);
}

export function assertWindowsLocalVolume(
  path: string,
  options: WindowsLocalVolumeOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  let phase: WindowsLocalVolumePhase = "input";
  try {
    assertUsablePath(path);
    phase = "resolve";
    const executable = options.resolvePowerShell?.() ?? resolveWindowsPowerShellExecutable();
    phase = "verify";
    verifyLocalVolume(path, executable, options);
  } catch (error) {
    reportLocalVolumeRefusal(options.securityLogSink, phase, error);
  }
}

// Folders a passive read has seen pass, by their exact spelling, for the life of this process.
const REMEMBERED_LOCAL_VOLUMES = new Set<string>();

/**
 * The same check for PASSIVE reads only: the update pre-report, which answers whether an update is
 * available and how it could be installed. A folder that passed once is not asked again in this
 * process, because each check runs Windows PowerShell and blocks its caller for as long as that
 * takes. Only
 * a pass is remembered; a refusal of either verdict is asked again every time.
 *
 * Nothing that ACTS on the verdict may call this: the launcher's root policy, the update session
 * and the start of the portable coding runtime call `assertWindowsLocalVolume`, which neither reads
 * nor writes this memory.
 */
export function assertWindowsLocalVolumeForPassiveRead(
  path: string,
  options: WindowsLocalVolumeOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  if (REMEMBERED_LOCAL_VOLUMES.has(path)) return;
  assertWindowsLocalVolume(path, options);
  REMEMBERED_LOCAL_VOLUMES.add(path);
}

/** Test seam: a process forgets nothing on its own. */
export function forgetRememberedWindowsLocalVolumesForTest(): void {
  REMEMBERED_LOCAL_VOLUMES.clear();
}
