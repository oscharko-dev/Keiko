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
import {
  evaluatePortableSidecarAvailability,
  type PortableSidecarAvailabilityInput,
  type PortableSidecarRuntimeVerification,
} from "../update-portable-sidecar-verification.js";
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
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
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  createRuntimeProcessSupervisor,
  type RuntimeProcessSupervisor,
  type RuntimeProcessTree,
  type RuntimeQualificationIdentity,
  type RuntimeReapReceipt,
} from "./runtimeProcessSupervisor.js";

export type CodingRuntimeAdapterKind = "opencode-compatible" | "codex-cli";

export type CodingRuntimeFailureCode =
  | "adapter-profile-mismatch"
  | "archive-digest-mismatch"
  | "env-secret-denied"
  | "executable-tree-digest-mismatch"
  | "gateway-non-loopback"
  | "payload-missing"
  | "platform-unsupported"
  | "protocol-schema-mismatch"
  | "qualification-missing"
  | "redistribution-unapproved"
  | "runtime-version-mismatch"
  | "runtime-already-running"
  | "runtime-crashed"
  | "runtime-run-mismatch"
  | "runtime-profile-open"
  | "runtime-unqualified"
  | "sidecar-missing"
  | "sidecar-unmanaged"
  | "signature-unverified"
  | "spawn-failed"
  | "start-aborted"
  | "start-timeout";

export type CodingRuntimeStatus =
  "ready" | "recovery-required" | "restart-denied" | "stopped" | "stopping";

export interface CodingRuntimeLaunchRequest {
  readonly runId: string;
  readonly treeBindingId: string;
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
  readonly confinement?: RuntimeQualificationIdentity | undefined;
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
    }
  | {
      readonly status: "recovery-required";
      readonly activeRunId: string;
      readonly failureCode: "runtime-reap-unproven";
      readonly restartDenied: true;
    };

