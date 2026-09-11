import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 as win32Path } from "node:path";
import {
  emitSecurityLogEvent,
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemBinary,
  resolveWindowsSystemDirectory,
  securityErrorKind,
  type SecurityLogSink,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BASE64,
  WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BYTE_LENGTH,
  WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256,
  WINDOWS_RFC3161_VERIFIER_SOURCE,
  WINDOWS_RFC3161_VERIFIER_SOURCE_SHA256,
} from "./windowsPortableAuthenticodeVerifier.generated.js";

export { WINDOWS_RFC3161_VERIFIER_SOURCE };

const WINDOWS_SIGNATURE_TIMEOUT_MS = 10_000;
const WINDOWS_SIGNER_THUMBPRINT = /^[A-F0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
let validatedVerifierAssemblyInput: string | undefined;

export interface WindowsAuthenticodeCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly windowsHide: boolean;
}

export interface WindowsAuthenticodeCommandResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type WindowsAuthenticodeCommandRunner = (
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
) => WindowsAuthenticodeCommandResult;

export type WindowsAuthenticodeAsyncCommandRunner = (
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
) => Promise<WindowsAuthenticodeCommandResult>;

export interface WindowsAuthenticodeSystemOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly existsAsFile?: WindowsBinaryExistsCheck | undefined;
  readonly identityCheck?: WindowsSystemDirectoryIdentityCheck | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export interface WindowsAuthenticodeSystem {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}

function logSystemResolutionFailure(error: unknown, sink: SecurityLogSink | undefined): void {
  const target = sink ?? processServerLogSink();
  if (error instanceof WindowsSystemDirectoryError) {
    emitSecurityLogEvent(target, {
      level: "warn",
      category: "security",
      op: "portable.windows-authenticode.system-binary-refused",
      correlationId: UNKNOWN_CORRELATION_ID,
      errorKind: securityErrorKind(error),
    });
  } else if (error instanceof WindowsSystemBinaryMissingError) {
    emitSecurityLogEvent(target, {
      level: "error",
      category: "diagnostic",
      op: "portable.windows-authenticode.system-binary-refused",
      correlationId: UNKNOWN_CORRELATION_ID,
      errorKind: securityErrorKind(error),
    });
  }
}

export function resolveWindowsAuthenticodeSystem(
  options: WindowsAuthenticodeSystemOptions = {},
): WindowsAuthenticodeSystem {
  const env = options.env ?? process.env;
  try {
    const systemRoot = resolveWindowsSystemDirectory(env, options.identityCheck);
    const command = resolveWindowsPowerShellExecutable(
      env,
      options.existsAsFile,
      options.identityCheck,
    );
    const cmd = resolveWindowsSystemBinary(
      "cmd.exe",
      env,
      options.existsAsFile,
      options.identityCheck,
    );
    return {
      command,
      env: {
        ComSpec: cmd,
        PATH: `${win32Path.dirname(cmd)};${systemRoot}`,
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      },
    };
  } catch (error) {
    logSystemResolutionFailure(error, options.securityLogSink);
    throw error;
  }
}

export function windowsSystemEnvironment(
  options: WindowsAuthenticodeSystemOptions = {},
): NodeJS.ProcessEnv {
  return resolveWindowsAuthenticodeSystem(options).env;
}

