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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { UpdateActivationWalState } from "@oscharko-dev/keiko-contracts";
import {
  portableHandoffPlanSha256,
  portableHandoffRoot,
  readPortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";

const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
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
  readonly publishCoordinatorPid: (sessionId: string, coordinatorPid: number) => boolean;
  readonly spawnFn?: SpawnFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly acceptanceTimeoutMs?: number | undefined;
  readonly teardownTimeoutMs?: number | undefined;
}

export class PortableHandoffCoordinatorError extends Error {
  public constructor(
    message: string,
    public readonly nativeAuthorityMayBeLive = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
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

function assertSourceIdentity(path: string, descriptor: number, maxBytes: number): NativeIdentity {
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
    opened.size > maxBytes
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

function assertNoLinkPath(root: string, path: string): void {
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(path);
  const child = relative(canonicalRoot, canonicalPath);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail("portable handoff source escaped its verified root");
  }
  const rootStat = lstatSync(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("portable handoff source path is unsafe");
  }
  let cursor = canonicalRoot;
  const segments = child.split(sep);
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("portable handoff source path is unsafe");
    }
  }
}

function copyBytes(
  sourceFd: number,
  destinationFd: number,
  maxBytes: number,
): { readonly sha256: string; readonly size: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let copied = 0;
  for (;;) {
    const count = readSync(sourceFd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    copied += count;
    if (copied > maxBytes) fail("portable handoff source is too large");
    hash.update(buffer.subarray(0, count));
    let offset = 0;
    while (offset < count) offset += writeSync(destinationFd, buffer, offset, count - offset);
  }
  return { sha256: hash.digest("hex"), size: copied };
}

function digestOpenedFile(descriptor: number, expectedSize: number, maxBytes: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let readBytes = 0;
  for (;;) {
    const count = readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    readBytes += count;
    if (readBytes > expectedSize || readBytes > maxBytes) {
      fail("portable handoff copy changed during verification");
    }
    hash.update(buffer.subarray(0, count));
  }
  if (readBytes !== expectedSize) fail("portable handoff copy changed during verification");
  return hash.digest("hex");
}

function digestCopiedFile(destination: string, expectedSize: number, maxBytes: number): string {
  const copiedFd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const copiedStat = fstatSync(copiedFd);
    if (!copiedStat.isFile() || copiedStat.nlink !== 1 || copiedStat.size !== expectedSize) {
      fail("portable handoff copy is unsafe");
    }
    return digestOpenedFile(copiedFd, expectedSize, maxBytes);
  } finally {
    closeSync(copiedFd);
  }
}

function digestExistingFile(path: string, maxBytes: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = assertSourceIdentity(path, descriptor, maxBytes);
    const digest = digestOpenedFile(descriptor, before.size, maxBytes);
    assertUnchangedIdentity(before, assertSourceIdentity(path, descriptor, maxBytes));
    return digest;
  } finally {
    closeSync(descriptor);
  }
}

function copyVerifiedFile(
  source: string,
  destination: string,
  sourceRoot: string,
  maxBytes: number,
  mode: number,
): string {
  assertNoLinkPath(sourceRoot, source);
  const noFollow = constants.O_NOFOLLOW;
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  let destinationFd: number | undefined;
  try {
    const sourceIdentity = assertSourceIdentity(source, sourceFd, maxBytes);
    destinationFd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      mode,
    );
    const copied = copyBytes(sourceFd, destinationFd, maxBytes);
    fsyncSync(destinationFd);
    closeSync(destinationFd);
    destinationFd = undefined;
    assertUnchangedIdentity(sourceIdentity, assertSourceIdentity(source, sourceFd, maxBytes));
    renameSync(temporary, destination);
    if (process.platform !== "win32") {
      const parentFd = openSync(dirname(destination), constants.O_RDONLY);
      try {
        fsyncSync(parentFd);
      } finally {
        closeSync(parentFd);
      }
    }
    const actual = digestCopiedFile(destination, copied.size, maxBytes);
    if (actual !== copied.sha256) fail("portable handoff copy digest mismatch");
    assertNoLinkPath(sourceRoot, source);
    return actual;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
    rmSync(temporary, { force: true });
  }
}

function copyVerifiedNative(source: string, destination: string, sourceRoot: string): string {
  return copyVerifiedFile(source, destination, sourceRoot, MAX_NATIVE_BYTES, 0o700);
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
    bindAcceptanceListeners(child, response, signal, rejectClosed, onData, onEnd);
  });
}

