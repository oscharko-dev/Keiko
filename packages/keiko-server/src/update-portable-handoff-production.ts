import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { bindSecurityLogCorrelation, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import type { UpdateActivationWalState, UpdateSession } from "@oscharko-dev/keiko-contracts";
import { transitionUpdateSession } from "./update-lifecycle.js";
import { attestPortableManagedRegistration } from "./update-portable-activation-files.js";
import {
  createPortableHandoffTreeAttestor,
  type PortableHandoffProcessIdentity,
} from "./update-portable-handoff-builder.js";
import { readPortableHandoffPlan } from "./update-portable-handoff-plan.js";
import {
  createPortableHandoffCoordinator,
  type PortableHandoffCoordinatorPort,
} from "./update-portable-handoff.js";
import { verifyPortableHandoffNativeCopy } from "./update-portable-handoff-native-verification.js";
import {
  createUpdateStartupRecovery,
  type UpdateStartupActiveInstallAttestationInput,
  type UpdateStartupRecoveryPort,
  type UpdateStartupRecoveryOptions,
} from "./update-portable-handoff-recovery.js";
import { attestWindowsGenerationInstallation } from "./update-portable-windows-inspection-allowance.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";
import {
  releaseStateDirUpdateSessionLockForRecovery,
  type UpdateSessionLock,
  type UpdateSessionRecoveryOwnership,
} from "./update-session-lock.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const LAUNCH_ID = /^[a-f0-9]{32}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;

export interface ProductionPortableHandoffRuntimeOptions {
  readonly env: EnvSource;
  readonly stateDir: string;
  readonly currentVersion: string;
  readonly localState: UpdateLocalStateManager;
  readonly sessionLock: UpdateSessionLock;
  readonly recoveryOwnership?: UpdateSessionRecoveryOwnership | undefined;
  readonly now?: (() => number) | undefined;
  readonly pid?: number | undefined;
  readonly verifyNativeCopy?: typeof verifyPortableHandoffNativeCopy | undefined;
  readonly canComplete?: ((session: UpdateSession) => boolean) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export interface ProductionPortableHandoffRuntime {
  readonly coordinator: PortableHandoffCoordinatorPort;
  readonly recovery: UpdateStartupRecoveryPort;
  readonly currentProcess: () => PortableHandoffProcessIdentity;
}

export class ProductionPortableHandoffError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProductionPortableHandoffError";
  }
}

function fail(message: string): never {
  throw new ProductionPortableHandoffError(message);
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function validHandoffPort(portText: string | undefined, port: number): boolean {
  return /^[1-9]\d{0,4}$/u.test(portText ?? "") && Number.isSafeInteger(port) && port <= 65_535;
}

function validCurrentProcessInput(
  input: Pick<ProductionPortableHandoffRuntimeOptions, "env" | "currentVersion">,
  launchId: string | undefined,
  portText: string | undefined,
  port: number,
): boolean {
  return (
    input.env.KEIKO_UI_HOST === "127.0.0.1" &&
    LAUNCH_ID.test(launchId ?? "") &&
    validHandoffPort(portText, port) &&
    VERSION.test(input.currentVersion)
  );
}

export function createPortableHandoffCurrentProcessResolver(input: {
  readonly env: EnvSource;
  readonly currentVersion: string;
  readonly pid?: number | undefined;
}): () => PortableHandoffProcessIdentity {
  return () => {
    const launchId = input.env.KEIKO_UI_LAUNCH_ID;
    const portText = input.env.KEIKO_UI_PORT;
    const port = portText === undefined ? Number.NaN : Number(portText);
    if (!validCurrentProcessInput(input, launchId, portText, port)) {
      fail("portable handoff current process identity is unavailable");
    }
    const pid = input.pid ?? process.pid;
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
      fail("portable handoff current process identity is unavailable");
    }
    return {
      pid,
      launchId: launchId ?? "",
      host: "127.0.0.1",
      port,
      version: input.currentVersion,
    };
  };
}

function assertSessionAndWal(input: {
  readonly localState: UpdateLocalStateManager;
  readonly sessionId: string;
  readonly activationWal: UpdateActivationWalState;
  readonly prepared: boolean;
}): ReturnType<UpdateLocalStateManager["readRuntimeState"]> {
  const current = input.localState.readRuntimeState();
  assertHandoffSession(current, input.sessionId);
  if (input.prepared) assertPreparedAuthority(current, input.activationWal);
  else assertAcceptedAuthority(current, input.activationWal);
  return current;
}

function assertHandoffSession(
  current: ReturnType<UpdateLocalStateManager["readRuntimeState"]>,
  sessionId: string,
): void {
  if (current.activeSession?.sessionId !== sessionId) {
    fail("portable handoff session authority changed");
  }
}

