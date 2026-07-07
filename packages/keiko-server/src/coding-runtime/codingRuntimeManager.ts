import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";

import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  CODING_WORKBENCH_PERMISSION_REQUEST_KINDS,
  validateCodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchPermissionRequest,
  CodingWorkbenchPermissionRequestKind,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimeHealth,
  CodingWorkbenchRuntimeSource,
} from "@oscharko-dev/keiko-contracts";
import { buildSandboxEnv, collectSensitiveEnvValues } from "@oscharko-dev/keiko-tools";

import { createDeadlineCancellation, isCancellation } from "../editor/languageCancellation.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";

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
  readonly onRuntimeEvent?: ((event: CodingWorkbenchRuntimeEvent) => void) | undefined;
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
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
}

export interface CodingRuntimeManager {
  start(request: CodingRuntimeLaunchRequest): CodingRuntimeStartResult;
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
  readonly nowIso: () => string;
  stdoutBuffer: string;
  exited: boolean;
  status: CodingRuntimeStatus;
  sequence: number;
}

interface SidecarPermissionEvent {
  readonly type: "permission-request";
  readonly requestId: string;
  readonly kind: CodingWorkbenchPermissionRequestKind;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly reasonCode: string;
  readonly expiresAt: string;
  readonly commandLabel?: string | undefined;
}

interface SidecarHealthEvent {
  readonly type: "health";
  readonly health: CodingWorkbenchRuntimeHealth;
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
    onRuntimeEvent: deps.onRuntimeEvent ?? ((): void => undefined),
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
    active.status = "stopping";
    await escalateRuntimeKill(active, this.deps.killScheduler);
    active.status = "stopped";
    this.active = undefined;
    this.emit(
      runtimeEvent(active, this.nextSequence(active), "runtime-stopped", { health: "stopped" }),
    );
    return { ok: true, status: "stopped" };
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
      const active = createActiveRuntime(request, child, this.deps.nowIso);
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
    const active = createInactiveRuntime(request, this.deps.nowIso);
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
    if (validation.ok) this.deps.onRuntimeEvent(event);
  }
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
  nowIso: () => string,
): ActiveRuntime {
  return {
    context: eventContext(request),
    child,
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    exitWaiters: [],
    nowIso,
    stdoutBuffer: "",
    exited: false,
    status: "ready",
    sequence: 0,
  };
}

function createInactiveRuntime(
  request: CodingRuntimeLaunchRequest,
  nowIso: () => string,
): ActiveRuntime {
  return {
    context: eventContext(request),
    child: inertChild(),
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    exitWaiters: [],
    nowIso,
    stdoutBuffer: "",
    exited: true,
    status: "stopped",
    sequence: 0,
  };
}

function eventContext(request: CodingRuntimeLaunchRequest): RuntimeEventContext {
  return {
    runId: request.runId,
    taskRef: request.taskRef,
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
  if (line.length === 0) return undefined;
  const parsed = parseJson(line);
  if (!isRecord(parsed)) {
    return runtimeEvent(active, sequence, "failure-redacted", invalidSidecarEventDetails());
  }
  const typed = typedSidecarEvent(parsed);
  return typed === undefined
    ? runtimeEvent(active, sequence, "failure-redacted", invalidSidecarEventDetails())
    : sidecarRuntimeEvent(active, sequence, typed);
}

function sidecarRuntimeEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarHealthEvent | SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent {
  if (event.type === "health") {
    return runtimeEvent(active, sequence, "runtime-health", { health: event.health });
  }
  return runtimeEvent(active, sequence, "permission-requested", {
    permissionRequest: permissionRequest(event),
  });
}

function invalidSidecarEventDetails(): Partial<CodingWorkbenchRuntimeEvent> {
  return {
    failureCode: "failure-redacted",
    failureSummary: "sidecar-event-denied",
    retryable: false,
  };
}

function typedSidecarEvent(
  record: Record<string, unknown>,
): SidecarHealthEvent | SidecarPermissionEvent | undefined {
  if (record.type === "health") return healthEvent(record);
  if (record.type === "permission-request") return permissionEvent(record);
  return undefined;
}

function healthEvent(record: Record<string, unknown>): SidecarHealthEvent | undefined {
  const health = record.health;
  return typeof health === "string" && isRuntimeHealth(health)
    ? { type: "health", health }
    : undefined;
}

function permissionEvent(record: Record<string, unknown>): SidecarPermissionEvent | undefined {
  const requestId = stringField(record, "requestId");
  const kind = permissionKind(record.kind);
  const actionClass = actionClassValue(record.actionClass);
  const reasonCode = stringField(record, "reasonCode");
  const expiresAt = stringField(record, "expiresAt");
  if (requestId === undefined || kind === undefined || actionClass === undefined) return undefined;
  if (reasonCode === undefined || expiresAt === undefined) return undefined;
  return {
    type: "permission-request",
    requestId,
    kind,
    actionClass,
    reasonCode,
    expiresAt,
    ...optionalCommandLabel(record),
  };
}

function optionalCommandLabel(record: Record<string, unknown>): { readonly commandLabel?: string } {
  const commandLabel = stringField(record, "commandLabel");
  return commandLabel === undefined ? {} : { commandLabel };
}

function permissionRequest(event: SidecarPermissionEvent): CodingWorkbenchPermissionRequest {
  return {
    requestId: event.requestId,
    kind: event.kind,
    actionClass: event.actionClass,
    reasonCode: event.reasonCode,
    expiresAt: event.expiresAt,
    ...(event.commandLabel === undefined ? {} : { commandLabel: event.commandLabel }),
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function permissionKind(value: unknown): CodingWorkbenchPermissionRequestKind | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_PERMISSION_REQUEST_KINDS as readonly string[]).includes(value)
    ? (value as CodingWorkbenchPermissionRequestKind)
    : undefined;
}

function actionClassValue(value: unknown): CodingWorkbenchActionClass | undefined {
  return typeof value === "string" &&
    (CODING_WORKBENCH_ACTION_CLASSES as readonly string[]).includes(value)
    ? (value as CodingWorkbenchActionClass)
    : undefined;
}

function isRuntimeHealth(value: string): value is CodingWorkbenchRuntimeHealth {
  return (CODING_WORKBENCH_RUNTIME_HEALTH_STATES as readonly string[]).includes(value);
}
