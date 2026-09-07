import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { UpdateActivationWalState } from "@oscharko-dev/keiko-contracts";
import {
  portableHandoffPlanSha256,
  portableHandoffRoot,
  readPortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";

const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const ACCEPT_TIMEOUT_MS = 15 * 60 * 1_000;
const COORDINATOR_TEARDOWN_TIMEOUT_MS = 5_000;

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface PortableHandoffCoordinatorPort {
  readonly begin: (input: {
    readonly sessionId: string;
    readonly activationId: string;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<{ readonly coordinatorId: string; readonly acceptedAt: string }>;
}

export interface PortableHandoffPreparedIntent {
  readonly sessionId: string;
  readonly activationWal: UpdateActivationWalState;
}

export interface PortableHandoffAcceptedIntent {
  readonly sessionId: string;
  readonly activationWal: UpdateActivationWalState;
}

export interface PortableHandoffCoordinatorOptions {
  readonly stateDir: string;
  readonly persistPrepared: (intent: PortableHandoffPreparedIntent) => Promise<void>;
  readonly persistAccepted: (intent: PortableHandoffAcceptedIntent) => Promise<void>;
  readonly verifyNativeCopy: (input: {
    readonly kind: "coordinator" | "runtime-supervisor";
    readonly currentPath: string;
    readonly copiedPath: string;
  }) => Promise<void>;
  readonly spawnFn?: SpawnFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly acceptanceTimeoutMs?: number | undefined;
  readonly teardownTimeoutMs?: number | undefined;
}

export class PortableHandoffCoordinatorError extends Error {
  public constructor(
    message: string,
    public readonly nativeAuthorityMayBeLive = false,
  ) {
    super(message);
    this.name = "PortableHandoffCoordinatorError";
  }
}

function fail(message: string): never {
  throw new PortableHandoffCoordinatorError(message);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("portable handoff coordinator was cancelled");
}

interface NativeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

function assertSourceIdentity(path: string, descriptor: number): NativeIdentity {
  const before = lstatSync(path);
  const opened = fstatSync(descriptor);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !opened.isFile() ||
    opened.nlink !== 1 ||
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    opened.size < 1 ||
    opened.size > MAX_NATIVE_BYTES
  )
    fail("portable handoff native source is unsafe");
  return { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs };
}

function assertUnchangedIdentity(before: NativeIdentity, after: NativeIdentity): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    fail("portable handoff native source changed during copy");
  }
}

