import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";

import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  CODING_WORKBENCH_SCHEMA_VERSION,
  decideCodingWorkbenchActionForMode,
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
  validateCodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchPermissionRequest,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimePendingApprovalReview,
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
import {
  inspectStagedSidecarPayload,
  type PortableSidecarDiskEvidence,
} from "../update-portable-sidecar-staging-verification.js";
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
  type SupervisedCodingApprovalBindingOnce,
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
import {
  createCodingRuntimeLineParser,
  createCodingRuntimeStderrDrainer,
  type CodingRuntimeLineParser,
  type CodingRuntimeStderrDrainer,
  type CodingRuntimeStderrSummary,
} from "./codingRuntimeProcessIo.js";

export type CodingRuntimeAdapterKind = "opencode-compatible" | "codex-cli";

export type CodingRuntimeFailureCode =
  | "adapter-profile-mismatch"
  | "archive-digest-mismatch"
  | "env-secret-denied"
  | "egress-unqualified"
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
  | "runtime-reap-unproven"
  | "runtime-state-unavailable"
  | "runtime-unqualified"
  | "sidecar-missing"
  | "sidecar-unmanaged"
  | "signature-unverified"
  | "spawn-failed"
  | "start-aborted"
  | "start-timeout";

export type CodingRuntimeStatus =
  "ready" | "recovery-required" | "restart-denied" | "starting" | "stopped" | "stopping";

