import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import type { UpdateRuntimeState, UpdateSession } from "@oscharko-dev/keiko-contracts";
import { emitSecurityLogEvent, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import { attestPortableManagedRegistration } from "./update-portable-activation-files.js";
import { createPortableHandoffTreeAttestor } from "./update-portable-handoff-builder.js";
import {
  portableHandoffPlanSha256,
  portableHandoffRoot,
  readPortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  portableHandoffReceiptSha256,
  readPortableHandoffReceipts,
  validatePortableHandoffReceiptSequence,
  type PortableHandoffReceipt,
} from "./update-portable-handoff-receipts.js";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import {
  adoptStateDirUpdateSessionLockForRecovery,
  claimStateDirUpdateSessionLockForRecovery,
  createStateDirUpdateSessionLock,
  inspectStateDirUpdateSessionLockForRecovery,
  releaseStateDirUpdateSessionLockForRecovery,
  type UpdateSessionRecoveryOwnership,
  type UpdateSessionRecoveryLockInspection,
} from "./update-session-lock.js";

const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const RECOVERY_TIMEOUT_MS = 15 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9]{32}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
export const PORTABLE_RECOVERED_LAUNCH_ENV = "KEIKO_PORTABLE_RECOVERED_LAUNCH";

export interface PortableRecoveredLaunchDescriptor extends UpdateSessionRecoveryOwnership {
  readonly activationId: string;
  readonly planSha256: string;
  readonly launchId: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly expectedVersion: string;
}

export type PortableNormalStartupRecoveryResult =
  | { readonly status: "normal" }
  | { readonly status: "recovered"; readonly descriptor: PortableRecoveredLaunchDescriptor }
  | { readonly status: "recovery-required" };

function validPattern(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function validRecoveredOwnership(descriptor: Record<string, unknown>): boolean {
  return (
    typeof descriptor.sessionId === "string" &&
    descriptor.sessionId.length > 0 &&
    descriptor.sessionId.length <= 256 &&
    validPattern(descriptor.targetVersion, VERSION) &&
    validPattern(descriptor.lockIdentity, SHA256)
  );
}

function validRecoveredProcess(descriptor: Record<string, unknown>): boolean {
  if (!Number.isSafeInteger(descriptor.port)) return false;
  const port = descriptor.port as number;
  return descriptor.host === "127.0.0.1" && port > 0 && port <= 65_535;
}

function validRecoveredActivation(descriptor: Record<string, unknown>): boolean {
  return (
    validPattern(descriptor.activationId, ID) &&
    validPattern(descriptor.planSha256, SHA256) &&
    validPattern(descriptor.launchId, ID) &&
    validPattern(descriptor.expectedVersion, VERSION)
  );
}

function validRecoveredDescriptor(value: unknown): value is PortableRecoveredLaunchDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  return (
    validRecoveredOwnership(descriptor) &&
    validRecoveredActivation(descriptor) &&
    validRecoveredProcess(descriptor)
  );
}

export function encodePortableRecoveredLaunchDescriptor(
  descriptor: PortableRecoveredLaunchDescriptor,
): string {
  if (!validRecoveredDescriptor(descriptor)) throw new TypeError("invalid recovered launch");
  return Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url");
}

