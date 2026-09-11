import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import {
  type PortablePlatformVerificationInput,
  PortableUpdateStagingError,
} from "./update-portable-staging-shared.js";
import {
  resolveWindowsAuthenticodeSystem,
  type WindowsAuthenticodeSystem,
  type WindowsAuthenticodeSystemOptions,
  windowsAuthenticodePublisherIdentityScript,
  windowsAuthenticodeVerifierAssemblyInput,
} from "./coding-runtime/windowsPortableAuthenticode.js";
import { discoverQualifiedPortableOpenCode } from "./coding-runtime/productionPortableCodingRuntime.js";

const VERIFY_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 16_384;

type PlatformCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  stdin: string | undefined,
) => Promise<string>;

export interface PortablePlatformVerifierOptions {
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly linuxRuntimeVerifier?: ((resourceRoot: string) => boolean) | undefined;
  readonly runCommand?: PlatformCommandRunner | undefined;
  readonly windowsSystem?: WindowsAuthenticodeSystemOptions | undefined;
}

function targetHostPlatform(target: UpdatePortableTarget): NodeJS.Platform {
  if (target === "linux-x64") return "linux";
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

function spawnPipedCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: string | undefined,
): { readonly child: ChildProcess; readonly stderr: Readable; readonly stdout: Readable } {
  const child = spawn(command, [...args], {
    env,
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const { stderr, stdout } = child;
  if (stdout === null || stderr === null) {
    child.kill();
    throw commandFailed(command);
  }
  return { child, stderr, stdout };
}

function writeCommandInput(child: ChildProcess, stdin: string | undefined): void {
  if (stdin === undefined) return;
  child.stdin?.once("error", () => child.kill());
  child.stdin?.end(stdin, "ascii");
}

function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  stdin: string | undefined,
): Promise<string> {
  return new Promise((resolveDone, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    let spawned: ReturnType<typeof spawnPipedCommand>;
    try {
      spawned = spawnPipedCommand(command, args, env, stdin);
    } catch (error) {
      reject(error instanceof Error ? error : commandFailed(command));
      return;
    }
    const { child, stderr, stdout } = spawned;
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
    stdout.on("data", appendOutput);
    stderr.on("data", appendOutput);
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
    writeCommandInput(child, stdin);
  });
}

function requireCurrentPath(path: string | undefined): string {
  if (path === undefined) {
    throw verifierUnavailable("active portable signing identity is unavailable");
  }
  return path;
}

interface WindowsPublisherIdentity {
  readonly subscriberEku: string;
  readonly rootThumbprint: string;
}

function windowsSignerIdentity(output: string): WindowsPublisherIdentity {
  const [subscriberEku, rootThumbprint, leafThumbprint, ...extra] = output.trim().split("|");
  if (
    extra.length > 0 ||
    subscriberEku === undefined ||
    !/^1\.3\.6\.1\.4\.1\.311\.97\.\d+(?:\.\d+)*$/u.test(subscriberEku) ||
    rootThumbprint === undefined ||
    !/^[A-F0-9]{40,128}$/u.test(rootThumbprint) ||
    leafThumbprint === undefined ||
    !/^[A-F0-9]{40,128}$/u.test(leafThumbprint)
  ) {
    throw verifierUnavailable("windows portable signer identity is unavailable");
  }
  return { subscriberEku, rootThumbprint };
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

function assertSameWindowsPublisher(
  staged: WindowsPublisherIdentity,
  current: WindowsPublisherIdentity,
): void {
  if (
    staged.subscriberEku !== current.subscriberEku ||
    staged.rootThumbprint !== current.rootThumbprint
  ) {
    throw verifierUnavailable("portable signer identity does not match the active install");
  }
}

async function verifyWindowsPath(
  path: string,
  signal: AbortSignal | undefined,
  commandRunner: PlatformCommandRunner,
  system: WindowsAuthenticodeSystem,
): Promise<WindowsPublisherIdentity> {
  const output = await commandRunner(
    system.command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsAuthenticodePublisherIdentityScript(),
      path,
    ],
    system.env,
    signal,
    windowsAuthenticodeVerifierAssemblyInput(),
  );
  return windowsSignerIdentity(output);
}

async function verifyWindows(
  input: PortablePlatformVerificationInput,
  commandRunner: PlatformCommandRunner,
  systemOptions: WindowsAuthenticodeSystemOptions | undefined,
): Promise<void> {
  const system = resolveWindowsAuthenticodeSystem(systemOptions);
  const staged = await verifyWindowsPath(input.stagedRoot, input.signal, commandRunner, system);
  const current = await verifyWindowsPath(
    requireCurrentPath(input.currentLauncherPath),
    input.signal,
    commandRunner,
    system,
  );
  assertSameWindowsPublisher(staged, current);
}

async function verifyMacosBundle(
  bundlePath: string,
  signal: AbortSignal | undefined,
  commandRunner: PlatformCommandRunner,
): Promise<string> {
  await commandRunner(
    "codesign",
    ["--verify", "--deep", "--strict", bundlePath],
    {},
    signal,
    undefined,
  );
  await commandRunner("xcrun", ["stapler", "validate", bundlePath], {}, signal, undefined);
  await commandRunner(
    "spctl",
    ["--assess", "--type", "execute", bundlePath],
    {},
    signal,
    undefined,
  );
  return macosTeamIdentifier(
    await commandRunner(
      "codesign",
      ["--display", "--verbose=4", bundlePath],
      {},
      signal,
      undefined,
    ),
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

function productionLinuxRuntimeVerified(resourceRoot: string): boolean {
  const runtime = discoverQualifiedPortableOpenCode({
    env: {},
    platform: "linux",
    arch: "x64",
    installRoot: resourceRoot,
  });
  return (
    runtime?.target === "linux-x64" &&
    runtime.platformAssurance === "release-qualified" &&
    runtime.qualification.backend === "linux-namespace-gateway"
  );
}

function verifyLinux(
  input: PortablePlatformVerificationInput,
  verifier: (resourceRoot: string) => boolean,
): void {
  const resourceRoot = dirname(input.launcherPath);
  if (!verifier(resourceRoot)) {
    throw verifierUnavailable("Linux qualification and Sigstore evidence did not verify");
  }
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
      await verifyWindows(input, commandRunner, options.windowsSystem);
      return;
    }
    if (input.target === "linux-x64") {
      verifyLinux(input, options.linuxRuntimeVerifier ?? productionLinuxRuntimeVerified);
      return;
    }
    await verifyMacos(input, commandRunner);
  };
}

export const verifyPortablePlatformSignature = createPortablePlatformVerifier();
