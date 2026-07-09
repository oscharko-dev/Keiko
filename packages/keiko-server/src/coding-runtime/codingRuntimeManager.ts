import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";

import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  decideCodingWorkbenchActionForMode,
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchPermissionRequest,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchSupervisedActionKind,
  CodingWorkbenchSupervisedPolicyReason,
} from "@oscharko-dev/keiko-contracts";
import { buildSandboxEnv, collectSensitiveEnvValues } from "@oscharko-dev/keiko-tools";

import { createDeadlineCancellation, isCancellation } from "../editor/languageCancellation.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  decideSupervisedFileEdit,
  decideSupervisedMutation,
  decideSupervisedVerificationCommand,
  type SupervisedCodingDecision,
} from "./supervisedCodingPolicy.js";
import {
  createInMemorySupervisedCodingApprovalStore,
  supervisedCodingApprovalScopeDigest,
  type SupervisedCodingApprovalBinding,
  type SupervisedCodingApprovalClaim,
  type SupervisedCodingApprovalStore,
  type SupervisedCodingConsumedApproval,
} from "./supervisedCodingApprovalStore.js";
import {
  parseCodingSidecarEventLine,
  type SidecarHealthEvent,
  type SidecarPermissionEvent,
} from "./codingSidecarEventParser.js";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "../diagnostics-log.js";

export type CodingRuntimeAdapterKind = "opencode-compatible" | "codex-cli";

export type CodingRuntimeFailureCode =
  | "adapter-profile-mismatch"
  | "env-secret-denied"
  | "gateway-non-loopback"
  | "runtime-already-running"
  | "runtime-crashed"
  | "runtime-run-mismatch"
  | "sidecar-missing"
  | "sidecar-unmanaged"
  | "spawn-failed"
  | "start-aborted"
  | "start-timeout";

export type CodingRuntimeStatus = "ready" | "restart-denied" | "stopped" | "stopping";

export interface CodingRuntimeLaunchRequest {
  readonly runId: string;
  readonly taskRef: string;
  readonly adapterKind: CodingRuntimeAdapterKind;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly requestedMode: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly workspaceRoot: string;
  readonly executablePath: string;
  readonly managedRoot: string;
  readonly gatewayUrl: string;
  readonly modelProfileId: string;
  readonly args: readonly string[];
  readonly inheritedEnvAllowlist: readonly string[];
  readonly shutdownTimeoutMs: number;
  readonly startTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export type CodingRuntimeStartResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly status: "ready";
    }
  | {
      readonly ok: false;
      readonly failureCode: CodingRuntimeFailureCode;
      readonly retryable: boolean;
    };

export type CodingRuntimeHealthReport =
  | { readonly status: "stopped" }
  | {
      readonly status: "ready" | "stopping";
      readonly activeRunId: string;
    }
  | {
      readonly status: "restart-denied";
      readonly activeRunId: string;
      readonly failureCode: "runtime-crashed";
      readonly restartDenied: true;
    };

export type CodingRuntimeStopResult =
  | { readonly ok: true; readonly status: "stopped" }
  | {
      readonly ok: false;
      readonly failureCode: "runtime-run-mismatch";
      readonly retryable: false;
    };

export interface CodingRuntimeApprovalIssueRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly approvedByUserId: string;
  readonly ttlMs?: number | undefined;
}

export type CodingRuntimeApprovalIssueResult =
  | {
      readonly ok: true;
      readonly approval: SupervisedCodingApprovalClaim;
      readonly approvalDigest: string;
      readonly expiresAtMs: number;
    }
  | {
      readonly ok: false;
      readonly failureCode: "runtime-run-mismatch" | "runtime-stopped";
      readonly retryable: false;
    };

export interface CodingRuntimeSpawnHandle {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): void;
  onExit(callback: (code: number | null) => void): void;
  onError(callback: (error: Error) => void): void;
}

export type CodingRuntimeSpawnFn = (
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
) => CodingRuntimeSpawnHandle;

export interface CodingRuntimeKillScheduler {
  setTimer(callback: () => void, delayMs: number): unknown;
}

