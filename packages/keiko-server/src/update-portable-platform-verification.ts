import { spawn, type ChildProcess } from "node:child_process";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import {
  type PortablePlatformVerificationInput,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";

const VERIFY_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 16_384;

type PlatformCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
) => Promise<string>;

export interface PortablePlatformVerifierOptions {
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly runCommand?: PlatformCommandRunner | undefined;
}

function targetHostPlatform(target: UpdatePortableTarget): NodeJS.Platform {
  return target === "windows-x64" ? "win32" : "darwin";
}

function verifierUnavailable(message: string): PortableUpdateStagingError {
  return new PortableUpdateStagingError("portable-verification-failed", message);
}

function commandFailed(command: string): PortableUpdateStagingError {
  return new PortableUpdateStagingError(
    "portable-verification-failed",
    `${command} did not verify the staged portable payload`,
  );
}

function abortError(): PortableUpdateStagingError {
  return new PortableUpdateStagingError(
    "cancelled",
    "portable platform verification was cancelled",
  );
}

function cleanup(
  child: ChildProcess,
  timer: NodeJS.Timeout,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): void {
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  child.removeAllListeners();
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
}

function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolveDone, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const child = spawn(command, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill(), VERIFY_TIMEOUT_MS);
    const onAbort = (): void => {
      child.kill();
    };
    const appendOutput = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      cleanup(child, timer, signal, onAbort);
      reject(commandFailed(command));
    });
    child.once("close", (code) => {
      cleanup(child, timer, signal, onAbort);
      if (signal?.aborted === true) reject(abortError());
      else if (code === 0 && outputBytes <= MAX_COMMAND_OUTPUT_BYTES) resolveDone(output);
      else reject(commandFailed(command));
    });
  });
}

function verifierEnv(path: string): NodeJS.ProcessEnv {
  return { ...process.env, KEIKO_PORTABLE_VERIFY_PATH: path };
}

function windowsAuthenticodeScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$sig = Get-AuthenticodeSignature -LiteralPath $env:KEIKO_PORTABLE_VERIFY_PATH",
    "if ($sig.Status -ne 'Valid') { exit 1 }",
    "if ($null -eq $sig.SignerCertificate) { exit 1 }",
    "if ($null -eq $sig.TimeStamperCertificate) { exit 1 }",
    "Write-Output $sig.SignerCertificate.Thumbprint",
    "exit 0",
  ].join("; ");
}

function requireCurrentPath(path: string | undefined): string {
  if (path === undefined) {
    throw verifierUnavailable("active portable signing identity is unavailable");
  }
  return path;
}

function windowsSignerIdentity(output: string): string {
  const identity = output.trim().toUpperCase();
  if (!/^[A-F0-9]{40}$/u.test(identity)) {
    throw verifierUnavailable("windows portable signer identity is unavailable");
  }
  return identity;
}

function macosTeamIdentifier(output: string): string {
  const match = /^TeamIdentifier=(?<team>[A-Z0-9]{10})$/mu.exec(output);
  const team = match?.groups?.team;
  if (team === undefined) {
    throw verifierUnavailable("macOS portable signer identity is unavailable");
  }
  return team;
}

function assertSameSignerIdentity(staged: string, current: string): void {
  if (staged !== current) {
    throw verifierUnavailable("portable signer identity does not match the active install");
  }
}

async function verifyWindowsPath(
  path: string,
  signal: AbortSignal | undefined,
  commandRunner: PlatformCommandRunner,
): Promise<string> {
  const output = await commandRunner(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsAuthenticodeScript(),
    ],
    verifierEnv(path),
    signal,
  );
  return windowsSignerIdentity(output);
}

async function verifyWindows(
  input: PortablePlatformVerificationInput,
  commandRunner: PlatformCommandRunner,
): Promise<void> {
  const staged = await verifyWindowsPath(input.launcherPath, input.signal, commandRunner);
  const current = await verifyWindowsPath(
    requireCurrentPath(input.currentLauncherPath),
    input.signal,
    commandRunner,
  );
  assertSameSignerIdentity(staged, current);
}

async function verifyMacosBundle(
  bundlePath: string,
  signal: AbortSignal | undefined,
  commandRunner: PlatformCommandRunner,
): Promise<string> {
  await commandRunner("codesign", ["--verify", "--deep", "--strict", bundlePath], {}, signal);
  await commandRunner("xcrun", ["stapler", "validate", bundlePath], {}, signal);
  await commandRunner("spctl", ["--assess", "--type", "execute", bundlePath], {}, signal);
  return macosTeamIdentifier(
    await commandRunner("codesign", ["--display", "--verbose=4", bundlePath], {}, signal),
  );
}

async function verifyMacos(
  input: PortablePlatformVerificationInput,
  commandRunner: PlatformCommandRunner,
): Promise<void> {
  const bundlePath = input.appBundlePath;
  if (bundlePath === undefined) {
    throw verifierUnavailable("macOS portable bundle path is unavailable");
  }
  const staged = await verifyMacosBundle(bundlePath, input.signal, commandRunner);
  const current = await verifyMacosBundle(
    requireCurrentPath(input.currentAppBundlePath),
    input.signal,
    commandRunner,
  );
  assertSameSignerIdentity(staged, current);
}

export function createPortablePlatformVerifier(
  options: PortablePlatformVerifierOptions = {},
): (input: PortablePlatformVerificationInput) => Promise<void> {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const commandRunner = options.runCommand ?? runCommand;
  return async (input): Promise<void> => {
    if (hostPlatform !== targetHostPlatform(input.target)) {
      throw verifierUnavailable("local platform verifier does not match the portable target");
    }
    if (input.target === "windows-x64") {
      await verifyWindows(input, commandRunner);
      return;
    }
    await verifyMacos(input, commandRunner);
  };
}

export const verifyPortablePlatformSignature = createPortablePlatformVerifier();