export function readPortableRecoveredLaunchDescriptor(
  value: string | undefined,
): PortableRecoveredLaunchDescriptor | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return undefined;
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    return validRecoveredDescriptor(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface PortableNativeRecoveryInput {
  readonly coordinator: string;
  readonly activationId: string;
  readonly control: Buffer;
  readonly stateDir: string;
  readonly timeoutMs: number;
  readonly onSpawn: (pid: number) => boolean;
}

export interface PortableNormalStartupRecoveryOptions {
  readonly stateDir: string;
  readonly target: PortableHandoffPlan["target"];
  readonly expectedManagedRoot: string;
  readonly pidAlive?: ((pid: number) => boolean) | undefined;
  readonly processIdentity?: string | undefined;
  readonly currentPid?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly runNative?: ((input: PortableNativeRecoveryInput) => Promise<boolean>) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

interface RecoveryAuthority {
  readonly state: UpdateRuntimeState & {
    readonly activationWal: NonNullable<UpdateRuntimeState["activationWal"]>;
  };
  readonly session: NonNullable<UpdateRuntimeState["activeSession"]>;
  readonly plan: PortableHandoffPlan;
  readonly receipts: readonly PortableHandoffReceipt[];
  readonly runtimeStateSha256: string;
}

interface ClaimedRecovery {
  readonly authority: RecoveryAuthority;
  readonly ownership: UpdateSessionRecoveryOwnership;
  readonly unaccepted: boolean;
}

type RecoveryFailureReason =
  | "runtime-state-invalid"
  | "authority-invalid"
  | "managed-root-mismatch"
  | "ownership-live-or-mismatch"
  | "ownership-claim-failed"
  | "prepared-settlement-failed"
  | "coordinator-invalid"
  | "native-recovery-failed"
  | "post-native-authority-invalid";

function recoveryRequired(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  reason: RecoveryFailureReason,
  authority?: RecoveryAuthority,
): PortableNormalStartupRecoveryResult {
  emitSecurityLogEvent(options.securityLogSink, {
    level: "error",
    category: "diagnostic",
    op: "portable.normal-startup-recovery.required",
    errorKind: "PortableNormalStartupRecoveryRequired",
    ...(authority === undefined ? {} : { correlationId: authority.session.correlationId }),
    extra: { reason },
  });
  if (authority !== undefined) {
    try {
      localState.recordAuditEvent("portable-relaunch-result", {
        correlationId: authority.session.correlationId,
        targetVersion: authority.session.targetVersion,
        portableActivationId: authority.plan.activationId,
        status: "failed",
      });
    } catch {
      // The canonical security event above remains available when audit persistence is degraded.
    }
  }
  return { status: "recovery-required" };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function validNativeFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= MAX_NATIVE_BYTES;
}

function unchangedNativeFile(before: Stats, after: Stats, namedAfter: Stats): boolean {
  if (!namedAfter.isFile() || namedAfter.isSymbolicLink() || namedAfter.nlink !== 1) return false;
  if (after.dev !== before.dev || after.ino !== before.ino) return false;
  if (after.mtimeMs !== before.mtimeMs) return false;
  return namedAfter.dev === before.dev && namedAfter.ino === before.ino;
}

function digestDescriptor(descriptor: number, expectedSize: number): string | undefined {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const count = readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > expectedSize) return undefined;
    hash.update(buffer.subarray(0, count));
  }
  return total === expectedSize ? hash.digest("hex") : undefined;
}

function digestOpenFile(path: string, descriptor: number): string | undefined {
  const before = fstatSync(descriptor);
  if (!validNativeFile(before)) return undefined;
  const digest = digestDescriptor(descriptor, before.size);
  if (digest === undefined) return undefined;
  return unchangedNativeFile(before, fstatSync(descriptor), lstatSync(path)) ? digest : undefined;
}

function digestFile(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return digestOpenFile(path, descriptor);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function authoritySession(state: UpdateRuntimeState): UpdateSession | undefined {
  if (state.activeSession !== undefined) return state.activeSession;
  const session = state.lastSession;
  const terminal = session?.phase === "succeeded" && session.lifecycle.phase === "succeeded";
  return state.activationWal?.checkpoint === "complete" && terminal ? session : undefined;
}

function receiptsAnchorWal(
  wal: NonNullable<UpdateRuntimeState["activationWal"]>,
  receipts: readonly PortableHandoffReceipt[],
): boolean {
  if (wal.receiptSequence === 0) return wal.receiptSha256 === undefined;
  const receipt = receipts[wal.receiptSequence - 1];
  return receipt !== undefined && portableHandoffReceiptSha256(receipt) === wal.receiptSha256;
}

function authorityMetadataMatches(
  wal: NonNullable<UpdateRuntimeState["activationWal"]>,
  session: UpdateSession,
  plan: PortableHandoffPlan,
  receipts: readonly PortableHandoffReceipt[],
): boolean {
  if (!receiptsAnchorWal(wal, receipts) || receipts.length < wal.receiptSequence) return false;
  if (wal.coordinatorId !== undefined && receipts.length < 2) return false;
  if (portableHandoffPlanSha256(plan) !== wal.planSha256) return false;
  if (plan.aggregateRevision !== wal.intentRevision || plan.sessionId !== session.sessionId)
    return false;
  return plan.targetVersion === session.targetVersion;
}

function loadAuthority(
  stateDir: string,
  state: UpdateRuntimeState,
  runtimeStateSha256: string,
): RecoveryAuthority | undefined {
  const wal = state.activationWal;
  if (wal === undefined) return undefined;
  try {
    const plan = readPortableHandoffPlan(stateDir, wal.activationId);
    const session = authoritySession(state);
    if (session === undefined) return undefined;
    const receipts = readPortableHandoffReceipts(stateDir, wal.activationId);
    validatePortableHandoffReceiptSequence({
      activationId: wal.activationId,
      planSha256: wal.planSha256,
      receipts,
    });
    if (!authorityMetadataMatches(wal, session, plan, receipts)) return undefined;
    return {
      state: state as RecoveryAuthority["state"],
      session,
      plan,
      receipts,
      runtimeStateSha256,
    };
  } catch {
    return undefined;
  }
}

async function initialStateAttested(
  authority: RecoveryAuthority,
  stateDir: string,
): Promise<boolean> {
  const { plan } = authority;
  return (
    attestPortableManagedRegistration({
      stateDir,
      managedRoot: plan.paths.managedRoot,
      target: plan.target,
      version: plan.oldProcess.version,
      expectedSha256: plan.digests.previousRegistrationSha256,
    }) &&
    createPortableHandoffTreeAttestor({ managedRoot: plan.paths.managedRoot })(
      plan.digests.currentTreeSha256,
    )
  );
}

async function settleUnaccepted(
  authority: RecoveryAuthority,
  stateDir: string,
  now: () => number,
): Promise<boolean> {
  const session = authority.state.activeSession;
  if (
    session?.sessionId !== authority.session.sessionId ||
    !(await initialStateAttested(authority, stateDir))
  )
    return false;
  const localState = createUpdateLocalStateManager({ stateDir, now });
  localState.writeRuntimeState({
    ...authority.state,
    activationWal: undefined,
    recovery: {
      status: "settled",
      sessionId: session.sessionId,
      updatedAt: new Date(now()).toISOString(),
    },
  });
  return true;
}

function encodeControl(
  authority: RecoveryAuthority,
  ownership: UpdateSessionRecoveryOwnership,
): Buffer {
  const wal = authority.state.activationWal;
  return Buffer.from(
    [
      "KRC1",
      wal.activationId,
      wal.planSha256,
      wal.coordinatorSha256,
      String(wal.intentRevision),
      String(wal.receiptSequence),
      wal.receiptSha256 ?? "-",
      authority.runtimeStateSha256,
      ownership.lockIdentity,
      "",
    ].join("\n"),
    "ascii",
  );
}

function defaultRunNative(input: PortableNativeRecoveryInput): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(input.coordinator, ["--recover-update", input.activationId], {
      env: { KEIKO_STATE_DIR: input.stateDir },
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, input.timeoutMs);
    child.once("error", () => {
      finish(false);
    });
    child.once("exit", (code, signal) => {
      finish(code === 0 && signal === null);
    });
    if (child.pid === undefined || !input.onSpawn(child.pid)) {
      child.kill("SIGKILL");
      finish(false);
      return;
    }
    child.stdin.end(input.control);
  });
}

