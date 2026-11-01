// Windows has no POSIX owner or mode bits worth trusting: Node reports 0o666 for every writable file
// and no uid. "Owner-private" is therefore answered from the file's own security descriptor (#4068,
// owner decision). Like windows-local-volume.ts this uses the identity-validated inbox PowerShell,
// never a candidate-provided helper. The program only gathers facts from ONE handle per file —
// opened without following a reparse point — and the decision lives in
// windows-security-descriptor.ts. The caller binds those facts to its own open descriptor by volume
// serial and file index, so a file swapped after the inspection is refused, not read.
import { spawnSync } from "node:child_process";
import { win32 as win32Path } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitSecurityLogEvent, securityErrorKind, type SecurityLogSink } from "./log-port.js";
import {
  evaluateWindowsSecurityDescriptor,
  type WindowsDescriptorPrincipal,
  type WindowsOwnerPrivateRefusal,
} from "./windows-security-descriptor.js";
import {
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemBinary,
} from "./windows-system-directory.js";
import type { WindowsLocalVolumeRunner } from "./windows-local-volume.js";

export const WINDOWS_OWNER_PRIVATE_TIMEOUT_MS = 20_000;
export const WINDOWS_OWNER_PRIVATE_MAX_FILES = 4_096;
const MAX_PATH_CHARS = 32_767;
// One header line plus, per file, a bounded fact line (attributes, identity, Base64 descriptor).
const MAX_LINE_BYTES = 96 * 1024;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const SID = /^S-1-\d+(?:-\d+){1,15}$/u;

const SECURITY_WINDOWS_OWNER_PRIVATE_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-owner-private.refused",
  category: "security",
  owner: "keiko-security",
  emitter: "windows-owner-private.inspectWindowsOwnerPrivateFiles",
  fields: {
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["input", "resolve", "inspect", "protect"],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-owner-private"],
  proofIds: ["security.windows-owner-private.refused.phase"],
  releaseImpact: "patch",
});

/** What one handle reported, or that no handle could be opened and inspected. */
export type WindowsOwnerPrivateFacts =
  | {
      readonly kind: "facts";
      readonly attributes: number;
      readonly volumeSerial: bigint;
      readonly fileIndex: bigint;
      readonly links: number;
      readonly descriptor: Uint8Array;
    }
  | { readonly kind: "unavailable" };

export interface WindowsOwnerPrivateInspection {
  readonly principal: WindowsDescriptorPrincipal;
  /** In the order of the requested paths. */
  readonly files: readonly WindowsOwnerPrivateFacts[];
}

/** Node's own view of the descriptor it opened: `fstatSync(fd, { bigint: true })`. */
export interface WindowsOpenedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export type WindowsOwnerPrivateVerdict =
  | { readonly kind: "owner-private" }
  | {
      readonly kind: "refused";
      readonly reason: WindowsOwnerPrivateRefusal | "unavailable" | "not-regular-file" | "replaced";
    };