export interface CodingRuntimeManagerDeps {
  readonly spawn?: CodingRuntimeSpawnFn | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now?: (() => number) | undefined;
  readonly nowIso?: (() => string) | undefined;
  readonly killScheduler?: CodingRuntimeKillScheduler | undefined;
  readonly approvalStore?: SupervisedCodingApprovalStore | undefined;
  readonly onRuntimeEvent?: ((event: CodingWorkbenchRuntimeEvent) => void) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

export interface CodingRuntimeSidecarLaunchTarget {
  readonly managedRoot: string;
  readonly executablePath: string;
  readonly runtimeName: string;
  readonly payloadSha256Prefix: string;
}

export type CodingRuntimeSidecarLaunchTargetResult =
  { readonly ok: true; readonly target: CodingRuntimeSidecarLaunchTarget } | FailureResult;

interface NormalizedCodingRuntimeManagerDeps {
  readonly spawn: CodingRuntimeSpawnFn;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly killScheduler: CodingRuntimeKillScheduler;
  readonly approvalStore: SupervisedCodingApprovalStore;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly diagnostics: ServerDiagnosticSink | undefined;
}

export interface CodingRuntimeManager {
  start(request: CodingRuntimeLaunchRequest): CodingRuntimeStartResult;
  issueApproval(request: CodingRuntimeApprovalIssueRequest): CodingRuntimeApprovalIssueResult;
  stop(runId: string): Promise<CodingRuntimeStopResult>;
  health(): CodingRuntimeHealthReport;
}

interface PreflightOk {
  readonly ok: true;
  readonly executablePath: string;
}

interface FailureResult {
  readonly ok: false;
  readonly failureCode: CodingRuntimeFailureCode;
  readonly retryable: boolean;
}

interface RuntimeEventContext {
  readonly runId: string;
  readonly taskRef: string;
  readonly workspaceRoot: string;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly requestedMode: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
}

interface ActiveRuntime {
  readonly context: RuntimeEventContext;
  readonly child: CodingRuntimeSpawnHandle;
  readonly shutdownTimeoutMs: number;
  readonly exitWaiters: (() => void)[];
  readonly approvalStore: SupervisedCodingApprovalStore;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  stdoutBuffer: string;
  exited: boolean;
  stopRequested: boolean;
  status: CodingRuntimeStatus;
  sequence: number;
}

interface SupervisedRuntimeEvidenceContext {
  readonly recordId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
}

const MAX_SIDECAR_EVENT_LINE_BYTES = 8192;
const SECRET_ENV_NAME = /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const defaultKillScheduler: CodingRuntimeKillScheduler = {
  setTimer: (callback, delayMs): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs),
};