function assertPreparedAuthority(
  current: ReturnType<UpdateLocalStateManager["readRuntimeState"]>,
  wal: UpdateActivationWalState,
): void {
  if (
    current.revision + 1 !== wal.intentRevision ||
    current.activationWal !== undefined ||
    current.activeSession?.lifecycle.cancellationCutoff !== "not-reached"
  ) {
    fail("portable handoff aggregate revision changed");
  }
}

function assertAcceptedAuthority(
  current: ReturnType<UpdateLocalStateManager["readRuntimeState"]>,
  wal: UpdateActivationWalState,
): void {
  const active = current.activeSession;
  const persisted = current.activationWal;
  if (
    persisted?.activationId !== wal.activationId ||
    persisted.planSha256 !== wal.planSha256 ||
    persisted.coordinatorSha256 !== wal.coordinatorSha256 ||
    persisted.coordinatorId !== undefined ||
    !active?.cancelable ||
    active.lifecycle.cancellationCutoff !== "not-reached" ||
    active.lifecycle.phase !== "staging"
  ) {
    fail("portable handoff prepared authority changed");
  }
}

function recoveryState(
  now: () => number,
  sessionId: string,
  status: "reconciling" | "settled",
): ReturnType<UpdateLocalStateManager["readRuntimeState"]>["recovery"] {
  return { status, sessionId, updatedAt: nowIso(now) };
}

function projectRecoveredSession(
  session: UpdateSession,
  wal: UpdateActivationWalState,
  canComplete: ((session: UpdateSession) => boolean) | undefined,
): { readonly active?: UpdateSession | undefined; readonly last?: UpdateSession | undefined } {
  if (wal.checkpoint === "complete") {
    const completionReady =
      session.lifecycle.phase === "handoff-pending"
        ? {
            ...session,
            ...transitionUpdateSession(session, { phase: "verifying-relaunch" }),
          }
        : session;
    const phase = canComplete?.(session) === false ? "remediation-required" : "succeeded";
    const projected = {
      ...completionReady,
      ...transitionUpdateSession(completionReady, { phase }),
      failureReason: "none" as const,
      retryable: false,
      message:
        phase === "succeeded"
          ? `Portable update ${session.targetVersion} completed after native recovery.`
          : "Portable update activation completed; required remediation is still pending.",
    };
    return phase === "succeeded" ? { last: projected } : { active: projected };
  }
  const phase = wal.checkpoint === "cleanup-pending" ? "cleanup-pending" : "verifying-relaunch";
  if (session.lifecycle.phase === phase) return { active: session };
  return {
    active: {
      ...session,
      ...transitionUpdateSession(session, { phase }),
      failureReason: "none",
      retryable: false,
      message:
        phase === "cleanup-pending"
          ? "Portable update is verified and native cleanup is pending."
          : "Portable update is running and awaiting native cleanup proof.",
    },
  };
}

function resolvedPromise<T>(work: () => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(work);
}

function recoveryActiveSession(
  active: UpdateSession | undefined,
  sessionId: string,
): UpdateSession {
  if (active?.sessionId !== sessionId) fail("portable recovery session authority changed");
  return active;
}

function createRecoveryReadActivation(
  localState: UpdateLocalStateManager,
): UpdateStartupRecoveryOptions["readActivation"] {
  return () => {
    const inspected = localState.inspectRuntimeState();
    if (!("state" in inspected)) {
      return {
        failureReason: inspected.status === "unwritable" ? "persistence-failed" : inspected.status,
      };
    }
    const state = inspected.state;
    const session =
      state.activeSession ?? (state.activationWal === undefined ? undefined : state.lastSession);
    return {
      ...(session === undefined ? {} : { sessionId: session.sessionId }),
      ...(state.activationWal === undefined ? {} : { activationWal: state.activationWal }),
    };
  };
}

function releaseRecoveredOwnership(options: ProductionPortableHandoffRuntimeOptions): void {
  if (options.recoveryOwnership === undefined) return;
  if (!releaseStateDirUpdateSessionLockForRecovery(options.stateDir, options.recoveryOwnership)) {
    fail("portable recovery ownership changed before release");
  }
}

function persistTerminalRecovery(input: {
  readonly options: ProductionPortableHandoffRuntimeOptions;
  readonly now: () => number;
  readonly current: ReturnType<UpdateLocalStateManager["readRuntimeState"]>;
  readonly sessionId: string;
  readonly activationWal: UpdateActivationWalState;
  readonly phase: "pre-listen" | "post-listen";
}): void {
  if (
    input.current.lastSession?.sessionId !== input.sessionId ||
    input.activationWal.checkpoint !== "complete"
  ) {
    fail("portable recovery terminal session authority changed");
  }
  const settled = input.phase === "post-listen";
  input.options.localState.writeRuntimeState({
    ...input.current,
    activationWal: settled ? undefined : input.activationWal,
    recovery: recoveryState(input.now, input.sessionId, settled ? "settled" : "reconciling"),
  });
  if (settled) releaseRecoveredOwnership(input.options);
}