function bindAcceptanceListeners(
  child: ChildProcess,
  response: Readable,
  signal: AbortSignal | undefined,
  rejectClosed: () => void,
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
): void {
  child.once("error", rejectClosed);
  child.once("exit", rejectClosed);
  signal?.addEventListener("abort", rejectClosed, { once: true });
  if (signal?.aborted === true) {
    rejectClosed();
    return;
  }
  response.on("data", onData);
  response.once("end", onEnd);
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
  const extension = plan.target === "windows-x64" ? ".exe" : "";
  const coordinator = join(root, `coordinator${extension}`);
  const supervisor = join(root, `runtime-supervisor${extension}`);
  try {
    const coordinatorSha256 = await copyAndVerifyNativeArtifacts({
      options,
      plan,
      coordinator,
      supervisor,
      signal,
    });
    snapshotWindowsCapsule(plan, root);
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
    cleanupAfterPreparationFailure(plan, root, coordinator, supervisor, error);
  }
}

function cleanupAfterPreparationFailure(
  plan: PortableHandoffPlan,
  root: string,
  coordinator: string,
  supervisor: string,
  preparationError: unknown,
): never {
  try {
    cleanupPreparedArtifacts(plan, root, coordinator, supervisor);
  } catch (cleanupError) {
    throw new PortableHandoffCoordinatorError(
      "portable handoff preparation cleanup failed",
      false,
      new AggregateError(
        [preparationError, cleanupError],
        "portable handoff preparation and cleanup failed",
      ),
    );
  }
  throw preparationError;
}

function cleanupPreparedArtifacts(
  plan: PortableHandoffPlan,
  root: string,
  coordinator: string,
  supervisor: string,
): void {
  const paths = [coordinator, supervisor];
  if (plan.target === "windows-x64") {
    paths.push(
      ...["launcher.next", "setup-manifest.previous", "setup-manifest.next"].map((name) =>
        join(root, name),
      ),
    );
  }
  const errors: unknown[] = [];
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "prepared artifact cleanup failed");
}

interface WindowsSnapshotArtifact {
  readonly source: string;
  readonly destination: string;
  readonly sourceRoot: string;
  readonly expectedSha256: string;
  readonly maxBytes: number;
  readonly mode: number;
}

function windowsSnapshotArtifacts(
  plan: Extract<PortableHandoffPlan, { readonly target: "windows-x64" }>,
  root: string,
): readonly WindowsSnapshotArtifact[] {
  return [
    {
      source: plan.paths.candidateLauncher,
      destination: join(root, "launcher.next"),
      sourceRoot: plan.paths.candidateRoot,
      expectedSha256: plan.digests.candidateLauncherSha256,
      maxBytes: MAX_NATIVE_BYTES,
      mode: 0o700,
    },
    {
      source: join(plan.paths.managedRoot, ".portable", "setup-manifest.json"),
      destination: join(root, "setup-manifest.previous"),
      sourceRoot: plan.paths.managedRoot,
      expectedSha256: plan.currentSetupManifestSha256,
      maxBytes: MAX_CONTROL_BYTES,
      mode: 0o600,
    },
    {
      source: join(plan.paths.candidateRoot, ".portable", "setup-manifest.json"),
      destination: join(root, "setup-manifest.next"),
      sourceRoot: plan.paths.candidateRoot,
      expectedSha256: plan.candidateSetupManifestSha256,
      maxBytes: MAX_CONTROL_BYTES,
      mode: 0o600,
    },
  ] as const;
}

function snapshotWindowsCapsule(plan: PortableHandoffPlan, root: string): void {
  if (plan.target !== "windows-x64") return;
  for (const artifact of windowsSnapshotArtifacts(plan, root)) {
    if (
      copyVerifiedFile(
        artifact.source,
        artifact.destination,
        artifact.sourceRoot,
        artifact.maxBytes,
        artifact.mode,
      ) !== artifact.expectedSha256
    ) {
      fail("portable handoff Windows capsule identity changed");
    }
  }
  assertNoLinkPath(root, join(root, "registration.previous"));
  assertNoLinkPath(root, join(root, "registration.next"));
  if (
    digestExistingFile(join(root, "registration.previous"), MAX_CONTROL_BYTES) !==
      plan.digests.previousRegistrationSha256 ||
    digestExistingFile(join(root, "registration.next"), MAX_CONTROL_BYTES) !==
      plan.digests.preparedRegistrationSha256
  ) {
    fail("portable handoff Windows registration snapshot changed");
  }
}