export function defaultCodingRuntimeSpawnFn(
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
): CodingRuntimeSpawnHandle {
  const child = spawn(executable, [...args], {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return wrapChild(child);
}

export function createCodingRuntimeManager(deps: CodingRuntimeManagerDeps): CodingRuntimeManager {
  return new CodingRuntimeManagerImpl(normalizeDeps(deps));
}

export function resolveCodingRuntimeSidecarLaunchTarget(
  managedInstallRoot: string,
  sidecar: PortableSidecarRuntimeVerification,
): CodingRuntimeSidecarLaunchTargetResult {
  if (sidecar.summary.status !== "verified") return failure("sidecar-missing", false);
  return {
    ok: true,
    target: {
      managedRoot: join(managedInstallRoot, sidecar.payloadRootPath),
      executablePath: join(managedInstallRoot, sidecar.executablePath),
      runtimeName: sidecar.summary.name,
      payloadSha256Prefix: sidecar.summary.payloadSha256Prefix,
    },
  };
}

function normalizeDeps(deps: CodingRuntimeManagerDeps): NormalizedCodingRuntimeManagerDeps {
  return {
    spawn: deps.spawn ?? defaultCodingRuntimeSpawnFn,
    processEnv: deps.processEnv,
    now: deps.now ?? Date.now,
    nowIso: deps.nowIso ?? ((): string => new Date().toISOString()),
    killScheduler: deps.killScheduler ?? defaultKillScheduler,
    approvalStore: deps.approvalStore ?? createInMemorySupervisedCodingApprovalStore(),
    onRuntimeEvent: deps.onRuntimeEvent ?? ((): void => undefined),
    diagnostics: deps.diagnostics,
  };
}

class CodingRuntimeManagerImpl implements CodingRuntimeManager {
  private active: ActiveRuntime | undefined;

  public constructor(private readonly deps: NormalizedCodingRuntimeManagerDeps) {}

  public start(request: CodingRuntimeLaunchRequest): CodingRuntimeStartResult {
    if (this.active !== undefined && this.active.status !== "stopped") {
      return failure("runtime-already-running", true);
    }
    const cancelled = cancellationFailure(request, this.deps);
    if (cancelled !== undefined) return cancelled;
    const adapter = validateAdapterSelection(request);
    if (!adapter.ok) return this.recordLaunchFailure(request, adapter);
    const preflight = preflightExecutable(request);
    if (!preflight.ok) return this.recordLaunchFailure(request, preflight);
    const env = buildRuntimeEnv(request, this.deps.processEnv);
    if (!env.ok) return this.recordLaunchFailure(request, env);
    return this.spawnRuntime(request, preflight.executablePath, env.value);
  }

  public async stop(runId: string): Promise<CodingRuntimeStopResult> {
    const active = this.active;
    if (active === undefined) return { ok: true, status: "stopped" };
    if (active.context.runId !== runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    active.stopRequested = true;
    active.status = "stopping";
    await escalateRuntimeKill(active, this.deps.killScheduler);
    active.status = "stopped";
    this.active = undefined;
    this.emit(
      runtimeEvent(active, this.nextSequence(active), "runtime-stopped", { health: "stopped" }),
    );
    return { ok: true, status: "stopped" };
  }

  public issueApproval(
    request: CodingRuntimeApprovalIssueRequest,
  ): CodingRuntimeApprovalIssueResult {
    const active = this.active;
    if (active?.context.runId !== request.runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    if (active.stopRequested || active.status !== "ready") {
      return { ok: false, failureCode: "runtime-stopped", retryable: false };
    }
    const binding = approvalBindingForIssue(active, request);
    const issued = this.deps.approvalStore.issue({
      binding,
      approvedByUserId: request.approvedByUserId,
      nowMs: this.deps.now(),
      ttlMs: request.ttlMs,
    });
    return {
      ok: true,
      approval: issued.approval,
      approvalDigest: issued.approvalDigest,
      expiresAtMs: issued.expiresAtMs,
    };
  }

  public health(): CodingRuntimeHealthReport {
    if (this.active === undefined || this.active.status === "stopped") return { status: "stopped" };
    if (this.active.status === "restart-denied") {
      return {
        status: "restart-denied",
        activeRunId: this.active.context.runId,
        failureCode: "runtime-crashed",
        restartDenied: true,
      };
    }
    return { status: this.active.status, activeRunId: this.active.context.runId };
  }

  private spawnRuntime(
    request: CodingRuntimeLaunchRequest,
    executablePath: string,
    env: Record<string, string>,
  ): CodingRuntimeStartResult {
    try {
      const child = this.deps.spawn(executablePath, request.args, env, request.workspaceRoot);
      const active = createActiveRuntime(
        request,
        child,
        this.deps.approvalStore,
        this.deps.now,
        this.deps.nowIso,
      );
      this.active = active;
      this.attachRuntime(active);
      this.emit(runtimeEvent(active, this.nextSequence(active), "runtime-started", {}));
      return { ok: true, runId: request.runId, status: "ready" };
    } catch {
      return this.recordLaunchFailure(request, failure("spawn-failed", true));
    }
  }

  private attachRuntime(active: ActiveRuntime): void {
    active.child.onExit((code) => {
      this.handleExit(active, code);
    });
    active.child.onError(() => {
      this.handleExit(active, 1);
    });
    active.child.stdout.setEncoding("utf8");
    active.child.stdout.on("data", (chunk) => {
      this.handleStdout(active, String(chunk));
    });
  }

  private handleExit(active: ActiveRuntime, code: number | null): void {
    active.exited = true;
    for (const waiter of active.exitWaiters.splice(0)) waiter();
    if (this.active !== active || active.status === "stopping" || active.status === "stopped")
      return;
    active.status = code === 0 ? "stopped" : "restart-denied";
    if (code === 0) this.active = undefined;
    this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
  }

  private handleStdout(active: ActiveRuntime, chunk: string): void {
    if (active.stopRequested) {
      active.stdoutBuffer = "";
      return;
    }
    active.stdoutBuffer += chunk;
    if (active.stdoutBuffer.length > MAX_SIDECAR_EVENT_LINE_BYTES) {
      active.stdoutBuffer = "";
      this.emitFailure(active);
      return;
    }
    this.drainStdoutLines(active);
  }

  private drainStdoutLines(active: ActiveRuntime): void {
    while (active.stdoutBuffer.includes("\n")) {
      const index = active.stdoutBuffer.indexOf("\n");
      const line = active.stdoutBuffer.slice(0, index);
      active.stdoutBuffer = active.stdoutBuffer.slice(index + 1);
      const event = normalizeSidecarLine(active, this.nextSequence(active), line.trim());
      if (event !== undefined) this.emit(event);
    }
  }

  private emitFailure(active: ActiveRuntime): void {
    this.emit(
      runtimeEvent(active, this.nextSequence(active), "failure-redacted", {
        failureCode: "failure-redacted",
        failureSummary: "sidecar-event-denied",
        retryable: false,
      }),
    );
  }

  private recordLaunchFailure(
    request: CodingRuntimeLaunchRequest,
    result: FailureResult,
  ): FailureResult {
    const active = createInactiveRuntime(
      request,
      this.deps.approvalStore,
      this.deps.now,
      this.deps.nowIso,
    );
    this.emit(
      runtimeEvent(active, this.nextSequence(active), "failure-redacted", {
        failureCode: "failure-redacted",
        failureSummary: "runtime-denied",
        retryable: result.retryable,
      }),
    );
    return result;
  }

  private nextSequence(active: ActiveRuntime): number {
    active.sequence += 1;
    return active.sequence;
  }

  private emit(event: CodingWorkbenchRuntimeEvent): void {
    const validation = validateCodingWorkbenchRuntimeEvent(event);
    if (validation.ok) {
      this.deps.onRuntimeEvent(event);
      return;
    }
    emitInvalidRuntimeEventDiagnostic(this.deps.diagnostics, event, this.deps.now);
  }
}

function emitInvalidRuntimeEventDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  event: Pick<CodingWorkbenchRuntimeEvent, "kind" | "runId">,
  now: () => number,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: event.runId,
    timestamp: new Date(now()).toISOString(),
    operation: "coding-runtime.emit",
    source: "coding-runtime-manager.emit",
    errorClass: "InvalidRuntimeEvent",
    message: `runtime-event-invalid:${event.kind}`,
  });
}

function wrapChild(child: ChildProcess): CodingRuntimeSpawnHandle {
  if (child.stdout === null || child.stderr === null) throw new Error("spawn-failed");
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: (signal): void => {
      killProcessGroup(child, signal);
    },
    onExit: (callback): void => {
      child.on("exit", (code) => {
        callback(code);
      });
    },
    onError: (callback): void => {
      child.on("error", callback);
    },
  };
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Child may have exited between checks; termination remains idempotent.
    }
  }
}

