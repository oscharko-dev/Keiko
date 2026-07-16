import { createHash } from "node:crypto";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  deriveCanonicalDebugProvisioningDigest,
  type DebugSpawnArtifactIdentity,
  type DebugSpawnEnvelope,
} from "./debugCapsulePlan.js";
import { DapProcessManagerError, type DebugCapsuleLauncher } from "./dapProcessManager.js";
import type { QualifiedDebugCapsuleHandle } from "./dapCapsuleSupervisor.js";

export interface DebugCapsuleLauncherDeps {
  readonly now: () => number;
  readonly epoch: () => number;
  readonly activationCurrent: (workspacePartitionKey: string, expectedRevision: number) => boolean;
  readonly revalidateTarget: (envelope: DebugSpawnEnvelope) => boolean;
  readonly platform?: NodeJS.Platform | undefined;
  readonly procRoot?: string | undefined;
  readonly spawnProcess?: DebugCapsuleSpawnProcess | undefined;
}

export type DebugCapsuleSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function envelopeDigest(envelope: DebugSpawnEnvelope): string {
  const values = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== "identityDigest" && key !== "planId"),
  );
  return hash(values);
}

function artifactPathUnchanged(
  artifact: DebugSpawnArtifactIdentity,
  real: string,
  root: string,
): boolean {
  const pathFromRoot = relative(root, real);
  const firstSegment = pathFromRoot.split(sep)[0];
  return [
    real === artifact.realPath,
    root === artifact.approvedRootRealPath,
    pathFromRoot !== "",
    firstSegment !== "..",
    !isAbsolute(pathFromRoot),
  ].every(Boolean);
}

function artifactStatUnchanged(artifact: DebugSpawnArtifactIdentity, stat: Stats): boolean {
  return [
    stat.isFile(),
    stat.dev === artifact.device,
    stat.ino === artifact.inode,
    stat.size === artifact.size,
    stat.mode === artifact.mode,
    stat.uid === artifact.ownerUid,
  ].every(Boolean);
}

function artifactUnchanged(artifact: DebugSpawnArtifactIdentity): boolean {
  try {
    const real = realpathSync(artifact.hostPath);
    const root = realpathSync(artifact.approvedRootRealPath);
    const stat = lstatSync(real);
    const digest = createHash("sha256").update(readFileSync(real)).digest("hex");
    return (
      artifactPathUnchanged(artifact, real, root) &&
      artifactStatUnchanged(artifact, stat) &&
      digest === artifact.identityDigest
    );
  } catch {
    return false;
  }
}

type PosixDebugEndpoint = Extract<DebugSpawnEnvelope["endpoint"], { readonly kind: "posixSocket" }>;
type RunningDebugChild = ChildProcessWithoutNullStreams & { readonly pid: number };

function runtimePathUnchanged(
  envelope: DebugSpawnEnvelope,
  endpoint: PosixDebugEndpoint,
  realPath: string,
): boolean {
  const identity = envelope.runtimeDirectoryIdentity;
  return [
    realPath === identity.realPath,
    endpoint.runtimeIdentity === identity.identityDigest,
  ].every(Boolean);
}

function currentUserId(): number {
  const posixProcess = process as NodeJS.Process & { getuid(): number };
  return posixProcess.getuid();
}

function runtimeStatUnchanged(envelope: DebugSpawnEnvelope, stat: Stats): boolean {
  const identity = envelope.runtimeDirectoryIdentity;
  return [
    stat.isDirectory(),
    !stat.isSymbolicLink(),
    (stat.mode & 0o777) === 0o700,
    stat.uid === currentUserId(),
    stat.dev === identity.device,
    stat.ino === identity.inode,
    stat.mode === identity.mode,
    stat.uid === identity.ownerUid,
  ].every(Boolean);
}

function runtimeUnchanged(envelope: DebugSpawnEnvelope, endpoint: PosixDebugEndpoint): boolean {
  try {
    const stat = lstatSync(endpoint.hostRuntimeDirectory);
    const realPath = realpathSync(endpoint.hostRuntimeDirectory);
    return (
      runtimePathUnchanged(envelope, endpoint, realPath) &&
      runtimeStatUnchanged(envelope, stat) &&
      hash([realPath, stat.dev, stat.ino, stat.mode, stat.uid]) ===
        envelope.runtimeDirectoryIdentity.identityDigest
    );
  } catch {
    return false;
  }
}

