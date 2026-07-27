import { spawnSync } from "node:child_process";

const WINDOWS_SIGNATURE_TIMEOUT_MS = 10_000;
const WINDOWS_SIGNER_THUMBPRINT = /^[A-F0-9]{40}$/u;

export const WINDOWS_SYSTEM_ROOT = String.raw`C:\Windows`;
export const WINDOWS_SYSTEM_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

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

export function windowsSystemEnvironment(): NodeJS.ProcessEnv {
  return {
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    PATH: String.raw`C:\Windows\System32;C:\Windows`,
    SystemRoot: WINDOWS_SYSTEM_ROOT,
    WINDIR: WINDOWS_SYSTEM_ROOT,
  };
}

export function windowsAuthenticodeIdentityScript(): string {
  return (
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate" +
    "-or $null -eq $s.TimeStamperCertificate){exit 1};" +
    "[Console]::Out.Write($s.SignerCertificate.Thumbprint)"
  );
}

export function windowsSignerIdentity(
  executable: string,
  run: WindowsAuthenticodeCommandRunner = runWindowsAuthenticodeCommand,
): string | undefined {
  const result = run(
    WINDOWS_SYSTEM_POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsAuthenticodeIdentityScript(),
      executable,
    ],
    {
      env: windowsSystemEnvironment(),
      timeout: WINDOWS_SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    return undefined;
  }
  const identity = result.stdout.trim().toUpperCase();
  return result.status === 0 && result.stderr === "" && WINDOWS_SIGNER_THUMBPRINT.test(identity)
    ? identity
    : undefined;
}

export function windowsPublisherIdentityMatches(
  trustedLauncher: string,
  executable: string,
  run: WindowsAuthenticodeCommandRunner = runWindowsAuthenticodeCommand,
): boolean {
  const trustedIdentity = windowsSignerIdentity(trustedLauncher, run);
  return (
    trustedIdentity !== undefined && windowsSignerIdentity(executable, run) === trustedIdentity
  );
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
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}
