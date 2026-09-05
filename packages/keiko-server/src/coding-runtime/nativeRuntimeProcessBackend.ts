import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  copyRuntimeGatewayConfinement,
  GATEWAY_UNSUPPORTED_ON_HOST_REASON,
  type LongLivedRuntimeQualification,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";

import { errorKindOf, type ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { processServerLogSink } from "../process-log-sink.js";
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
  readonly expectedHelperSha256?: string | undefined;
  readonly runtimeRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly identity?: Pick<LongLivedRuntimeQualification, "platform" | "arch" | "backend">;
  readonly spawnHelper?: NativeRuntimeHelperSpawn | undefined;
  /**
   * When a caller attaches a gateway-allowlist policy (ADR-0043 D14, #2951), every launch through
   * this backend fails closed: the native launch-packet protocol has no field for a network
   * policy, and no backend behind the Windows Job Object / native helper protocol can bind that
   * process to exactly one loopback destination today. This option exists so a caller CAN express
   * "this run requires gateway confinement" and get an honest refusal rather than an unconfined
   * spawn; it does not (yet) enforce anything at the OS level.
   */
  readonly gatewayConfinement?: RuntimeGatewayConfinement | undefined;
  /** Activity-log port for the closed gateway-confinement refusal below; defaults to the process sink. */
  readonly activityLog?: ServerLogSink | undefined;
}

export interface NativeRuntimeRecoveryPort {
  reconcile(recoveryHandle: string, timeoutMs: number): Promise<boolean>;
}

interface ValidatedBackendOptions {
  readonly helperPath: string;
  readonly expectedHelperSha256?: string | undefined;
  readonly runtimeRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly identity: Pick<LongLivedRuntimeQualification, "platform" | "arch" | "backend">;
  readonly spawnHelper: NativeRuntimeHelperSpawn;
  readonly gatewayConfinement?: RuntimeGatewayConfinement | undefined;
  readonly activityLog: ServerLogSink;
}

export function createNativeRuntimeProcessBackend(
  options: NativeRuntimeProcessBackendOptions,
): RuntimeProcessBackend {
  return new NativeRuntimeProcessBackend(validateBackendOptions(options));
}

export function createNativeRuntimeRecoveryPort(
  options: Pick<
    NativeRuntimeProcessBackendOptions,
    "helperPath" | "expectedHelperSha256" | "spawnHelper"
  >,
): NativeRuntimeRecoveryPort {
  const helperPath = safeRealFile(options.helperPath);
  const expectedHelperSha256 = validExpectedHelperSha256(options.expectedHelperSha256);
  const spawnHelper = options.spawnHelper ?? spawnNativeHelper;
  return {
    reconcile: (recoveryHandle, timeoutMs) =>
      reconcileRecoveryHandle(
        helperPath,
        expectedHelperSha256,
        spawnHelper,
        recoveryHandle,
        timeoutMs,
      ),
  };
}

class NativeRuntimeProcessBackend implements RuntimeProcessBackend {
  public readonly identity;

  public constructor(private readonly options: ValidatedBackendOptions) {
    this.identity = Object.freeze({ ...options.identity });
  }

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    try {
      assertGatewayConfinementUnsupported(this.options.gatewayConfinement, request);
    } catch (error) {
      recordNativeConfinementFailure(this.options.activityLog, request.runId, error);
      throw error;
    }
    const paths = validateLaunchPacketRequest(request, {
      ...this.options,
      safeRealFile,
      safeRealDirectory,
      pathIsContained,
      invalidRequest,
    });
    const recoveryHandle = request.recoveryHandle;
    const packet = encodeLaunchPacket(request, paths);
    const child = spawnVerifiedHelper(
      this.options.helperPath,
      this.options.expectedHelperSha256,
      this.options.spawnHelper,
      [],
    );
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
  const expectedHelperSha256 = validExpectedHelperSha256(options.expectedHelperSha256);
  const workspaceRoot = safeRealDirectory(options.workspaceRoot);
  if (options.runtimeRoots.length === 0 || options.runtimeRoots.length > 8) {
    throw new Error("native-runtime-config-invalid");
  }
  const runtimeRoots = options.runtimeRoots.map(safeRealDirectory);
  const gatewayConfinement = validGatewayConfinement(options.gatewayConfinement);
  return {
    helperPath,
    ...(expectedHelperSha256 === undefined ? {} : { expectedHelperSha256 }),
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
    activityLog: options.activityLog ?? processServerLogSink(),
    ...(gatewayConfinement === undefined ? {} : { gatewayConfinement }),
  };
}

