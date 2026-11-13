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

type LocalVolumePhase = "input" | "resolve" | "host-start" | "verify";

function localVolumeErrorKind(phase: LocalVolumePhase, error: unknown): ActivityLogErrorKind {
  if (phase === "input") return "invalid-request";
  if (phase === "resolve") return "unavailable";
  if (phase === "host-start" || error instanceof WindowsProgramWorkTimeoutError) return "timeout";
  return "unsafe-target";
}

// Both messages keep "local volume": the launcher prints them, and a person must be able to tell a
// volume that is not local from a check that could not be made.
function hostStartError(cause: unknown): Error {
  return new Error(
    "Windows managed root could not be verified as a local volume: Windows PowerShell did not start in time",
    { cause },
  );
}

function reportLocalVolumeRefusal(
  sink: SecurityLogSink | undefined,
  detected: LocalVolumePhase,
  error: unknown,
): never {
  // The host never reached the program: nothing about the volume was learned.
  const phase = error instanceof WindowsProgramHostStartError ? "host-start" : detected;
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      SECURITY_WINDOWS_LOCAL_VOLUME_REFUSED_OPERATION,
      { level: "error", errorKind: localVolumeErrorKind(phase, error) },
      { failureKind: securityErrorKind(error), phase },
    ),
  );
  if (error instanceof WindowsProgramHostStartError) throw hostStartError(error);
  if (error instanceof WindowsProgramWorkTimeoutError) {
    throw new Error("Windows managed root must be on a local volume", { cause: error });
  }
  throw error;
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
  if (commandFailed(result)) throw new Error("Windows managed root must be on a local volume");
}

export function assertWindowsLocalVolume(
  path: string,
  options: WindowsLocalVolumeOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  let phase: LocalVolumePhase = "input";
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