export interface WindowsOwnerPrivateOptions {
  readonly runner?: WindowsLocalVolumeRunner | undefined;
  readonly resolvePowerShell?: (() => string) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export interface WindowsOwnerPrivateProtectOptions {
  readonly runner?: WindowsLocalVolumeRunner | undefined;
  /** Resolves a bare System32 binary name (`whoami.exe`, `icacls.exe`). */
  readonly resolveSystemBinary?: ((name: string) => string) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

// Paths arrive as Base64 lines on standard input, so no path is ever interpolated into this fixed
// program. Failures are reported as a bare "E|<index>": no exception text leaves the program.
const QUERY = String.raw`
try {
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('KeikoOwnerPrivate'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('KeikoOwnerPrivate')
  $type = $module.DefineType('KeikoOwnerPrivateApi', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  function pinvoke($name, $returnType, $parameters) {
    $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', $name, $attributes, [Reflection.CallingConventions]::Standard, $returnType, [type[]]$parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    return $method
  }
  $null = pinvoke 'CreateFileW' ([Microsoft.Win32.SafeHandles.SafeFileHandle]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
  $null = pinvoke 'GetFileInformationByHandle' ([bool]) @([Microsoft.Win32.SafeHandles.SafeFileHandle], [IntPtr])
  $api = $type.CreateType()
  $create = $api.GetMethod('CreateFileW')
  $info = $api.GetMethod('GetFileInformationByHandle')
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  [Console]::Out.Write('P|' + $id.User.Value + '|' + $id.Owner.Value + [char]10)
} catch { exit 1 }
function u32($v) { return [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$v), 0) }
$index = 0
while ($true) {
  $line = [Console]::In.ReadLine()
  if ([string]::IsNullOrEmpty($line)) { break }
  if ($index -ge 4096 -or $line.Length -gt 65536) { exit 1 }
  $out = "E|$index"
  try {
    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    if ($p.StartsWith('\\') -or $p.StartsWith('//')) { throw 'unsupported' }
    $h = $create.Invoke($null, @($p, [uint32]0x20080, [uint32]7, [IntPtr]::Zero, [uint32]3, [uint32]0x00200000, [IntPtr]::Zero))
    if ($h.IsInvalid) { throw 'open' }
    try {
      $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
      try {
        if (-not $info.Invoke($null, @($h, $buf))) { throw 'info' }
        $fields = @(0, 28, 40, 44, 48) | ForEach-Object { u32 ([Runtime.InteropServices.Marshal]::ReadInt32($buf, $_)) }
      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
      $stream = [IO.FileStream]::new($h, [IO.FileAccess]::Read)
      $sd = $stream.GetAccessControl().GetSecurityDescriptorBinaryForm()
      $out = "F|$index|" + ($fields -join '|') + '|' + [Convert]::ToBase64String($sd)
    } finally { $h.Dispose() }
  } catch { $out = "E|$index" }
  [Console]::Out.Write($out + [char]10)
  $index += 1
}`;

function encodedQuery(): string {
  return Buffer.from(QUERY, "utf16le").toString("base64");
}

function trustedEnvironment(executable: string): NodeJS.ProcessEnv {
  const root = win32Path.dirname(
    win32Path.dirname(win32Path.dirname(win32Path.dirname(executable))),
  );
  return { SystemRoot: root, WINDIR: root, SystemDrive: root.slice(0, 2) };
}

// `<SystemRoot>\System32\<name>.exe`, as resolveWindowsSystemBinary returns it.
function systemBinaryEnvironment(executable: string): NodeJS.ProcessEnv {
  const root = win32Path.dirname(win32Path.dirname(executable));
  return { SystemRoot: root, WINDIR: root, SystemDrive: root.slice(0, 2) };
}

function text(value: string | Buffer | null): string {
  if (value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

// Only local drive paths are inspected; UNC shares and device namespaces stay refused here, as in
// the shared isLocalAbsolutePath contract.
function assertInspectablePaths(paths: readonly string[]): void {
  const usable = paths.every(
    (path) =>
      path.length > 0 &&
      path.length <= MAX_PATH_CHARS &&
      !/[\0\r\n]/u.test(path) &&
      /^[A-Za-z]:[\\/]/u.test(path),
  );
  if (!usable || paths.length > WINDOWS_OWNER_PRIVATE_MAX_FILES) {
    throw new TypeError("windows-owner-private-input-invalid");
  }
}

function parsePrincipal(line: string | undefined): WindowsDescriptorPrincipal {
  const [tag, userSid, tokenOwnerSid, ...rest] = (line ?? "").split("|");
  if (tag !== "P" || rest.length > 0 || userSid === undefined || tokenOwnerSid === undefined) {
    throw new Error("windows-owner-private-output-invalid");
  }
  if (!SID.test(userSid) || !SID.test(tokenOwnerSid)) {
    throw new Error("windows-owner-private-output-invalid");
  }
  return { userSid, tokenOwnerSid };
}

function unsigned(value: string | undefined): bigint {
  if (value === undefined || !/^\d{1,10}$/u.test(value)) {
    throw new Error("windows-owner-private-output-invalid");
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffffn) throw new Error("windows-owner-private-output-invalid");
  return parsed;
}

function parseFacts(line: string | undefined, index: number): WindowsOwnerPrivateFacts {
  const fields = (line ?? "").split("|");
  if (fields.length === 2 && fields[0] === "E" && fields[1] === String(index)) {
    return { kind: "unavailable" };
  }
  const [tag, at, attributes, serial, links, high, low, descriptor, ...rest] = fields;
  if (tag !== "F" || at !== String(index) || rest.length > 0 || descriptor === undefined) {
    throw new Error("windows-owner-private-output-invalid");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(descriptor)) {
    throw new Error("windows-owner-private-output-invalid");
  }
  return {
    kind: "facts",
    attributes: Number(unsigned(attributes)),
    volumeSerial: unsigned(serial),
    links: Number(unsigned(links)),
    fileIndex: (unsigned(high) << 32n) | unsigned(low),
    descriptor: new Uint8Array(Buffer.from(descriptor, "base64")),
  };
}

function parseInspection(stdout: string, count: number): WindowsOwnerPrivateInspection {
  const lines = stdout.split("\n");
  if (lines.at(-1) !== "" || lines.length !== count + 2) {
    throw new Error("windows-owner-private-output-invalid");
  }
  const principal = parsePrincipal(lines[0]);
  const files = Array.from({ length: count }, (_, index) => parseFacts(lines[index + 1], index));
  return { principal, files };
}

function runQuery(
  paths: readonly string[],
  executable: string,
  runner: WindowsLocalVolumeRunner,
): string {
  const input = paths.map((path) => `${Buffer.from(path, "utf8").toString("base64")}\n`).join("");
  const result = runner(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedQuery()],
    {
      encoding: "utf8",
      env: trustedEnvironment(executable),
      input: `${input}\n`,
      maxBuffer: MAX_LINE_BYTES * (paths.length + 1),
      shell: false,
      timeout: WINDOWS_OWNER_PRIVATE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const failed = [result.error !== undefined, result.status !== 0, text(result.stderr) !== ""];
  if (failed.some(Boolean)) throw new Error("windows-owner-private-unavailable");
  return text(result.stdout);
}

/**
 * Inspects every path through one PowerShell process. Throws (after a body-free security event)
 * when the inspection itself is unavailable; a single file that cannot be opened and inspected is
 * reported as `unavailable` and must be refused by the caller.
 */
export function inspectWindowsOwnerPrivateFiles(
  paths: readonly string[],
  options: WindowsOwnerPrivateOptions = {},
): WindowsOwnerPrivateInspection {
  let phase: "input" | "resolve" | "inspect" = "input";
  try {
    assertInspectablePaths(paths);
    phase = "resolve";
    const executable = options.resolvePowerShell?.() ?? resolveWindowsPowerShellExecutable();
    phase = "inspect";
    const stdout = runQuery(paths, executable, options.runner ?? spawnSync);
    return parseInspection(stdout, paths.length);
  } catch (error) {
    emitSecurityLogEvent(
      options.securityLogSink,
      activityLogEvent(
        SECURITY_WINDOWS_OWNER_PRIVATE_REFUSED_OPERATION,
        { level: "error", errorKind: phase === "input" ? "invalid-request" : "unavailable" },
        { failureKind: securityErrorKind(error), phase },
      ),
    );
    throw error;
  }
}

function runSystemBinary(
  runner: WindowsLocalVolumeRunner,
  executable: string,
  args: readonly string[],
): string {
  const result = runner(executable, args, {
    encoding: "utf8",
    env: systemBinaryEnvironment(executable),
    input: "",
    maxBuffer: MAX_LINE_BYTES,
    shell: false,
    timeout: WINDOWS_OWNER_PRIVATE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("windows-owner-private-protect-failed");
  }
  return text(result.stdout);
}

// whoami's CSV row ends with the SID, which is never localized; the account name is ignored.
function currentUserSid(runner: WindowsLocalVolumeRunner, whoami: string): string {
  const row = runSystemBinary(runner, whoami, ["/user", "/fo", "csv", "/nh"]).trim();
  const sid = /"(S-1-\d+(?:-\d+){1,15})"$/u.exec(row)?.[1];
  if (sid === undefined) throw new Error("windows-owner-private-protect-failed");
  return sid;
}

/**
 * Replaces the file's DACL with a protected one granting full control to the current user, SYSTEM
 * and Administrators only, so a private file Keiko writes does not inherit a profile or drive ACL
 * that lets other accounts modify it. icacls receives SIDs only and is judged by its exit status.
 * Callers protect a file they just created in their own directory and still verify it on read.
 */
export function protectWindowsOwnerPrivateFile(
  path: string,
  options: WindowsOwnerPrivateProtectOptions = {},
): void {
  let phase: "input" | "resolve" | "protect" = "input";
  try {
    assertInspectablePaths([path]);
    phase = "resolve";
    const resolve =
      options.resolveSystemBinary ?? ((name: string): string => resolveWindowsSystemBinary(name));
    const whoami = resolve("whoami.exe");
    const icacls = resolve("icacls.exe");
    phase = "protect";
    const runner = options.runner ?? spawnSync;
    const sid = currentUserSid(runner, whoami);
    runSystemBinary(runner, icacls, [
      path,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ]);
  } catch (error) {
    emitSecurityLogEvent(
      options.securityLogSink,
      activityLogEvent(
        SECURITY_WINDOWS_OWNER_PRIVATE_REFUSED_OPERATION,
        { level: "error", errorKind: phase === "input" ? "invalid-request" : "unavailable" },
        { failureKind: securityErrorKind(error), phase },
      ),
    );
    throw error;
  }
}

/**
 * The verdict for one file the caller has OPENED: its own descriptor must be the very object that
 * was inspected (same volume serial and file index), a regular file and not a reparse point, and
 * its security descriptor must satisfy the owner-private policy.
 */
export function windowsOwnerPrivateVerdict(
  facts: WindowsOwnerPrivateFacts,
  principal: WindowsDescriptorPrincipal,
  opened: WindowsOpenedFileIdentity,
): WindowsOwnerPrivateVerdict {
  if (facts.kind === "unavailable") return { kind: "refused", reason: "unavailable" };
  const linkOrDirectory = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT;
  if ((facts.attributes & linkOrDirectory) !== 0) {
    return { kind: "refused", reason: "not-regular-file" };
  }
  if (facts.volumeSerial !== opened.dev || facts.fileIndex !== opened.ino) {
    return { kind: "refused", reason: "replaced" };
  }
  return evaluateWindowsSecurityDescriptor(facts.descriptor, principal);
}