function isRecoveryResult(
  value: RecoveryAuthority | PortableNormalStartupRecoveryResult | ClaimedRecovery,
): value is PortableNormalStartupRecoveryResult {
  return "status" in value;
}

function loadStartupAuthority(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
): RecoveryAuthority | PortableNormalStartupRecoveryResult {
  const inspected = localState.inspectRuntimeState();
  if (inspected.status === "missing") return { status: "normal" };
  if (!("state" in inspected))
    return recoveryRequired(options, localState, "runtime-state-invalid");
  if (inspected.state.activationWal === undefined) return { status: "normal" };
  if (inspected.status !== "ok")
    return recoveryRequired(options, localState, "runtime-state-invalid");
  const authority = loadAuthority(options.stateDir, inspected.state, inspected.contentSha256);
  if (authority?.plan.target !== options.target)
    return recoveryRequired(options, localState, "authority-invalid");
  if (resolve(authority.plan.paths.managedRoot) !== resolve(options.expectedManagedRoot))
    return recoveryRequired(options, localState, "managed-root-mismatch", authority);
  return authority;
}

function isUnaccepted(authority: RecoveryAuthority): boolean {
  return (
    authority.state.activeSession?.sessionId === authority.session.sessionId &&
    authority.receipts.length === 0 &&
    authority.state.activationWal.coordinatorId === undefined
  );
}

function validRecoveryLock(
  lock: UpdateSessionRecoveryLockInspection,
  authority: RecoveryAuthority,
  isAlive: (pid: number) => boolean,
  unaccepted: boolean,
): boolean {
  if (isAlive(lock.ownerPid)) return false;
  if (lock.sessionId !== authority.session.sessionId) return false;
  if (lock.targetVersion !== authority.session.targetVersion) return false;
  if (lock.childPid !== undefined) return !isAlive(lock.childPid);
  return unaccepted;
}