function cancellationFailure(
  request: CodingRuntimeLaunchRequest,
  deps: NormalizedCodingRuntimeManagerDeps,
): FailureResult | undefined {
  const cancellation = createDeadlineCancellation({
    signal: request.signal,
    deadlineMs: request.startTimeoutMs,
    now: deps.now,
  });
  try {
    cancellation.throwIfCancellationRequested();
    return undefined;
  } catch (error) {
    if (!isCancellation(error)) throw error;
    return failure(cancellation.reason() === "aborted" ? "start-aborted" : "start-timeout", true);
  }
}

function validateAdapterSelection(
  request: CodingRuntimeLaunchRequest,
): { readonly ok: true } | FailureResult {
  if (request.adapterKind === "opencode-compatible") {
    const runtimeOk = request.runtimeSource === "keiko-sidecar";
    const modelOk = request.modelSource !== "chatgpt-codex-subscription-profile";
    return runtimeOk && modelOk ? { ok: true } : failure("adapter-profile-mismatch", false);
  }
  const codexRuntime = request.runtimeSource === "codex-cli-adapter";
  const codexModel = request.modelSource === "chatgpt-codex-subscription-profile";
  return codexRuntime && codexModel ? { ok: true } : failure("adapter-profile-mismatch", false);
}

function createActiveRuntime(
  request: CodingRuntimeLaunchRequest,
  child: CodingRuntimeSpawnHandle,
  approvalStore: SupervisedCodingApprovalStore,
  nowMs: () => number,
  nowIso: () => string,
): ActiveRuntime {
  return {
    context: eventContext(request),
    child,
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    exitWaiters: [],
    approvalStore,
    nowMs,
    nowIso,
    stdoutBuffer: "",
    exited: false,
    stopRequested: false,
    status: "ready",
    sequence: 0,
  };
}