export interface CodingRuntimeLaunchRequest {
  readonly runId: string;
  /** Opaque backend-owned 128-bit process-tree recovery identity (32 lowercase hex chars). */
  readonly recoveryHandle?: string | undefined;
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
      readonly status: "ready" | "starting" | "stopping";
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

export type CodingRuntimePauseResult =
  | { readonly ok: true; readonly paused: boolean }
  | { readonly ok: false; readonly failureCode: "runtime-run-mismatch"; readonly retryable: false };

export interface CodingRuntimeApprovalIssueRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly approvedByUserId: string;
  readonly ttlMs?: number | undefined;
  /**
   * The runtime revision the operator's decision was bound to (#2387). Informational for
   * downstream governed-action projections; deliberately NOT part of the approval scope digest,
   * so issue/consume binding semantics are unchanged.
   */
  readonly boundRevision?: number | undefined;
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
  readonly openCodeLifecycleAdapter?: OpenCodeLifecycleAdapter | undefined;
  readonly codexLifecycleAdapter?: CodexLifecycleAdapter | undefined;
  /** Existing, server-owned local-secret root; Codex state is derived beneath it per run. */
  readonly codexLocalSecretRoot?: string | undefined;
  /**
   * Server-side egress verifier. Its receipt attests to network enforcement; environment
   * projection is configuration only and is never treated as confinement.
   */
  readonly qualifyCodexEgress?:
    ((request: CodingRuntimeLaunchRequest) => ReviewedCodexEgressPolicy | undefined) | undefined;
  readonly portableRuntimeResolver?:
    | ((request: CodingRuntimeLaunchRequest) =>
        | {
            readonly verification: PortableSidecarRuntimeVerification;
            readonly resourceRoot: string;
            readonly target: PortableSidecarAvailabilityInput["target"];
            readonly admission?: PortableRuntimeAdmissionPolicy | undefined;
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

export interface OpenCodeLifecycleHandshakeRequest {
  readonly runId: string;
  readonly startupOutput: OpenCodeStartupOutput;
  readonly onPermission: (event: SidecarPermissionEvent) => void;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export interface OpenCodeStartupOutput {
  readonly nextLine: (signal?: AbortSignal) => Promise<string>;
}

export interface OpenCodeLifecyclePrepareRequest {
  readonly runId: string;
  readonly executablePath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly verification: PortableSidecarRuntimeVerification;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export type OpenCodeLifecyclePrepareResult =
  | { readonly ok: true; readonly env?: Readonly<Record<string, string>> | undefined }
  | { readonly ok: false; readonly reason: string };

export interface OpenCodeLifecycleMonitorRequest {
  readonly runId: string;
  readonly onFailure: () => void;
}

export interface OpenCodeLifecycleAdapter {
  prepare?: (request: OpenCodeLifecyclePrepareRequest) => Promise<OpenCodeLifecyclePrepareResult>;
  handshake(
    request: OpenCodeLifecycleHandshakeRequest,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  monitor?: ((request: OpenCodeLifecycleMonitorRequest) => (() => void) | undefined) | undefined;
  dispose?: ((runId: string) => boolean | Promise<boolean>) | undefined;
}

/**
 * Server-private lifecycle boundary for a reviewed Codex app-server composition.
 * It receives an already supervisor-owned process tree; it cannot spawn or kill one.
 */
export interface CodexLifecycleAdapter {
  qualify(request: CodexLifecycleCheckRequest): Promise<CodexLifecycleCheckResult>;
  inspectProfile(request: CodexLifecycleCheckRequest): Promise<CodexLifecycleCheckResult>;
  prepare(request: CodexLifecyclePrepareRequest): Promise<CodexLifecyclePrepareResult>;
  attach(request: CodexLifecycleAttachRequest): Promise<CodexLifecycleAttachment>;
  dispose(runId: string): boolean | Promise<boolean>;
}

export interface ReviewedCodexEgressPolicy {
  readonly verified: boolean;
  readonly receipt: string;
  /** Direct egress is denied unless the server-side verifier has explicitly approved it. */
  readonly directEgress: "disabled" | "approved";
  readonly httpsProxy?: string | undefined;
  readonly noProxy?: string | undefined;
  /** Canonical readable CA bundle beneath the server-owned config root. */
  readonly caBundlePath?: string | undefined;
  readonly serverConfigRoot?: string | undefined;
}

export interface CodexLifecycleCheckRequest {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export type CodexLifecycleCheckResult = { readonly ok: true } | { readonly ok: false };

export interface CodexLifecyclePrepareRequest extends CodexLifecycleCheckRequest {
  readonly stateRoot: string;
}

export type CodexLifecyclePrepareResult =
  { readonly ok: true; readonly stateRoot: string } | { readonly ok: false };

export interface CodexLifecycleAttachRequest extends CodexLifecycleCheckRequest {
  readonly tree: RuntimeProcessTree;
}

export type CodexLifecycleAttachment =
  { readonly ok: true; readonly detach: () => boolean | Promise<boolean> } | { readonly ok: false };

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
  readonly openCodeLifecycleAdapter: OpenCodeLifecycleAdapter | undefined;
  readonly codexLifecycleAdapter: CodexLifecycleAdapter | undefined;
  readonly codexLocalSecretRoot: string | undefined;
  readonly qualifyCodexEgress:
    ((request: CodingRuntimeLaunchRequest) => ReviewedCodexEgressPolicy | undefined) | undefined;
  readonly portableRuntimeResolver:
    | ((request: CodingRuntimeLaunchRequest) =>
        | {
            readonly verification: PortableSidecarRuntimeVerification;
            readonly resourceRoot: string;
            readonly target: PortableSidecarAvailabilityInput["target"];
            readonly admission?: PortableRuntimeAdmissionPolicy | undefined;
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
  start(
    request: CodingRuntimeLaunchRequest,
  ): CodingRuntimeStartResult | Promise<CodingRuntimeStartResult>;
  issueApproval(request: CodingRuntimeApprovalIssueRequest): CodingRuntimeApprovalIssueResult;
  pause(runId: string): CodingRuntimePauseResult;
  resume(runId: string): CodingRuntimePauseResult;
  stop(runId: string): Promise<CodingRuntimeStopResult>;
  takeover(runId: string): Promise<CodingRuntimeStopResult>;
  reconcile(runId: string): Promise<CodingRuntimeStopResult>;
  health(): CodingRuntimeHealthReport;
  /**
   * The reviewable changeset facts of the ask the operator is deciding about (#2853). Bound to both
   * the active run and the exact pending request id, so a stale panel or a foreign run can never
   * read a review, and it is served only over the authenticated app-session channel.
   */
  pendingApprovalReview(
    runId: string,
    requestId: string,
  ): CodingWorkbenchRuntimePendingApprovalReview | undefined;
}

interface PreflightOk {
  readonly ok: true;
  readonly executablePath: string;
  readonly managedRoot: string;
  readonly workspaceRoot: string;
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
  readonly openCodeLifecycleAdapter: OpenCodeLifecycleAdapter | undefined;
  readonly codexLifecycleAdapter: CodexLifecycleAdapter | undefined;
  startupOutput: OpenCodeStartupMailbox | undefined;
  lifecycleMonitorDispose: (() => void) | undefined;
  codexDetach: (() => boolean | Promise<boolean>) | undefined;
  stdoutParser: CodingRuntimeLineParser | undefined;
  stderrDrainer: CodingRuntimeStderrDrainer | undefined;
  /**
   * The reviewable changeset facts of the ask currently awaiting an operator decision (#2853).
   * Transient and run-local: it never enters a runtime event, a snapshot, the SSE projection or
   * evidence, because the paths are model-selected content (#2644).
   */
  pendingApprovalReview: CodingWorkbenchRuntimePendingApprovalReview | undefined;
  shutdownBarrierComplete: boolean;
  stopRequested: boolean;
  paused: boolean;
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

/**
 * Which admission policy vouched for the verification record (#2475, ADR-0140). The launch-time
 * availability re-check asserts exactly the checks that policy's discovery performed: the
 * release-qualified policy requires the complete packaged evidence set; the functional dev lane
 * never claims platform signature or supervisor qualification, so re-asserting them would refuse
 * an honestly weaker record. Absent markers fail closed to the release-qualified policy.
 */
type PortableRuntimeAdmissionPolicy = "release-qualified" | "functional-dev-lane";

interface ResolvedPortableRuntime {
  readonly verification: PortableSidecarRuntimeVerification;
  readonly resourceRoot: string;
  readonly target: PortableSidecarAvailabilityInput["target"];
  readonly admission?: PortableRuntimeAdmissionPolicy | undefined;
  readonly managedRoot: string;
  readonly executablePath: string;
}

interface OpenCodeStartupMailbox extends OpenCodeStartupOutput {
  offer(line: string): void;
  close(): void;
}

const SECRET_ENV_NAME = /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const FIXED_OPENCODE_ARGS = Object.freeze([
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  "0",
  "--no-mdns",
] as const);
const FIXED_CODEX_ARGS = Object.freeze([] as const);
const CODEX_STATE_DIRECTORY = "coding-runtime/codex";
const INHERITED_EGRESS_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;
const GLOBAL_RUNTIME_ENV_NAMES = [
  "CODEX_HOME",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PATH",
] as const;

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
    openCodeLifecycleAdapter: deps.openCodeLifecycleAdapter,
    codexLifecycleAdapter: deps.codexLifecycleAdapter,
    codexLocalSecretRoot: deps.codexLocalSecretRoot,
    qualifyCodexEgress: deps.qualifyCodexEgress,
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

  public start(
    request: CodingRuntimeLaunchRequest,
  ): CodingRuntimeStartResult | Promise<CodingRuntimeStartResult> {
    if (this.active !== undefined && this.active.status !== "stopped") {
      return failure("runtime-already-running", true);
    }
    const cancelled = cancellationFailure(request, this.deps);
    if (cancelled !== undefined) return cancelled;
    const adapter = validateAdapterSelection(request);
    if (!adapter.ok) return this.recordLaunchFailure(request, adapter);
    const portable = resolvePortableRuntime(request, this.deps);
    if (!portable.ok) return this.recordLaunchFailure(request, portable);
    const preflight = preflightExecutable(
      request,
      portable.value?.managedRoot,
      portable.value?.executablePath,
    );
    if (!preflight.ok) return this.recordLaunchFailure(request, preflight);
    return this.startAfterPreflight(request, portable.value, preflight);
  }

  private startAfterPreflight(
    request: CodingRuntimeLaunchRequest,
    portable: ResolvedPortableRuntime | undefined,
    preflight: PreflightOk,
  ): CodingRuntimeStartResult | Promise<CodingRuntimeStartResult> {
    if (request.adapterKind === "codex-cli") {
      const codex = this.deps.codexLifecycleAdapter;
      if (codex === undefined) {
        return this.recordLaunchFailure(request, failure("redistribution-unapproved", false));
      }
      return this.prepareAndSpawnCodex(request, preflight, portable, codex);
    }
    const env = buildRuntimeEnv(request, this.deps.processEnv);
    if (!env.ok) return this.recordLaunchFailure(request, env);
    const lifecycle = this.deps.openCodeLifecycleAdapter;
    if (lifecycle !== undefined) {
      return lifecycle.prepare === undefined
        ? this.spawnRuntime(
            request,
            preflight.executablePath,
            env.value,
            portable,
            FIXED_OPENCODE_ARGS,
            lifecycle,
          )
        : this.prepareAndSpawnOpenCode(
            request,
            preflight.executablePath,
            env.value,
            portable,
            lifecycle,
          );
    }
    return this.spawnRuntime(request, preflight.executablePath, env.value, portable, request.args);
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
    if (!(await this.disposeAndReleaseAfterReap(active, receipt))) {
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

  // Pause is load-bearing: while paused, issueApproval is refused so no new tool mutation can be
  // admitted, without terminating the run. Resume clears the flag; stop still supersedes both.
  public pause(runId: string): CodingRuntimePauseResult {
    return this.setPaused(runId, true);
  }

  public resume(runId: string): CodingRuntimePauseResult {
    return this.setPaused(runId, false);
  }

  private setPaused(runId: string, paused: boolean): CodingRuntimePauseResult {
    const active = this.active;
    if (active?.context.runId !== runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    active.paused = paused;
    return { ok: true, paused };
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
    if (!(await this.disposeAndReleaseAfterReap(active, result.receipt))) {
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
    if (active.stopRequested || active.paused || active.status !== "ready") {
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

  public pendingApprovalReview(
    runId: string,
    requestId: string,
  ): CodingWorkbenchRuntimePendingApprovalReview | undefined {
    const active = this.active;
    if (active?.context.runId !== runId) return undefined;
    const review = active.pendingApprovalReview;
    return review?.requestId === requestId ? review : undefined;
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
    args: readonly string[],
    lifecycleAdapter?: OpenCodeLifecycleAdapter,
  ): CodingRuntimeStartResult | Promise<CodingRuntimeStartResult> {
    const portableAvailability = portableAvailabilityFailure(portable);
    if (portableAvailability !== undefined) {
      return this.recordLaunchFailure(request, portableAvailability);
    }
    const launched = this.deps.supervisor.spawnOwnedTree(
      supervisorLaunchRequest(request, executablePath, env, args),
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
      lifecycleAdapter,
    );
    this.active = active;
    this.attachRuntime(active);
    if (request.adapterKind === "opencode-compatible" && lifecycleAdapter !== undefined) {
      return this.completeOpenCodeStart(request, active, lifecycleAdapter);
    }
    active.status = "ready";
    this.emit(runtimeEvent(active, this.nextSequence(active), "runtime-started", {}));
    return { ok: true, runId: request.runId, status: "ready" };
  }

  private async prepareAndSpawnOpenCode(
    request: CodingRuntimeLaunchRequest,
    executablePath: string,
    env: Record<string, string>,
    portable: ResolvedPortableRuntime | undefined,
    adapter: OpenCodeLifecycleAdapter,
  ): Promise<CodingRuntimeStartResult> {
    if (portable === undefined)
      return this.recordLaunchFailure(request, failure("qualification-missing", false));
    const prepared = await prepareOpenCodeLaunch(
      adapter,
      request,
      executablePath,
      env,
      portable.verification,
    );
    if (!prepared.ok) return this.recordLaunchFailure(request, prepared);
    return await this.spawnRuntime(
      request,
      executablePath,
      prepared.env,
      portable,
      FIXED_OPENCODE_ARGS,
      adapter,
    );
  }

  private async prepareAndSpawnCodex(
    request: CodingRuntimeLaunchRequest,
    preflight: PreflightOk,
    portable: ResolvedPortableRuntime | undefined,
    adapter: CodexLifecycleAdapter,
  ): Promise<CodingRuntimeStartResult> {
    const deadline = createCodexStartupDeadline(request);
    try {
      const initiallyCancelled = deadline.failureCode();
      if (initiallyCancelled !== undefined) {
        return this.recordLaunchFailure(request, failure(initiallyCancelled, true));
      }
      const egress = qualifyCodexEgress(request, this.deps);
      if (!egress.ok) return this.recordLaunchFailure(request, egress);
      const checks = await qualifyCodexLaunch(adapter, request, deadline);
      if (!checks.ok) return this.recordLaunchFailure(request, checks);
      const stateRoot = codexStateRoot(this.deps.codexLocalSecretRoot, request);
      if (stateRoot === undefined) {
        return this.recordLaunchFailure(request, failure("runtime-state-unavailable", false));
      }
      const prepared = await prepareCodexLaunch(adapter, request, stateRoot, deadline);
      if (!prepared.ok) return this.recordLaunchFailure(request, prepared);
      const validatedStateRoot = validatePreparedCodexStateRoot(
        prepared.stateRoot,
        stateRoot,
        preflight,
      );
      if (validatedStateRoot === undefined) {
        return this.recordLaunchFailure(request, failure("runtime-state-unavailable", false));
      }
      const env = buildRuntimeEnv(request, this.deps.processEnv, validatedStateRoot, egress.value);
      if (!env.ok) return this.recordLaunchFailure(request, env);
      const cancelled = deadline.failureCode();
      if (cancelled !== undefined) {
        return this.recordLaunchFailure(request, failure(cancelled, true));
      }
      return await this.spawnCodexRuntime(
        request,
        preflight.executablePath,
        env.value,
        portable,
        adapter,
        deadline,
      );
    } finally {
      deadline.dispose();
    }
  }

  private async spawnCodexRuntime(
    request: CodingRuntimeLaunchRequest,
    executablePath: string,
    env: Record<string, string>,
    portable: ResolvedPortableRuntime | undefined,
    adapter: CodexLifecycleAdapter,
    deadline: CodexStartupDeadline,
  ): Promise<CodingRuntimeStartResult> {
    const portableAvailability = portableAvailabilityFailure(portable);
    if (portableAvailability !== undefined)
      return this.recordLaunchFailure(request, portableAvailability);
    const launched = this.deps.supervisor.spawnOwnedTree(
      supervisorLaunchRequest(request, executablePath, env, FIXED_CODEX_ARGS),
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
      undefined,
      adapter,
    );
    this.active = active;
    this.attachRuntime(active);
    return await this.attachCodexRuntime(request, active, adapter, deadline);
  }

  private async attachCodexRuntime(
    request: CodingRuntimeLaunchRequest,
    active: ActiveRuntime,
    adapter: CodexLifecycleAdapter,
    deadline: CodexStartupDeadline,
  ): Promise<CodingRuntimeStartResult> {
    const cancelled = deadline.failureCode();
    if (cancelled !== undefined) return await this.failCodexStart(request, active, cancelled);
    const attachment = await deadline.race(
      Promise.resolve().then(() =>
        adapter.attach({
          runId: request.runId,
          tree: active.tree,
          signal: deadline.signal,
          timeoutMs: request.startTimeoutMs,
        }),
      ),
    );
    if (attachment.status === "cancelled") {
      return await this.failCodexStart(request, active, attachment.failureCode);
    }
    if (attachment.status === "failed" || !attachment.value.ok) {
      return await this.failCodexStart(request, active, "protocol-schema-mismatch");
    }
    active.codexDetach = attachment.value.detach;
    if (active.stopRequested || this.active !== active) return failure("runtime-crashed", false);
    active.status = "ready";
    this.emit(runtimeEvent(active, this.nextSequence(active), "runtime-started", {}));
    return { ok: true, runId: request.runId, status: "ready" };
  }

  private async failCodexStart(
    request: CodingRuntimeLaunchRequest,
    active: ActiveRuntime,
    failureCode: CodingRuntimeFailureCode,
  ): Promise<CodingRuntimeStartResult> {
    active.stopRequested = true;
    active.status = "stopping";
    const receipt = await this.revokeAndTerminate(active);
    if (receipt === undefined || !(await this.disposeAndReleaseAfterReap(active, receipt))) {
      await this.enterRecoveryRequired(active);
      return failure("runtime-reap-unproven", false);
    }
    active.status = "stopped";
    if (this.active === active) this.active = undefined;
    return this.recordLaunchFailure(
      request,
      failure(failureCode, failureCode === "start-aborted" || failureCode === "start-timeout"),
    );
  }

  private async completeOpenCodeStart(
    request: CodingRuntimeLaunchRequest,
    active: ActiveRuntime,
    adapter: OpenCodeLifecycleAdapter,
  ): Promise<CodingRuntimeStartResult> {
    const handshakeFailure = await openCodeHandshakeFailure(adapter, request, active, (event) => {
      this.handleOpenCodePermission(active, event);
    });
    active.startupOutput?.close();
    active.startupOutput = undefined;
    active.stdoutParser = undefined;
    if (
      handshakeFailure === undefined &&
      this.active === active &&
      !active.stopRequested &&
      active.status === "starting"
    ) {
      active.status = "ready";
      this.startLifecycleMonitor(active);
      this.emit(runtimeEvent(active, this.nextSequence(active), "runtime-started", {}));
      return { ok: true, runId: request.runId, status: "ready" };
    }
    if (handshakeFailure === undefined || this.active !== active) {
      return failure("runtime-crashed", false);
    }
    active.stopRequested = true;
    active.status = "stopping";
    const receipt = await this.revokeAndTerminate(active);
    if (receipt === undefined || !(await this.disposeAndReleaseAfterReap(active, receipt))) {
      await this.enterRecoveryRequired(active);
      return failure("runtime-reap-unproven", false);
    }
    active.status = "stopped";
    this.active = undefined;
    return handshakeFailure;
  }

  private async revokeAndTerminate(active: ActiveRuntime): Promise<RuntimeReapReceipt | undefined> {
    const barrierComplete = await this.runShutdownBarrier(active);
    active.shutdownBarrierComplete = barrierComplete;
    const receipt = await this.reapTree(active);
    return barrierComplete ? receipt : undefined;
  }

  /** Every independent revocation barrier must fail closed without skipping termination. */
  private async runShutdownBarrier(active: ActiveRuntime): Promise<boolean> {
    let barrierComplete = true;
    try {
      if (!(await this.deps.revokeRuntime(active.context.runId))) barrierComplete = false;
    } catch {
      barrierComplete = false;
    }
    try {
      this.deps.approvalStore.invalidateRun(active.context.runId);
    } catch {
      barrierComplete = false;
    }
    try {
      if (!(await this.deps.abortInFlightActions(active.context.runId))) barrierComplete = false;
    } catch {
      barrierComplete = false;
    }
    if (!this.disposeLifecycleMonitor(active)) barrierComplete = false;
    if (!(await this.detachCodexProtocol(active))) barrierComplete = false;
    return barrierComplete;
  }

  private async reapTree(active: ActiveRuntime): Promise<RuntimeReapReceipt | undefined> {
    try {
      this.deps.supervisor.terminate(active.tree, "graceful");
      const exit = await this.deps.supervisor.waitForCompleteTreeExit(
        active.tree,
        active.shutdownTimeoutMs,
      );
      if (exit.status === "reaped") return exit.receipt;
      return await this.forceReap(active);
    } catch {
      try {
        return await this.forceReap(active);
      } catch {
        // The caller moves the run to recovery-required when reap cannot be proven.
        return undefined;
      }
    }
  }

  private async forceReap(active: ActiveRuntime): Promise<RuntimeReapReceipt | undefined> {
    this.deps.supervisor.terminate(active.tree, "force");
    const exit = await this.deps.supervisor.waitForCompleteTreeExit(
      active.tree,
      active.shutdownTimeoutMs,
    );
    return exit.status === "reaped" ? exit.receipt : undefined;
  }

  private attachRuntime(active: ActiveRuntime): void {
    active.tree.onTreeExit((code) => {
      this.handleExit(active, code);
    });
    if (active.codexLifecycleAdapter === undefined) {
      active.stdoutParser = createCodingRuntimeLineParser({
        onLine: (line) => {
          this.handleStdoutLine(active, line);
        },
      });
      active.tree.stdout.on("data", (chunk) => {
        this.handleStdout(active, Buffer.isBuffer(chunk) ? chunk : String(chunk));
      });
    }
    active.stderrDrainer = createCodingRuntimeStderrDrainer({
      onSummary: (summary) => {
        emitRuntimeStderrSummary(
          this.deps.diagnostics,
          active.context.runId,
          summary,
          this.deps.now,
        );
      },
    });
    active.tree.stderr.on("data", (chunk) => {
      active.stderrDrainer?.push(Buffer.isBuffer(chunk) ? chunk : String(chunk));
    });
  }

  private handleExit(active: ActiveRuntime, code: number | null): void {
    if (this.active !== active || active.stopRequested || active.status === "stopped") return;
    active.stopRequested = true;
    active.status = "stopping";
    active.startupOutput?.close();
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
    if (!(await this.disposeAndReleaseAfterReap(active, receipt))) {
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

  private async disposeAndReleaseAfterReap(
    active: ActiveRuntime,
    receipt: RuntimeReapReceipt,
  ): Promise<boolean> {
    try {
      if (
        active.openCodeLifecycleAdapter?.dispose !== undefined &&
        !(await active.openCodeLifecycleAdapter.dispose(active.context.runId))
      ) {
        return false;
      }
      if (
        active.codexLifecycleAdapter !== undefined &&
        !(await boundedLifecycleDisposal(
          (): boolean | Promise<boolean> =>
            active.codexLifecycleAdapter?.dispose(active.context.runId) ?? false,
          active.shutdownTimeoutMs,
        ))
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return this.releaseAfterReap(active, receipt);
  }

  private startLifecycleMonitor(active: ActiveRuntime): void {
    const monitor = active.openCodeLifecycleAdapter?.monitor;
    if (monitor === undefined) return;
    try {
      active.lifecycleMonitorDispose = monitor({
        runId: active.context.runId,
        onFailure: (): void => {
          if (this.active !== active || active.stopRequested || active.status !== "ready") return;
          this.emit(
            runtimeEvent(active, this.nextSequence(active), "failure-redacted", {
              failureCode: "failure-redacted",
              failureSummary: "runtime-event-failed",
              retryable: false,
            }),
          );
          void this.stop(active.context.runId).catch(() => {
            if (this.active === active) void this.enterRecoveryRequired(active);
          });
        },
      });
    } catch {
      if (this.active === active && !active.stopRequested && active.status === "ready") {
        void this.stop(active.context.runId).catch(() => {
          if (this.active === active) void this.enterRecoveryRequired(active);
        });
      }
    }
  }

  private disposeLifecycleMonitor(active: ActiveRuntime): boolean {
    const dispose = active.lifecycleMonitorDispose;
    active.lifecycleMonitorDispose = undefined;
    if (dispose === undefined) return true;
    try {
      dispose();
      return true;
    } catch {
      return false;
    }
  }

  private async detachCodexProtocol(active: ActiveRuntime): Promise<boolean> {
    const detach = active.codexDetach;
    active.codexDetach = undefined;
    if (detach === undefined) return true;
    try {
      return await detach();
    } catch {
      return false;
    }
  }

  private handleStdout(active: ActiveRuntime, chunk: Buffer | string): void {
    if (active.stopRequested) {
      active.stdoutParser = undefined;
      return;
    }
    if (active.openCodeLifecycleAdapter !== undefined && active.startupOutput === undefined) return;
    const result = active.stdoutParser?.push(chunk);
    if (result?.ok === false) {
      active.stdoutParser = undefined;
      if (active.openCodeLifecycleAdapter === undefined) this.emitFailure(active);
      else active.startupOutput?.close();
    }
  }

  private handleStdoutLine(active: ActiveRuntime, line: string): void {
    active.startupOutput?.offer(`${line}\n`);
    if (active.openCodeLifecycleAdapter !== undefined) return;
    const event = normalizeSidecarLine(active, this.nextSequence(active), line.trim());
    if (event !== undefined) this.emit(event);
  }

  private handleOpenCodePermission(active: ActiveRuntime, event: SidecarPermissionEvent): void {
    if (this.active !== active || active.stopRequested || active.status !== "ready") return;
    this.emit(sidecarRuntimeEvent(active, this.nextSequence(active), event));
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

function emitRuntimeStderrSummary(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  summary: CodingRuntimeStderrSummary,
  now: () => number,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date(now()).toISOString(),
    operation: "coding-runtime.stderr",
    source: "coding-runtime-manager.stderr",
    errorClass: "RuntimeStderrSummary",
    message: `runtime-stderr-counts:bytes=${String(summary.bytes)}:lines=${String(summary.lines)}:truncated=${String(summary.truncated)}`,
  });
}

function resolvePortableRuntime(
  request: CodingRuntimeLaunchRequest,
  deps: Pick<NormalizedCodingRuntimeManagerDeps, "portableRuntimeResolver">,
): { readonly ok: true; readonly value: ResolvedPortableRuntime | undefined } | FailureResult {
  if (request.runtimeSource === "codex-cli-adapter") return { ok: true, value: undefined };
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
  if (resolved.admission === "functional-dev-lane") {
    return devLaneLaunchAvailabilityFailure(resolved.verification, disk);
  }
  const availability = evaluatePortableSidecarAvailability(resolved.verification, {
    target: resolved.target,
    ...disk,
  });
  return availability.available ? undefined : failure(availability.reason, false);
}

/**
 * Launch gate for dev-lane-admitted records: every disk fact is recomputed (the discovery-to-
 * launch tamper window stays fail-closed) and every stored check the lane's admission actually
 * performs is re-asserted. Signature and supervisor qualification are out of that admission
 * domain — they stay honestly unverified in the record and are never consulted here.
 */
function devLaneLaunchAvailabilityFailure(
  verification: PortableSidecarRuntimeVerification,
  disk: PortableSidecarDiskEvidence,
): FailureResult | undefined {
  if (!verification.availability.redistributionApproved) {
    return failure("redistribution-unapproved", false);
  }
  if (!disk.payloadPresent) return failure("payload-missing", false);
  if (!disk.archiveDigestVerified) return failure("archive-digest-mismatch", false);
  if (!disk.executableTreeDigestVerified) {
    return failure("executable-tree-digest-mismatch", false);
  }
  if (!verification.availability.runtimeVersionVerified) {
    return failure("runtime-version-mismatch", false);
  }
  if (!verification.availability.protocolSchemaVerified) {
    return failure("protocol-schema-mismatch", false);
  }
  return undefined;
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

type OpenCodeHandshakeOutcome = "aborted" | "failed" | "ok" | "timeout";

type CodexStartupCancellationCode = "start-aborted" | "start-timeout";
type CodexStartupStep<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed" }
  | { readonly status: "cancelled"; readonly failureCode: CodexStartupCancellationCode };

interface CodexStartupDeadline {
  readonly signal: AbortSignal;
  failureCode(): CodexStartupCancellationCode | undefined;
  race<T>(promise: Promise<T>): Promise<CodexStartupStep<T>>;
  dispose(): void;
}

function createCodexStartupDeadline(request: CodingRuntimeLaunchRequest): CodexStartupDeadline {
  const controller = new AbortController();
  let cancellationCode: CodexStartupCancellationCode | undefined;
  let cancel: ((code: CodexStartupCancellationCode) => void) | undefined;
  const cancellation = new Promise<CodexStartupCancellationCode>((resolve) => {
    cancel = resolve;
  });
  const abort = (): void => {
    if (cancellationCode !== undefined) return;
    cancellationCode = "start-aborted";
    controller.abort();
    cancel?.(cancellationCode);
  };
  if (request.signal?.aborted === true) abort();
  else request.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => {
      if (cancellationCode !== undefined) return;
      cancellationCode = "start-timeout";
      controller.abort();
      cancel?.(cancellationCode);
    },
    Math.max(0, request.startTimeoutMs),
  );
  timer.unref();
  return {
    signal: controller.signal,
    failureCode: (): CodexStartupCancellationCode | undefined => cancellationCode,
    async race<T>(promise: Promise<T>): Promise<CodexStartupStep<T>> {
      const operation = promise.then(
        (value): CodexStartupStep<T> => ({ status: "ok", value }),
        (): CodexStartupStep<T> => ({ status: "failed" }),
      );
      const cancelled = cancellation.then((failureCode): CodexStartupStep<T> => ({
        status: "cancelled",
        failureCode,
      }));
      return await Promise.race([operation, cancelled]);
    },
    dispose(): void {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      cancel = undefined;
    },
  };
}

async function qualifyCodexLaunch(
  adapter: CodexLifecycleAdapter,
  request: CodingRuntimeLaunchRequest,
  deadline: CodexStartupDeadline,
): Promise<{ readonly ok: true } | FailureResult> {
  const input = {
    runId: request.runId,
    signal: deadline.signal,
    timeoutMs: request.startTimeoutMs,
  };
  const qualification = await codexCheck(() => adapter.qualify(input), deadline);
  if (!qualification.ok) return qualification;
  return await codexCheck(() => adapter.inspectProfile(input), deadline);
}

async function codexCheck(
  check: () => Promise<CodexLifecycleCheckResult>,
  deadline: CodexStartupDeadline,
): Promise<{ readonly ok: true } | FailureResult> {
  const cancelled = deadline.failureCode();
  if (cancelled !== undefined) return failure(cancelled, true);
  const outcome = await deadline.race(Promise.resolve().then(check));
  if (outcome.status === "cancelled") return failure(outcome.failureCode, true);
  return outcome.status === "ok" && outcome.value.ok
    ? { ok: true }
    : failure("redistribution-unapproved", false);
}

async function boundedLifecycleDisposal(
  dispose: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(false);
      },
      Math.max(0, timeoutMs),
    );
    timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve().then(dispose), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function prepareCodexLaunch(
  adapter: CodexLifecycleAdapter,
  request: CodingRuntimeLaunchRequest,
  stateRoot: string,
  deadline: CodexStartupDeadline,
): Promise<{ readonly ok: true; readonly stateRoot: string } | FailureResult> {
  const outcome = await deadline.race(
    Promise.resolve().then(() =>
      adapter.prepare({
        runId: request.runId,
        signal: deadline.signal,
        timeoutMs: request.startTimeoutMs,
        stateRoot,
      }),
    ),
  );
  if (outcome.status === "cancelled") return failure(outcome.failureCode, true);
  if (outcome.status === "failed" || !outcome.value.ok) {
    return failure("protocol-schema-mismatch", false);
  }
  return outcome.value;
}

async function prepareOpenCodeLaunch(
  adapter: OpenCodeLifecycleAdapter,
  request: CodingRuntimeLaunchRequest,
  executablePath: string,
  env: Record<string, string>,
  verification: PortableSidecarRuntimeVerification,
): Promise<{ readonly ok: true; readonly env: Record<string, string> } | FailureResult> {
  if (adapter.prepare === undefined) return { ok: true, env };
  try {
    const result = await adapter.prepare({
      runId: request.runId,
      executablePath,
      env,
      verification,
      signal: request.signal,
      timeoutMs: request.startTimeoutMs,
    });
    if (!result.ok) return failure("protocol-schema-mismatch", false);
    return { ok: true, env: mergePreparedOpenCodeEnv(env, result.env) };
  } catch {
    return failure(request.signal?.aborted === true ? "start-aborted" : "start-timeout", true);
  }
}

function mergePreparedOpenCodeEnv(
  managerEnv: Readonly<Record<string, string>>,
  preparedEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const merged = { ...managerEnv, ...preparedEnv };
  for (const [name, value] of Object.entries(managerEnv)) {
    if (
      name.startsWith("KEIKO_CODING_") ||
      name === "KEIKO_MODEL_GATEWAY_URL" ||
      name === "KEIKO_MODEL_PROFILE_ID"
    ) {
      merged[name] = value;
    }
  }
  return merged;
}

async function openCodeHandshakeFailure(
  adapter: OpenCodeLifecycleAdapter,
  request: CodingRuntimeLaunchRequest,
  active: ActiveRuntime,
  onPermission: (event: SidecarPermissionEvent) => void,
): Promise<FailureResult | undefined> {
  const controller = new AbortController();
  let resolveCancellation: ((outcome: OpenCodeHandshakeOutcome) => void) | undefined;
  const cancellation = new Promise<OpenCodeHandshakeOutcome>((resolve) => {
    resolveCancellation = resolve;
  });
  const abort = (): void => {
    controller.abort();
    resolveCancellation?.("aborted");
  };
  if (request.signal?.aborted === true) abort();
  else request.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    resolveCancellation?.("timeout");
  }, request.startTimeoutMs);
  timer.unref();
  const handshake = Promise.resolve()
    .then(() =>
      adapter.handshake({
        runId: request.runId,
        startupOutput: active.startupOutput ?? closedStartupOutput,
        onPermission,
        signal: controller.signal,
        timeoutMs: request.startTimeoutMs,
      }),
    )
    .then(
      (result): OpenCodeHandshakeOutcome => (result.ok ? "ok" : "failed"),
      (): OpenCodeHandshakeOutcome => "failed",
    );
  try {
    const outcome = await Promise.race([handshake, cancellation]);
    if (outcome === "ok") return undefined;
    if (outcome === "aborted") return failure("start-aborted", true);
    if (outcome === "timeout") return failure("start-timeout", true);
    return failure("protocol-schema-mismatch", false);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    resolveCancellation = undefined;
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
  openCodeLifecycleAdapter: OpenCodeLifecycleAdapter | undefined,
  codexLifecycleAdapter?: CodexLifecycleAdapter,
): ActiveRuntime {
  return {
    context: eventContext(request),
    tree,
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    approvalStore,
    nowMs,
    nowIso,
    openCodeLifecycleAdapter,
    codexLifecycleAdapter,
    startupOutput:
      openCodeLifecycleAdapter === undefined ? undefined : createOpenCodeStartupMailbox(),
    lifecycleMonitorDispose: undefined,
    codexDetach: undefined,
    stdoutParser: undefined,
    stderrDrainer: undefined,
    pendingApprovalReview: undefined,
    shutdownBarrierComplete: false,
    stopRequested: false,
    paused: false,
    status: "starting",
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
    openCodeLifecycleAdapter: undefined,
    codexLifecycleAdapter: undefined,
    startupOutput: undefined,
    lifecycleMonitorDispose: undefined,
    codexDetach: undefined,
    stdoutParser: undefined,
    stderrDrainer: undefined,
    pendingApprovalReview: undefined,
    shutdownBarrierComplete: false,
    stopRequested: false,
    paused: false,
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

const closedStartupOutput: OpenCodeStartupOutput = {
  nextLine: () => Promise.reject(new Error("runtime-startup-output-closed")),
};

function createOpenCodeStartupMailbox(): OpenCodeStartupMailbox {
  let retained: string | undefined;
  let waiter: ((line: string) => void) | undefined;
  let rejectWaiter: ((error: Error) => void) | undefined;
  let closed = false;
  return {
    nextLine(signal): Promise<string> {
      if (retained !== undefined) {
        const line = retained;
        retained = undefined;
        return Promise.resolve(line);
      }
      if (closed || signal?.aborted === true) {
        return Promise.reject(new Error("runtime-startup-output-closed"));
      }
      return new Promise<string>((resolve, reject) => {
        waiter = resolve;
        rejectWaiter = reject;
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("runtime-startup-output-aborted"));
          },
          { once: true },
        );
      });
    },
    offer(line): void {
      if (closed || retained !== undefined) return;
      if (waiter !== undefined) {
        const resolve = waiter;
        waiter = undefined;
        rejectWaiter = undefined;
        resolve(line);
        return;
      }
      retained = line;
    },
    close(): void {
      closed = true;
      retained = undefined;
      rejectWaiter?.(new Error("runtime-startup-output-closed"));
      waiter = undefined;
      rejectWaiter = undefined;
    },
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
  return { ok: true, executablePath, managedRoot, workspaceRoot };
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
  codexStateRoot?: string,
  codexEgress?: ReviewedCodexEgressPolicy,
): { readonly ok: true; readonly value: Record<string, string> } | FailureResult {
  if (request.inheritedEnvAllowlist.some((name) => SECRET_ENV_NAME.test(name))) {
    return failure("env-secret-denied", false);
  }
  if (!isLoopbackUrl(request.gatewayUrl)) return failure("gateway-non-loopback", false);
  const env: Record<string, string> = {
    ...buildSandboxEnv(processEnv, request.inheritedEnvAllowlist),
    ...runtimeProjectionEnv(request),
  };
  if (request.adapterKind === "codex-cli") {
    if (codexStateRoot === undefined || codexEgress === undefined) {
      return failure("runtime-state-unavailable", false);
    }
    for (const name of GLOBAL_RUNTIME_ENV_NAMES) Reflect.deleteProperty(env, name);
    for (const name of INHERITED_EGRESS_ENV_NAMES) Reflect.deleteProperty(env, name);
    Object.assign(env, isolatedCodexRuntimeEnv(codexStateRoot), codexEgressEnv(codexEgress));
  }
  return envContainsDeniedSecret(env, processEnv, request.inheritedEnvAllowlist)
    ? failure("env-secret-denied", false)
    : { ok: true, value: env };
}

function isolatedCodexRuntimeEnv(stateRoot: string): Record<string, string> {
  const home = join(stateRoot, "home");
  const temporary = join(stateRoot, "tmp");
  return {
    CODEX_HOME: join(stateRoot, "codex-home"),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(stateRoot, "xdg-config"),
    XDG_DATA_HOME: join(stateRoot, "xdg-data"),
    XDG_CACHE_HOME: join(stateRoot, "xdg-cache"),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
  };
}

function codexStateRoot(
  localSecretRoot: string | undefined,
  request: CodingRuntimeLaunchRequest,
): string | undefined {
  const root = localSecretRoot === undefined ? undefined : realPath(localSecretRoot);
  if (root === undefined) return undefined;
  const identity = createHash("sha256")
    .update(request.runId)
    .update("\0")
    .update(request.treeBindingId)
    .digest("hex");
  return join(root, CODEX_STATE_DIRECTORY, identity);
}

function validatePreparedCodexStateRoot(
  preparedStateRoot: string,
  expectedStateRoot: string,
  preflight: PreflightOk,
): string | undefined {
  const prepared = realPath(preparedStateRoot);
  const expectedParent = realPath(dirname(expectedStateRoot));
  if (
    prepared === undefined ||
    expectedParent === undefined ||
    dirname(prepared) !== expectedParent ||
    basename(prepared) !== basename(expectedStateRoot)
  ) {
    return undefined;
  }
  if (
    pathInside(preflight.managedRoot, prepared) ||
    pathInside(preflight.workspaceRoot, prepared)
  ) {
    return undefined;
  }
  return prepared;
}

function qualifyCodexEgress(
  request: CodingRuntimeLaunchRequest,
  deps: Pick<NormalizedCodingRuntimeManagerDeps, "qualifyCodexEgress">,
): { readonly ok: true; readonly value: ReviewedCodexEgressPolicy } | FailureResult {
  try {
    const policy = deps.qualifyCodexEgress?.(request);
    return policy !== undefined && validCodexEgressPolicy(policy)
      ? { ok: true, value: policy }
      : failure("egress-unqualified", false);
  } catch {
    return failure("egress-unqualified", false);
  }
}

function validCodexEgressPolicy(policy: ReviewedCodexEgressPolicy): boolean {
  return (
    policy.verified &&
    policy.receipt.length > 0 &&
    validDirectEgress((policy as { readonly directEgress: unknown }).directEgress) &&
    validCodexProxyPolicy(policy) &&
    validCodexNoProxyPolicy(policy) &&
    validCodexCaPolicy(policy)
  );
}

function validDirectEgress(value: unknown): value is ReviewedCodexEgressPolicy["directEgress"] {
  return value === "disabled" || value === "approved";
}

function validCodexProxyPolicy(policy: ReviewedCodexEgressPolicy): boolean {
  return policy.httpsProxy === undefined || validHttpsProxy(policy.httpsProxy) !== undefined;
}

function validCodexNoProxyPolicy(policy: ReviewedCodexEgressPolicy): boolean {
  if (policy.noProxy === undefined) return true;
  return policy.directEgress === "approved" && validNoProxy(policy.noProxy);
}

function validCodexCaPolicy(policy: ReviewedCodexEgressPolicy): boolean {
  return policy.caBundlePath === undefined
    ? policy.serverConfigRoot === undefined
    : validCaBundlePath(policy.caBundlePath, policy.serverConfigRoot);
}

function validHttpsProxy(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function validNoProxy(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/u.test(value);
}

function validCaBundlePath(path: string, configRoot: string | undefined): boolean {
  const root = configRoot === undefined ? undefined : realPath(configRoot);
  const bundle = realPath(path);
  if (root === undefined || bundle === undefined || !pathInside(root, bundle)) return false;
  try {
    accessSync(bundle, constants.R_OK);
    return statSync(bundle).isFile();
  } catch {
    return false;
  }
}

function codexEgressEnv(policy: ReviewedCodexEgressPolicy): Record<string, string> {
  const proxy = policy.httpsProxy === undefined ? {} : { HTTPS_PROXY: policy.httpsProxy };
  const noProxy = policy.noProxy === undefined ? {} : { NO_PROXY: policy.noProxy };
  const ca = policy.caBundlePath === undefined ? {} : { SSL_CERT_FILE: policy.caBundlePath };
  return { ...proxy, ...noProxy, ...ca };
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
  args: readonly string[],
): Parameters<RuntimeProcessSupervisor["spawnOwnedTree"]>[0] {
  return {
    runId: request.runId,
    recoveryHandle: request.recoveryHandle ?? request.treeBindingId.slice(0, 32),
    treeBindingId: request.treeBindingId,
    executable,
    args,
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
  active.pendingApprovalReview = approvalReviewFacts(event);
  return runtimeEvent(active, sequence, "permission-requested", {
    permissionRequest: request,
  });
}

/**
 * Projects the reviewable changeset facts of a governed `file-edit` ask (#2853). The admission
 * projection has already fail-closed on every escaping, duplicated or oversized path shape, and the
 * shared public contract re-validates here: a review is retained only when the whole payload is
 * admissible, so an operator surface can never render a path the runtime itself would refuse.
 *
 * Deliberately NOT attached to the runtime event: the paths are model-selected content and ride
 * only the authenticated app-session channel, never a snapshot, the SSE projection, or evidence
 * (#2644). Only the path, the file count and the line counts travel — never a byte of the patch.
 */
function approvalReviewFacts(
  event: SidecarPermissionEvent,
): CodingWorkbenchRuntimePendingApprovalReview | undefined {
  if (event.actionKind !== "file-edit") return undefined;
  const declared = event.allowedRelativePaths ?? [];
  const paths = declared.slice(0, CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS);
  const pending: CodingWorkbenchRuntimePendingApprovalReview = {
    requestId: event.requestId,
    paths,
    pathsTruncated: paths.length < declared.length,
    fileCount: event.fileCount ?? declared.length,
    addedLines: event.addedLines ?? 0,
    deletedLines: event.deletedLines ?? 0,
  };
  return validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending,
  }).ok
    ? pending
    : undefined;
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

/**
 * Reachability, stated plainly so this is not mistaken for the live containment gate: the bundled
 * OpenCode child asks for a governed permission ONLY when `KEIKO_CODING_MODE === "governed-assist"`
 * (the generated tool source in opencodeRuntimeAdapter returns early otherwise). For that runtime
 * this whole `supervised-coding` branch — including `decideSupervisedFileEdit`'s realpath
 * containment — is therefore not on the edit path; it stays live for sidecar-stream runtimes that
 * do announce supervised asks. Workspace containment for the OpenCode edit path is enforced by the
 * tool-IPC parse boundary (`codingToolIpc`, pinned in codingToolIpc.test.ts) and by the
 * `keiko-tools` contained writer at the effect edge — not here.
 */
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
): SupervisedCodingApprovalBindingOnce {
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
): SupervisedCodingApprovalBindingOnce {
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
}): SupervisedCodingApprovalBindingOnce {
  const connectorScopes = normalizedConnectorScopes(input.connectorScopes);
  const scopeDigest = supervisedCodingApprovalScopeDigest({ ...input, connectorScopes });
  return {
    grantScope: "once",
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
  return [...new Set(scopes ?? [])].sort((left, right) => left.localeCompare(right));
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