function claimStartupOwnership(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  authority: RecoveryAuthority,
): ClaimedRecovery | PortableNormalStartupRecoveryResult {
  const lock = inspectStateDirUpdateSessionLockForRecovery(options.stateDir);
  const isAlive = options.pidAlive ?? pidAlive;
  const unaccepted = isUnaccepted(authority);
  if (lock === undefined || !validRecoveryLock(lock, authority, isAlive, unaccepted))
    return recoveryRequired(options, localState, "ownership-live-or-mismatch", authority);
  const ownershipOptions = {
    currentPid: options.currentPid ?? process.pid,
    processIdentity: options.processIdentity ?? randomUUID(),
    pidAlive: isAlive,
  };
  const ownership = unaccepted
    ? adoptStateDirUpdateSessionLockForRecovery(options.stateDir, lock, ownershipOptions)
    : claimStateDirUpdateSessionLockForRecovery(
        options.stateDir,
        authority.session,
        ownershipOptions,
      );
  return ownership === undefined
    ? recoveryRequired(options, localState, "ownership-claim-failed", authority)
    : { authority, ownership, unaccepted };
}

async function recoverUnaccepted(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  claimed: ClaimedRecovery,
  now: () => number,
): Promise<PortableNormalStartupRecoveryResult> {
  try {
    if (!(await settleUnaccepted(claimed.authority, options.stateDir, now)))
      return recoveryRequired(options, localState, "prepared-settlement-failed", claimed.authority);
    return releaseStateDirUpdateSessionLockForRecovery(options.stateDir, claimed.ownership)
      ? { status: "normal" }
      : recoveryRequired(options, localState, "prepared-settlement-failed", claimed.authority);
  } catch {
    return recoveryRequired(options, localState, "prepared-settlement-failed", claimed.authority);
  }
}

async function recoverAccepted(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  claimed: ClaimedRecovery,
): Promise<PortableNormalStartupRecoveryResult> {
  const { authority, ownership } = claimed;
  const wal = authority.state.activationWal;
  const coordinator = join(portableHandoffRoot(options.stateDir, wal.activationId), "coordinator");
  if (!SHA256.test(wal.coordinatorSha256) || digestFile(coordinator) !== wal.coordinatorSha256)
    return recoveryRequired(options, localState, "coordinator-invalid", authority);
  const ownedLock = createStateDirUpdateSessionLock(options.stateDir);
  const ran = await (options.runNative ?? defaultRunNative)({
    coordinator,
    activationId: wal.activationId,
    control: encodeControl(authority, ownership),
    stateDir: options.stateDir,
    timeoutMs: RECOVERY_TIMEOUT_MS,
    onSpawn: (nativePid) => ownedLock.updateChildPid(authority.session.sessionId, nativePid),
  });
  if (!ran) {
    ownedLock.updateChildPid(authority.session.sessionId, options.currentPid ?? process.pid);
    return recoveryRequired(options, localState, "native-recovery-failed", authority);
  }
  const refreshed = localState.inspectRuntimeState();
  if (refreshed.status !== "ok")
    return recoveryRequired(options, localState, "post-native-authority-invalid", authority);
  const refreshedAuthority = loadAuthority(
    options.stateDir,
    refreshed.state,
    refreshed.contentSha256,
  );
  const descriptor =
    refreshedAuthority === undefined
      ? undefined
      : recoveredDescriptor(refreshedAuthority, ownership);
  return descriptor === undefined
    ? recoveryRequired(options, localState, "post-native-authority-invalid", authority)
    : { status: "recovered", descriptor };
}

function recoveredDescriptor(
  authority: RecoveryAuthority,
  ownership: UpdateSessionRecoveryOwnership,
): PortableRecoveredLaunchDescriptor | undefined {
  const restored = authority.receipts.some(
    (receipt) => receipt.kind === "restore" && receipt.outcome === "completed",
  );
  const targetStarted = authority.receipts.some(
    (receipt) => receipt.kind === "start" && receipt.outcome === "completed",
  );
  if (!restored && !targetStarted) return undefined;
  return {
    ...ownership,
    activationId: authority.plan.activationId,
    planSha256: portableHandoffPlanSha256(authority.plan),
    launchId: restored ? authority.plan.restoreLaunchId : authority.plan.newLaunchId,
    host: authority.plan.oldProcess.host,
    port: authority.plan.oldProcess.port,
    expectedVersion: restored ? authority.plan.oldProcess.version : authority.plan.targetVersion,
  };
}

export async function reconcilePortableNormalStartup(
  options: PortableNormalStartupRecoveryOptions,
): Promise<PortableNormalStartupRecoveryResult> {
  if (options.target === "windows-x64") return { status: "normal" };
  const now = options.now ?? Date.now;
  const localState = createUpdateLocalStateManager({
    stateDir: options.stateDir,
    now,
    activityLog: options.securityLogSink,
  });
  const authority = loadStartupAuthority(options, localState);
  if (isRecoveryResult(authority)) return authority;
  const claimed = claimStartupOwnership(options, localState, authority);
  if (isRecoveryResult(claimed)) return claimed;
  return claimed.unaccepted
    ? recoverUnaccepted(options, localState, claimed, now)
    : recoverAccepted(options, localState, claimed);
}