function workspaceUnchanged(envelope: DebugSpawnEnvelope): boolean {
  try {
    const identity = envelope.workspaceIdentity;
    const realPath = realpathSync(identity.realPath);
    const stat = lstatSync(realPath);
    const digest = hash([realPath, stat.dev, stat.ino, stat.mode, stat.uid]);
    return [
      realPath === identity.realPath,
      stat.isDirectory(),
      stat.dev === identity.device,
      stat.ino === identity.inode,
      stat.mode === identity.mode,
      stat.uid === identity.ownerUid,
      digest === identity.identityDigest,
    ].every(Boolean);
  } catch {
    return false;
  }
}

function authorityCurrent(
  deps: DebugCapsuleLauncherDeps,
  envelope: DebugSpawnEnvelope,
  signal: AbortSignal,
): boolean {
  return (
    !signal.aborted &&
    envelope.backend === "linuxNamespace" &&
    (deps.platform ?? process.platform) === "linux" &&
    deps.now() < envelope.expiresAtMs &&
    deps.epoch() === envelope.epoch &&
    deps.activationCurrent(envelope.workspaceIdentity.identityDigest, envelope.activationRevision)
  );
}

function identityCurrent(envelope: DebugSpawnEnvelope, endpoint: PosixDebugEndpoint): boolean {
  const backendArtifact = envelope.artifacts[0];
  return (
    envelope.planId === envelope.identityDigest &&
    envelopeDigest(envelope) === envelope.identityDigest &&
    backendArtifact?.realPath === envelope.capsuleCommand &&
    runtimeUnchanged(envelope, endpoint) &&
    workspaceUnchanged(envelope) &&
    envelope.artifacts.every(artifactUnchanged) &&
    deriveCanonicalDebugProvisioningDigest(envelope.artifacts) === envelope.provisioningDigest
  );
}

function targetCurrent(deps: DebugCapsuleLauncherDeps, envelope: DebugSpawnEnvelope): boolean {
  try {
    return deps.revalidateTarget(envelope);
  } catch {
    return false;
  }
}

function requirePosixEndpoint(envelope: DebugSpawnEnvelope): PosixDebugEndpoint {
  if (envelope.endpoint.kind !== "posixSocket") {
    throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  }
  return envelope.endpoint;
}

function assertSynchronousCurrent(
  deps: DebugCapsuleLauncherDeps,
  envelope: DebugSpawnEnvelope,
  endpoint: PosixDebugEndpoint,
  signal: AbortSignal,
): void {
  if (!authorityCurrent(deps, envelope, signal) || !identityCurrent(envelope, endpoint)) {
    throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  }
}

function assertCurrent(
  deps: DebugCapsuleLauncherDeps,
  envelope: DebugSpawnEnvelope,
  signal: AbortSignal,
): PosixDebugEndpoint {
  const endpoint = requirePosixEndpoint(envelope);
  assertSynchronousCurrent(deps, envelope, endpoint, signal);
  if (!targetCurrent(deps, envelope)) {
    throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  }
  assertSynchronousCurrent(deps, envelope, endpoint, signal);
  return endpoint;
}

function groupKill(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // An already exited capsule is safe at this boundary.
    }
  }
}

function processParent(procRoot: string, pid: string): number {
  return processIdentity(procRoot, pid)?.parentPid ?? -1;
}

interface LinuxProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly startTime: string;
  readonly state: string;
}

interface LinuxScopeTracker {
  readonly observedDescendants: Map<number, string>;
  rootStartTime?: string | undefined;
  observationComplete: boolean;
}

function processIdentity(
  procRoot: string,
  pidEntry: string,
): LinuxProcessIdentity | null | undefined {
  try {
    const value = readFileSync(join(procRoot, pidEntry, "stat"), "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = value
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const pid = Number(pidEntry);
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const startTime = String(fields[19]);
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    // Stryker disable next-line ConditionalExpression: RegExp.test coerces an absent field to a
    // non-matching string, so the explicit typeof guard is a TypeScript narrowing only.
    if (typeof state !== "string" || !/^[A-Z]$/u.test(state)) return undefined;
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) return undefined;
    if (!/^\d+$/u.test(startTime)) return undefined;
    return { pid, parentPid, startTime, state };
  } catch {
    return null;
  }
}

