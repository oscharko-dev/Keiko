import { createHash } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  encodeAppEnvironmentPacket,
  encodeLaunchPacket,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";
import { isProcessId } from "@oscharko-dev/keiko-security/process-scope";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { readNativeUiResponse } from "./native-ui-channel.js";
import { emitNativeUiOwnership } from "./lifecycle-native-activity.js";
import type { PortableLayout, PortableTarget } from "./portable-shared.js";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

export interface NativeUiRuntime {
  readonly launcherPath: string;
  readonly supervisorPath: string;
  readonly supervisorSha256: string;
  readonly nodePath: string;
  readonly cliBinPath: string;
  readonly staticRoot: string;
}

export interface NativeUiLaunch {
  readonly pid: number;
  readonly commit: () => Promise<void>;
  readonly release: () => void;
  readonly abort: () => Promise<boolean>;
}

export async function resolveManagedNativeUiRuntime(
  stateDir: string,
  env: EnvSource,
  home: string,
  platform: NodeJS.Platform,
): Promise<NativeUiRuntime | undefined> {
  if (
    !new Set(["linux", "darwin"]).has(platform) ||
    !existsSync(join(stateDir, "portable-install-state.json"))
  )
    return undefined;
  const { attestedPortableInstallRecord } = await import("./portable-install.js");
  const installed = attestedPortableInstallRecord(stateDir, env, home);
  if (installed?.registration.status !== "managed") return undefined;
  const nativePlatform = nativeUiPlatform(installed.target);
  if (nativePlatform !== platform) return undefined;
  if (installed.layout === undefined) throw new Error("native-ui-install-attestation-unavailable");
  return nativeUiRuntimeForLayout(installed.layout);
}

function nativeUiPlatform(target: PortableTarget): NodeJS.Platform {
  if (target === "linux-x64") return "linux";
  return target.startsWith("macos-") ? "darwin" : "win32";
}

export function nativeUiRuntimeForLayout(
  layout: PortableLayout,
  securityLogSink?: SecurityLogSink,
): NativeUiRuntime {
  try {
    return readNativeUiRuntimeForLayout(layout);
  } catch (error) {
    emitNativeUiOwnership(securityLogSink, "admission", "refused", error);
    throw new Error("installed native runtime could not be verified.", { cause: error });
  }
}

function readNativeUiRuntimeForLayout(layout: PortableLayout): NativeUiRuntime {
  const descriptor = openSync(
    layout.runtimeSupervisorPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n)
      throw new Error("native-ui-supervisor-invalid");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let offset = 0;
    while (BigInt(offset) < before.size) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count <= 0) throw new Error("native-ui-supervisor-changed");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      BigInt(offset) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("native-ui-supervisor-changed");
    return {
      launcherPath: layout.primaryLauncherPath,
      supervisorPath: layout.runtimeSupervisorPath,
      supervisorSha256: hash.digest("hex"),
      nodePath: layout.runtimeNodePath,
      cliBinPath: join(layout.appRoot, "dist", "cli", "index.js"),
      staticRoot: join(layout.appRoot, "dist", "ui", "static"),
    };
  } finally {
    closeSync(descriptor);
  }
}

interface NativeUiStartInput {
  readonly runtime: NativeUiRuntime;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly launchId: string;
  readonly startTimeoutMs: number;
  readonly deadline: number;
  readonly reserve: () => void;
  readonly spawnFn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

function launchPacket(input: NativeUiStartInput): Buffer {
  const env = {
    KEIKO_UI_LAUNCH_ID: input.launchId,
    KEIKO_STATE_DIR: input.env.KEIKO_STATE_DIR ?? "",
    KEIKO_START_TIMEOUT_SECS: String(input.startTimeoutMs / 1000),
  };
  return encodeLaunchPacket(
    { recoveryHandle: input.launchId, args: [...input.args, "--runtime-owner"], env },
    { executable: input.runtime.nodePath, cwd: input.cwd },
  );
}

export class NativeUiAdmissionError extends Error {
  public override readonly name = "NativeUiAdmissionError";
  public constructor(public readonly nativeAuthorityMayBeLive: boolean) {
    super("native-ui-admission-unavailable");
  }
}

/** Linux libuv and the native owner share CLOCK_MONOTONIC; sample before the remaining grant. */
export function nativeUiStartDeadline(deadline: number): string {
  const observed = process.hrtime.bigint() / 1_000_000n;
  const remaining = Math.floor(deadline - performance.now());
  if (!Number.isSafeInteger(remaining) || remaining <= 0)
    throw new Error("native-ui-start-grant-expired");
  return (observed + BigInt(remaining)).toString();
}

export function nativeUiCommitPacket(launchId: string): Buffer {
  const header = Buffer.alloc(12);
  header.write("KRC1");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(32, 8);
  return Buffer.concat([header, Buffer.from(launchId)]);
}

async function waitForOwnerExit(child: ChildProcess): Promise<boolean> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const finish = (confirmed: boolean): void => {
      clearTimeout(timer);
      child.off("exit", exited);
      resolve(confirmed);
    };
    const exited = (): void => {
      finish(true);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, 5000);
    child.once("exit", exited);
  });
}

