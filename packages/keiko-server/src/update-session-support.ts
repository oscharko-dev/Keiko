import { randomUUID } from "node:crypto";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
} from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  UpdateInstallMode,
  UpdateSession,
  UpdateSessionFailureReason,
  UpdateSessionLogPreview,
  UpdateSessionPhase,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_SESSION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  detectUpdateInstallMode,
  productionUpdateFacts,
  type UpdateRuntimeFacts,
} from "./update-install-mode.js";

const LOG_PREVIEW_BYTES = 4_096;
const UPDATE_TIMEOUT_MS = 5 * 60_000;

export type UpdateRunCommandImpl = (
  input: Parameters<typeof runCommand>[0],
  deps: RunCommandDeps,
) => Promise<CommandResult>;

export type UpdateRestartCompletionGate = (session: UpdateSession) => boolean;
export type UpdateRestartVerifier = (
  targetVersion?: string,
  canCompleteUpdate?: UpdateRestartCompletionGate,
) => UpdateSession;

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

export function defaultDetectorFor(
  options: {
    readonly detector?: (() => UpdateInstallMode) | undefined;
    readonly facts?: (() => UpdateRuntimeFacts) | undefined;
  },
  env: NodeJS.ProcessEnv,
): () => UpdateInstallMode {
  if (options.detector !== undefined) return options.detector;
  return (): UpdateInstallMode =>
    detectUpdateInstallMode(options.facts?.() ?? productionUpdateFacts(env), env);
}

export interface UpdateSessionRuntimeOptions {
  readonly redactor?: ((input: string) => string) | undefined;
  readonly currentVersion?: (() => string) | undefined;
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly runCommandImpl?: UpdateRunCommandImpl | undefined;
  readonly runDeps?: Partial<RunCommandDeps> | undefined;
  readonly beforeExecute?: (() => Promise<void>) | undefined;
  readonly policy?: SandboxPolicy | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ResolvedManagerRuntime {
  readonly redactor: (input: string) => string;
  readonly currentVersion: () => string;
  readonly now: () => number;
  readonly idFactory: () => string;
  readonly runCommandImpl: UpdateRunCommandImpl;
  readonly runDeps: Partial<RunCommandDeps>;
  readonly policy: SandboxPolicy;
  readonly timeoutMs: number;
  readonly beforeExecute: (() => Promise<void>) | undefined;
}

export function resolveManagerRuntime(
  options: UpdateSessionRuntimeOptions,
): ResolvedManagerRuntime {
  return {
    redactor: options.redactor ?? ((input: string): string => input),
    currentVersion: options.currentVersion ?? ((): string => SDK_VERSION),
    now: options.now ?? Date.now,
    idFactory: options.idFactory ?? randomUUID,
    runCommandImpl: options.runCommandImpl ?? runCommand,
    runDeps: options.runDeps ?? {},
    policy: options.policy ?? DEFAULT_SANDBOX_POLICY,
    timeoutMs: options.timeoutMs ?? UPDATE_TIMEOUT_MS,
    beforeExecute: options.beforeExecute,
  };
}

export function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

export function workspaceFor(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function outputPreview(value: string): string {
  return value.length <= LOG_PREVIEW_BYTES ? value : value.slice(0, LOG_PREVIEW_BYTES);
}

export function logPreview(
  result: CommandResult,
  redactor: (input: string) => string,
): UpdateSessionLogPreview {
  const stdout = redactor(result.stdout);
  const stderr = redactor(result.stderr);
  return {
    collapsed: true,
    stdoutPreview: outputPreview(stdout),
    stderrPreview: outputPreview(stderr),
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    truncated:
      result.truncated || stdout.length > LOG_PREVIEW_BYTES || stderr.length > LOG_PREVIEW_BYTES,
  };
}

export function retryableFailure(reason: UpdateSessionFailureReason): boolean {
  return (
    reason === "non-zero-exit" ||
    reason === "timed-out" ||
    reason === "spawn-error" ||
    reason === "portable-download-failed" ||
    reason === "portable-sidecar-verification-failed" ||
    reason === "portable-staging-failed" ||
    reason === "portable-activation-failed" ||
    reason === "portable-relaunch-failed" ||
    reason === "portable-version-verification-failed"
  );
}

export function failureFromError(error: unknown): UpdateSessionFailureReason {
  if (error instanceof CommandDeniedError) return "command-denied";
  if (error instanceof CommandTimeoutError) return "timed-out";
  if (error instanceof CommandCancelledError) return "cancelled";
  return "spawn-error";
}

const FAILURE_MESSAGES: Partial<Record<UpdateSessionFailureReason, string>> = {
  "command-denied": "The update command was blocked by policy.",
  "timed-out": "The package manager did not finish before the timeout.",
  cancelled: "The update was cancelled.",
  "restart-version-mismatch":
    "Restart not detected yet. Run the restart command, then try Verify restart again.",
  "portable-preflight-ineligible":
    "The portable update candidate is no longer eligible. Re-run update preflight.",
  "portable-download-failed": "The portable update asset could not be downloaded.",
  "portable-verification-failed": "The portable update asset could not be verified.",
  "portable-sidecar-verification-failed":
    "The bundled sidecar payload could not be verified as part of the Keiko update.",
  "portable-staging-failed": "The portable update asset could not be staged safely.",
  "portable-activation-failed":
    "The portable update could not be activated safely. The current install was preserved when possible.",
  "portable-relaunch-failed":
    "The portable update was activated, but Keiko could not relaunch automatically.",
  "portable-version-verification-failed":
    "Keiko relaunched, but the target version could not be verified.",
};

export function messageForFailure(reason: UpdateSessionFailureReason): string {
  return FAILURE_MESSAGES[reason] ?? "The package manager could not complete the update.";
}

export function isTerminal(phase: UpdateSessionPhase): boolean {
  return phase === "failed" || phase === "cancelled" || phase === "succeeded";
}

export function createRestartVerificationSession(input: {
  readonly packageName: string;
  readonly targetVersion: string;
  readonly sessionId: string;
  readonly now: () => number;
}): UpdateSession {
  const timestamp = nowIso(input.now);
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    packageName: input.packageName,
    targetVersion: input.targetVersion,
    phase: "restart-required",
    failureReason: "none",
    startedAt: timestamp,
    updatedAt: timestamp,
    cancelable: false,
    retryable: false,
    restartRequired: true,
    message: "Verifying the version running after restart.",
  };
}

export function restartVerificationPatch(
  session: UpdateSession,
  currentVersion: string,
  canCompleteUpdate: UpdateRestartCompletionGate | undefined,
): Partial<UpdateSession> {
  if (currentVersion !== session.targetVersion) {
    return {
      phase: "restart-required",
      failureReason: "restart-version-mismatch",
      cancelable: false,
      restartRequired: true,
      retryable: false,
      message: messageForFailure("restart-version-mismatch"),
    };
  }
  if (canCompleteUpdate?.(session) === false) {
    return {
      restartRequired: false,
      message: `Keiko is now running ${session.targetVersion}. Complete remaining remediation before the update is marked successful.`,
    };
  }
  return {
    phase: "succeeded",
    failureReason: "none",
    restartRequired: false,
    message: `Keiko is now running ${session.targetVersion}.`,
  };
}