function persistActiveRecovery(input: {
  readonly options: ProductionPortableHandoffRuntimeOptions;
  readonly now: () => number;
  readonly current: ReturnType<UpdateLocalStateManager["readRuntimeState"]>;
  readonly active: UpdateSession;
  readonly sessionId: string;
  readonly activationWal: UpdateActivationWalState;
  readonly phase: "pre-listen" | "post-listen";
}): void {
  const authoritative = recoveryActiveSession(input.active, input.sessionId);
  const projection =
    input.phase === "pre-listen"
      ? { active: authoritative }
      : projectRecoveredSession(authoritative, input.activationWal, input.options.canComplete);
  const settled = input.phase === "post-listen" && input.activationWal.checkpoint === "complete";
  input.options.localState.writeRuntimeState({
    ...input.current,
    ...(projection.active === undefined
      ? { activeSession: undefined, activeCandidate: undefined }
      : { activeSession: projection.active }),
    ...(projection.last === undefined ? {} : { lastSession: projection.last }),
    activationWal: settled ? undefined : input.activationWal,
    recovery: recoveryState(input.now, input.sessionId, settled ? "settled" : "reconciling"),
  });
  if (settled) releaseRecoveredOwnership(input.options);
}

function persistRecoveredActivation(
  options: ProductionPortableHandoffRuntimeOptions,
  now: () => number,
): UpdateStartupRecoveryOptions["persistActivation"] {
  return ({ sessionId, activationWal, phase }) =>
    resolvedPromise(() => {
      const current = options.localState.readRuntimeState();
      const active = current.activeSession;
      if (active === undefined) {
        persistTerminalRecovery({ options, now, current, sessionId, activationWal, phase });
        return;
      }
      persistActiveRecovery({ options, now, current, active, sessionId, activationWal, phase });
    });
}

function settleRestoredActivation(
  options: ProductionPortableHandoffRuntimeOptions,
  now: () => number,
): UpdateStartupRecoveryOptions["settleRestored"] {
  return ({ sessionId, activationWal }) =>
    resolvedPromise(() => {
      const current = options.localState.readRuntimeState();
      const active = current.activeSession;
      if (
        active?.sessionId !== sessionId ||
        activationWal.checkpoint !== "restored-verified" ||
        current.activationWal?.activationId !== activationWal.activationId
      ) {
        fail("portable restore settlement authority changed");
      }
      const restored = recoveryActiveSession(active, sessionId);
      const failed = {
        ...restored,
        ...transitionUpdateSession(restored, { phase: "failed" }),
        failureReason: "portable-relaunch-failed" as const,
        cancelable: false,
        retryable: false,
        restartRequired: false,
        message: `Portable update ${restored.targetVersion} failed; the prior verified installation was restored.`,
      };
      options.localState.writeRuntimeState({
        ...current,
        activeSession: undefined,
        activeCandidate: undefined,
        lastSession: failed,
        activationWal: undefined,
        recovery: recoveryState(now, sessionId, "settled"),
      });
      options.localState.recordAuditEvent("portable-relaunch-result", {
        correlationId: restored.correlationId,
        targetVersion: restored.targetVersion,
        portableActivationId: activationWal.activationId,
        status: "failed",
      });
      releaseRecoveredOwnership(options);
    });
}

function attestRecoveredTree(
  options: ProductionPortableHandoffRuntimeOptions,
): UpdateStartupRecoveryOptions["attestActiveTree"] {
  return (input) => {
    const expectedSha256 =
      input.kind === "windows-generation-v1"
        ? input.expectedGenerationTreeSha256
        : input.expectedTreeSha256;
    if (!SHA256.test(expectedSha256)) return Promise.resolve(false);
    return resolvedPromise<boolean>(() => attestRecoveredInstall(options, input));
  };
}