/**
 * Body-free evidence for the closed native-lane gateway-confinement refusal (ADR-0043 D14, #2951):
 * the macOS dev-lane path already records `runtime.confinement.failed` for the same class of
 * refusal (`devLaneRuntimeProcessBackend.ts`'s `recordConfinementFailure`); this backend must not
 * fail silently just because its refusal is synchronous and pre-spawn. Same op, same shape, same
 * correlation id — a support bundle reconstructs either lane's refusal identically.
 */
function recordNativeConfinementFailure(sink: ServerLogSink, runId: string, error: unknown): void {
  sink.write({
    category: "process",
    level: "error",
    op: "runtime.confinement.failed",
    correlationId: runId,
    errorKind: errorKindOf(error),
    extra: { frames: keikoStackFrames(error), causeChain: causeChain(error) },
  });
}

function validGatewayConfinement(
  value: RuntimeGatewayConfinement | undefined,
): RuntimeGatewayConfinement | undefined {
  if (value === undefined) return undefined;
  const closed = copyRuntimeGatewayConfinement(value);
  if (closed === undefined) throw new Error("native-runtime-config-invalid");
  return closed;
}

/**
 * Fails a gateway-confined launch closed rather than spawning it unconfined (ADR-0043 D14, ADR-0140
 * D6, #2951). The reason text is imported from keiko-sandbox, not restated, so this backend reports
 * the identical "unsupported-on-this-host" refusal `planIsolatedRun` would produce for the same
 * unsupported host instead of a second, independently-worded string.
 */
function assertGatewayConfinementUnsupported(
  policy: RuntimeGatewayConfinement | undefined,
  request: RuntimeSupervisorLaunchRequest,
): void {
  if (policy === undefined) return;
  if (policy.runId !== request.runId || policy.treeBindingId !== request.treeBindingId) {
    throw new Error("runtime-gateway-confinement-drift");
  }
  throw new Error(GATEWAY_UNSUPPORTED_ON_HOST_REASON);
}

function validExpectedHelperSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("native-runtime-config-invalid");
  return value;
}

interface VerifiedHelperExecutionCopy {
  readonly path: string;
  cleanup(): void;
}

function spawnVerifiedHelper(
  helperPath: string,
  expectedHelperSha256: string | undefined,
  spawnHelper: NativeRuntimeHelperSpawn,
  args: readonly string[],
): NativeRuntimeHelperProcess {
  if (expectedHelperSha256 === undefined)
    return spawnHelper(helperPath, args, nativeSpawnOptions(helperPath));
  const executionCopy = verifiedHelperExecutionCopy(helperPath, expectedHelperSha256);
  try {
    const child = spawnHelper(executionCopy.path, args, nativeSpawnOptions(executionCopy.path));
    child.onExit((): void => {
      executionCopy.cleanup();
    });
    child.onError((): void => {
      executionCopy.cleanup();
    });
    return child;
  } catch (error) {
    executionCopy.cleanup();
    throw error;
  }
}

function nativeSpawnOptions(helperPath: string): NativeRuntimeHelperSpawnOptions {
  return { cwd: dirname(helperPath), env: {}, shell: false, windowsHide: true };
}

function verifiedHelperExecutionCopy(
  helperPath: string,
  expectedHelperSha256: string,
): VerifiedHelperExecutionCopy {
  const bytes = readFileSync(helperPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedHelperSha256) throw new Error("native-runtime-helper-digest-mismatch");
  const directory = mkdtempSync(join(tmpdir(), "keiko-native-runtime-"));
  const path = join(directory, basename(helperPath));
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o700 });
    return {
      path,
      cleanup: (): void => {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
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
  expectedHelperSha256: string | undefined,
  spawnHelper: NativeRuntimeHelperSpawn,
  recoveryHandle: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/u.test(recoveryHandle)) invalidRequest();
  const child = spawnVerifiedHelper(helperPath, expectedHelperSha256, spawnHelper, [
    "--reconcile",
    recoveryHandle,
  ]);
  const tree = new NativeRuntimeTree(recoveryHandle, child);
  return tree.waitForProof(timeoutMs);
}

function nativeTree(tree: RuntimeProcessTree): NativeRuntimeTree {
  if (!(tree instanceof NativeRuntimeTree)) throw new Error("native-runtime-tree-not-owned");
  return tree;
}
