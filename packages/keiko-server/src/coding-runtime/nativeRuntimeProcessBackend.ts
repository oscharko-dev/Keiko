import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import type { LongLivedRuntimeQualification } from "@oscharko-dev/keiko-sandbox";

import { encodeLaunchPacket, validateLaunchPacketRequest } from "./nativeRuntimeProcessProtocol.js";
import {
  invalidRequest,
  pathIsContained,
  safeRealDirectory,
  safeRealFile,
} from "./nativeRuntimeProcessPaths.js";
import { NativeRuntimeTree, type NativeRuntimeHelperProcess } from "./nativeRuntimeProcessTree.js";
import type {
  RuntimeProcessBackend,
  RuntimeProcessTree,
  RuntimeSupervisorLaunchRequest,
  RuntimeTreeSignal,
} from "./runtimeProcessSupervisor.js";

export type { NativeRuntimeHelperProcess } from "./nativeRuntimeProcessTree.js";

export interface NativeRuntimeHelperSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly windowsHide: true;
}

export type NativeRuntimeHelperSpawn = (
  helperPath: string,
  args: readonly string[],
  options: NativeRuntimeHelperSpawnOptions,
) => NativeRuntimeHelperProcess;

export interface NativeRuntimeProcessBackendOptions {
  readonly helperPath: string;
  readonly runtimeRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly identity?: Pick<LongLivedRuntimeQualification, "platform" | "arch" | "backend">;
  readonly spawnHelper?: NativeRuntimeHelperSpawn | undefined;
}

export interface NativeRuntimeRecoveryPort {
  reconcile(recoveryHandle: string, timeoutMs: number): Promise<boolean>;
}

interface ValidatedBackendOptions {
  readonly helperPath: string;
  readonly runtimeRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly identity: Pick<LongLivedRuntimeQualification, "platform" | "arch" | "backend">;
  readonly spawnHelper: NativeRuntimeHelperSpawn;
}

export function createNativeRuntimeProcessBackend(
  options: NativeRuntimeProcessBackendOptions,
): RuntimeProcessBackend {
  return new NativeRuntimeProcessBackend(validateBackendOptions(options));
}

export function createNativeRuntimeRecoveryPort(
  options: Pick<NativeRuntimeProcessBackendOptions, "helperPath" | "spawnHelper">,
): NativeRuntimeRecoveryPort {
  const helperPath = safeRealFile(options.helperPath);
  const spawnHelper = options.spawnHelper ?? spawnNativeHelper;
  return {
    reconcile: (recoveryHandle, timeoutMs) =>
      reconcileRecoveryHandle(helperPath, spawnHelper, recoveryHandle, timeoutMs),
  };
}

class NativeRuntimeProcessBackend implements RuntimeProcessBackend {
  public readonly identity;

  public constructor(private readonly options: ValidatedBackendOptions) {
    this.identity = Object.freeze({ ...options.identity });
  }

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    validateLaunchPacketRequest(request, {
      ...this.options,
      safeRealFile,
      safeRealDirectory,
      pathIsContained,
      invalidRequest,
    });
    const recoveryHandle = request.recoveryHandle;
    const packet = encodeLaunchPacket(request);
    const child = this.options.spawnHelper(this.options.helperPath, [], {
      cwd: dirname(this.options.helperPath),
      env: {},
      shell: false,
      windowsHide: true,
    });
    const tree = new NativeRuntimeTree(recoveryHandle, child);
    child.controlInput.write(packet);
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    // The portable GUI helper cannot assume that a shared Windows console exists, so both
    // shutdown modes terminate the contained Job Object; the distinction is retained in the
    // protocol for a future qualified cooperative-shutdown implementation.
    nativeTree(tree).sendControl(signal === "graceful" ? 2 : 3);
  }

  public waitForCompleteTreeExit(tree: RuntimeProcessTree, timeoutMs: number): Promise<boolean> {
    return nativeTree(tree).waitForProof(timeoutMs);
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve(nativeTree(tree).hasReapProof());
  }
}

function validateBackendOptions(
  options: NativeRuntimeProcessBackendOptions,
): ValidatedBackendOptions {
  const helperPath = safeRealFile(options.helperPath);
  const workspaceRoot = safeRealDirectory(options.workspaceRoot);
  if (options.runtimeRoots.length === 0 || options.runtimeRoots.length > 8) {
    throw new Error("native-runtime-config-invalid");
  }
  const runtimeRoots = options.runtimeRoots.map(safeRealDirectory);
  return {
    helperPath,
    workspaceRoot,
    runtimeRoots,
    identity:
      options.identity ??
      Object.freeze({
        platform: "win32" as const,
        arch: "x64" as const,
        backend: "windows-job-object" as const,
      }),
    spawnHelper: options.spawnHelper ?? spawnNativeHelper,
  };
}

function spawnNativeHelper(
  helperPath: string,
  args: readonly string[],
  options: NativeRuntimeHelperSpawnOptions,
): NativeRuntimeHelperProcess {
  const child = spawn(helperPath, args, {
    ...options,
    detached: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const [stdin, stdout, stderr, controlInput, controlOutput] = child.stdio;
  if (
    !(stdin instanceof Writable) ||
    !(stdout instanceof Readable) ||
    !(stderr instanceof Readable) ||
    !(controlInput instanceof Writable) ||
    !(controlOutput instanceof Readable)
  ) {
    throw new TypeError("native-runtime-helper-pipes-unavailable");
  }
  return {
    stdin,
    stdout,
    stderr,
    controlInput,
    controlOutput,
    onExit: (listener): void => {
      child.once("exit", listener);
    },
    onError: (listener): void => {
      child.once("error", listener);
    },
  };
}

async function reconcileRecoveryHandle(
  helperPath: string,
  spawnHelper: NativeRuntimeHelperSpawn,
  recoveryHandle: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/u.test(recoveryHandle)) invalidRequest();
  const child = spawnHelper(helperPath, ["--reconcile", recoveryHandle], {
    cwd: dirname(helperPath),
    env: {},
    shell: false,
    windowsHide: true,
  });
  const tree = new NativeRuntimeTree(recoveryHandle, child);
  return tree.waitForProof(timeoutMs);
}

function nativeTree(tree: RuntimeProcessTree): NativeRuntimeTree {
  if (!(tree instanceof NativeRuntimeTree)) throw new Error("native-runtime-tree-not-owned");
  return tree;
}