function windowsAttestationSelection(
  plan: Extract<ReturnType<typeof readPortableHandoffPlan>, { readonly target: "windows-x64" }>,
  input: Extract<
    UpdateStartupActiveInstallAttestationInput,
    { readonly kind: "windows-generation-v1" }
  >,
): "current" | "candidate" | undefined {
  if (
    plan.currentGenerationTreeSha256 === input.expectedGenerationTreeSha256 &&
    plan.currentSetupManifestSha256 === input.expectedSetupManifestSha256 &&
    plan.digests.previousRegistrationSha256 === input.expectedRegistrationSha256 &&
    plan.oldProcess.version === input.expectedVersion
  ) {
    return "current";
  }
  return plan.candidateGenerationTreeSha256 === input.expectedGenerationTreeSha256 &&
    plan.candidateSetupManifestSha256 === input.expectedSetupManifestSha256 &&
    plan.digests.preparedRegistrationSha256 === input.expectedRegistrationSha256 &&
    plan.targetVersion === input.expectedVersion
    ? "candidate"
    : undefined;
}

async function attestRecoveredWindowsInstall(
  options: ProductionPortableHandoffRuntimeOptions,
  plan: Extract<ReturnType<typeof readPortableHandoffPlan>, { readonly target: "windows-x64" }>,
  input: UpdateStartupActiveInstallAttestationInput,
): Promise<boolean> {
  if (input.kind !== "windows-generation-v1" || !SHA256.test(input.expectedSetupManifestSha256)) {
    return false;
  }
  const selection = windowsAttestationSelection(plan, input);
  return selection === undefined
    ? false
    : attestWindowsGenerationInstallation({ plan, selection, stateDir: options.stateDir });
}

async function attestRecoveredMacInstall(
  options: ProductionPortableHandoffRuntimeOptions,
  plan: Exclude<ReturnType<typeof readPortableHandoffPlan>, { readonly target: "windows-x64" }>,
  input: UpdateStartupActiveInstallAttestationInput,
): Promise<boolean> {
  if (
    input.kind !== "whole-root-v1" ||
    (plan.digests.candidateTreeSha256 !== input.expectedTreeSha256 &&
      plan.digests.currentTreeSha256 !== input.expectedTreeSha256) ||
    !attestPortableManagedRegistration({
      stateDir: options.stateDir,
      managedRoot: plan.paths.managedRoot,
      target: plan.target,
      version: input.expectedVersion,
      expectedSha256: input.expectedRegistrationSha256,
    })
  ) {
    return false;
  }
  return createPortableHandoffTreeAttestor({
    managedRoot: plan.paths.managedRoot,
    securityLogSink: bindSecurityLogCorrelation(options.securityLogSink, input.activationId),
  })(input.expectedTreeSha256);
}

function attestRecoveredInstall(
  options: ProductionPortableHandoffRuntimeOptions,
  input: UpdateStartupActiveInstallAttestationInput,
): Promise<boolean> {
  const plan = readPortableHandoffPlan(options.stateDir, input.activationId);
  return plan.target === "windows-x64"
    ? attestRecoveredWindowsInstall(options, plan, input)
    : attestRecoveredMacInstall(options, plan, input);
}

function createProductionRecovery(
  options: ProductionPortableHandoffRuntimeOptions,
  now: () => number,
): UpdateStartupRecoveryPort {
  return createUpdateStartupRecovery({
    stateDir: options.stateDir,
    readActivation: createRecoveryReadActivation(options.localState),
    persistActivation: persistRecoveredActivation(options, now),
    settleRestored: settleRestoredActivation(options, now),
    attestActiveTree: attestRecoveredTree(options),
    now,
  });
}

export function createProductionPortableHandoffRuntime(
  options: ProductionPortableHandoffRuntimeOptions,
): ProductionPortableHandoffRuntime {
  const now = options.now ?? Date.now;
  const persistWal = (input: {
    readonly sessionId: string;
    readonly activationWal: UpdateActivationWalState;
    readonly prepared: boolean;
  }): Promise<void> =>
    resolvedPromise(() => {
      const current = assertSessionAndWal({ ...input, localState: options.localState });
      options.localState.writeRuntimeState({
        ...current,
        activationWal: input.activationWal,
        recovery: recoveryState(now, input.sessionId, "reconciling"),
      });
    });
  const coordinator = createPortableHandoffCoordinator({
    stateDir: options.stateDir,
    persistPrepared: ({ sessionId, activationWal }) =>
      persistWal({ sessionId, activationWal, prepared: true }),
    persistAccepted: ({ sessionId, activationWal }) =>
      persistWal({ sessionId, activationWal, prepared: false }),
    publishCoordinatorPid: (sessionId, coordinatorPid) =>
      options.sessionLock.updateChildPid(sessionId, coordinatorPid),
    verifyNativeCopy: options.verifyNativeCopy ?? verifyPortableHandoffNativeCopy,
    now,
  });
  const recovery = createProductionRecovery(options, now);
  return {
    coordinator,
    recovery,
    currentProcess: createPortableHandoffCurrentProcessResolver({
      env: options.env,
      currentVersion: options.currentVersion,
      pid: options.pid,
    }),
  };
}