async function copyAndVerifyNativeArtifacts(input: {
  readonly options: PortableHandoffCoordinatorOptions;
  readonly plan: PortableHandoffPlan;
  readonly coordinator: string;
  readonly supervisor: string;
  readonly signal: AbortSignal | undefined;
}): Promise<string> {
  const current = currentNativeArtifacts(input.plan);
  const coordinatorSha256 = copyVerifiedNative(
    current.coordinator,
    input.coordinator,
    input.plan.paths.managedRoot,
  );
  const supervisorSha256 = copyVerifiedNative(
    current.supervisor,
    input.supervisor,
    input.plan.paths.managedRoot,
  );
  if (
    coordinatorSha256 !== input.plan.digests.currentLauncherSha256 ||
    supervisorSha256 !== input.plan.digests.currentSupervisorSha256
  ) {
    fail("portable handoff current native identity changed");
  }
  await input.options.verifyNativeCopy({
    kind: "coordinator",
    currentPath: current.coordinator,
    copiedPath: input.coordinator,
  });
  assertNotAborted(input.signal);
  await input.options.verifyNativeCopy({
    kind: "runtime-supervisor",
    currentPath: current.supervisor,
    copiedPath: input.supervisor,
  });
  assertNotAborted(input.signal);
  return coordinatorSha256;
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
    const generation = join(
      plan.paths.managedRoot,
      ".portable",
      "generations",
      plan.currentGenerationTreeSha256,
    );
    return {
      coordinator: join(plan.paths.managedRoot, "Keiko.exe"),
      supervisor: join(generation, "runtime", "native", "keiko-runtime-supervisor.exe"),
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

async function beginPortableHandoff(
  options: PortableHandoffCoordinatorOptions,
  input: Parameters<PortableHandoffCoordinatorPort["begin"]>[0],
): ReturnType<PortableHandoffCoordinatorPort["begin"]> {
  const { sessionId, activationId, signal } = input;
  const prepared = await prepareCoordinator(options, sessionId, activationId, signal);
  const child = spawnPreparedCoordinator(options, prepared.coordinator, activationId);
  try {
    await acceptPreparedCoordinator(options, prepared, child, input);
  } catch (error) {
    try {
      await cleanupFailedCoordinator(
        child,
        options.teardownTimeoutMs ?? COORDINATOR_TEARDOWN_TIMEOUT_MS,
      );
    } catch (cleanupError) {
      const retainedAuthority =
        cleanupError instanceof PortableHandoffCoordinatorError &&
        cleanupError.nativeAuthorityMayBeLive;
      throw new PortableHandoffCoordinatorError(
        "portable handoff coordinator did not stop after acceptance failed",
        retainedAuthority,
        new AggregateError(
          [error, cleanupError],
          "portable handoff acceptance and teardown failed",
        ),
      );
    }
    throw error;
  }
  (child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.();
  child.unref();
  return {
    coordinatorId: prepared.coordinatorSha256,
    acceptedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
  };
}

function spawnPreparedCoordinator(
  options: PortableHandoffCoordinatorOptions,
  coordinator: string,
  activationId: string,
): ChildProcess {
  return (options.spawnFn ?? spawn)(coordinator, ["--coordinate-update", activationId], {
    detached: true,
    env: { KEIKO_STATE_DIR: options.stateDir },
    stdio: ["pipe", "ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

async function acceptPreparedCoordinator(
  options: PortableHandoffCoordinatorOptions,
  prepared: Awaited<ReturnType<typeof prepareCoordinator>>,
  child: ChildProcess,
  input: Parameters<PortableHandoffCoordinatorPort["begin"]>[0],
): Promise<void> {
  if (child.pid === undefined || !options.publishCoordinatorPid(input.sessionId, child.pid)) {
    fail("portable handoff coordinator ownership could not be published");
  }
  await Promise.all([
    writeCoordinatorControl(child, prepared.planSha256),
    awaitCoordinatorAcceptance(
      child,
      prepared.planSha256,
      options.acceptanceTimeoutMs ?? ACCEPT_TIMEOUT_MS,
      input.signal,
    ),
  ]);
  assertNotAborted(input.signal);
  await options.persistAccepted({
    sessionId: input.sessionId,
    activationWal: {
      activationId: input.activationId,
      planSha256: prepared.planSha256,
      coordinatorSha256: prepared.coordinatorSha256,
      intentRevision: prepared.intentRevision,
      checkpoint: "prepared",
      receiptSequence: 0,
      coordinatorId: prepared.coordinatorSha256,
    },
  });
}

export function createPortableHandoffCoordinator(
  options: PortableHandoffCoordinatorOptions,
): PortableHandoffCoordinatorPort {
  return { begin: (input) => beginPortableHandoff(options, input) };
}

export function portableCoordinatorArtifactNames(): readonly string[] {
  const extension = process.platform === "win32" ? ".exe" : "";
  return [`coordinator${extension}`, `runtime-supervisor${extension}`].map((name) =>
    basename(name),
  );
}
