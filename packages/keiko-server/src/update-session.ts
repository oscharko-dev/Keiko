import {
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type {
  UpdateInstallMode,
  UpdateInstallPackageManager,
  UpdateCandidateSnapshot,
  UpdatePortableActivationSummary,
  UpdatePortableStagingSummary,
  UpdatePreflightReport,
  UpdateReleaseImpactInput,
  UpdateLifecyclePhase,
  UpdateRestartCommandPreview,
  UpdateSession,
  UpdateSessionFailureReason,
  UpdateSessionStartRequest,
  UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_SESSION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/update-session";
import {
  PACKAGE_NAME,
  UPDATE_COMMAND_RULES,
  buildUpdateCommand,
  productionUpdateFacts,
  resolveUpdateMutationPolicy,
  type UpdateRuntimeFacts,
} from "./update-install-mode.js";
import {
  PortableUpdateStagingError,
  type PortableUpdateStager,
} from "./update-portable-staging.js";
import {
  PortableUpdateActivationError,
  type PortableUpdateActivator,
} from "./update-portable-activation.js";
import {
  defaultDetectorFor,
  failureFromError,
  isTerminal,
  logPreview,
  messageForFailure,
  nowIso,
  resolveManagerRuntime,
  retryableFailure,
  restartVerificationPatch,
  workspaceFor,
  type UpdateRestartVerifier,
  type UpdateRunCommandImpl,
  UpdateSessionError,
} from "./update-session-support.js";
import type { UpdateSessionLock } from "./update-session-lock.js";
import type {
  UpdateCandidateAuthority,
  UpdateCandidateRejection,
} from "./update-candidate-authority.js";
import {
  digestUpdateCandidate,
  updateCandidateRuntimeRejection,
} from "./update-candidate-authority.js";
import { initialUpdateLifecycle, transitionUpdateSession } from "./update-lifecycle.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";

export { UpdateSessionError } from "./update-session-support.js";

const RESTART_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const SIMPLE_SHELL_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/u;
const UPDATE_SESSION_LIFECYCLE_OP = "update.session.lifecycle";

function validPort(value: string | undefined): value is string {
  if (value === undefined || !/^\d{1,5}$/u.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function validHost(value: string | undefined): value is string {
  return value !== undefined && RESTART_HOSTS.has(value);
}

function validStateDir(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !/[\0\r\n]/u.test(value);
}

function shellQuoteArg(value: string): string {
  if (SIMPLE_SHELL_ARG.test(value)) return value;
  const escapedSingleQuote = String.raw`'\''`;
  return `'${value.replaceAll("'", escapedSingleQuote)}'`;
}

function restartCommandPreview(env: NodeJS.ProcessEnv): UpdateRestartCommandPreview | undefined {
  const port = env.KEIKO_UI_PORT;
  const host = env.KEIKO_UI_HOST;
  const stateDir = env.KEIKO_STATE_DIR;
  if (!validPort(port) || !validHost(host) || !validStateDir(stateDir)) return undefined;
  const args = ["restart", "--port", port, "--host", host, "--state-dir", stateDir];
  return {
    executable: "keiko",
    args,
    label: ["keiko", ...args].map(shellQuoteArg).join(" "),
  };
}

function assertRestartTargetMatches(
  session: UpdateSession,
  targetVersion: string | undefined,
): void {
  if (targetVersion === undefined || session.targetVersion === targetVersion) return;
  throw new UpdateSessionError(
    "UPDATE_TARGET_MISMATCH",
    "The restart target does not match the session.",
    409,
  );
}

function durableSession(session: UpdateSession): UpdateSession {
  const bodyFree = { ...session };
  delete bodyFree.logs;
  delete bodyFree.installRoot;
  delete bodyFree.commandPreview;
  delete bodyFree.restartCommandPreview;
  return bodyFree;
}

export interface UpdateSessionStartOutcome {
  readonly session: UpdateSession;
  readonly reused: boolean;
}

export type UpdateCompletionGate = (session: UpdateSession) => boolean;

export interface PortableHandoffShutdownRequest {
  readonly sessionId: string;
  readonly activationId: string;
  readonly pid: number;
  readonly launchId: string;
}

export interface UpdateSessionManager {
  readonly getStatus: () => UpdateSessionStatus;
  readonly start: (
    input: UpdateSessionStartRequest,
    freshReport?: UpdatePreflightReport,
  ) => UpdateSessionStartOutcome;
  readonly retry: () => UpdateSessionStartOutcome;
  readonly cancel: () => UpdateSession;
  readonly verifyRestart: UpdateRestartVerifier;
  readonly refreshDurableProjection?: (() => void) | undefined;
}

export interface UpdateSessionManagerOptions {
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly detector?: (() => UpdateInstallMode) | undefined;
  readonly facts?: (() => UpdateRuntimeFacts) | undefined;
  readonly redactor?: ((input: string) => string) | undefined;
  readonly currentVersion?: (() => string) | undefined;
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly runCommandImpl?: UpdateRunCommandImpl | undefined;
  readonly runDeps?: Partial<RunCommandDeps> | undefined;
  readonly beforeExecute?: (() => Promise<void>) | undefined;
  readonly policy?: SandboxPolicy | undefined;
  readonly timeoutMs?: number | undefined;
  readonly lock?: UpdateSessionLock | undefined;
  readonly portableStager?: PortableUpdateStager | undefined;
  readonly portableActivator?: PortableUpdateActivator | undefined;
  readonly portableCompletionGate?: UpdateCompletionGate | undefined;
  readonly onPortableHandoffAccepted?:
    ((request: PortableHandoffShutdownRequest) => Promise<void>) | undefined;
  readonly candidateAuthority?: UpdateCandidateAuthority | undefined;
  readonly candidateGate?:
    ((candidate: UpdateCandidateSnapshot, impact: UpdateReleaseImpactInput) => void) | undefined;
  readonly localState?: UpdateLocalStateManager | undefined;
  readonly activityLog?: SecurityLogSink | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

function candidateError(reason: UpdateCandidateRejection): UpdateSessionError {
  let code = "UPDATE_CANDIDATE_INVALID";
  let message = "The reviewed update candidate no longer matches this installation.";
  if (reason === "expired") {
    code = "UPDATE_CANDIDATE_EXPIRED";
    message = "The reviewed update candidate expired. Run preflight again.";
  } else if (reason === "replayed") {
    code = "UPDATE_CANDIDATE_REPLAYED";
    message = "The reviewed update candidate was already consumed.";
  }
  return new UpdateSessionError(code, message, 409);
}

class UpdateSessionManagerImpl implements UpdateSessionManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly detector: () => UpdateInstallMode;
  private readonly redactor: (input: string) => string;
  private readonly currentVersion: () => string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly runCommandImpl: NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>;
  private readonly runDeps: Partial<RunCommandDeps>;
  private readonly policy: SandboxPolicy;
  private readonly timeoutMs: number;
  private readonly beforeExecute: (() => Promise<void>) | undefined;
  private readonly lock: UpdateSessionLock | undefined;
  private readonly facts: () => UpdateRuntimeFacts;
  private readonly portableStager: PortableUpdateStager | undefined;
  private readonly portableActivator: PortableUpdateActivator | undefined;
  private readonly portableCompletionGate: UpdateCompletionGate | undefined;
  private readonly onPortableHandoffAccepted:
    ((request: PortableHandoffShutdownRequest) => Promise<void>) | undefined;
  private readonly candidateAuthority: UpdateCandidateAuthority | undefined;
  private readonly candidateGate:
    ((candidate: UpdateCandidateSnapshot, impact: UpdateReleaseImpactInput) => void) | undefined;
  private readonly localState: UpdateLocalStateManager | undefined;
  private persistenceStatus: NonNullable<UpdateSessionStatus["persistence"]> = "missing";
  private activeCandidate: UpdateCandidateSnapshot | undefined;
  private readonly activityLog: SecurityLogSink | undefined;
  private readonly diagnostics: ServerDiagnosticSink | undefined;
  private active: UpdateSession | undefined;
  private last: UpdateSession | undefined;
  private activeAbort:
    { readonly sessionId: string; readonly controller: AbortController } | undefined;
  private statusInstallModeSnapshot:
    { readonly sessionId: string; readonly installMode: UpdateInstallMode } | undefined;

  public constructor(options: UpdateSessionManagerOptions = {}) {
    this.env = options.processEnv ?? process.env;
    this.detector = defaultDetectorFor(options, this.env);
    const runtime = resolveManagerRuntime(options);
    this.redactor = runtime.redactor;
    this.currentVersion = runtime.currentVersion;
    this.now = runtime.now;
    this.idFactory = runtime.idFactory;
    this.runCommandImpl = runtime.runCommandImpl;
    this.runDeps = runtime.runDeps;
    this.policy = runtime.policy;
    this.timeoutMs = runtime.timeoutMs;
    this.beforeExecute = runtime.beforeExecute;
    this.lock = options.lock;
    this.facts = options.facts ?? ((): UpdateRuntimeFacts => productionUpdateFacts(this.env));
    this.portableStager = options.portableStager;
    this.portableActivator = options.portableActivator;
    this.portableCompletionGate = options.portableCompletionGate;
    this.onPortableHandoffAccepted = options.onPortableHandoffAccepted;
    this.candidateAuthority = options.candidateAuthority;
    this.candidateGate = options.candidateGate;
    this.localState = options.localState;
    this.activityLog = options.activityLog;
    this.diagnostics = options.diagnostics;
    this.restoreDurableState();
  }

  public readonly getStatus = (): UpdateSessionStatus => {
    const installMode = this.installModeForStatus();
    return {
      schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
      installMode,
      policy: resolveUpdateMutationPolicy(this.env),
      persistence: this.persistenceStatus,
      ...(this.active === undefined ? {} : { activeSession: this.active }),
      ...(this.last === undefined ? {} : { lastSession: this.last }),
    };
  };

  private installModeForStatus(): UpdateInstallMode {
    const activeSessionId = this.active?.sessionId;
    if (activeSessionId === undefined) {
      this.statusInstallModeSnapshot = undefined;
      return this.detector();
    }
    if (this.statusInstallModeSnapshot?.sessionId === activeSessionId) {
      return this.statusInstallModeSnapshot.installMode;
    }
    const installMode = this.detector();
    this.statusInstallModeSnapshot = { sessionId: activeSessionId, installMode };
    return installMode;
  }

  private replaceActiveProjection(active: UpdateSession | undefined): void {
    if (this.statusInstallModeSnapshot?.sessionId !== active?.sessionId) {
      this.statusInstallModeSnapshot = undefined;
    }
    this.active = active;
  }

  public readonly refreshDurableProjection = (): void => {
    if (this.localState === undefined) return;
    const inspected = this.localState.inspectRuntimeState();
    if (!("state" in inspected)) {
      this.persistenceStatus = inspected.status;
      return;
    }
    this.persistenceStatus = "ready";
    this.replaceActiveProjection(inspected.state.activeSession);
    this.activeCandidate = inspected.state.activeCandidate;
    this.last = inspected.state.lastSession;
  };

  // Start keeps consume-before-mutate ordering visible as a single authority boundary.
  // eslint-disable-next-line max-lines-per-function
  public readonly start = (
    input: UpdateSessionStartRequest,
    freshReport?: UpdatePreflightReport,
  ): UpdateSessionStartOutcome => {
    const currentMode = this.detector();
    const consumed = this.candidateAuthority?.consume(
      input,
      this.currentVersion(),
      currentMode,
      freshReport,
    );
    if (consumed === undefined) {
      throw new UpdateSessionError(
        "UPDATE_CANDIDATE_REQUIRED",
        "Run update preflight and confirm its reviewed candidate before starting.",
        409,
      );
    }
    if (!consumed.ok) throw candidateError(consumed.reason);
    this.candidateGate?.(consumed.snapshot, consumed.impact);
    const existing = this.active;
    if (existing !== undefined && !isTerminal(existing.phase)) {
      throw new UpdateSessionError(
        "UPDATE_SESSION_ACTIVE",
        "Another update session is active.",
        409,
      );
    }
    const mode = consumed.installMode;
    this.assertStartAllowed(mode);
    const session = this.createSession(consumed.snapshot, mode, input.requestId);
    this.acquireLock(session);
    this.active = session;
    this.statusInstallModeSnapshot = { sessionId: session.sessionId, installMode: currentMode };
    this.activeCandidate = consumed.snapshot;
    try {
      this.persistDurableState();
    } catch {
      this.active = undefined;
      this.activeCandidate = undefined;
      this.statusInstallModeSnapshot = undefined;
      this.lock?.release(session.sessionId);
      throw new UpdateSessionError(
        "UPDATE_STATE_UNWRITABLE",
        "Update lifecycle state could not be persisted safely.",
        503,
      );
    }
    this.emitSessionEvent(session, "started");
    void this.execute(session.sessionId, mode, consumed.snapshot).catch((error: unknown) => {
      const pending = this.active?.sessionId === session.sessionId ? this.active : undefined;
      if (pending !== undefined && !isTerminal(pending.phase)) {
        try {
          this.settleFailure(pending, failureFromError(error));
        } catch {
          this.failWithoutPersistence(pending, failureFromError(error));
        }
      }
    });
    return { session, reused: false };
  };

  public readonly retry = (): UpdateSessionStartOutcome => {
    throw new UpdateSessionError(
      "UPDATE_RETRY_REQUIRES_PREFLIGHT",
      "Run preflight again and confirm a fresh candidate before retrying.",
      409,
    );
  };

  public readonly cancel = (): UpdateSession => {
    const session = this.active;
    if (session === undefined) {
      throw new UpdateSessionError("UPDATE_SESSION_NOT_FOUND", "No update session is active.", 404);
    }
    if (session.phase === "running" && session.lifecycle.cancellationCutoff === "not-reached") {
      if (this.activeAbort?.sessionId === session.sessionId) {
        this.activeAbort.controller.abort();
        // The preparatory adapter owns the atomic prepared-WAL teardown. Keep the
        // authoritative session byte-for-byte cancelable until that teardown CAS
        // succeeds; otherwise the aggregate guard cannot distinguish a safe
        // pre-ACK abort from a committed native handoff.
        return session;
      }
      return this.replace(session, {
        cancelable: false,
        retryable: false,
        message: "Cancellation requested. Waiting for the update operation to stop.",
      });
    }
    if (session.phase !== "preparing") {
      throw new UpdateSessionError(
        "UPDATE_NOT_CANCELABLE",
        "Package mutation has already started.",
        409,
      );
    }
    return this.finishTransition(session, "cancelled", {
      failureReason: "cancelled",
      cancelable: false,
      retryable: false,
      message: messageForFailure("cancelled"),
    });
  };

  public readonly verifyRestart: UpdateRestartVerifier = (targetVersion, canCompleteUpdate) => {
    const session = this.sessionForRestart(targetVersion);
    if (session.portableStage !== undefined) {
      throw new UpdateSessionError(
        "UPDATE_RESTART_NOT_PENDING",
        "Portable updates are verified only by native startup recovery.",
        409,
      );
    }
    const initialPatch = restartVerificationPatch(
      session,
      this.currentVersion(),
      canCompleteUpdate,
    );
    if (session.lifecycle.phase === "remediation-required") {
      if (initialPatch.phase === "succeeded") {
        return this.finishTransition(session, "succeeded", initialPatch);
      }
      return this.transition(
        session,
        "remediation-required",
        initialPatch,
        session.lifecycle.progress,
      );
    }
    const verifying =
      session.lifecycle.phase === "verifying-relaunch"
        ? session
        : this.transition(session, "verifying-relaunch", {
            message: "Verifying the relaunched update.",
          });
    const patch = initialPatch;
    if (patch.phase === "succeeded") {
      return this.finishTransition(verifying, "succeeded", patch);
    }
    if (patch.restartRequired === false) {
      return this.transition(verifying, "remediation-required", patch);
    }
    return this.transition(verifying, "verifying-relaunch", patch, verifying.lifecycle.progress);
  };

  private assertStartAllowed(mode: UpdateInstallMode): void {
    const policy = resolveUpdateMutationPolicy(this.env);
    if (!policy.enabled) {
      throw new UpdateSessionError(
        "UPDATE_POLICY_DISABLED",
        policy.reason ?? "Updates are disabled.",
        403,
      );
    }
    if (mode.status !== "supported") {
      throw new UpdateSessionError(
        "UPDATE_INSTALL_MODE_UNSUPPORTED",
        mode.manualInstructions ?? "Automatic update is unavailable.",
        409,
      );
    }
  }

  // eslint-disable-next-line max-lines-per-function
  private createSession(
    candidate: UpdateCandidateSnapshot,
    mode: UpdateInstallMode,
    requestId: string | undefined,
  ): UpdateSession {
    const timestamp = nowIso(this.now);
    const identity = {
      candidateId: candidate.candidateId,
      candidateDigest: digestUpdateCandidate(candidate),
      correlationId: requestId ?? candidate.candidateId,
    };
    if (mode.installKind === "portable-managed") {
      return {
        schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
        sessionId: this.idFactory(),
        ...identity,
        packageName: PACKAGE_NAME,
        targetVersion: candidate.targetVersion,
        phase: "preparing",
        lifecycle: initialUpdateLifecycle(),
        failureReason: "none",
        ...(mode.installRoot === undefined ? {} : { installRoot: mode.installRoot }),
        startedAt: timestamp,
        updatedAt: timestamp,
        cancelable: true,
        retryable: false,
        restartRequired: false,
        message: "Preparing portable update staging.",
      };
    }
    const packageManager = this.packageManagerFor(mode);
    const restartPreview = restartCommandPreview(this.env);
    return {
      schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
      sessionId: this.idFactory(),
      ...identity,
      packageName: PACKAGE_NAME,
      targetVersion: candidate.targetVersion,
      phase: "preparing",
      lifecycle: initialUpdateLifecycle(),
      failureReason: "none",
      packageManager,
      installRoot: mode.installRoot,
      commandPreview: buildUpdateCommand(packageManager, candidate.targetVersion),
      ...(restartPreview === undefined ? {} : { restartCommandPreview: restartPreview }),
      startedAt: timestamp,
      updatedAt: timestamp,
      cancelable: true,
      retryable: false,
      restartRequired: false,
      message: "Preparing the governed update command.",
    };
  }

  private sessionForRestart(targetVersion: string | undefined): UpdateSession {
    const active = this.active;
    if (active !== undefined) {
      if (active.phase !== "restart-required") {
        throw new UpdateSessionError(
          "UPDATE_RESTART_NOT_PENDING",
          "Package mutation is still active.",
          409,
        );
      }
      assertRestartTargetMatches(active, targetVersion);
      return active;
    }
    if (this.last?.phase === "restart-required") {
      assertRestartTargetMatches(this.last, targetVersion);
      return this.last;
    }
    throw new UpdateSessionError(
      "UPDATE_RESTART_NOT_PENDING",
      "No restart verification is pending.",
      409,
    );
  }

  private acquireLock(session: UpdateSession): void {
    if (this.lock === undefined) return;
    const acquired = this.lock.acquire({
      sessionId: session.sessionId,
      targetVersion: session.targetVersion,
      startedAt: session.startedAt,
      pid: process.pid,
    });
    if (!acquired) {
      throw new UpdateSessionError(
        "UPDATE_SESSION_ACTIVE",
        "Another update session lock is active.",
        409,
      );
    }
  }

  private packageManagerFor(mode: UpdateInstallMode): UpdateInstallPackageManager {
    if (mode.packageManager !== undefined) return mode.packageManager;
    throw new UpdateSessionError(
      "UPDATE_INSTALL_MODE_UNSUPPORTED",
      "Automatic update is unavailable.",
      409,
    );
  }

  private replace(session: UpdateSession, patch: Partial<UpdateSession>): UpdateSession {
    const next: UpdateSession = { ...session, ...patch, updatedAt: nowIso(this.now) };
    if (this.active?.sessionId === session.sessionId) this.active = next;
    if (this.last?.sessionId === session.sessionId) this.last = next;
    this.persistDurableState();
    this.emitSessionEvent(next, "transition");
    return next;
  }

  private transition(
    session: UpdateSession,
    phase: UpdateLifecyclePhase,
    patch: Partial<UpdateSession> = {},
    progress?: UpdateSession["lifecycle"]["progress"],
  ): UpdateSession {
    return this.replace(session, {
      ...patch,
      ...transitionUpdateSession(session, {
        phase,
        ...(progress === undefined ? {} : { progress }),
      }),
    });
  }

  private finishTransition(
    session: UpdateSession,
    phase: UpdateLifecyclePhase,
    patch: Partial<UpdateSession> = {},
    progress?: UpdateSession["lifecycle"]["progress"],
  ): UpdateSession {
    const next: UpdateSession = {
      ...session,
      ...patch,
      ...transitionUpdateSession(session, {
        phase,
        ...(progress === undefined ? {} : { progress }),
      }),
      updatedAt: nowIso(this.now),
    };
    const previousActive = this.active;
    const previousCandidate = this.activeCandidate;
    const previousLast = this.last;
    const previousStatusInstallMode = this.statusInstallModeSnapshot;
    this.last = next;
    if (this.active?.sessionId === session.sessionId && isTerminal(next.phase)) {
      this.active = undefined;
      this.activeCandidate = undefined;
      this.statusInstallModeSnapshot = undefined;
    }
    try {
      this.persistDurableState();
    } catch (error) {
      this.active = previousActive;
      this.activeCandidate = previousCandidate;
      this.last = previousLast;
      this.statusInstallModeSnapshot = previousStatusInstallMode;
      this.persistenceStatus = "unwritable";
      this.emitSessionEvent(this.active ?? this.last ?? session, "persistence-failed");
      throw error;
    }
    this.lock?.release(next.sessionId);
    this.emitSessionEvent(next, "transition");
    return next;
  }

  private restoreDurableState(): void {
    if (this.localState === undefined) return;
    const result = this.localState.inspectRuntimeState();
    this.persistenceStatus = result.status === "ok" ? "ready" : result.status;
    if (!("state" in result)) return;
    this.replaceActiveProjection(result.state.activeSession);
    this.activeCandidate = result.state.activeCandidate;
    this.last = result.state.lastSession;
    if (this.settleRestoredTerminalIfNeeded()) return;
    if (this.active === undefined) {
      try {
        this.persistDurableState();
      } catch {
        this.persistenceStatus = "unwritable";
      }
      return;
    }
    const lifecycle = this.active.lifecycle;
    if (lifecycle.cancellationCutoff === "not-reached") {
      this.last = {
        ...this.active,
        phase: "failed",
        lifecycle: { ...lifecycle, phase: "failed" },
        failureReason: "spawn-error",
        cancelable: false,
        retryable: true,
        restartRequired: false,
        message: "The prior update was interrupted before mutation and must be checked again.",
      };
      this.active = undefined;
      this.activeCandidate = undefined;
      this.statusInstallModeSnapshot = undefined;
    } else {
      this.active = {
        ...this.active,
        phase: "restart-required",
        lifecycle: { ...lifecycle, phase: "recovery-required" },
        cancelable: false,
        retryable: false,
        restartRequired: true,
        message: "The prior update requires startup recovery before another update can start.",
      };
    }
    try {
      this.persistDurableState("required", "interrupted");
    } catch {
      this.persistenceStatus = "unwritable";
    }
  }

  private settleRestoredTerminalIfNeeded(): boolean {
    if (this.active === undefined || !isTerminal(this.active.phase)) return false;
    this.settleRestoredTerminal(this.active);
    return true;
  }

  private settleRestoredTerminal(session: UpdateSession): void {
    const previousCandidate = this.activeCandidate;
    const previousLast = this.last;
    this.last = session;
    this.active = undefined;
    this.activeCandidate = undefined;
    this.statusInstallModeSnapshot = undefined;
    try {
      this.persistDurableState();
    } catch {
      this.active = session;
      this.activeCandidate = previousCandidate;
      this.last = previousLast;
      this.persistenceStatus = "unwritable";
      return;
    }
    this.lock?.release(session.sessionId);
  }

  private persistDurableState(
    recoveryStatus?: "none" | "reconciling" | "required" | "settled",
    recoveryReason?: "interrupted",
  ): void {
    if (this.localState === undefined) return;
    const current = this.localState.readRuntimeState();
    const recovery = this.durableRecovery(recoveryStatus, recoveryReason);
    this.localState.writeRuntimeState(this.durableRuntimeState(current, recovery));
    this.persistenceStatus = "ready";
  }

  private durableRecovery(
    recoveryStatus: "none" | "reconciling" | "required" | "settled" | undefined,
    recoveryReason: "interrupted" | undefined,
  ): ReturnType<UpdateLocalStateManager["readRuntimeState"]>["recovery"] {
    const status = recoveryStatus ?? this.derivedRecoveryStatus();
    return {
      status,
      ...(this.active?.sessionId === undefined ? {} : { sessionId: this.active.sessionId }),
      ...(status !== "required" ? {} : { reason: recoveryReason ?? ("interrupted" as const) }),
      updatedAt: nowIso(this.now),
    };
  }

  private derivedRecoveryStatus(): "none" | "reconciling" | "required" {
    if (this.active?.lifecycle.phase === "recovery-required") return "required";
    return this.active?.lifecycle.cancellationCutoff === "handoff-committed"
      ? "reconciling"
      : "none";
  }

  private durableRuntimeState(
    current: ReturnType<UpdateLocalStateManager["readRuntimeState"]>,
    recovery: ReturnType<UpdateLocalStateManager["readRuntimeState"]>["recovery"],
  ): ReturnType<UpdateLocalStateManager["readRuntimeState"]> {
    return {
      ...current,
      activeSession: this.active === undefined ? undefined : durableSession(this.active),
      activeCandidate: this.activeCandidate,
      ...(this.last === undefined ? {} : { lastSession: durableSession(this.last) }),
      recovery,
    };
  }

  private failWithoutPersistence(session: UpdateSession, reason: UpdateSessionFailureReason): void {
    const persistenceFailureReported = this.persistenceStatus === "unwritable";
    if (session.lifecycle.cancellationCutoff !== "not-reached") {
      const recovery: UpdateSession = {
        ...session,
        phase: "restart-required",
        lifecycle: {
          ...session.lifecycle,
          phase: "recovery-required",
          cancellationCutoff: "handoff-committed",
        },
        failureReason: reason,
        cancelable: false,
        retryable: false,
        restartRequired: true,
        message: "The update outcome is uncertain and requires startup recovery.",
        updatedAt: nowIso(this.now),
      };
      this.active = recovery;
      this.persistenceStatus = "unwritable";
      if (!persistenceFailureReported) this.emitSessionEvent(recovery, "persistence-failed");
      return;
    }
    const lifecycle = { ...session.lifecycle, phase: "failed" as const };
    this.last = {
      ...session,
      phase: "failed",
      lifecycle,
      failureReason: reason,
      cancelable: false,
      retryable: false,
      restartRequired: false,
      message: "The update failed and its lifecycle state could not be persisted.",
      updatedAt: nowIso(this.now),
    };
    this.active = undefined;
    this.activeCandidate = undefined;
    this.statusInstallModeSnapshot = undefined;
    this.persistenceStatus = "unwritable";
    if (!persistenceFailureReported) this.emitSessionEvent(this.last, "persistence-failed");
  }

  private emitSessionEvent(
    session: UpdateSession,
    eventKind: "started" | "transition" | "persistence-failed",
  ): void {
    try {
      this.activityLog?.write({
        category: "diagnostic",
        op: UPDATE_SESSION_LIFECYCLE_OP,
        correlationId: session.correlationId,
        extra: {
          sessionId: session.sessionId,
          candidateId: session.candidateId,
          candidateDigest: session.candidateDigest,
          targetVersion: session.targetVersion,
          phase: session.lifecycle.phase,
          cancellationCutoff: session.lifecycle.cancellationCutoff,
          eventKind,
          completedBytes: session.lifecycle.progress.completedBytes,
          ...(session.lifecycle.progress.totalBytes === undefined
            ? {}
            : { totalBytes: session.lifecycle.progress.totalBytes }),
          failureReason: session.failureReason,
        },
      });
    } catch (error) {
      emitServerDiagnostic(
        this.diagnostics,
        serverDiagnosticFromError({
          correlationId: session.correlationId,
          operation: "update.session.activity-log",
          source: "update-session",
          error,
          redact: (): string => "A bounded update diagnostic failed.",
        }),
      );
    }
  }

  private async execute(
    sessionId: string,
    mode: UpdateInstallMode,
    candidate: UpdateCandidateSnapshot,
  ): Promise<void> {
    await this.beforeExecute?.();
    const prepared = this.active?.sessionId === sessionId ? this.active : undefined;
    if (prepared === undefined || prepared.phase === "cancelled") return;
    const runtimeRejection = this.runtimeCandidateRejection(candidate);
    if (runtimeRejection !== undefined) {
      this.rejectRuntimeCandidate(prepared, mode, runtimeRejection);
      return;
    }
    const running = this.startExecution(prepared, mode);
    if (mode.installKind === "portable-managed") {
      await this.invokePortableStager(running, mode, candidate);
      return;
    }
    await this.invokeCommand(running, mode);
  }

  private runtimeCandidateRejection(
    candidate: UpdateCandidateSnapshot,
  ): UpdateCandidateRejection | undefined {
    try {
      return updateCandidateRuntimeRejection(candidate, this.currentVersion(), this.detector());
    } catch {
      return "install-facts-changed";
    }
  }

  private rejectRuntimeCandidate(
    session: UpdateSession,
    mode: UpdateInstallMode,
    rejection: UpdateCandidateRejection,
  ): void {
    this.finishTransition(session, "failed", {
      failureReason:
        mode.installKind === "portable-managed"
          ? "portable-preflight-ineligible"
          : "unsupported-install-mode",
      cancelable: false,
      retryable: false,
      restartRequired: false,
      message:
        rejection === "current-version-changed"
          ? "The running version changed after review. Run update preflight again."
          : "The installation changed after review. Run update preflight again.",
    });
  }

  private startExecution(session: UpdateSession, mode: UpdateInstallMode): UpdateSession {
    const portable = mode.installKind === "portable-managed";
    return this.transition(session, portable ? "downloading" : "activating", {
      message: portable
        ? "Portable update asset is downloading and staging."
        : "Package-manager update is running.",
    });
  }

  private async invokePortableStager(
    session: UpdateSession,
    mode: UpdateInstallMode,
    candidate: UpdateCandidateSnapshot,
  ): Promise<void> {
    if (this.portableStager === undefined || this.portableActivator === undefined) {
      this.settleFailure(session, "portable-preflight-ineligible");
      return;
    }
    const controller = new AbortController();
    this.activeAbort = { sessionId: session.sessionId, controller };
    try {
      const { portableStage, runtimeFacts } = await this.stagePortableUpdate(
        session,
        mode,
        candidate,
        controller,
        this.portableStager,
      );
      const staged = this.persistPortableStage(session.sessionId, portableStage);
      if (staged === undefined) return;
      const portableActivation = await this.portableActivator.activate({
        sessionId: session.sessionId,
        targetVersion: session.targetVersion,
        stage: portableStage,
        runtimeFacts,
        signal: controller.signal,
      });
      await this.settlePortableActivationResult(
        staged.sessionId,
        candidate,
        portableStage,
        portableActivation,
      );
    } catch (error) {
      const reason = this.portableFailureReason(error);
      this.settlePortableFailure(session.sessionId, reason);
    } finally {
      if (this.activeAbort.sessionId === session.sessionId) {
        this.activeAbort = undefined;
      }
    }
  }

  private async stagePortableUpdate(
    session: UpdateSession,
    mode: UpdateInstallMode,
    candidate: UpdateCandidateSnapshot,
    controller: AbortController,
    stager: PortableUpdateStager,
  ): Promise<{
    readonly portableStage: UpdatePortableStagingSummary;
    readonly runtimeFacts: UpdateRuntimeFacts;
  }> {
    const runtimeFacts = this.facts();
    const portableStage = await stager.stage({
      sessionId: session.sessionId,
      targetVersion: session.targetVersion,
      installMode: mode,
      runtimeFacts,
      candidate,
      onProgress: (progress): void => {
        this.updatePortableStageProgress(session.sessionId, controller, progress);
      },
      signal: controller.signal,
    });
    return { portableStage, runtimeFacts };
  }

  private updatePortableStageProgress(
    sessionId: string,
    controller: AbortController,
    progress: UpdateSession["lifecycle"]["progress"] & { readonly phase: UpdateLifecyclePhase },
  ): void {
    const current = this.active?.sessionId === sessionId ? this.active : undefined;
    if (current === undefined || controller.signal.aborted) return;
    this.replace(current, {
      ...transitionUpdateSession(current, { phase: progress.phase, progress }),
    });
  }

  private persistPortableStage(
    sessionId: string,
    portableStage: UpdatePortableStagingSummary,
  ): UpdateSession | undefined {
    const current = this.active?.sessionId === sessionId ? this.active : undefined;
    if (current === undefined) return undefined;
    const patch = {
      portableStage,
      message: "Portable update is staged and preparing governed handoff authority.",
    };
    return current.lifecycle.phase === "staging"
      ? this.replace(current, patch)
      : this.transition(current, "staging", patch);
  }

  private async settlePortableActivationResult(
    sessionId: string,
    candidate: UpdateCandidateSnapshot,
    portableStage: UpdatePortableStagingSummary,
    result: Awaited<ReturnType<PortableUpdateActivator["activate"]>>,
  ): Promise<void> {
    const current = this.active?.sessionId === sessionId ? this.active : undefined;
    if (current === undefined || isTerminal(current.phase)) return;
    if (result.status === "handoff-pending") {
      await this.settlePortableHandoffPending(sessionId, current, result.activationId);
      return;
    }
    const activating = this.transition(current, "activating", {
      message: "Portable update activation has started.",
    });
    this.settlePortableActivation(activating, candidate, portableStage, result);
  }

  private async settlePortableHandoffPending(
    sessionId: string,
    current: UpdateSession,
    activationId: string,
  ): Promise<void> {
    if (
      current.lifecycle.phase === "handoff-pending" ||
      current.lifecycle.phase === "recovery-required"
    ) {
      return;
    }
    const pending = this.transition(current, "handoff-pending", {
      message: `Portable update ${current.targetVersion} handoff ${activationId} was accepted and is awaiting restart verification.`,
    });
    const launchId = this.env.KEIKO_UI_LAUNCH_ID;
    if (this.onPortableHandoffAccepted === undefined) return;
    if (!/^[a-f0-9]{32}$/u.test(launchId ?? "")) {
      this.requirePortableRecovery(sessionId, {
        message: "The update handoff was accepted, but the current launch identity is invalid.",
      });
      return;
    }
    try {
      await this.onPortableHandoffAccepted({
        sessionId,
        activationId,
        pid: process.pid,
        launchId: launchId ?? "",
      });
    } catch (error) {
      this.recordPortableHandoffShutdownFailure(pending, error);
      this.requirePortableRecovery(sessionId, {
        message: "The update handoff was accepted, but orderly shutdown could not be requested.",
      });
    }
  }

  private recordPortableHandoffShutdownFailure(session: UpdateSession, error: unknown): void {
    emitServerDiagnostic(
      this.diagnostics,
      serverDiagnosticFromError({
        correlationId: session.correlationId,
        operation: "update.session.portable-handoff-shutdown",
        source: "update-session",
        error,
        redact: (): string => "The accepted portable update handoff could not request shutdown.",
      }),
    );
  }

  private requirePortableRecovery(sessionId: string, patch: Partial<UpdateSession> = {}): void {
    const current = this.active?.sessionId === sessionId ? this.active : undefined;
    if (current === undefined || isTerminal(current.phase)) return;
    if (current.lifecycle.phase === "recovery-required") {
      this.replace(current, { ...patch, cancelable: false, retryable: false });
      return;
    }
    this.transition(current, "recovery-required", {
      ...patch,
      cancelable: false,
      retryable: false,
      restartRequired: true,
    });
  }

  private settlePortableFailure(sessionId: string, reason: UpdateSessionFailureReason): void {
    const current = this.active?.sessionId === sessionId ? this.active : undefined;
    if (current === undefined || isTerminal(current.phase)) return;
    const durableHandoffCommitted = ((): boolean => {
      if (this.localState === undefined) return false;
      try {
        const durable = this.localState.readRuntimeState();
        return (
          durable.activeSession?.sessionId === sessionId &&
          durable.activationWal?.coordinatorId !== undefined
        );
      } catch {
        return true;
      }
    })();
    if (current.lifecycle.cancellationCutoff !== "not-reached" || durableHandoffCommitted) {
      this.requirePortableRecovery(sessionId, {
        failureReason: reason,
        message: "Portable update recovery must reconcile the committed handoff.",
      });
      return;
    }
    this.settleFailure(current, reason);
  }

  private portableFailureReason(error: unknown): UpdateSessionFailureReason {
    if (error instanceof PortableUpdateStagingError) return error.reason;
    if (error instanceof PortableUpdateActivationError) return error.reason;
    return "portable-staging-failed";
  }

  // Explicit comparisons bind success to the exact immutable candidate proof.
  // eslint-disable-next-line complexity
  private settlePortableActivation(
    session: UpdateSession,
    candidate: UpdateCandidateSnapshot,
    portableStage: UpdatePortableStagingSummary,
    portableActivation: UpdatePortableActivationSummary,
  ): void {
    const expected = candidate.portable;
    const stageMatchesCandidate =
      expected !== undefined &&
      portableStage.status === "staged" &&
      portableStage.target === expected.target &&
      portableStage.packageVersion === candidate.targetVersion &&
      portableStage.releaseId === expected.releaseId &&
      portableStage.assetId === expected.assetId &&
      portableStage.assetName === expected.assetName &&
      portableStage.sizeBytes === expected.sizeBytes &&
      portableStage.sha256 === expected.sha256 &&
      portableStage.manifestSha256 === expected.manifestSha256;
    const activationProvesTarget =
      portableActivation.status === "activated" &&
      portableActivation.stageId === portableStage.stageId &&
      portableActivation.target === expected?.target &&
      portableActivation.packageVersion === candidate.targetVersion &&
      portableActivation.versionVerified;
    if (!stageMatchesCandidate || !activationProvesTarget) {
      this.settleFailure(session, "portable-version-verification-failed");
      return;
    }
    const activated = this.replace(session, {
      failureReason: "none",
      cancelable: false,
      retryable: false,
      restartRequired: false,
      portableStage,
      portableActivation,
    });
    const updateCanComplete = this.portableCompletionGate?.(activated) ?? true;
    const verified = this.transition(activated, "verifying-relaunch", {
      message: `Portable update ${session.targetVersion} activation proof is verified.`,
    });
    this.finishTransition(verified, "succeeded", {
      message: updateCanComplete
        ? `Portable update ${session.targetVersion} is active and verified.`
        : `Keiko is now running ${session.targetVersion}. Complete remaining follow-up action before affected workflows are fully ready.`,
    });
  }

  private async invokeCommand(session: UpdateSession, mode: UpdateInstallMode): Promise<void> {
    const command = buildUpdateCommand(this.packageManagerFor(mode), session.targetVersion);
    const controller = new AbortController();
    this.activeAbort = { sessionId: session.sessionId, controller };
    try {
      const result = await this.runCommandImpl(
        {
          command: command.executable,
          args: command.args,
          cwd: undefined,
          timeoutMs: this.timeoutMs,
          signal: controller.signal,
          onSpawn: (childPid): void => {
            if (this.lock !== undefined && !this.lock.updateChildPid(session.sessionId, childPid)) {
              throw new Error("Update child ownership could not be published.");
            }
          },
        },
        this.buildRunDeps(mode.installRoot ?? process.cwd()),
      );
      this.settleResult(session, result);
    } catch (error) {
      this.settleFailure(session, failureFromError(error));
    } finally {
      if (this.activeAbort.sessionId === session.sessionId) {
        this.activeAbort = undefined;
      }
    }
  }

  private buildRunDeps(root: string): RunCommandDeps {
    return {
      workspace: workspaceFor(root),
      policy: this.policy,
      commandRules: UPDATE_COMMAND_RULES,
      spawn: this.runDeps.spawn ?? nodeSpawnFn,
      processEnv: this.env,
      now: this.runDeps.now ?? this.now,
      fs: this.runDeps.fs ?? nodeWorkspaceFs,
      ...(this.runDeps.resolveExecutable === undefined
        ? {}
        : { resolveExecutable: this.runDeps.resolveExecutable }),
      ...(this.runDeps.home === undefined ? {} : { home: this.runDeps.home }),
      ...(this.runDeps.sandboxAvailability === undefined
        ? {}
        : { sandboxAvailability: this.runDeps.sandboxAvailability }),
      ...(this.runDeps.platform === undefined ? {} : { platform: this.runDeps.platform }),
    };
  }

  private settleResult(session: UpdateSession, result: CommandResult): void {
    if (result.exitCode === 0) {
      this.transition(session, "handoff-pending", {
        restartRequired: true,
        message: `Update installed. Restart Keiko to load ${session.targetVersion}.`,
        logs: logPreview(result, this.redactor),
      });
      this.lock?.release(session.sessionId);
      return;
    }
    this.settleFailure(session, "non-zero-exit", result);
  }

  private settleFailure(
    session: UpdateSession,
    reason: UpdateSessionFailureReason,
    result?: CommandResult,
  ): void {
    this.finishTransition(session, reason === "cancelled" ? "cancelled" : "failed", {
      failureReason: reason,
      retryable: retryableFailure(reason),
      message: messageForFailure(reason),
      ...(result === undefined ? {} : { logs: logPreview(result, this.redactor) }),
    });
  }
}

export function createUpdateSessionManager(
  options: UpdateSessionManagerOptions = {},
): UpdateSessionManager {
  return new UpdateSessionManagerImpl(options);
}