function readProcessTable(procRoot: string): ReadonlyMap<number, LinuxProcessIdentity> {
  const processes = new Map<number, LinuxProcessIdentity>();
  for (const pidEntry of readdirSync(procRoot)) {
    const identity = processIdentity(procRoot, pidEntry);
    if (identity) processes.set(identity.pid, identity);
  }
  return processes;
}

function reachesRoot(
  parents: ReadonlyMap<number, number>,
  start: number,
  rootPid: number,
): boolean {
  let current = start;
  for (const ancestor of parents.keys()) {
    if (!Number.isSafeInteger(ancestor)) return false;
    if (current === rootPid) return true;
    current = parents.get(current) ?? -1;
  }
  return false;
}

function descendantIdentities(
  processes: ReadonlyMap<number, LinuxProcessIdentity>,
  rootPid: number,
): readonly LinuxProcessIdentity[] {
  const parents = new Map<number, number>();
  for (const process of processes.values()) parents.set(process.pid, process.parentPid);
  const descendants: LinuxProcessIdentity[] = [];
  for (const process of processes.values()) {
    if (process.pid !== rootPid && reachesRoot(parents, process.pid, rootPid)) {
      descendants.push(process);
    }
  }
  return descendants;
}

function descendantCount(procRoot: string, rootPid: number): number {
  return descendantIdentities(readProcessTable(procRoot), rootPid).length;
}

function createLinuxScopeTracker(): LinuxScopeTracker {
  return { observedDescendants: new Map<number, string>(), observationComplete: false };
}

function recordLiveScope(
  tracker: LinuxScopeTracker,
  processes: ReadonlyMap<number, LinuxProcessIdentity>,
  rootPid: number,
): number | undefined {
  const root = processes.get(rootPid);
  if (root === undefined) return undefined;
  if (tracker.rootStartTime !== undefined && tracker.rootStartTime !== root.startTime) {
    return undefined;
  }
  tracker.rootStartTime = root.startTime;
  const descendants = descendantIdentities(processes, rootPid);
  for (const process of descendants) {
    tracker.observedDescendants.set(process.pid, process.startTime);
  }
  tracker.observationComplete = true;
  return descendants.length;
}

function remainingObservedDescendants(
  tracker: LinuxScopeTracker,
  processes: ReadonlyMap<number, LinuxProcessIdentity>,
): number | undefined {
  if (!tracker.observationComplete) return undefined;
  let remaining = 0;
  for (const [pid, startTime] of tracker.observedDescendants) {
    const process = processes.get(pid);
    if (process?.startTime === startTime && process.state !== "Z") remaining += 1;
  }
  return remaining;
}

function terminateObservedLinuxDescendants(tracker: LinuxScopeTracker, procRoot: string): void {
  if (tracker.observedDescendants.size === 0) return;
  const processes = readProcessTable(procRoot);
  for (const [pid, startTime] of tracker.observedDescendants) {
    if (processes.get(pid)?.startTime !== startTime) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // A concurrently exited observed descendant is already contained.
    }
  }
}

const DESCENDANT_SETTLE_ATTEMPTS = 10;
const DESCENDANT_SETTLE_INTERVAL_MS = 5;

function waitForDescendantSettleInterval(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, DESCENDANT_SETTLE_INTERVAL_MS).unref();
  });
}

async function awaitObservedLinuxDescendants(
  tracker: LinuxScopeTracker,
  procRoot: string,
): Promise<void> {
  if (tracker.observedDescendants.size === 0) return;
  for (let attempt = 0; attempt < DESCENDANT_SETTLE_ATTEMPTS; attempt += 1) {
    const remaining = remainingObservedDescendants(tracker, readProcessTable(procRoot));
    if (remaining === 0) return;
    await waitForDescendantSettleInterval();
  }
}

function inspectLinuxScope(
  envelope: DebugSpawnEnvelope,
  pid: number,
  exited: boolean,
  procRoot: string,
  tracker: LinuxScopeTracker = createLinuxScopeTracker(),
): ReturnType<QualifiedDebugCapsuleHandle["inspectScope"]> {
  const processes = readProcessTable(procRoot);
  const observed = exited
    ? remainingObservedDescendants(tracker, processes)
    : recordLiveScope(tracker, processes, pid);
  const descendants = observed ?? -1;
  return Promise.resolve({
    qualified:
      envelope.backend === "linuxNamespace" &&
      envelope.capsuleCommand === envelope.artifacts[0]?.realPath &&
      descendants >= 0,
    backend: envelope.backend,
    runtimeIdentityDigest: envelope.runtimeIdentityDigest,
    descendants,
  });
}