export type CodingRuntimeStopResult =
  | { readonly ok: true; readonly status: "stopped" }
  | {
      readonly ok: false;
      readonly failureCode: "runtime-reap-unproven" | "runtime-run-mismatch";
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

export interface CodingRuntimeManagerDeps {
  readonly supervisor?: RuntimeProcessSupervisor | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now?: (() => number) | undefined;
  readonly nowIso?: (() => string) | undefined;
  readonly approvalStore?: SupervisedCodingApprovalStore | undefined;
  readonly onRuntimeEvent?: ((event: CodingWorkbenchRuntimeEvent) => void) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly portableRuntimeResolver?:
    | ((request: CodingRuntimeLaunchRequest) =>
        | {
            readonly verification: PortableSidecarRuntimeVerification;
            readonly resourceRoot: string;
            readonly target: PortableSidecarAvailabilityInput["target"];
          }
        | undefined)
    | undefined;
  readonly revokeRuntime: (runId: string) => boolean | Promise<boolean>;
  readonly abortInFlightActions: (runId: string) => boolean | Promise<boolean>;
  readonly markRuntimeRecoveryRequired: (runId: string) => boolean | Promise<boolean>;
  readonly releaseRuntimeAfterReap: (
    runId: string,
    receipt: RuntimeReapReceipt,
  ) => boolean | Promise<boolean>;
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
  readonly supervisor: RuntimeProcessSupervisor;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly approvalStore: SupervisedCodingApprovalStore;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly portableRuntimeResolver:
    | ((request: CodingRuntimeLaunchRequest) =>
        | {
            readonly verification: PortableSidecarRuntimeVerification;
            readonly resourceRoot: string;
            readonly target: PortableSidecarAvailabilityInput["target"];
          }
        | undefined)
    | undefined;
  readonly revokeRuntime: (runId: string) => boolean | Promise<boolean>;
  readonly abortInFlightActions: (runId: string) => boolean | Promise<boolean>;
  readonly markRuntimeRecoveryRequired: (runId: string) => boolean | Promise<boolean>;
  readonly releaseRuntimeAfterReap: (
    runId: string,
    receipt: RuntimeReapReceipt,
  ) => boolean | Promise<boolean>;
}

export interface CodingRuntimeManager {
  start(request: CodingRuntimeLaunchRequest): CodingRuntimeStartResult;
  issueApproval(request: CodingRuntimeApprovalIssueRequest): CodingRuntimeApprovalIssueResult;
  stop(runId: string): Promise<CodingRuntimeStopResult>;
  takeover(runId: string): Promise<CodingRuntimeStopResult>;
  reconcile(runId: string): Promise<CodingRuntimeStopResult>;
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
  readonly tree: RuntimeProcessTree;
  readonly shutdownTimeoutMs: number;
  readonly approvalStore: SupervisedCodingApprovalStore;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  stdoutBuffer: string;
  shutdownBarrierComplete: boolean;
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

interface ResolvedPortableRuntime {
  readonly verification: PortableSidecarRuntimeVerification;
  readonly resourceRoot: string;
  readonly target: PortableSidecarAvailabilityInput["target"];
  readonly managedRoot: string;
  readonly executablePath: string;
}

const MAX_SIDECAR_EVENT_LINE_BYTES = 8192;
const SECRET_ENV_NAME = /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function createCodingRuntimeManager(deps: CodingRuntimeManagerDeps): CodingRuntimeManager {
  return new CodingRuntimeManagerImpl(normalizeDeps(deps));
}

export function resolveCodingRuntimeSidecarLaunchTarget(
  managedInstallRoot: string,
  sidecar: PortableSidecarRuntimeVerification,
  availabilityInput: PortableSidecarAvailabilityInput,
): CodingRuntimeSidecarLaunchTargetResult {
  const availability = evaluatePortableSidecarAvailability(sidecar, availabilityInput);
  if (!availability.available) return failure(availability.reason, false);
  if (sidecar.summary.status !== "verified") return failure("payload-missing", false);
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
    supervisor:
      deps.supervisor ?? createRuntimeProcessSupervisor({ backend: unavailableRuntimeBackend }),
    processEnv: deps.processEnv,
    now: deps.now ?? Date.now,
    nowIso: deps.nowIso ?? ((): string => new Date().toISOString()),
    approvalStore: deps.approvalStore ?? createInMemorySupervisedCodingApprovalStore(),
    onRuntimeEvent: deps.onRuntimeEvent ?? ((): void => undefined),
    diagnostics: deps.diagnostics,
    portableRuntimeResolver: deps.portableRuntimeResolver,
    revokeRuntime: deps.revokeRuntime,
    abortInFlightActions: deps.abortInFlightActions,
    markRuntimeRecoveryRequired: deps.markRuntimeRecoveryRequired,
    releaseRuntimeAfterReap: deps.releaseRuntimeAfterReap,
  };
}

const unavailableRuntimeBackend = {
  identity: {
    platform: "win32" as const,
    arch: "x64" as const,
    backend: "windows-job-object" as const,
  },
  spawnOwnedTree: (): never => {
    throw new Error("runtime-unqualified");
  },
  signalTree: (): never => {
    throw new Error("runtime-tree-not-owned");
  },
  waitForCompleteTreeExit: (): Promise<false> => Promise.resolve(false),
  reconcileTreeExit: (): Promise<false> => Promise.resolve(false),
};

class CodingRuntimeManagerImpl implements CodingRuntimeManager {
  private active: ActiveRuntime | undefined;

  public constructor(private readonly deps: NormalizedCodingRuntimeManagerDeps) {}

  public start(request: CodingRuntimeLaunchRequest): CodingRuntimeStartResult {
    if (this.active !== undefined && this.active.status !== "stopped") {
      return failure("runtime-already-running", true);
    }
    const cancelled = cancellationFailure(request, this.deps);
    if (cancelled !== undefined) return cancelled;
    const portable = resolvePortableRuntime(request, this.deps);
    if (!portable.ok) return this.recordLaunchFailure(request, portable);
    const adapter = validateAdapterSelection(request);
    if (!adapter.ok) return this.recordLaunchFailure(request, adapter);
    const preflight = preflightExecutable(
      request,
      portable.value?.managedRoot,
      portable.value?.executablePath,
    );
    if (!preflight.ok) return this.recordLaunchFailure(request, preflight);
    const env = buildRuntimeEnv(request, this.deps.processEnv);
    if (!env.ok) return this.recordLaunchFailure(request, env);
    return this.spawnRuntime(request, preflight.executablePath, env.value, portable.value);
  }

  public async stop(runId: string): Promise<CodingRuntimeStopResult> {
    const active = this.active;
    if (active === undefined) return { ok: true, status: "stopped" };
    if (active.context.runId !== runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    active.stopRequested = true;
    active.status = "stopping";
    const receipt = await this.revokeAndTerminate(active);
    if (receipt === undefined) {
      await this.enterRecoveryRequired(active);
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
    if (!(await this.releaseAfterReap(active, receipt))) {
      await this.enterRecoveryRequired(active);
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
    active.status = "stopped";
    this.active = undefined;
    this.emit(
      runtimeEvent(active, this.nextSequence(active), "runtime-stopped", { health: "stopped" }),
    );
    return { ok: true, status: "stopped" };
  }

  public takeover(runId: string): Promise<CodingRuntimeStopResult> {
    return this.stop(runId);
  }

  public async reconcile(runId: string): Promise<CodingRuntimeStopResult> {
    const active = this.active;
    if (active === undefined) return { ok: true, status: "stopped" };
    if (active.context.runId !== runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    if (!active.shutdownBarrierComplete) {
      await this.enterRecoveryRequired(active);
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
    const result = await this.deps.supervisor.reconcile(active.tree);
    if (result.status !== "reaped") {
      await this.enterRecoveryRequired(active);
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
    if (!(await this.releaseAfterReap(active, result.receipt))) {
      await this.enterRecoveryRequired(active);
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
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
    if (this.active.status === "recovery-required") {
      return {
        status: "recovery-required",
        activeRunId: this.active.context.runId,
        failureCode: "runtime-reap-unproven",
        restartDenied: true,
      };
    }
    return { status: this.active.status, activeRunId: this.active.context.runId };
  }

  private spawnRuntime(
    request: CodingRuntimeLaunchRequest,
    executablePath: string,
    env: Record<string, string>,
    portable: ResolvedPortableRuntime | undefined,
  ): CodingRuntimeStartResult {
    const portableAvailability = portableAvailabilityFailure(portable);
    if (portableAvailability !== undefined) {
      return this.recordLaunchFailure(request, portableAvailability);
    }
    const launched = this.deps.supervisor.spawnOwnedTree(
      supervisorLaunchRequest(request, executablePath, env),
    );
    if (!launched.ok) {
      return this.recordLaunchFailure(
        request,
        failure(launched.failureCode, launched.failureCode === "spawn-failed"),
      );
    }
    const active = createActiveRuntime(
      request,
      launched.tree,
      this.deps.approvalStore,
      this.deps.now,
      this.deps.nowIso,
    );
    this.active = active;
    this.attachRuntime(active);
    this.emit(runtimeEvent(active, this.nextSequence(active), "runtime-started", {}));
    return { ok: true, runId: request.runId, status: "ready" };
  }

  private async revokeAndTerminate(active: ActiveRuntime): Promise<RuntimeReapReceipt | undefined> {
    try {
      if (!(await this.deps.revokeRuntime(active.context.runId))) return undefined;
      this.deps.approvalStore.invalidateRun(active.context.runId);
      if (!(await this.deps.abortInFlightActions(active.context.runId))) return undefined;
      active.shutdownBarrierComplete = true;
      this.deps.supervisor.terminate(active.tree, "graceful");
      let exit = await this.deps.supervisor.waitForCompleteTreeExit(
        active.tree,
        active.shutdownTimeoutMs,
      );
      if (exit.status === "reaped") return exit.receipt;
      this.deps.supervisor.terminate(active.tree, "force");
      exit = await this.deps.supervisor.waitForCompleteTreeExit(
        active.tree,
        active.shutdownTimeoutMs,
      );
      return exit.status === "reaped" ? exit.receipt : undefined;
    } catch {
      return undefined;
    }
  }

  private attachRuntime(active: ActiveRuntime): void {
    active.tree.onTreeExit((code) => {
      this.handleExit(active, code);
    });
    active.tree.stdout.setEncoding("utf8");
    active.tree.stdout.on("data", (chunk) => {
      this.handleStdout(active, String(chunk));
    });
    active.tree.stderr.resume();
  }

  private handleExit(active: ActiveRuntime, code: number | null): void {
    if (this.active !== active || active.stopRequested || active.status === "stopped") return;
    active.stopRequested = true;
    active.status = "stopping";
    void this.finalizeUnexpectedExit(active, code);
  }

  private async finalizeUnexpectedExit(active: ActiveRuntime, code: number | null): Promise<void> {
    const receipt = await this.revokeAndTerminate(active);
    if (this.active !== active) return;
    if (receipt === undefined) {
      await this.enterRecoveryRequired(active);
      this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
      return;
    }
    if (!(await this.releaseAfterReap(active, receipt))) {
      await this.enterRecoveryRequired(active);
      this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
      return;
    }
    active.status = "stopped";
    this.active = undefined;
    this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
  }

  private async enterRecoveryRequired(active: ActiveRuntime): Promise<void> {
    active.status = "recovery-required";
    try {
      await this.deps.markRuntimeRecoveryRequired(active.context.runId);
    } catch {
      // The manager remains fail-closed even if authority-state projection fails.
    }
  }

  private async releaseAfterReap(
    active: ActiveRuntime,
    receipt: RuntimeReapReceipt,
  ): Promise<boolean> {
    try {
      return await this.deps.releaseRuntimeAfterReap(active.context.runId, receipt);
    } catch {
      return false;
    }
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

function resolvePortableRuntime(
  request: CodingRuntimeLaunchRequest,
  deps: Pick<NormalizedCodingRuntimeManagerDeps, "portableRuntimeResolver">,
): { readonly ok: true; readonly value: ResolvedPortableRuntime | undefined } | FailureResult {
  if (request.runtimeSource === "codex-cli-adapter") {
    return failure("redistribution-unapproved", false);
  }
  if (request.runtimeSource !== "keiko-sidecar") return { ok: true, value: undefined };
  const resolved = deps.portableRuntimeResolver?.(request);
  if (resolved === undefined) return failure("qualification-missing", false);
  return {
    ok: true,
    value: {
      ...resolved,
      managedRoot: join(resolved.resourceRoot, resolved.verification.payloadRootPath),
      executablePath: join(resolved.resourceRoot, resolved.verification.executablePath),
    },
  };
}

function portableAvailabilityFailure(
  resolved: ResolvedPortableRuntime | undefined,
): FailureResult | undefined {
  if (resolved === undefined) return undefined;
  const disk = inspectStagedSidecarPayload(resolved.resourceRoot, resolved.verification);
  const availability = evaluatePortableSidecarAvailability(resolved.verification, {
    target: resolved.target,
    ...disk,
  });
  return availability.available ? undefined : failure(availability.reason, false);
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
  tree: RuntimeProcessTree,
  approvalStore: SupervisedCodingApprovalStore,
  nowMs: () => number,
  nowIso: () => string,
): ActiveRuntime {
  return {
    context: eventContext(request),
    tree,
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    approvalStore,
    nowMs,
    nowIso,
    stdoutBuffer: "",
    shutdownBarrierComplete: false,
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
    tree: inertTree(),
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    approvalStore,
    nowMs,
    nowIso,
    stdoutBuffer: "",
    shutdownBarrierComplete: false,
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

function inertTree(): RuntimeProcessTree {
  const empty = new Readable({ read: (): void => undefined });
  return {
    treeId: "inactive",
    stdout: empty,
    stderr: empty,
    onTreeExit: (): void => undefined,
  };
}

function preflightExecutable(
  request: CodingRuntimeLaunchRequest,
  resolvedManagedRoot?: string,
  resolvedExecutablePath?: string,
): PreflightOk | FailureResult {
  const managedRoot = realPath(resolvedManagedRoot ?? request.managedRoot);
  const workspaceRoot = realPath(request.workspaceRoot);
  const executablePath = executableRealPath(resolvedExecutablePath ?? request.executablePath);
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

function supervisorLaunchRequest(
  request: CodingRuntimeLaunchRequest,
  executable: string,
  env: Record<string, string>,
): Parameters<RuntimeProcessSupervisor["spawnOwnedTree"]>[0] {
  return {
    runId: request.runId,
    treeBindingId: request.treeBindingId,
    executable,
    args: request.args,
    cwd: request.workspaceRoot,
    env,
    qualification: request.confinement ?? {
      platform: "win32",
      arch: "x64",
      backend: "windows-job-object",
      releaseReceipt: "unqualified",
    },
    launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
  };
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