function ownerPipes(child: ChildProcess): {
  readonly control: Writable;
  readonly response: Readable;
} {
  const control = child.stdio[3],
    response = child.stdio[4];
  if (!(control instanceof Writable) || !(response instanceof Readable)) {
    child.kill("SIGTERM");
    throw new Error("native-ui-owner-channel-unavailable");
  }
  child.on("error", () => {
    control.destroy();
    response.destroy();
  });
  control.on("error", () => {
    response.destroy();
  });
  response.on("error", () => {
    control.destroy();
  });
  return { control, response };
}

interface NativeUiOwner {
  readonly packet: Buffer;
  readonly child: ChildProcess;
  readonly control: Writable;
  readonly response: Readable;
}

function spawnNativeUiOwner(input: NativeUiStartInput): NativeUiOwner {
  let packet: Buffer, child: ChildProcess;
  let deadline: string;
  try {
    packet = Buffer.concat([launchPacket(input), encodeAppEnvironmentPacket(input.env)]);
    deadline = nativeUiStartDeadline(input.deadline);
    input.reserve();
    if (performance.now() >= input.deadline) throw new Error("native-ui-start-grant-expired");
  } catch {
    throw new NativeUiAdmissionError(false);
  }
  try {
    child = input.spawnFn(
      input.runtime.launcherPath,
      ["--own-app-runtime", input.runtime.supervisorPath, input.runtime.supervisorSha256],
      {
        cwd: input.cwd,
        detached: true,
        env: {
          KEIKO_STATE_DIR: input.env.KEIKO_STATE_DIR,
          KEIKO_UI_LAUNCH_ID: input.launchId,
          KEIKO_START_TIMEOUT_SECS: String(input.startTimeoutMs / 1000),
          KEIKO_UI_START_DEADLINE_MS: deadline,
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new NativeUiAdmissionError(true);
  }
  return { child, packet, ...ownerPipes(child) };
}

export async function startNativeUiProcess(input: NativeUiStartInput): Promise<NativeUiLaunch> {
  const { child, packet, control, response } = spawnNativeUiOwner(input);
  const release = (): void => {
    control.end();
    response.destroy();
    child.unref();
  };
  const abort = async (): Promise<boolean> => {
    release();
    return waitForOwnerExit(child);
  };
  try {
    const receipt = readNativeUiResponse(response, 4, 36, input.deadline);
    control.write(packet);
    const bytes = await receipt,
      pid = bytes.readUInt32LE(0);
    if (
      !isProcessId(pid) ||
      pid === child.pid ||
      bytes.subarray(4).toString() !== input.launchId ||
      performance.now() >= input.deadline
    )
      throw new Error("native-ui-owner-root-invalid");
    return {
      pid,
      release,
      abort,
      commit: async (): Promise<void> => {
        const receipt = readNativeUiResponse(response, 5, 32, input.deadline);
        control.write(nativeUiCommitPacket(input.launchId));
        if ((await receipt).toString() !== input.launchId || performance.now() >= input.deadline)
          throw new Error("native-ui-owner-commit-invalid");
      },
    };
  } catch {
    await abort();
    throw new NativeUiAdmissionError(child.pid !== undefined);
  }
}