function authenticodeResult(
  executable: string,
  run: WindowsAuthenticodeCommandRunner,
  systemOptions: WindowsAuthenticodeSystemOptions,
): WindowsAuthenticodeCommandResult {
  const system = resolveWindowsAuthenticodeSystem(systemOptions);
  return run(
    system.command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsAuthenticodeIdentityScript(),
      executable,
    ],
    {
      env: system.env,
      timeout: WINDOWS_SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

function acceptedSignerIdentity(result: WindowsAuthenticodeCommandResult): string | undefined {
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") return undefined;
  const identity = result.stdout.trim().toUpperCase();
  return result.status === 0 && result.stderr === "" && WINDOWS_SIGNER_THUMBPRINT.test(identity)
    ? identity
    : undefined;
}

export function windowsAuthenticodeIdentityScript(): string {
  return (
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate" +
    " -or $null -eq $s.TimeStamperCertificate){exit 1};" +
    "[Console]::Out.Write($s.SignerCertificate.Thumbprint)"
  );
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateWindowsAuthenticodeVerifierAssembly(
  encoded = WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BASE64,
): string {
  if (
    !SHA256_PATTERN.test(WINDOWS_RFC3161_VERIFIER_SOURCE_SHA256) ||
    sha256Hex(Buffer.from(WINDOWS_RFC3161_VERIFIER_SOURCE, "utf8")) !==
      WINDOWS_RFC3161_VERIFIER_SOURCE_SHA256 ||
    !BASE64_PATTERN.test(encoded)
  ) {
    throw new Error("Windows Authenticode verifier asset is invalid");
  }
  const assembly = Buffer.from(encoded, "base64");
  if (
    assembly.toString("base64") !== encoded ||
    assembly.byteLength !== WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BYTE_LENGTH ||
    !SHA256_PATTERN.test(WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256) ||
    sha256Hex(assembly) !== WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256
  ) {
    throw new Error("Windows Authenticode verifier asset is invalid");
  }
  return encoded;
}

export function windowsAuthenticodeVerifierAssemblyInput(): string {
  validatedVerifierAssemblyInput ??= validateWindowsAuthenticodeVerifierAssembly();
  return validatedVerifierAssemblyInput;
}

export function windowsAuthenticodeVerifierLoaderScript(): string {
  const encodedLength = WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BASE64.length;
  return (
    "$ErrorActionPreference='Stop';" +
    `$n=${String(encodedLength)};$r=[Console]::In;$c=[char[]]::new($n+1);$o=0;` +
    "while($o -lt $c.Length){$k=$r.Read($c,$o,$c.Length-$o);if($k -eq 0){break};$o+=$k};" +
    "if($o -ne $n -or $r.Peek() -ne -1){exit 1};" +
    "$s=[string]::new($c,0,$o);try{$b=[Convert]::FromBase64String($s)}catch{exit 1};" +
    `if($b.Length -ne ${String(WINDOWS_RFC3161_VERIFIER_ASSEMBLY_BYTE_LENGTH)}){exit 1};` +
    "$h=[Security.Cryptography.SHA256]::Create();try{" +
    "$d=[BitConverter]::ToString($h.ComputeHash($b)).Replace('-','').ToLowerInvariant()" +
    `}finally{$h.Dispose()};if($d -cne '${WINDOWS_RFC3161_VERIFIER_ASSEMBLY_SHA256}'){exit 1};` +
    "try{[Reflection.Assembly]::Load($b)|Out-Null}catch{exit 1};"
  );
}

export function windowsAuthenticodePublisherIdentityScript(): string {
  return (
    windowsAuthenticodeVerifierLoaderScript() +
    "function E($c){@($c.Extensions|?{$_.Oid.Value -eq '2.5.29.37'}|%{" +
    "([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($_,$_.Critical)).EnhancedKeyUsages|%{$_.Value}})};" +
    String.raw`function P($c){@(Get-ChildItem -LiteralPath Cert:\LocalMachine\AuthRoot|?{$_.Thumbprint -eq $c.Thumbprint}).Count -eq 1};` +
    "function R($c,$time,$eku){$x=[Security.Cryptography.X509Certificates.X509Chain]::new();try{" +
    "$x.ChainPolicy.RevocationMode='Online';$x.ChainPolicy.RevocationFlag='EntireChain';" +
    "$x.ChainPolicy.VerificationTime=$time.UtcDateTime;" +
    "$x.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new($eku));" +
    "if(-not $x.Build($c) -or $x.ChainElements.Count -lt 2){return $null};" +
    "$z=$x.ChainElements[$x.ChainElements.Count-1].Certificate;if(-not (P $z)){return $null};$z.Thumbprint}finally{$x.Dispose()}};" +
    "$p=Get-Item -LiteralPath $args[0] -Force;" +
    "$f=@(if($p.PSIsContainer){Get-ChildItem -LiteralPath $p.FullName -Recurse -Force -File|" +
    "?{$_.Extension -in '.exe','.dll','.node'}}else{$p});if($f.Count -eq 0){exit 1};" +
    "$i=$null;$r=$null;$l=$null;" +
    "foreach($v in $f){$s=Get-AuthenticodeSignature -LiteralPath $v.FullName;" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $null -eq $s.TimeStamperCertificate){exit 1};" +
    "$q=[Keiko.Portable.Runtime.Rfc3161]::VerifyFile($v.FullName);" +
    "if(-not $q.Valid -or $q.Certificates.Count -ne 1 -or $q.GenerationTimes.Count -ne 1){exit 1};" +
    "if($s.TimeStamperCertificate.Thumbprint -ne $q.Certificates[0].Thumbprint){exit 1};" +
    "$e=@(E $s.SignerCertificate);$j=@($e|?{$_ -match '^1[.]3[.]6[.]1[.]4[.]1[.]311[.]97[.][0-9]+(?:[.][0-9]+)*$'});" +
    "$sr=R $s.SignerCertificate $q.GenerationTimes[0] '1.3.6.1.5.5.7.3.3';" +
    "$tr=R $q.Certificates[0] $q.GenerationTimes[0] '1.3.6.1.5.5.7.3.8';" +
    "if($e -notcontains '1.3.6.1.5.5.7.3.3' -or $j.Count -ne 1 -or $null -eq $sr){exit 1};" +
    "if($null -eq $tr){exit 1};" +
    "$sl=$s.SignerCertificate.Thumbprint;" +
    "if($null -eq $i){$i=$j[0];$r=$sr;$l=$sl}elseif($i -ne $j[0] -or $r -ne $sr -or $l -ne $sl){exit 1}};" +
    "[Console]::Out.Write(('{0}|{1}|{2}' -f $i,$r,$l))"
  );
}

export function windowsSignerIdentity(
  executable: string,
  run: WindowsAuthenticodeCommandRunner = runWindowsAuthenticodeCommand,
  systemOptions: WindowsAuthenticodeSystemOptions = {},
): string | undefined {
  return acceptedSignerIdentity(authenticodeResult(executable, run, systemOptions));
}

export function windowsPublisherIdentityMatches(
  trustedLauncher: string,
  executable: string,
  run: WindowsAuthenticodeCommandRunner = runWindowsAuthenticodeCommand,
  systemOptions: WindowsAuthenticodeSystemOptions = {},
): boolean {
  const trustedIdentity = windowsSignerIdentity(trustedLauncher, run, systemOptions);
  return (
    trustedIdentity !== undefined &&
    windowsSignerIdentity(executable, run, systemOptions) === trustedIdentity
  );
}

export async function windowsPublisherIdentityMatchesAsync(
  trustedLauncher: string,
  executable: string,
  run: WindowsAuthenticodeAsyncCommandRunner = runWindowsAuthenticodeCommandAsync,
  systemOptions: WindowsAuthenticodeSystemOptions = {},
): Promise<boolean> {
  const trustedIdentity = await windowsSignerIdentityAsync(trustedLauncher, run, systemOptions);
  return (
    trustedIdentity !== undefined &&
    (await windowsSignerIdentityAsync(executable, run, systemOptions)) === trustedIdentity
  );
}

async function windowsSignerIdentityAsync(
  executable: string,
  run: WindowsAuthenticodeAsyncCommandRunner,
  systemOptions: WindowsAuthenticodeSystemOptions,
): Promise<string | undefined> {
  const system = resolveWindowsAuthenticodeSystem(systemOptions);
  const result = await run(
    system.command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsAuthenticodeIdentityScript(),
      executable,
    ],
    {
      env: system.env,
      timeout: WINDOWS_SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const identity = result.stdout.trim().toUpperCase();
  return result.status === 0 && result.stderr === "" && WINDOWS_SIGNER_THUMBPRINT.test(identity)
    ? identity
    : undefined;
}

function runWindowsAuthenticodeCommandAsync(
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
): Promise<WindowsAuthenticodeCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: options.env,
        shell: false,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
      },
      (error, stdout, stderr) => {
        let status: number | null = null;
        if (error === null) {
          status = 0;
        } else if (typeof error.code === "number") {
          status = error.code;
        }
        resolve({
          status,
          stderr,
          stdout,
        });
      },
    );
  });
}

function runWindowsAuthenticodeCommand(
  command: string,
  args: readonly string[],
  options: WindowsAuthenticodeCommandOptions,
): WindowsAuthenticodeCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: options.env,
    shell: false,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}
