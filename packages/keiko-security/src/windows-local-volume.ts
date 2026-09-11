// Windows managed roots must remain on a local volume. This intentionally uses the already
// identity-validated inbox PowerShell resolver rather than a candidate-provided helper: evaluation
// archives do not carry the production attestor and an archive must never vouch for its own root.
import { spawnSync } from "node:child_process";
import { win32 as win32Path } from "node:path";
import { emitSecurityLogEvent, securityErrorKind, type SecurityLogSink } from "./log-port.js";
import { resolveWindowsPowerShellExecutable } from "./windows-system-directory.js";

export const WINDOWS_LOCAL_VOLUME_TIMEOUT_MS = 10_000;
export const WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES = 256;
const SUCCESS = "KEIKO_LOCAL_VOLUME_OK";

export type WindowsLocalVolumeRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly input: string;
    readonly shell: false;
    readonly timeout: number;
    readonly windowsHide: true;
  },
) => {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: string | Buffer | null;
  readonly stderr: string | Buffer | null;
};

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
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('KeikoLocalVolume'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('KeikoLocalVolume')
  $type = $module.DefineType('KeikoLocalVolumeApi', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  function pinvoke($name, $returnType, $parameters) {
    $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', $name, $attributes, [Reflection.CallingConventions]::Standard, $returnType, [type[]]$parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    return $method
  }
  $create = pinvoke 'CreateFileW' ([Microsoft.Win32.SafeHandles.SafeFileHandle]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
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

function encodedQuery(): string {
  return Buffer.from(QUERY, "utf16le").toString("base64");
}

function trustedEnvironment(executable: string): NodeJS.ProcessEnv {
  const root = win32Path.dirname(
    win32Path.dirname(win32Path.dirname(win32Path.dirname(executable))),
  );
  return {
    SystemRoot: root,
    WINDIR: root,
    SystemDrive: root.slice(0, 2),
  };
}

function text(value: string | Buffer | null): string {
  if (value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function assertUsablePath(path: string): void {
  if (path.length === 0 || /[\0\r\n]/u.test(path)) {
    throw new Error("Windows managed root locality is unavailable");
  }
}

function commandFailed(result: ReturnType<WindowsLocalVolumeRunner>): boolean {
  return [
    result.error !== undefined,
    result.status !== 0,
    text(result.stderr) !== "",
    text(result.stdout) !== SUCCESS,
  ].some(Boolean);
}

export function assertWindowsLocalVolume(
  path: string,
  options: WindowsLocalVolumeOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  let phase: "input" | "resolve" | "verify" = "input";
  try {
    assertUsablePath(path);
    phase = "resolve";
    const executable = options.resolvePowerShell?.() ?? resolveWindowsPowerShellExecutable();
    const runner = options.runner ?? spawnSync;
    phase = "verify";
    const result = runner(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedQuery()],
      {
        encoding: "utf8",
        env: trustedEnvironment(executable),
        input: `${Buffer.from(path, "utf8").toString("base64")}\n`,
        maxBuffer: WINDOWS_LOCAL_VOLUME_MAX_OUTPUT_BYTES,
        shell: false,
        timeout: WINDOWS_LOCAL_VOLUME_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (commandFailed(result)) {
      throw new Error("Windows managed root must be on a local volume");
    }
  } catch (error) {
    emitSecurityLogEvent(options.securityLogSink, {
      level: "error",
      category: "security",
      op: "security.windows-local-volume.refused",
      errorKind: securityErrorKind(error),
      extra: { phase },
    });
    throw error;
  }
}
