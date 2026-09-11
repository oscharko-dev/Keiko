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
import {
  bindSecurityLogCorrelation,
  emitSecurityLogEvent,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
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
import {
  attestWindowsGenerationInstallation,
  windowsGenerationInspectionAllowance,
  type WindowsGenerationInspectionAllowance,
} from "./update-portable-windows-inspection-allowance.js";
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
const RECOVERY_TEARDOWN_TIMEOUT_MS = 5_000;
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
  | {
      readonly status: "normal";
      readonly inspectionAllowance?: WindowsGenerationInspectionAllowance;
    }
  | {
      readonly status: "recovered";
      readonly descriptor: PortableRecoveredLaunchDescriptor;
      readonly inspectionAllowance?: WindowsGenerationInspectionAllowance;
    }
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

export type PortableNativeRecoveryOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly process: "confirmed-dead" | "ambiguous-live" };

export interface PortableNativeRecoveryProcess {
  readonly pid: number | undefined;
  readonly destroyControl: () => void;
  readonly endControl: (control: Buffer) => void;
  readonly onControlError: (listener: (error: Error) => void) => void;
  readonly onError: (listener: (error: Error) => void) => void;
  readonly onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  readonly terminate: (signal: NodeJS.Signals) => void;
}

export interface PortableNormalStartupRecoveryOptions {
  readonly stateDir: string;
  readonly target: PortableHandoffPlan["target"];
  readonly expectedManagedRoot: string;
  readonly pidAlive?: ((pid: number) => boolean) | undefined;
  readonly processIdentity?: string | undefined;
  readonly currentPid?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly runNative?:
    ((input: PortableNativeRecoveryInput) => Promise<PortableNativeRecoveryOutcome>) | undefined;
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

type RecoveryCompletion = "native-recovered" | "unaccepted-settled";

function recordRecoveryCompleted(
  options: PortableNormalStartupRecoveryOptions,
  authority: RecoveryAuthority,
  outcome: RecoveryCompletion,
): void {
  emitSecurityLogEvent(options.securityLogSink, {
    category: "diagnostic",
    correlationId: authority.session.correlationId,
    op: "portable.normal-startup-recovery.completed",
    extra: { outcome, target: authority.plan.target },
  });
}

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
  securityLogSink: SecurityLogSink | undefined,
): Promise<boolean> {
  const { plan } = authority;
  if (plan.target === "windows-x64") {
    return attestWindowsGenerationInstallation({ plan, selection: "current", stateDir });
  }
  return (
    attestPortableManagedRegistration({
      stateDir,
      managedRoot: plan.paths.managedRoot,
      target: plan.target,
      version: plan.oldProcess.version,
      expectedSha256: plan.digests.previousRegistrationSha256,
    }) &&
    createPortableHandoffTreeAttestor({
      managedRoot: plan.paths.managedRoot,
      securityLogSink: bindSecurityLogCorrelation(
        securityLogSink,
        authority.state.activationWal.activationId,
      ),
    })(plan.digests.currentTreeSha256)
  );
}