function createInactiveRuntime(
  request: CodingRuntimeLaunchRequest,
  approvalStore: SupervisedCodingApprovalStore,
  nowMs: () => number,
  nowIso: () => string,
): ActiveRuntime {
  return {
    context: eventContext(request),
    child: inertChild(),
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    exitWaiters: [],
    approvalStore,
    nowMs,
    nowIso,
    stdoutBuffer: "",
    exited: true,
    stopRequested: false,
    status: "stopped",
    sequence: 0,
  };
}

function eventContext(request: CodingRuntimeLaunchRequest): RuntimeEventContext {
  return {
    runId: request.runId,
    taskRef: request.taskRef,
    workspaceRoot: request.workspaceRoot,
    runtimeSource: request.runtimeSource,
    modelSource: request.modelSource,
    requestedMode: request.requestedMode,
    effectiveMode: request.effectiveMode,
  };
}

function inertChild(): CodingRuntimeSpawnHandle {
  const empty = new Readable({ read: (): void => undefined });
  return {
    stdout: empty,
    stderr: empty,
    kill: (): void => undefined,
    onExit: (): void => undefined,
    onError: (): void => undefined,
  };
}

function preflightExecutable(request: CodingRuntimeLaunchRequest): PreflightOk | FailureResult {
  const managedRoot = realPath(request.managedRoot);
  const workspaceRoot = realPath(request.workspaceRoot);
  const executablePath = executableRealPath(request.executablePath);
  if (managedRoot === undefined || workspaceRoot === undefined || executablePath === undefined) {
    return failure("sidecar-missing", false);
  }
  if (pathInside(workspaceRoot, managedRoot) || !pathInside(managedRoot, executablePath)) {
    return failure("sidecar-unmanaged", false);
  }
  return { ok: true, executablePath };
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function executableRealPath(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    accessSync(real, constants.X_OK);
    return real;
  } catch {
    return undefined;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildRuntimeEnv(
  request: CodingRuntimeLaunchRequest,
  processEnv: NodeJS.ProcessEnv,
): { readonly ok: true; readonly value: Record<string, string> } | FailureResult {
  if (request.inheritedEnvAllowlist.some((name) => SECRET_ENV_NAME.test(name))) {
    return failure("env-secret-denied", false);
  }
  if (!isLoopbackUrl(request.gatewayUrl)) return failure("gateway-non-loopback", false);
  const env = {
    ...buildSandboxEnv(processEnv, request.inheritedEnvAllowlist),
    ...runtimeProjectionEnv(request),
  };
  return envContainsDeniedSecret(env, processEnv, request.inheritedEnvAllowlist)
    ? failure("env-secret-denied", false)
    : { ok: true, value: env };
}

function runtimeProjectionEnv(request: CodingRuntimeLaunchRequest): Record<string, string> {
  return {
    KEIKO_CODING_RUN_ID: request.runId,
    KEIKO_CODING_TASK_REF: request.taskRef,
    KEIKO_CODING_ADAPTER_KIND: request.adapterKind,
    KEIKO_CODING_RUNTIME_SOURCE: request.runtimeSource,
    KEIKO_CODING_MODEL_SOURCE: request.modelSource,
    KEIKO_CODING_MODE: request.effectiveMode,
    KEIKO_CODING_WORKSPACE_ROOT: request.workspaceRoot,
    KEIKO_MODEL_GATEWAY_URL: request.gatewayUrl,
    KEIKO_MODEL_PROFILE_ID: request.modelProfileId,
  };
}

function envContainsDeniedSecret(
  env: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): boolean {
  const deniedValues = new Set(collectSensitiveEnvValues(processEnv, allowlist));
  return Object.values(env).some((value) => deniedValues.has(value));
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function failure(code: CodingRuntimeFailureCode, retryable: boolean): FailureResult {
  return { ok: false, failureCode: code, retryable };
}

async function escalateRuntimeKill(
  active: ActiveRuntime,
  scheduler: CodingRuntimeKillScheduler,
): Promise<void> {
  safeKill(active.child, "SIGTERM");
  if (active.exited) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (sendKill: boolean): void => {
      if (settled) return;
      settled = true;
      if (sendKill && !active.exited) safeKill(active.child, "SIGKILL");
      resolve();
    };
    active.exitWaiters.push(() => {
      finish(false);
    });
    scheduler.setTimer(() => {
      finish(true);
    }, active.shutdownTimeoutMs);
  });
}

function safeKill(child: CodingRuntimeSpawnHandle, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Child may have already exited; kill escalation remains best-effort and idempotent.
  }
}