function copyBytes(
  sourceFd: number,
  destinationFd: number,
): { readonly sha256: string; readonly size: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let copied = 0;
  for (;;) {
    const count = readSync(sourceFd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    copied += count;
    if (copied > MAX_NATIVE_BYTES) fail("portable handoff native source is too large");
    hash.update(buffer.subarray(0, count));
    let offset = 0;
    while (offset < count) offset += writeSync(destinationFd, buffer, offset, count - offset);
  }
  return { sha256: hash.digest("hex"), size: copied };
}

function digestCopiedNative(destination: string, expectedSize: number): string {
  const copiedFd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const copiedStat = fstatSync(copiedFd);
    if (!copiedStat.isFile() || copiedStat.nlink !== 1 || copiedStat.size !== expectedSize) {
      fail("portable handoff native copy is unsafe");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let readBytes = 0;
    for (;;) {
      const count = readSync(copiedFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      readBytes += count;
      if (readBytes > expectedSize || readBytes > MAX_NATIVE_BYTES) {
        fail("portable handoff native copy changed during verification");
      }
      hash.update(buffer.subarray(0, count));
    }
    if (readBytes !== expectedSize)
      fail("portable handoff native copy changed during verification");
    return hash.digest("hex");
  } finally {
    closeSync(copiedFd);
  }
}

function copyVerifiedNative(source: string, destination: string): string {
  const noFollow = constants.O_NOFOLLOW;
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  let destinationFd: number | undefined;
  try {
    const sourceIdentity = assertSourceIdentity(source, sourceFd);
    destinationFd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o700,
    );
    const copied = copyBytes(sourceFd, destinationFd);
    fsyncSync(destinationFd);
    closeSync(destinationFd);
    destinationFd = undefined;
    assertUnchangedIdentity(sourceIdentity, assertSourceIdentity(source, sourceFd));
    renameSync(temporary, destination);
    if (process.platform !== "win32") {
      const parentFd = openSync(dirname(destination), constants.O_RDONLY);
      try {
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
    }
    const actual = digestCopiedNative(destination, copied.size);
    if (actual !== copied.sha256) fail("portable handoff native copy digest mismatch");
    return actual;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
    rmSync(temporary, { force: true });
  }
}

function coordinatorResponse(child: ChildProcess): Readable {
  const response = child.stdio[3];
  if (
    response === undefined ||
    response === null ||
    typeof response === "number" ||
    !("on" in response)
  ) {
    fail("portable handoff coordinator response pipe is unavailable");
  }
  return response as Readable;
}

function awaitCoordinatorAcceptance(
  child: ChildProcess,
  planSha256: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = coordinatorResponse(child);
  return new Promise<void>((resolve, reject) => {
    let bytes = "";
    let settled = false;
    const timer = setTimeout(() => {
      rejectClosed();
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      bytes += chunk.toString("latin1");
      if (bytes.length > 69) rejectClosed();
    };
    const onEnd = (): void => {
      if (bytes !== `KHA1${planSha256}\n`) rejectClosed();
      else {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("error", rejectClosed);
      child.removeListener("exit", rejectClosed);
      response.removeListener("data", onData);
      response.removeListener("end", onEnd);
      signal?.removeEventListener("abort", rejectClosed);
    };
    const rejectClosed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new PortableHandoffCoordinatorError(
          "portable handoff coordinator closed before acceptance",
        ),
      );
    };
    child.once("error", rejectClosed);
    child.once("exit", rejectClosed);
    signal?.addEventListener("abort", rejectClosed, { once: true });
    if (signal?.aborted === true) {
      rejectClosed();
      return;
    }
    response.on("data", onData);
    response.once("end", onEnd);
  });
}

async function cleanupFailedCoordinator(child: ChildProcess, timeoutMs: number): Promise<void> {
  child.stdin?.destroy();
  if (typeof child.exitCode === "number" || typeof child.signalCode === "string") return;
  const exited = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      reject(
        new PortableHandoffCoordinatorError("portable handoff coordinator did not stop", true),
      );
    }, timeoutMs);
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
  try {
    child.kill();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new PortableHandoffCoordinatorError(
        "portable handoff coordinator could not be stopped",
        true,
      );
    }
  }
  await exited;
}

function writeCoordinatorControl(child: ChildProcess, planSha256: string): Promise<void> {
  const control = child.stdin;
  if (control === null) fail("portable handoff coordinator control pipe is unavailable");
  return new Promise<void>((resolve, reject) => {
    control.write(`${planSha256}\n`, (error: Error | null | undefined) => {
      if (error === null || error === undefined) resolve();
      else reject(new PortableHandoffCoordinatorError("portable handoff coordinator pipe failed"));
    });
  });
}

async function prepareCoordinator(
  options: PortableHandoffCoordinatorOptions,
  sessionId: string,
  activationId: string,
  signal: AbortSignal | undefined,
): Promise<{
  readonly coordinator: string;
  readonly coordinatorSha256: string;
  readonly planSha256: string;
  readonly intentRevision: number;
}> {
  const plan = readPortableHandoffPlan(options.stateDir, activationId);
  assertNotAborted(signal);
  if (plan.sessionId !== sessionId) fail("portable handoff session identity does not match");
  const root = portableHandoffRoot(options.stateDir, activationId);
  const extension = process.platform === "win32" ? ".exe" : "";
  const coordinator = join(root, `coordinator${extension}`);
  const supervisor = join(root, `runtime-supervisor${extension}`);
  const current = currentNativeArtifacts(plan);
  try {
    const coordinatorSha256 = copyVerifiedNative(current.coordinator, coordinator);
    const supervisorSha256 = copyVerifiedNative(current.supervisor, supervisor);
    if (
      coordinatorSha256 !== plan.digests.currentLauncherSha256 ||
      supervisorSha256 !== plan.digests.currentSupervisorSha256
    ) {
      fail("portable handoff current native identity changed");
    }
    await options.verifyNativeCopy({
      kind: "coordinator",
      currentPath: current.coordinator,
      copiedPath: coordinator,
    });
    assertNotAborted(signal);
    await options.verifyNativeCopy({
      kind: "runtime-supervisor",
      currentPath: current.supervisor,
      copiedPath: supervisor,
    });
    assertNotAborted(signal);
    const planSha256 = await persistPreparedCoordinator(
      options,
      plan,
      sessionId,
      coordinatorSha256,
    );
    return {
      coordinator,
      coordinatorSha256,
      planSha256,
      intentRevision: plan.aggregateRevision,
    };
  } catch (error) {
    rmSync(coordinator, { force: true });
    rmSync(supervisor, { force: true });
    throw error;
  }
}

