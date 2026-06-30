import {
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  UPDATE_SESSION_SCHEMA_VERSION,
  type UpdateInstallMode,
  type UpdateInstallPackageManager,
  type UpdateSession,
  type UpdateSessionFailureReason,
  type UpdateSessionStartRequest,
  type UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  PACKAGE_NAME,
  UPDATE_COMMAND_RULES,
  buildUpdateCommand,
  detectUpdateInstallMode,
  productionUpdateFacts,
  resolveUpdateMutationPolicy,
  type UpdateRuntimeFacts,
} from "./update-install-mode.js";
import {
  createRestartVerificationSession,
  failureFromError,
  isTerminal,
  logPreview,
  messageForFailure,
  nowIso,
  resolveManagerRuntime,
  retryableFailure,
  workspaceFor,
  type UpdateRunCommandImpl,
} from "./update-session-support.js";
import type { UpdateSessionLock } from "./update-session-lock.js";

export interface UpdateSessionStartOutcome {
  readonly session: UpdateSession;
  readonly reused: boolean;
}

export interface UpdateSessionManager {
  readonly getStatus: () => UpdateSessionStatus;
  readonly start: (input: UpdateSessionStartRequest) => UpdateSessionStartOutcome;
  readonly retry: () => UpdateSessionStartOutcome;
  readonly cancel: () => UpdateSession;
  readonly verifyRestart: (targetVersion?: string) => UpdateSession;
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
}

export class UpdateSessionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "UpdateSessionError";
  }
}