function runtimeExitEvent(
  active: ActiveRuntime,
  sequence: number,
  code: number | null,
): CodingWorkbenchRuntimeEvent {
  if (code === 0) {
    return runtimeEvent(active, sequence, "runtime-stopped", { health: "stopped" });
  }
  return runtimeEvent(active, sequence, "failure-redacted", {
    failureCode: "failure-redacted",
    failureSummary: "runtime-failed",
    retryable: true,
  });
}

function runtimeEvent(
  active: ActiveRuntime,
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  details: Partial<CodingWorkbenchRuntimeEvent>,
): CodingWorkbenchRuntimeEvent {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: `coding-runtime-${active.context.runId}-${String(sequence)}`,
    runId: active.context.runId,
    occurredAt: active.nowIso(),
    kind,
    ...runtimeContextFields(active, kind),
    ...details,
  };
}

function runtimeContextFields(
  active: ActiveRuntime,
  kind: CodingWorkbenchRuntimeEvent["kind"],
): Partial<CodingWorkbenchRuntimeEvent> {
  if (kind === "runtime-started") {
    return {
      runtimeSource: active.context.runtimeSource,
      modelSource: active.context.modelSource,
      requestedMode: active.context.requestedMode,
      effectiveMode: active.context.effectiveMode,
    };
  }
  if (kind === "runtime-stopped") {
    return {
      runtimeSource: active.context.runtimeSource,
      modelSource: active.context.modelSource,
      effectiveMode: active.context.effectiveMode,
    };
  }
  if (kind === "runtime-health") {
    return { runtimeSource: active.context.runtimeSource, modelSource: active.context.modelSource };
  }
  return {};
}

function normalizeSidecarLine(
  active: ActiveRuntime,
  sequence: number,
  line: string,
): CodingWorkbenchRuntimeEvent | undefined {
  const parsed = parseCodingSidecarEventLine(line);
  if (parsed.status === "empty") return undefined;
  return parsed.status === "invalid"
    ? runtimeEvent(active, sequence, "failure-redacted", invalidSidecarEventDetails())
    : sidecarRuntimeEvent(active, sequence, parsed.event);
}

function sidecarRuntimeEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarHealthEvent | SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent {
  if (event.type === "health") {
    return runtimeEvent(active, sequence, "runtime-health", { health: event.health });
  }
  const request = permissionRequest(event);
  const validation = validateCodingWorkbenchPermissionRequest(request);
  if (!validation.ok) {
    return runtimeEvent(active, sequence, "failure-redacted", invalidSidecarEventDetails());
  }
  const autonomous = autonomousDeliveryRuntimeEvent(active, sequence, event, request);
  if (autonomous !== undefined) return autonomous;
  const supervised = supervisedCodingRuntimeEvent(active, sequence, event, request);
  if (supervised !== undefined) return supervised;
  const decision = decideCodingWorkbenchActionForMode(
    active.context.effectiveMode,
    request.actionClass,
    request.connectorScopes ?? [],
  );
  if (!decision.allowed) {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: decision.reasonCode,
      failureSummary: decision.reasonCode,
      retryable: false,
    });
  }
  return runtimeEvent(active, sequence, "permission-requested", {
    permissionRequest: request,
  });
}

function autonomousDeliveryRuntimeEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
  request: CodingWorkbenchPermissionRequest,
): CodingWorkbenchRuntimeEvent | undefined {
  if (active.context.effectiveMode !== "autonomous-delivery") return undefined;
  if (active.stopRequested || event.operatorStopped === true) {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: "operator-stopped",
      failureSummary: "operator-stopped",
      retryable: false,
    });
  }
  if (request.actionClass === "workspace-read") return undefined;
  return runtimeEvent(active, sequence, "failure-redacted", {
    failureCode: "delivery-denied",
    failureSummary: "delivery-denied",
    retryable: false,
  });
}

function supervisedCodingRuntimeEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
  request: CodingWorkbenchPermissionRequest,
): CodingWorkbenchRuntimeEvent | undefined {
  if (active.context.effectiveMode !== "supervised-coding" || request.actionKind === undefined) {
    return undefined;
  }
  if (request.actionKind === "file-edit") return supervisedFileEditEvent(active, sequence, event);
  if (request.actionKind === "verification-command") {
    return supervisedVerificationEvent(active, sequence, event);
  }
  return supervisedMutationEvent(active, sequence, event, request.actionKind);
}

function supervisedFileEditEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent {
  const decision = decideSupervisedFileEdit({
    ...supervisedEvidenceContext(active, "file-edit"),
    workspaceRoot: active.context.workspaceRoot,
    targetPath: event.targetPath ?? "",
    allowedRelativePaths: event.allowedRelativePaths ?? [".."],
    fileCount: event.fileCount ?? 0,
    addedLines: event.addedLines ?? 0,
    deletedLines: event.deletedLines ?? 0,
  });
  if (decision.status !== "allowed") return supervisedFailureEvent(active, sequence, decision);
  return runtimeEvent(active, sequence, "diff-summarized", {
    fileCount: decision.evidence.fileCount ?? 0,
    addedLines: decision.evidence.addedLines ?? 0,
    deletedLines: decision.evidence.deletedLines ?? 0,
  });
}

function supervisedVerificationEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent {
  const decision = decideSupervisedVerificationCommand({
    ...supervisedEvidenceContext(active, "verification-command"),
    executable: event.executable ?? "",
    args: event.args ?? [],
    passedCount: event.passedCount ?? 0,
    failedCount: event.failedCount ?? 0,
    skippedCount: event.skippedCount ?? 0,
  });
  if (decision.status !== "allowed") return supervisedFailureEvent(active, sequence, decision);
  return runtimeEvent(active, sequence, "verification-summarized", {
    verificationKind: "verification-command",
    verificationStatus: verificationStatus(decision),
    passedCount: decision.evidence.passedCount ?? 0,
    failedCount: decision.evidence.failedCount ?? 0,
    skippedCount: decision.evidence.skippedCount ?? 0,
  });
}

function supervisedMutationEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
  actionKind: CodingWorkbenchSupervisedActionKind,
): CodingWorkbenchRuntimeEvent {
  if (active.stopRequested || event.operatorStopped === true) {
    return supervisedPolicyFailureEvent(active, sequence, "operator-stopped");
  }
  if (event.approvalTokenMalformed === true) {
    return supervisedPolicyFailureEvent(active, sequence, "approval-proof-stale");
  }
  const binding = approvalBindingForEvent(active, event, actionKind);
  const approval = consumePresentedApproval(active, event, binding);
  if (event.approvalToken !== undefined && approval === undefined) {
    return supervisedPolicyFailureEvent(active, sequence, "approval-proof-stale");
  }
  const decision = decideSupervisedMutation({
    ...supervisedEvidenceContext(active, actionKind),
    actionKind,
    requestId: event.requestId,
    scopeDigest: binding.scopeDigest,
    expiresAt: event.expiresAt,
    approval,
    connectorScopes: binding.connectorScopes,
    nowIso: active.nowIso(),
    operatorStopped: false,
  });
  if (decision.status === "approval-required" && decision.permissionRequest !== undefined) {
    return runtimeEvent(active, sequence, "permission-requested", {
      permissionRequest: decision.permissionRequest,
    });
  }
  if (decision.status === "allowed")
    return supervisedApprovalAcceptedEvent(active, sequence, decision);
  return supervisedFailureEvent(active, sequence, decision);
}

function approvalBindingForIssue(
  active: ActiveRuntime,
  request: CodingRuntimeApprovalIssueRequest,
): SupervisedCodingApprovalBinding {
  return approvalBinding({
    runId: active.context.runId,
    requestId: request.requestId,
    actionKind: request.actionKind,
    connectorScopes: request.connectorScopes,
  });
}