async function settleUnaccepted(
  authority: RecoveryAuthority,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  stateDir: string,
  now: () => number,
  securityLogSink: SecurityLogSink | undefined,
): Promise<boolean> {
  const session = authority.state.activeSession;
  if (
    session?.sessionId !== authority.session.sessionId ||
    !(await initialStateAttested(authority, stateDir, securityLogSink))
  )
    return false;
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
      "KUR1",
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

function spawnNativeRecoveryProcess(
  input: PortableNativeRecoveryInput,
): PortableNativeRecoveryProcess {
  const child = spawn(input.coordinator, ["--recover-update", input.activationId], {
    env: { KEIKO_STATE_DIR: input.stateDir },
    stdio: ["pipe", "ignore", "ignore"],
  });
  return {
    pid: child.pid,
    destroyControl: (): void => {
      child.stdin.destroy();
    },
    endControl: (control): void => {
      child.stdin.end(control);
    },
    onControlError: (listener): void => {
      child.stdin.once("error", listener);
    },
    onError: (listener): void => {
      child.once("error", listener);
    },
    onExit: (listener): void => {
      child.once("exit", listener);
    },
    terminate: (signal): void => {
      child.kill(signal);
    },
  };
}

interface NativeRecoveryLifecycle {
  readonly beginTeardown: () => void;
  readonly finish: (outcome: PortableNativeRecoveryOutcome) => void;
  readonly isTearingDown: () => boolean;
  readonly startTimeout: (timeoutMs: number) => void;
}

function createNativeRecoveryLifecycle(
  child: PortableNativeRecoveryProcess,
  resolveOutcome: (outcome: PortableNativeRecoveryOutcome) => void,
): NativeRecoveryLifecycle {
  let settled = false;
  let tearingDown = false;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let teardownTimer: NodeJS.Timeout | undefined;
  const finish = (outcome: PortableNativeRecoveryOutcome): void => {
    if (settled) return;
    settled = true;
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    if (teardownTimer !== undefined) clearTimeout(teardownTimer);
    resolveOutcome(outcome);
  };
  const beginTeardown = (): void => {
    if (tearingDown || settled) return;
    tearingDown = true;
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    try {
      child.destroyControl();
    } catch {
      // Process exit remains the ownership authority when closing the pipe fails.
    }
    teardownTimer = setTimeout(() => {
      finish({ status: "failed", process: "ambiguous-live" });
    }, RECOVERY_TEARDOWN_TIMEOUT_MS);
    try {
      child.terminate("SIGKILL");
    } catch {
      // The bounded exit wait distinguishes confirmed death from ambiguity.
    }
  };
  return {
    beginTeardown,
    finish,
    isTearingDown: (): boolean => tearingDown,
    startTimeout: (timeoutMs): void => {
      recoveryTimer = setTimeout(beginTeardown, timeoutMs);
    },
  };
}

export function runPortableNativeRecoveryProcess(
  input: PortableNativeRecoveryInput,
  spawnProcess: (
    input: PortableNativeRecoveryInput,
  ) => PortableNativeRecoveryProcess = spawnNativeRecoveryProcess,
): Promise<PortableNativeRecoveryOutcome> {
  let child: PortableNativeRecoveryProcess;
  try {
    child = spawnProcess(input);
  } catch {
    return Promise.resolve({ status: "failed", process: "confirmed-dead" });
  }
  return new Promise<PortableNativeRecoveryOutcome>((resolve) => {
    const lifecycle = createNativeRecoveryLifecycle(child, resolve);
    lifecycle.startTimeout(input.timeoutMs);
    child.onError(() => {
      if (child.pid === undefined) {
        lifecycle.finish({ status: "failed", process: "confirmed-dead" });
        return;
      }
      lifecycle.beginTeardown();
    });
    child.onControlError(lifecycle.beginTeardown);
    child.onExit((code, signal) => {
      lifecycle.finish(
        code === 0 && signal === null && !lifecycle.isTearingDown()
          ? { status: "succeeded" }
          : { status: "failed", process: "confirmed-dead" },
      );
    });
    if (child.pid === undefined) {
      lifecycle.finish({ status: "failed", process: "confirmed-dead" });
      return;
    }
    try {
      if (!input.onSpawn(child.pid)) {
        lifecycle.beginTeardown();
        return;
      }
      child.endControl(input.control);
    } catch {
      lifecycle.beginTeardown();
    }
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
  const [prepared] = authority.receipts;
  const preacceptanceReceipts =
    authority.receipts.length === 0 ||
    (authority.receipts.length === 1 &&
      prepared?.kind === "prepared" &&
      prepared.outcome === "completed");
  return (
    authority.state.activeSession?.sessionId === authority.session.sessionId &&
    preacceptanceReceipts &&
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
  return unaccepted && authority.receipts.length === 0;
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
    if (
      !(await settleUnaccepted(
        claimed.authority,
        localState,
        options.stateDir,
        now,
        options.securityLogSink,
      ))
    )
      return recoveryRequired(options, localState, "prepared-settlement-failed", claimed.authority);
    if (!releaseStateDirUpdateSessionLockForRecovery(options.stateDir, claimed.ownership)) {
      return recoveryRequired(options, localState, "prepared-settlement-failed", claimed.authority);
    }
    recordRecoveryCompleted(options, claimed.authority, "unaccepted-settled");
    return { status: "normal" };
  } catch {
    return recoveryRequired(options, localState, "prepared-settlement-failed", claimed.authority);
  }
}

interface NativeRecoveryAttempt {
  readonly outcome: PortableNativeRecoveryOutcome;
  readonly nativePidPublished: boolean;
}

function recordConfirmedNativeRecoveryFailure(
  options: PortableNormalStartupRecoveryOptions,
  authority: RecoveryAuthority,
  ownedLock: ReturnType<typeof createStateDirUpdateSessionLock>,
  attempt: NativeRecoveryAttempt,
): void {
  if (
    attempt.outcome.status === "failed" &&
    attempt.outcome.process === "confirmed-dead" &&
    !attempt.nativePidPublished
  ) {
    ownedLock.updateChildPid(authority.session.sessionId, options.currentPid ?? process.pid);
  }
}

function recoveryCoordinatorName(plan: PortableHandoffPlan): string {
  return plan.target === "windows-x64" ? "coordinator.exe" : "coordinator";
}

async function runAcceptedNativeRecovery(
  options: PortableNormalStartupRecoveryOptions,
  authority: RecoveryAuthority,
  ownership: UpdateSessionRecoveryOwnership,
  ownedLock: ReturnType<typeof createStateDirUpdateSessionLock>,
): Promise<NativeRecoveryAttempt> {
  const publishedNativePids = new Set<number>();
  try {
    const outcome = await (options.runNative ?? runPortableNativeRecoveryProcess)({
      coordinator: join(
        portableHandoffRoot(options.stateDir, authority.plan.activationId),
        recoveryCoordinatorName(authority.plan),
      ),
      activationId: authority.plan.activationId,
      control: encodeControl(authority, ownership),
      stateDir: options.stateDir,
      timeoutMs: RECOVERY_TIMEOUT_MS,
      onSpawn: (nativePid) => {
        const published = ownedLock.updateChildPid(authority.session.sessionId, nativePid);
        if (published) publishedNativePids.add(nativePid);
        return published;
      },
    });
    return { outcome, nativePidPublished: publishedNativePids.size > 0 };
  } catch {
    const nativePidPublished = publishedNativePids.size > 0;
    return {
      outcome: {
        status: "failed",
        process: nativePidPublished ? "ambiguous-live" : "confirmed-dead",
      },
      nativePidPublished,
    };
  }
}

async function recoverAccepted(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  claimed: ClaimedRecovery,
): Promise<PortableNormalStartupRecoveryResult> {
  const { authority, ownership } = claimed;
  const wal = authority.state.activationWal;
  const coordinator = join(
    portableHandoffRoot(options.stateDir, wal.activationId),
    recoveryCoordinatorName(authority.plan),
  );
  if (!SHA256.test(wal.coordinatorSha256) || digestFile(coordinator) !== wal.coordinatorSha256)
    return recoveryRequired(options, localState, "coordinator-invalid", authority);
  const ownedLock = createStateDirUpdateSessionLock(options.stateDir);
  const attempt = await runAcceptedNativeRecovery(options, authority, ownership, ownedLock);
  if (attempt.outcome.status === "failed") {
    recordConfirmedNativeRecoveryFailure(options, authority, ownedLock, attempt);
    return recoveryRequired(options, localState, "native-recovery-failed", authority);
  }
  return attestRecoveredStartup(options, localState, authority, ownership);
}

async function attestRecoveredStartup(
  options: PortableNormalStartupRecoveryOptions,
  localState: ReturnType<typeof createUpdateLocalStateManager>,
  priorAuthority: RecoveryAuthority,
  ownership: UpdateSessionRecoveryOwnership,
): Promise<PortableNormalStartupRecoveryResult> {
  const refreshed = localState.inspectRuntimeState();
  if (refreshed.status !== "ok")
    return recoveryRequired(options, localState, "post-native-authority-invalid", priorAuthority);
  const refreshedAuthority = loadAuthority(
    options.stateDir,
    refreshed.state,
    refreshed.contentSha256,
  );
  const descriptor =
    refreshedAuthority === undefined
      ? undefined
      : recoveredDescriptor(refreshedAuthority, ownership);
  if (descriptor === undefined || refreshedAuthority === undefined) {
    return recoveryRequired(options, localState, "post-native-authority-invalid", priorAuthority);
  }
  if (!(await recoveredWindowsInstallAttested(refreshedAuthority, options.stateDir))) {
    return recoveryRequired(options, localState, "post-native-authority-invalid", priorAuthority);
  }
  recordRecoveryCompleted(options, refreshedAuthority, "native-recovered");
  localState.recordAuditEvent("portable-relaunch-result", {
    correlationId: refreshedAuthority.session.correlationId,
    targetVersion: refreshedAuthority.session.targetVersion,
    portableActivationId: refreshedAuthority.plan.activationId,
    status: "succeeded",
  });
  return recoveredStartupResult(refreshedAuthority, descriptor);
}

async function recoveredWindowsInstallAttested(
  authority: RecoveryAuthority,
  stateDir: string,
): Promise<boolean> {
  if (authority.plan.target !== "windows-x64") return true;
  const restored = hasCompletedReceipt(authority, "restore");
  return attestWindowsGenerationInstallation({
    plan: authority.plan,
    selection: restored ? "current" : "candidate",
    stateDir,
  });
}

function hasCompletedReceipt(
  authority: RecoveryAuthority,
  kind: PortableHandoffReceipt["kind"],
): boolean {
  return authority.receipts.some(
    (receipt) => receipt.kind === kind && receipt.outcome === "completed",
  );
}

function recoveredStartupResult(
  authority: RecoveryAuthority,
  descriptor: PortableRecoveredLaunchDescriptor,
): PortableNormalStartupRecoveryResult {
  if (authority.plan.target !== "windows-x64") return { status: "recovered", descriptor };
  return {
    status: "recovered",
    descriptor,
    inspectionAllowance: windowsGenerationInspectionAllowance(authority.plan, authority.receipts),
  };
}

function recoveredDescriptor(
  authority: RecoveryAuthority,
  ownership: UpdateSessionRecoveryOwnership,
): PortableRecoveredLaunchDescriptor | undefined {
  const restored = hasCompletedReceipt(authority, "restore");
  const targetStarted = hasCompletedReceipt(authority, "start");
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