function cleanupEndpoint(endpoint: PosixDebugEndpoint): Promise<void> {
  rmSync(endpoint.hostSocketPath, { force: true });
  return Promise.resolve();
}

function isSpawnedDebugChild(child: ChildProcess): child is RunningDebugChild {
  return (
    child.pid !== undefined &&
    child.stdin !== null &&
    child.stdout !== null &&
    child.stderr !== null
  );
}

function byteSink(child: RunningDebugChild): QualifiedDebugCapsuleHandle["sink"] {
  return {
    write: (chunk): void => {
      child.stdin.write(chunk);
    },
  };
}

function processGroup(child: RunningDebugChild): QualifiedDebugCapsuleHandle["processGroup"] {
  return {
    pid: child.pid,
    kill: (signal): void => {
      groupKill(child, signal);
    },
  };
}

function wrapChild(
  child: ChildProcess,
  envelope: DebugSpawnEnvelope,
  endpoint: PosixDebugEndpoint,
  procRoot: string,
): QualifiedDebugCapsuleHandle {
  if (!isSpawnedDebugChild(child)) {
    groupKill(child, "SIGKILL");
    throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
  }
  const pid = child.pid;
  const scopeTracker = createLinuxScopeTracker();
  try {
    recordLiveScope(scopeTracker, readProcessTable(procRoot), pid);
  } catch {
    // The mandatory teardown inspection remains fail closed when procfs cannot be read.
  }
  let exited = false;
  const exitCallbacks = new Set<() => Promise<void>>();
  child.once("exit", () => {
    exited = true;
    for (const callback of exitCallbacks) void callback();
  });
  child.stdin.on("error", () => {
    // Exit and containment observation own this failure.
  });
  // DAP uses the private endpoint; inherited capsule stdio must never backpressure startup.
  child.stdout.resume();
  child.stderr.resume();
  return {
    planId: envelope.planId,
    source: child.stdout,
    sink: byteSink(child),
    processGroup: processGroup(child),
    exited: () => exited,
    whenExited: (callback): void => {
      if (exited) {
        callback();
      } else child.once("exit", callback);
    },
    inspectScope: () => inspectLinuxScope(envelope, pid, exited, procRoot, scopeTracker),
    terminateContainment: async (): Promise<void> => {
      groupKill(child, "SIGKILL");
      terminateObservedLinuxDescendants(scopeTracker, procRoot);
      await awaitObservedLinuxDescendants(scopeTracker, procRoot);
    },
    cleanup: () => cleanupEndpoint(endpoint),
    onExit: (callback): void => {
      exitCallbacks.add(callback);
    },
  };
}

function spawnOptions(envelope: DebugSpawnEnvelope): SpawnOptions {
  return {
    cwd: "/",
    env: { ...envelope.environment },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

function resolveProcRoot(deps: DebugCapsuleLauncherDeps): string {
  return deps.procRoot ?? "/proc";
}

/** @internal Mutation-test surface for security-critical pure and fail-closed helpers. */
export const debugCapsuleLauncherInternals = Object.freeze({
  artifactUnchanged,
  cleanupEndpoint,
  createLinuxScopeTracker,
  descendantCount,
  descendantIdentities,
  groupKill,
  inspectLinuxScope,
  processIdentity,
  processParent,
  readProcessTable,
  requirePosixEndpoint,
  resolveProcRoot,
  runtimeUnchanged,
  spawnOptions,
  targetCurrent,
  terminateObservedLinuxDescendants,
  workspaceUnchanged,
});

function awaitSpawn(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => {
      reject(new DapProcessManagerError("INVALID_CAPSULE_PLAN"));
    });
  });
}

export function createProductionDebugCapsuleLauncher(
  deps: DebugCapsuleLauncherDeps,
): DebugCapsuleLauncher {
  return async (envelope, signal): Promise<QualifiedDebugCapsuleHandle> => {
    const endpoint = assertCurrent(deps, envelope, signal);
    const child = (deps.spawnProcess ?? spawn)(
      envelope.capsuleCommand,
      [...envelope.capsuleArgs],
      spawnOptions(envelope),
    );
    try {
      await awaitSpawn(child);
    } catch (error: unknown) {
      groupKill(child, "SIGKILL");
      rmSync(endpoint.hostSocketPath, { force: true });
      throw error;
    }
    return wrapChild(child, envelope, endpoint, resolveProcRoot(deps));
  };
}
