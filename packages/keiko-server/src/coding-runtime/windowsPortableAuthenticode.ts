import { execFile, spawnSync } from "node:child_process";
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

const WINDOWS_SIGNATURE_TIMEOUT_MS = 10_000;
const WINDOWS_SIGNER_THUMBPRINT = /^[A-F0-9]{40}$/u;

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