function defaultDetectorFor(
  options: UpdateSessionManagerOptions,
  env: NodeJS.ProcessEnv,
): () => UpdateInstallMode {
  if (options.detector !== undefined) return options.detector;
  return (): UpdateInstallMode =>
    detectUpdateInstallMode(options.facts?.() ?? productionUpdateFacts(env), env);
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
  private active: UpdateSession | undefined;
  private last: UpdateSession | undefined;

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
  }

  public readonly getStatus = (): UpdateSessionStatus => ({
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    installMode: this.detector(),
    policy: resolveUpdateMutationPolicy(this.env),
    ...(this.active === undefined ? {} : { activeSession: this.active }),
    ...(this.last === undefined ? {} : { lastSession: this.last }),
  });

  public readonly start = (input: UpdateSessionStartRequest): UpdateSessionStartOutcome => {
    const existing = this.active;
    if (existing !== undefined && !isTerminal(existing.phase)) {
      if (existing.targetVersion === input.targetVersion) return { session: existing, reused: true };
      throw new UpdateSessionError("UPDATE_SESSION_ACTIVE", "Another update session is active.", 409);
    }
    const mode = this.detector();
    this.assertStartAllowed(mode);
    const session = this.createSession(input.targetVersion, mode);
    this.acquireLock(session);
    this.active = session;
    void this.execute(session.sessionId, mode).catch(() => undefined);
    return { session, reused: false };
  };

  public readonly retry = (): UpdateSessionStartOutcome => {
    if (this.active !== undefined && !isTerminal(this.active.phase)) {
      throw new UpdateSessionError("UPDATE_SESSION_ACTIVE", "Another update session is active.", 409);
    }
    const last = this.last;
    if (!last?.retryable) {
      throw new UpdateSessionError("UPDATE_RETRY_UNAVAILABLE", "No retryable update session exists.", 409);
    }
    return this.start({ targetVersion: last.targetVersion });
  };

  public readonly cancel = (): UpdateSession => {
    const session = this.active;
    if (session === undefined) {
      throw new UpdateSessionError("UPDATE_SESSION_NOT_FOUND", "No update session is active.", 404);
    }
    if (session.phase !== "preparing") {
      throw new UpdateSessionError("UPDATE_NOT_CANCELABLE", "Package mutation has already started.", 409);
    }
    return this.finish(
      this.replace(session, {
        phase: "cancelled",
        failureReason: "cancelled",
        cancelable: false,
        retryable: false,
        message: messageForFailure("cancelled"),
      }),
    );
  };

  public readonly verifyRestart = (targetVersion?: string): UpdateSession => {
    const session = this.sessionForRestart(targetVersion);
    if (this.currentVersion() === session.targetVersion) {
      return this.finish(
        this.replace(session, {
          phase: "succeeded",
          failureReason: "none",
          restartRequired: false,
          message: `Keiko is now running ${session.targetVersion}.`,
        }),
      );
    }
    return this.finish(
      this.replace(session, {
        phase: "failed",
        failureReason: "restart-version-mismatch",
        restartRequired: true,
        retryable: false,
        message: messageForFailure("restart-version-mismatch"),
      }),
    );
  };

  private assertStartAllowed(mode: UpdateInstallMode): void {
    const policy = resolveUpdateMutationPolicy(this.env);
    if (!policy.enabled) {
      throw new UpdateSessionError("UPDATE_POLICY_DISABLED", policy.reason ?? "Updates are disabled.", 403);
    }
    if (mode.status !== "supported") {
      throw new UpdateSessionError(
        "UPDATE_INSTALL_MODE_UNSUPPORTED",
        mode.manualInstructions ?? "Automatic update is unavailable.",
        409,
      );
    }
  }

  private createSession(targetVersion: string, mode: UpdateInstallMode): UpdateSession {
    const timestamp = nowIso(this.now);
    const packageManager = this.packageManagerFor(mode);
    return {
      schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
      sessionId: this.idFactory(),
      packageName: PACKAGE_NAME,
      targetVersion,
      phase: "preparing",
      failureReason: "none",
      packageManager,
      installRoot: mode.installRoot,
      commandPreview: buildUpdateCommand(packageManager, targetVersion),
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
        throw new UpdateSessionError("UPDATE_RESTART_NOT_PENDING", "Package mutation is still active.", 409);
      }
      if (targetVersion !== undefined && active.targetVersion !== targetVersion) {
        throw new UpdateSessionError(
          "UPDATE_TARGET_MISMATCH",
          "The restart target does not match the session.",
          409,
        );
      }
      return active;
    }
    if (this.last?.phase === "restart-required") {
      if (targetVersion !== undefined && this.last.targetVersion !== targetVersion) {
        throw new UpdateSessionError(
          "UPDATE_TARGET_MISMATCH",
          "The restart target does not match the session.",
          409,
        );
      }
      return this.last;
    }
    if (targetVersion !== undefined) {
      return createRestartVerificationSession({
        packageName: PACKAGE_NAME,
        targetVersion,
        sessionId: this.idFactory(),
        now: this.now,
      });
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
      throw new UpdateSessionError("UPDATE_SESSION_ACTIVE", "Another update session lock is active.", 409);
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
    return next;
  }

  private finish(session: UpdateSession): UpdateSession {
    this.last = session;
    if (this.active?.sessionId === session.sessionId && isTerminal(session.phase)) {
      this.active = undefined;
    }
    this.lock?.release(session.sessionId);
    return session;
  }

  private async execute(sessionId: string, mode: UpdateInstallMode): Promise<void> {
    await this.beforeExecute?.();
    const prepared = this.active?.sessionId === sessionId ? this.active : undefined;
    if (prepared === undefined || prepared.phase === "cancelled") return;
    const running = this.replace(prepared, {
      phase: "running",
      cancelable: false,
      message: "Package-manager update is running. Cancellation is no longer safe.",
    });
    await this.invokeCommand(running, mode);
  }

  private async invokeCommand(session: UpdateSession, mode: UpdateInstallMode): Promise<void> {
    const command = buildUpdateCommand(this.packageManagerFor(mode), session.targetVersion);
    const controller = new AbortController();
    try {
      const result = await this.runCommandImpl(
        {
          command: command.executable,
          args: command.args,
          cwd: undefined,
          timeoutMs: this.timeoutMs,
          signal: controller.signal,
        },
        this.buildRunDeps(mode.installRoot ?? process.cwd()),
      );
      this.settleResult(session, result);
    } catch (error) {
      this.settleFailure(session, failureFromError(error));
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
      this.replace(session, {
        phase: "restart-required",
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
    const next = this.replace(session, {
      phase: reason === "cancelled" ? "cancelled" : "failed",
      failureReason: reason,
      retryable: retryableFailure(reason),
      message: messageForFailure(reason),
      ...(result === undefined ? {} : { logs: logPreview(result, this.redactor) }),
    });
    this.finish(next);
  }
}

export function createUpdateSessionManager(
  options: UpdateSessionManagerOptions = {},
): UpdateSessionManager {
  return new UpdateSessionManagerImpl(options);
}