async function persistPreparedCoordinator(
  options: PortableHandoffCoordinatorOptions,
  plan: PortableHandoffPlan,
  sessionId: string,
  coordinatorSha256: string,
): Promise<string> {
  const planSha256 = portableHandoffPlanSha256(plan);
  await options.persistPrepared({
    sessionId,
    activationWal: {
      activationId: plan.activationId,
      planSha256,
      coordinatorSha256,
      intentRevision: plan.aggregateRevision,
      checkpoint: "prepared",
      receiptSequence: 0,
    },
  });
  return planSha256;
}

function currentNativeArtifacts(plan: PortableHandoffPlan): {
  readonly coordinator: string;
  readonly supervisor: string;
} {
  if (plan.target === "windows-x64") {
    return {
      coordinator: join(plan.paths.managedRoot, "Keiko.exe"),
      supervisor: join(plan.paths.managedRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    };
  }
  return {
    coordinator: join(plan.paths.managedRoot, "Contents", "MacOS", "Keiko"),
    supervisor: join(
      plan.paths.managedRoot,
      "Contents",
      "Resources",
      "runtime",
      "native",
      "keiko-runtime-supervisor",
    ),
  };
}

export function createPortableHandoffCoordinator(
  options: PortableHandoffCoordinatorOptions,
): PortableHandoffCoordinatorPort {
  return {
    async begin({ sessionId, activationId, signal }): Promise<{
      readonly coordinatorId: string;
      readonly acceptedAt: string;
    }> {
      const prepared = await prepareCoordinator(options, sessionId, activationId, signal);
      const child = (options.spawnFn ?? spawn)(
        prepared.coordinator,
        ["--coordinate-update", activationId],
        {
          detached: true,
          env: { KEIKO_STATE_DIR: options.stateDir },
          stdio: ["pipe", "ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      try {
        await Promise.all([
          writeCoordinatorControl(child, prepared.planSha256),
          awaitCoordinatorAcceptance(
            child,
            prepared.planSha256,
            options.acceptanceTimeoutMs ?? ACCEPT_TIMEOUT_MS,
            signal,
          ),
        ]);
        assertNotAborted(signal);
        await options.persistAccepted({
          sessionId,
          activationWal: {
            activationId,
            planSha256: prepared.planSha256,
            coordinatorSha256: prepared.coordinatorSha256,
            intentRevision: prepared.intentRevision,
            checkpoint: "prepared",
            receiptSequence: 0,
            coordinatorId: prepared.coordinatorSha256,
          },
        });
      } catch (error) {
        await cleanupFailedCoordinator(
          child,
          options.teardownTimeoutMs ?? COORDINATOR_TEARDOWN_TIMEOUT_MS,
        );
        throw error;
      }
      (child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.();
      child.unref();
      return {
        coordinatorId: prepared.coordinatorSha256,
        acceptedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      };
    },
  };
}

export function portableCoordinatorArtifactNames(): readonly string[] {
  const extension = process.platform === "win32" ? ".exe" : "";
  return [`coordinator${extension}`, `runtime-supervisor${extension}`].map((name) =>
    basename(name),
  );
}