function approvalBindingForEvent(
  active: ActiveRuntime,
  event: SidecarPermissionEvent,
  actionKind: CodingWorkbenchSupervisedActionKind,
): SupervisedCodingApprovalBinding {
  return approvalBinding({
    runId: active.context.runId,
    requestId: event.requestId,
    actionKind,
    connectorScopes: event.connectorScopes,
  });
}

function approvalBinding(input: {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
}): SupervisedCodingApprovalBinding {
  const connectorScopes = normalizedConnectorScopes(input.connectorScopes);
  const scopeDigest = supervisedCodingApprovalScopeDigest({ ...input, connectorScopes });
  return {
    runId: input.runId,
    requestId: input.requestId,
    actionKind: input.actionKind,
    scopeDigest,
    connectorScopes,
  };
}

function consumePresentedApproval(
  active: ActiveRuntime,
  event: SidecarPermissionEvent,
  binding: SupervisedCodingApprovalBinding,
): SupervisedCodingConsumedApproval | undefined {
  if (event.approvalToken === undefined) return undefined;
  return active.approvalStore.consume({
    approval: event.approvalToken,
    binding,
    nowMs: active.nowMs(),
  });
}

function normalizedConnectorScopes(
  scopes: readonly CodingWorkbenchConnectorScope[] | undefined,
): readonly CodingWorkbenchConnectorScope[] {
  return [...new Set(scopes ?? [])].sort();
}

function supervisedEvidenceContext(
  active: ActiveRuntime,
  label: CodingWorkbenchSupervisedActionKind,
): SupervisedRuntimeEvidenceContext {
  return {
    recordId: `coding-runtime-${active.context.runId}-${label}`,
    runId: active.context.runId,
    occurredAt: active.nowIso(),
    effectiveMode: active.context.effectiveMode,
    runtimeSource: active.context.runtimeSource,
    modelSource: active.context.modelSource,
  } as const;
}

function supervisedApprovalAcceptedEvent(
  active: ActiveRuntime,
  sequence: number,
  decision: SupervisedCodingDecision,
): CodingWorkbenchRuntimeEvent {
  return runtimeEvent(active, sequence, "artifact-produced", {
    artifactKind: "approval",
    artifactLabel: decision.reason,
    artifactDigest: decision.evidence.digest,
    artifactBytes: 0,
  });
}

function supervisedFailureEvent(
  active: ActiveRuntime,
  sequence: number,
  decision: SupervisedCodingDecision,
): CodingWorkbenchRuntimeEvent {
  return supervisedPolicyFailureEvent(active, sequence, decision.reason);
}

function supervisedPolicyFailureEvent(
  active: ActiveRuntime,
  sequence: number,
  reason: CodingWorkbenchSupervisedPolicyReason,
): CodingWorkbenchRuntimeEvent {
  return runtimeEvent(active, sequence, "failure-redacted", {
    failureCode: reason,
    failureSummary: reason,
    retryable: false,
  });
}

function verificationStatus(decision: SupervisedCodingDecision): "passed" | "failed" | "partial" {
  if ((decision.evidence.failedCount ?? 0) > 0) return "failed";
  if ((decision.evidence.skippedCount ?? 0) > 0) return "partial";
  return "passed";
}

function invalidSidecarEventDetails(): Partial<CodingWorkbenchRuntimeEvent> {
  return {
    failureCode: "failure-redacted",
    failureSummary: "sidecar-event-denied",
    retryable: false,
  };
}

function permissionRequest(event: SidecarPermissionEvent): CodingWorkbenchPermissionRequest {
  return {
    requestId: event.requestId,
    kind: event.kind,
    actionClass: event.actionClass,
    reasonCode: event.reasonCode,
    expiresAt: event.expiresAt,
    ...(event.actionKind === undefined ? {} : { actionKind: event.actionKind }),
    ...(event.scopeLabel === undefined ? {} : { scopeLabel: event.scopeLabel }),
    ...(event.risk === undefined ? {} : { risk: event.risk }),
    ...(event.policyReason === undefined ? {} : { policyReason: event.policyReason }),
    ...(event.connectorScopes === undefined ? {} : { connectorScopes: event.connectorScopes }),
    ...(event.commandLabel === undefined ? {} : { commandLabel: event.commandLabel }),
  };
}
