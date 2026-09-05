import { draftPendingApprovalReview } from "./productionDraftDeliveryRuntime.js";
import { createHash } from "node:crypto";
import { isDenied, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";

import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  decideCodingWorkbenchActionForMode,
  isCodingWorkbenchModeWidening,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchPermissionRequest,
  CodingWorkbenchPolicyResourceScope,
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
import { inspectStagedSidecarPayload } from "../update-portable-sidecar-staging-verification.js";
import {
  decideSupervisedFileEdit,
  decideSupervisedMutation,
  decideSupervisedVerificationCommand,
  resolveEditTargetRealPath,
  type SupervisedCodingDecision,
  type SupervisedCodingFileEditRequest,
} from "./supervisedCodingPolicy.js";
import {
  createInMemorySupervisedCodingApprovalStore,
  supervisedCodingApprovalScopeDigest,
  supervisedCodingTaskScopeDigest,
  type SupervisedCodingApprovalBinding,
  type SupervisedCodingApprovalBindingOnce,
  type SupervisedCodingApprovalBindingTask,
  type SupervisedCodingApprovalClaim,
  type SupervisedCodingApprovalStore,
  type SupervisedCodingConsumedApproval,
  type SupervisedCodingIssuedApproval,
} from "./supervisedCodingApprovalStore.js";
import {
  parseCodingSidecarEventLine,
  type SidecarHealthEvent,
  type SidecarPermissionEvent,
} from "./codingSidecarEventParser.js";
import type { CodingToolApprovalBridge } from "./codingToolApprovalBridge.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
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
  createCodingRuntimeProcessSummaryAccumulator,
  createCodingRuntimeStderrDrainer,
  type CodingRuntimeLineParser,
  type CodingRuntimeProcessSummary,
  type CodingRuntimeProcessSummaryAccumulator,
  type CodingRuntimeStderrDrainer,
  type CodingRuntimeStderrSummary,
} from "./codingRuntimeProcessIo.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";

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
  | "start-timeout"
  // The admitted managed workspace root no longer re-proves at the spawn boundary (#3347 owner P1).
  | "workspace-root-denied";

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

export interface CodingRuntimeRunResult {
  readonly status: "cancelled" | "failed" | "signalled" | "succeeded";
  readonly exitCode: number | null;
  readonly output: CodingRuntimeProcessSummary;
  readonly error: CodingRuntimeProcessSummary;
}

export type CodingRuntimePauseResult =
  | {
      readonly ok: true;
      readonly paused: boolean;
      readonly effectiveMode?: CodingWorkbenchMode | undefined;
    }
  | {
      readonly ok: false;
      readonly failureCode:
        | "authority-expired"
        | "authority-resolution-failed"
        | "runtime-run-mismatch"
        | "runtime-stopped";
      readonly retryable: false;
    };

export interface CodingRuntimeApprovalIssueRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly approvedByUserId: string;
  readonly ttlMs?: number | undefined;
  /** A reusable grant is limited to routine contained edits and verification commands. */
  readonly grantScope?: "once" | "task" | undefined;
  /** Stable server-approved command identity for a reusable verification grant. */
  readonly commandTemplateId?: string | undefined;
  /** Server-classified argument shapes for a reusable verification grant. */
  readonly safeArgumentClasses?: readonly string[] | undefined;
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
      readonly failureCode:
        "approval-activation-failed" | "runtime-run-mismatch" | "runtime-stopped";
      readonly retryable: false;
    };

export interface CodingRuntimeManagerDeps {
  readonly supervisor?: RuntimeProcessSupervisor | undefined;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly now?: (() => number) | undefined;
  readonly nowIso?: (() => string) | undefined;
  readonly approvalStore?: SupervisedCodingApprovalStore | undefined;
  readonly codingToolApprovals?: CodingToolApprovalBridge | undefined;
  readonly onRuntimeEvent?: ((event: CodingWorkbenchRuntimeEvent) => void) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly openCodeLifecycleAdapter?: OpenCodeLifecycleAdapter | undefined;
  readonly codexLifecycleAdapter?: CodexLifecycleAdapter | undefined;
  /** Existing, server-owned local-secret root; Codex state is derived beneath it per run. */
  readonly codexLocalSecretRoot?: string | undefined;
  readonly resolveWorkspaceRootAccess?: (() => WorkspaceRootAccess | undefined) | undefined;
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
 *
 * As of 2026-08-28, no production implementation of this interface is wired into
 * `deps.ts` (`grep -c codexLifecycleAdapter` returns 0). A composition-level
 * factory already exists — `createCodexRuntimeComposition` in
 * `codexRuntimeComposition.ts` builds a full `CodexLifecycleAdapter` and is
 * unit-tested — but nothing constructs it in production: there is no Codex
 * counterpart to `productionOpenCodeBackend.ts` calling
 * `createOpenCodeRuntimeComposition`, nor to `resolveProductionOpenCodeActivation`
 * wired into `deps.ts` for OpenCode. This is intentional: Codex subscription
 * activation is deferred for this release per
 * `docs/adr/ADR-0163-self-contained-release-qualified-coding-runtime.md` D6, and
 * `startAfterPreflight` correctly fails closed with `"redistribution-unapproved"`
 * when `codexLifecycleAdapter` is undefined. This interface and
 * `codexRuntimeComposition.ts` (which has no production importer) are a
 * deliberate composition seam, not dead code — do not delete either. Before
 * Codex activation ever ships, see #3316 (KEIKO-0602, KEIKO-0671) for the
 * production wiring and `prepare()` sandbox/approval-policy prerequisites.
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
  readonly codingToolApprovals: CodingToolApprovalBridge | undefined;
  readonly onRuntimeEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly openCodeLifecycleAdapter: OpenCodeLifecycleAdapter | undefined;
  readonly codexLifecycleAdapter: CodexLifecycleAdapter | undefined;
  readonly codexLocalSecretRoot: string | undefined;
  readonly resolveWorkspaceRootAccess: (() => WorkspaceRootAccess | undefined) | undefined;
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

type CodingRuntimeTerminalStatus = Extract<
  CodingRuntimeRunResult["status"],
  "cancelled" | "failed" | "succeeded"
>;

function mostSevereTerminalStatus(
  current: CodingRuntimeTerminalStatus,
  requested: CodingRuntimeTerminalStatus,
): CodingRuntimeTerminalStatus {
  if (current === "failed" || requested === "failed") return "failed";
  if (current === "cancelled" || requested === "cancelled") return "cancelled";
  return "succeeded";
}

// #3099 R8 P2 (+ R9 S3358 refactor): merges an exit-derived status with the client's requested
// terminal status so an explicit client "failed" folded onto a crash teardown remains
// authoritative. "signalled" (code=null) stays "signalled" unless the client requested "failed"
// — cancelled is not more severe than a real signal exit.
function mergedExitStatus(
  exitStatus: CodingRuntimeRunResult["status"],
  requested: CodingRuntimeTerminalStatus,
): CodingRuntimeRunResult["status"] {
  if (exitStatus !== "signalled") return mostSevereTerminalStatus(exitStatus, requested);
  return requested === "failed" ? "failed" : "signalled";
}

export interface CodingRuntimeManager {
  start(
    request: CodingRuntimeLaunchRequest,
  ): CodingRuntimeStartResult | Promise<CodingRuntimeStartResult>;
  issueApproval(request: CodingRuntimeApprovalIssueRequest): CodingRuntimeApprovalIssueResult;
  pause(runId: string): CodingRuntimePauseResult;
  resume(runId: string, requestedMode?: CodingWorkbenchMode): CodingRuntimePauseResult;
  stop(runId: string, resultStatus?: CodingRuntimeTerminalStatus): Promise<CodingRuntimeStopResult>;
  takeover(runId: string): Promise<CodingRuntimeStopResult>;
  reconcile(runId: string): Promise<CodingRuntimeStopResult>;
  health(): CodingRuntimeHealthReport;
  /**
   * The reviewable changeset facts of the ask the operator is deciding about (#2802). Bound to both
   * the active run and the exact pending request id, so a stale panel or a foreign run can never
   * read a review, and it is served only over the authenticated app-session channel.
   */
  pendingApprovalReview(
    runId: string,
    requestId: string,
  ): CodingWorkbenchRuntimePendingApprovalReview | undefined;
  result(runId: string): CodingRuntimeRunResult | undefined;
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
  effectiveMode: CodingWorkbenchMode;
  readonly tree: RuntimeProcessTree;
  readonly shutdownTimeoutMs: number;
  readonly approvalStore: SupervisedCodingApprovalStore;
  readonly issuedTaskApprovalMetadata: Map<string, IssuedTaskApprovalMetadata>;
  readonly codingToolApprovals: CodingToolApprovalBridge | undefined;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  readonly resolveWorkspaceRootAccess: (() => WorkspaceRootAccess | undefined) | undefined;
  readonly openCodeLifecycleAdapter: OpenCodeLifecycleAdapter | undefined;
  readonly codexLifecycleAdapter: CodexLifecycleAdapter | undefined;
  startupOutput: OpenCodeStartupMailbox | undefined;
  lifecycleMonitorDispose: (() => void) | undefined;
  codexDetach: (() => boolean | Promise<boolean>) | undefined;
  stdoutParser: CodingRuntimeLineParser | undefined;
  stderrDrainer: CodingRuntimeStderrDrainer | undefined;
  readonly outputSummary: CodingRuntimeProcessSummaryAccumulator;
  readonly errorSummary: CodingRuntimeProcessSummaryAccumulator;
  streamDrainComplete: Promise<boolean>;
  /**
   * The reviewable changeset facts of the ask currently awaiting an operator decision (#2802).
   * Transient and run-local: it never enters a runtime event, a snapshot, the SSE projection or
   * evidence, because the paths are model-selected content (#2644).
   */
  pendingApprovalReview: CodingWorkbenchRuntimePendingApprovalReview | undefined;
  shutdownBarrierComplete: boolean;
  stopPromise: Promise<CodingRuntimeStopResult> | undefined;
  stopResultStatus: CodingRuntimeTerminalStatus;
  stopRequested: boolean;
  /**
   * Set synchronously by the FIRST teardown initiator (stop/takeover/reconcile OR handleExit) so
   * a concurrent second caller short-circuits instead of firing revokeAndTerminate / reapTree
   * a second time on the same ActiveRuntime. `stopPromise` alone dedupes only stop-vs-stop; a
   * crash-initiated teardown (handleExit → finalizeUnexpectedExit) previously did not set it,
   * so a client stop() racing an in-flight crash reap could enter the supervisor concurrently.
   * KEIKO-0402.
   */
  tearingDown: boolean;
  /**
   * Dedicated in-flight-reconcile promise. #3099 R4 P1: `tearingDown` alone cannot serialize
   * reconcile-vs-reconcile in the recovery-required state (both callers must be admitted, but
   * both must NOT enter `supervisor.reconcile` on the same tree). Both callers await this
   * shared promise instead of racing.
   */
  reconcilePromise: Promise<CodingRuntimeStopResult> | undefined;
  paused: boolean;
  status: CodingRuntimeStatus;
  sequence: number;
}

interface IssuedTaskApprovalMetadata {
  readonly commandTemplateId: string;
  readonly safeArgumentClasses: readonly string[];
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
type PortableRuntimeAdmissionPolicy =
  "release-qualified" | "functional-dev-lane" | "functional-evaluation-lane";

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

interface OpenCodeStartupWaiter {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
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
    codingToolApprovals: deps.codingToolApprovals,
    onRuntimeEvent: deps.onRuntimeEvent ?? ((): void => undefined),
    diagnostics: deps.diagnostics,
    openCodeLifecycleAdapter: deps.openCodeLifecycleAdapter,
    codexLifecycleAdapter: deps.codexLifecycleAdapter,
    codexLocalSecretRoot: deps.codexLocalSecretRoot,
    resolveWorkspaceRootAccess: deps.resolveWorkspaceRootAccess,
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
  private lastResult:
    { readonly runId: string; readonly result: CodingRuntimeRunResult } | undefined;

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

  public stop(
    runId: string,
    resultStatus: CodingRuntimeTerminalStatus = "cancelled",
  ): Promise<CodingRuntimeStopResult> {
    const active = this.active;
    if (active === undefined) return Promise.resolve({ ok: true, status: "stopped" });
    if (active.context.runId !== runId) {
      return Promise.resolve({
        ok: false,
        failureCode: "runtime-run-mismatch",
        retryable: false,
      });
    }
    active.stopResultStatus = mostSevereTerminalStatus(active.stopResultStatus, resultStatus);
    // KEIKO-0402 (and #3099 P1 follow-up): both stop() and handleExit() write `stopPromise`
    // exactly once, so the second entry point AWAITS the real teardown result instead of
    // synthesizing a success while the crash-triggered `finalizeUnexpectedExit` is still trying
    // to reap the process tree. Without this, the orchestrator's caller received `ok:true` while
    // the tree could still fail its reap, clearing the active slot and admitting a new runtime
    // over a live one.
    if (active.stopPromise !== undefined) return active.stopPromise;
    active.tearingDown = true;
    const stopping = this.stopActive(active);
    active.stopPromise = stopping;
    return stopping;
  }

  private async stopActive(active: ActiveRuntime): Promise<CodingRuntimeStopResult> {
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
    this.captureResult(active, active.stopResultStatus, null);
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

  public resume(runId: string, requestedMode?: CodingWorkbenchMode): CodingRuntimePauseResult {
    const active = this.active;
    if (active?.context.runId !== runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    // Regression: KEIKO-0386. A resume racing an in-flight crash/handleExit teardown reported
    // ok:true with paused:false while `active.status` was already "stopping" and `stopRequested`
    // was true — issueApproval already guards against that same race at line ~808; resume/pause
    // must apply the same guard so the operator never sees a "resumed" runtime that is halfway
    // through disposal.
    if (active.stopRequested || active.status !== "ready") {
      return { ok: false, failureCode: "runtime-stopped", retryable: false };
    }
    if (
      requestedMode !== undefined &&
      isCodingWorkbenchModeWidening(active.effectiveMode, requestedMode)
    ) {
      return { ok: false, failureCode: "authority-resolution-failed", retryable: false };
    }
    if (requestedMode !== undefined) active.effectiveMode = requestedMode;
    active.paused = false;
    return {
      ok: true,
      paused: false,
      ...(requestedMode === undefined ? {} : { effectiveMode: active.effectiveMode }),
    };
  }

  public result(runId: string): CodingRuntimeRunResult | undefined {
    return this.lastResult?.runId === runId ? this.lastResult.result : undefined;
  }

  private setPaused(runId: string, paused: boolean): CodingRuntimePauseResult {
    const active = this.active;
    if (active?.context.runId !== runId) {
      return { ok: false, failureCode: "runtime-run-mismatch", retryable: false };
    }
    // KEIKO-0386: pause() must reject a mid-teardown runtime for the same reason resume() does —
    // an ok:true pause on a stopping/stopped/recovery-required active reports state the manager
    // will never honour.
    if (active.stopRequested || active.status !== "ready") {
      return { ok: false, failureCode: "runtime-stopped", retryable: false };
    }
    active.paused = paused;
    return { ok: true, paused };
  }

  public reconcile(runId: string): Promise<CodingRuntimeStopResult> {
    const active = this.active;
    if (active === undefined) return Promise.resolve({ ok: true, status: "stopped" });
    if (active.context.runId !== runId) {
      return Promise.resolve({ ok: false, failureCode: "runtime-run-mismatch", retryable: false });
    }
    // KEIKO-0402 + #3099 R4/R6 P1: reconcile is the sanctioned second-chance path (after a
    // prior teardown returned reap-unproven). Precedence rules:
    //   1. Another reconcile is already in flight → fold onto it (per-tree serialization).
    //   2. A stop/handleExit teardown is in flight AND we are not yet recovery-required → await
    //      its REAL result (not a synthesized ok:true). The teardown may still enter
    //      recovery-required, and the operator MUST see that.
    //   3. Otherwise, start a fresh reconcile against the tree.
    if (active.reconcilePromise !== undefined) return active.reconcilePromise;
    if (active.stopPromise !== undefined && active.status !== "recovery-required") {
      return active.stopPromise;
    }
    active.tearingDown = true;
    const reconciling = this.runReconcile(active);
    active.reconcilePromise = reconciling;
    return reconciling;
  }

  private async runReconcile(active: ActiveRuntime): Promise<CodingRuntimeStopResult> {
    try {
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
    } finally {
      // Once this teardown attempt has published its result, allow a subsequent operator-driven
      // reconcile to try again if the runtime is back in recovery-required.
      active.reconcilePromise = undefined;
    }
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
    if (isOwnedGitApproval(request)) return this.issueCommitApproval(request);
    const binding = approvalBindingForIssue(active, request);
    const issued = issueSupervisedApproval(
      this.deps.approvalStore,
      binding,
      request,
      this.deps.now(),
    );
    if (issued === undefined) {
      return { ok: false, failureCode: "approval-activation-failed", retryable: false };
    }
    if (!activateIssuedToolApproval(this.deps.codingToolApprovals, request, issued)) {
      rollbackIssuedApproval(this.deps.approvalStore, binding);
      return { ok: false, failureCode: "approval-activation-failed", retryable: false };
    }
    rememberIssuedTaskApproval(active, binding, issued.approval.approvalId);
    return {
      ok: true,
      approval: issued.approval,
      approvalDigest: issued.approvalDigest,
      expiresAtMs: issued.expiresAtMs,
    };
  }

  private issueCommitApproval(
    request: CodingRuntimeApprovalIssueRequest,
  ): CodingRuntimeApprovalIssueResult {
    if (request.grantScope === "task")
      return { ok: false, failureCode: "approval-activation-failed", retryable: false };
    if (!draftApprovalKindMatches(this.deps.codingToolApprovals, request))
      return { ok: false, failureCode: "approval-activation-failed", retryable: false };
    const methods = {
      "git-stage": this.deps.codingToolApprovals?.issueStage,
      commit: this.deps.codingToolApprovals?.issueCommit,
      push: this.deps.codingToolApprovals?.issueDelivery,
      "pull-request": this.deps.codingToolApprovals?.issueDelivery,
    };
    const issuer = methods[request.actionKind as keyof typeof methods];
    const issued = issuer?.(request.runId, request.requestId);
    if (issued === undefined)
      return { ok: false, failureCode: "approval-activation-failed", retryable: false };
    return {
      ok: true,
      approval: {
        approvalId: issued.approval.approvalId,
        approvalToken: issued.approval.approvalToken,
      },
      approvalDigest: issued.approvalTokenHash,
      expiresAtMs: issued.expiresAtMs,
    };
  }

  public pendingApprovalReview(
    runId: string,
    requestId: string,
  ): CodingWorkbenchRuntimePendingApprovalReview | undefined {
    const active = this.active;
    if (active?.context.runId !== runId) return undefined;
    const git = this.gitApprovalReview(runId, requestId);
    if (git !== undefined) return git;
    const review = active.pendingApprovalReview;
    return review?.requestId === requestId ? review : undefined;
  }

  private gitApprovalReview(
    runId: string,
    requestId: string,
  ): CodingWorkbenchRuntimePendingApprovalReview | undefined {
    const commit = this.deps.codingToolApprovals?.commitService?.review(requestId);
    if (commit?.binding.runId === runId) return commit.review;
    const stage = this.deps.codingToolApprovals?.gitService?.review(requestId);
    if (stage?.runId === runId) return stage.review;
    return draftPendingApprovalReview(
      this.deps.codingToolApprovals?.deliveryService,
      runId,
      requestId,
    );
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
    const proof = proveSpawnWorkspaceRoot(
      this.deps.resolveWorkspaceRootAccess,
      request.workspaceRoot,
    );
    if (!proof.ok)
      return this.recordLaunchFailure(request, failure("workspace-root-denied", false));
    const launched = this.deps.supervisor.spawnOwnedTree(
      supervisorLaunchRequest(request, executablePath, env, args, proof.cwd),
    );
    if (!launched.ok) {
      return this.recordLaunchFailure(
        request,
        failure(launched.failureCode, launched.failureCode === "spawn-failed"),
      );
    }
    const active = createActiveRuntime(request, launched.tree, this.deps, lifecycleAdapter);
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
    const proof = proveSpawnWorkspaceRoot(
      this.deps.resolveWorkspaceRootAccess,
      request.workspaceRoot,
    );
    if (!proof.ok)
      return this.recordLaunchFailure(request, failure("workspace-root-denied", false));
    const launched = this.deps.supervisor.spawnOwnedTree(
      supervisorLaunchRequest(request, executablePath, env, FIXED_CODEX_ARGS, proof.cwd),
    );
    if (!launched.ok) {
      return this.recordLaunchFailure(
        request,
        failure(launched.failureCode, launched.failureCode === "spawn-failed"),
      );
    }
    const active = createActiveRuntime(request, launched.tree, this.deps, undefined, adapter);
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
    const handshakeFailure = await openCodeHandshakeFailure(
      adapter,
      request,
      active,
      (event) => {
        this.handleOpenCodePermission(active, event);
      },
      this.deps.diagnostics,
      this.deps.now,
    );
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
    const supervisedApprovalsInvalidated = invalidateApprovalBarrier(
      this.deps.diagnostics,
      active.context.runId,
      "supervised-approval-store",
      (runId): void => {
        this.deps.approvalStore.invalidateRun(runId);
      },
      this.deps.now,
    );
    const codingToolApprovalsInvalidated = invalidateApprovalBarrier(
      this.deps.diagnostics,
      active.context.runId,
      "coding-tool-approval-bridge",
      this.deps.codingToolApprovals === undefined
        ? undefined
        : (runId): void => {
            this.deps.codingToolApprovals?.invalidateRun(runId);
          },
      this.deps.now,
    );
    if (!supervisedApprovalsInvalidated || !codingToolApprovalsInvalidated) {
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
    }
    active.tree.stdout.on("data", (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : String(chunk);
      active.outputSummary.push(value);
      if (active.codexLifecycleAdapter === undefined) this.handleStdout(active, value);
    });
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
      const value = Buffer.isBuffer(chunk) ? chunk : String(chunk);
      active.errorSummary.push(value);
      active.stderrDrainer?.push(value);
    });
    active.streamDrainComplete = runtimeStreamDrainCompletion(
      active.tree,
      this.deps.diagnostics,
      active.context.runId,
      this.deps.now,
    );
  }

  private handleExit(active: ActiveRuntime, code: number | null): void {
    if (this.active !== active || active.stopRequested || active.status === "stopped") return;
    // KEIKO-0402: mark the teardown BEFORE any await (finalizeUnexpectedExit) so a client stop()
    // arriving in the same tick sees the flag and folds onto the same teardown result instead of
    // re-entering revokeAndTerminate on this same ActiveRuntime.
    if (active.tearingDown) return;
    active.tearingDown = true;
    active.stopRequested = true;
    active.status = "stopping";
    active.startupOutput?.close();
    // The lifecycle projection collapses the exit to a terminal run state and stderr is drained
    // count-only, so without this record the numeric exit status exists nowhere: an operator sees
    // an opaque `runtime-failed` and has nothing to diagnose it with. The code is a bounded number,
    // never content, and rides the redacted channel keyed by the run's correlation id.
    emitRuntimeExitDiagnostic(this.deps.diagnostics, active.context.runId, code, this.deps.now);
    // #3099 P1: publish the result-bearing crash teardown on `stopPromise` so a racing stop() /
    // takeover() / reconcile() awaits the REAL reap outcome — not a synthesized `{ok:true}` that
    // would let the orchestrator clear the active slot while the tree is still recovery-required
    // or reap-unproven.
    active.stopPromise = this.finalizeUnexpectedExit(active, code);
  }

  private captureResult(
    active: ActiveRuntime,
    status: CodingRuntimeRunResult["status"],
    exitCode: number | null,
  ): void {
    this.lastResult = {
      runId: active.context.runId,
      result: {
        status,
        exitCode,
        output: active.outputSummary.snapshot(),
        error: active.errorSummary.snapshot(),
      },
    };
  }

  private async finalizeUnexpectedExit(
    active: ActiveRuntime,
    code: number | null,
  ): Promise<CodingRuntimeStopResult> {
    const receipt = await this.revokeAndTerminate(active);
    if (this.active !== active) return { ok: true, status: "stopped" };
    if (receipt === undefined) {
      await this.enterRecoveryRequired(active);
      this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
    if (!(await this.disposeAndReleaseAfterReap(active, receipt))) {
      await this.enterRecoveryRequired(active);
      this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
      return { ok: false, failureCode: "runtime-reap-unproven", retryable: false };
    }
    // #3099 R8 P2: when a client stop(runId, "failed") races a crash-triggered teardown, it
    // folds onto this promise via active.stopPromise (KEIKO-0402), after having merged the
    // requested "failed" into active.stopResultStatus. An explicit client "failed" must remain
    // authoritative over the exit-derived status — otherwise a lifecycle failure racing a clean
    // exit would record the terminal result as "succeeded". A "signalled" exit (code=null)
    // stays "signalled" unless the client requested something more severe.
    const status = mergedExitStatus(exitResultStatus(code), active.stopResultStatus);
    this.captureResult(active, status, boundedExitCode(code));
    active.status = "stopped";
    this.active = undefined;
    this.emit(runtimeExitEvent(active, this.nextSequence(active), code));
    return { ok: true, status: "stopped" };
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
    if (!(await boundedStreamDrain(active))) return false;
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
          void this.stop(active.context.runId, "failed").catch(() => {
            if (this.active === active) void this.enterRecoveryRequired(active);
          });
        },
      });
    } catch {
      if (this.active === active && !active.stopRequested && active.status === "ready") {
        void this.stop(active.context.runId, "failed").catch(() => {
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
      this.deps.resolveWorkspaceRootAccess,
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
    // Issue #3245: `event.kind` is a bounded closed union, but its members number too many to
    // enumerate as individual `message` vocabulary entries. `message` stays a fixed condition
    // label; the specific kind moves to `code` (already documented as "a stable machine-readable
    // code"), which is exactly the shape this value has.
    message: "runtime-event-invalid",
    code: event.kind,
  });
}

function emitRuntimeExitDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  code: number | null,
  now: () => number,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date(now()).toISOString(),
    operation: "coding-runtime.exit",
    source: "coding-runtime-manager.exit",
    errorClass: "RuntimeUnexpectedExit",
    // Issue #3245: the process exit code is unbounded per-invocation data, not a fixed condition
    // label — moved to `code` (the field this data actually belongs on), `message` stays fixed.
    message: "runtime-exit-code",
    code: code === null ? "signal" : String(code),
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
    // Issue #3245: bytes/lines/truncated are unbounded per-invocation counts, not a fixed
    // condition label — moved to `code` as a compact machine-readable string, `message` fixed.
    message: "runtime-stderr-counts",
    code: `bytes=${String(summary.bytes)}:lines=${String(summary.lines)}:truncated=${String(summary.truncated)}`,
  });
}

function emitRuntimeStreamDrainFailureDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  error: unknown,
  now: () => number,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date(now()).toISOString(),
    operation: "coding-runtime.stream-drain",
    source: "coding-runtime-manager.stream-drain",
    errorClass: contentFreeErrorClass(error),
    message: "runtime-stream-drain-failed",
  });
}

function invalidateApprovalBarrier(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  source: "coding-tool-approval-bridge" | "supervised-approval-store",
  invalidateRun: ((runId: string) => void) | undefined,
  now: () => number,
): boolean {
  if (invalidateRun === undefined) return true;
  try {
    invalidateRun(runId);
    return true;
  } catch (error) {
    emitServerDiagnostic(diagnostics, {
      correlationId: runId,
      timestamp: new Date(now()).toISOString(),
      operation: "coding-runtime.approval-revocation",
      source: `coding-runtime-manager.${source}`,
      errorClass: contentFreeErrorClass(error),
      message: "runtime-approval-revocation-failed",
    });
    return false;
  }
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
  const availability = evaluatePortableSidecarAvailability(resolved.verification, {
    target: resolved.target,
    // Every disk fact is recomputed on every lane, so the discovery-to-launch tamper window stays
    // fail-closed everywhere. Only the two checks the admitting policy never performed are omitted:
    // the functional dev lane and the packaged evaluation lane claim no platform signature and no
    // supervisor qualification, so re-asserting them would refuse an honestly weaker record. An
    // absent admission marker still takes the full release-qualified re-check.
    platformAttested:
      resolved.admission === undefined || resolved.admission === "release-qualified",
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

type OpenCodeHandshakeSettlement =
  | { readonly kind: "aborted" }
  | { readonly kind: "ok" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed"; readonly reason: string };

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

function runtimeStreamDrainCompletion(
  tree: RuntimeProcessTree,
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  now: () => number,
): Promise<boolean> {
  let failureReported = false;
  const reportFailure = (error: unknown): void => {
    if (failureReported) return;
    failureReported = true;
    emitRuntimeStreamDrainFailureDiagnostic(diagnostics, runId, error, now);
  };
  return Promise.all([
    readableDrainCompletion(tree.stdout, reportFailure),
    readableDrainCompletion(tree.stderr, reportFailure),
  ])
    .then(([stdout, stderr]) => stdout && stderr)
    .catch((error: unknown) => {
      reportFailure(error);
      return false;
    });
}

function readableDrainCompletion(
  stream: Readable,
  reportFailure: (error: unknown) => void,
): Promise<boolean> {
  if (stream.readableEnded) return Promise.resolve(true);
  if (stream.closed || stream.destroyed) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const finish = (complete: boolean): void => {
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
      resolve(complete);
    };
    const onEnd = (): void => {
      finish(true);
    };
    const onClose = (): void => {
      finish(stream.readableEnded);
    };
    const onError = (error: unknown): void => {
      reportFailure(error);
      finish(false);
    };
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function boundedStreamDrain(active: ActiveRuntime): Promise<boolean> {
  return boundedLifecycleDisposal(
    (): Promise<boolean> => active.streamDrainComplete,
    active.shutdownTimeoutMs,
  );
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
  diagnostics: ServerDiagnosticSink | undefined,
  now: () => number,
): Promise<FailureResult | undefined> {
  const controller = new AbortController();
  let resolveCancellation: ((outcome: OpenCodeHandshakeSettlement) => void) | undefined;
  const cancellation = new Promise<OpenCodeHandshakeSettlement>((resolve) => {
    resolveCancellation = resolve;
  });
  const abort = (): void => {
    controller.abort();
    resolveCancellation?.({ kind: "aborted" });
  };
  if (request.signal?.aborted === true) abort();
  else request.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    resolveCancellation?.({ kind: "timeout" });
  }, request.startTimeoutMs);
  timer.unref();
  const handshake = settleOpenCodeHandshake(adapter, request, active, onPermission, controller);
  try {
    const outcome = await Promise.race([handshake, cancellation]);
    if (outcome.kind === "ok") return undefined;
    if (outcome.kind === "aborted") return failure("start-aborted", true);
    if (outcome.kind === "timeout") {
      emitOpenCodeHandshakeDiagnostic(diagnostics, request.runId, "timeout", now);
      return failure("start-timeout", true);
    }
    emitOpenCodeHandshakeDiagnostic(diagnostics, request.runId, outcome.reason, now);
    return failure(openCodeHandshakeFailureCode(outcome.reason), false);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    resolveCancellation = undefined;
  }
}

function settleOpenCodeHandshake(
  adapter: OpenCodeLifecycleAdapter,
  request: CodingRuntimeLaunchRequest,
  active: ActiveRuntime,
  onPermission: (event: SidecarPermissionEvent) => void,
  controller: AbortController,
): Promise<OpenCodeHandshakeSettlement> {
  return Promise.resolve()
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
      (result): OpenCodeHandshakeSettlement =>
        result.ok ? { kind: "ok" } : { kind: "failed", reason: result.reason },
      (): OpenCodeHandshakeSettlement => ({ kind: "failed", reason: "handshake-rejected" }),
    );
}

const OPEN_CODE_HANDSHAKE_PHASES: ReadonlySet<string> = new Set([
  "target-attestation",
  "config-materialization",
  "endpoint",
  "authenticated-health",
  "authenticated-health-version",
  "unauthenticated-health",
  "openapi-digest",
  "gateway-challenge",
  "tool-facade-challenge",
  "sse-history-reconciliation",
  "session-echo",
  "endpoint-invalid",
  "preparation-missing",
  "readiness-failed",
  "handshake-rejected",
  "timeout",
]);

function openCodeHandshakeFailureCode(reason: string): CodingRuntimeFailureCode {
  return reason === "authenticated-health-version"
    ? "runtime-version-mismatch"
    : "protocol-schema-mismatch";
}

function emitOpenCodeHandshakeDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: string,
  now: () => number,
): void {
  const phase = OPEN_CODE_HANDSHAKE_PHASES.has(reason) ? reason : "unclassified";
  emitServerDiagnostic(diagnostics, {
    correlationId: runId,
    timestamp: new Date(now()).toISOString(),
    operation: "coding-runtime.handshake",
    source: "coding-runtime-manager.handshake",
    errorClass: "OpenCodeHandshakeFailure",
    // Issue #3245: `phase` is bounded (OPEN_CODE_HANDSHAKE_PHASES) but not narrowed by `.has()`
    // on a `ReadonlySet<string>`, and enumerating all 16 phases as `message` members would bloat
    // the vocabulary for one condition — moved to `code`, `message` stays the fixed condition.
    message: "runtime-handshake-failed",
    code: phase,
  });
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
  deps: Pick<
    NormalizedCodingRuntimeManagerDeps,
    "approvalStore" | "codingToolApprovals" | "now" | "nowIso" | "resolveWorkspaceRootAccess"
  >,
  openCodeLifecycleAdapter: OpenCodeLifecycleAdapter | undefined,
  codexLifecycleAdapter?: CodexLifecycleAdapter,
): ActiveRuntime {
  return {
    context: eventContext(request),
    effectiveMode: request.effectiveMode,
    tree,
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    approvalStore: deps.approvalStore,
    issuedTaskApprovalMetadata: new Map(),
    codingToolApprovals: deps.codingToolApprovals,
    nowMs: deps.now,
    nowIso: deps.nowIso,
    resolveWorkspaceRootAccess: deps.resolveWorkspaceRootAccess,
    openCodeLifecycleAdapter,
    codexLifecycleAdapter,
    startupOutput:
      openCodeLifecycleAdapter === undefined ? undefined : createOpenCodeStartupMailbox(),
    lifecycleMonitorDispose: undefined,
    codexDetach: undefined,
    stdoutParser: undefined,
    stderrDrainer: undefined,
    outputSummary: createCodingRuntimeProcessSummaryAccumulator(),
    errorSummary: createCodingRuntimeProcessSummaryAccumulator(),
    streamDrainComplete: Promise.resolve(false),
    pendingApprovalReview: undefined,
    shutdownBarrierComplete: false,
    stopPromise: undefined,
    stopResultStatus: "succeeded",
    stopRequested: false,
    tearingDown: false,
    reconcilePromise: undefined,
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
  resolveWorkspaceRootAccess: (() => WorkspaceRootAccess | undefined) | undefined,
): ActiveRuntime {
  return {
    context: eventContext(request),
    effectiveMode: request.effectiveMode,
    tree: inertTree(),
    shutdownTimeoutMs: request.shutdownTimeoutMs,
    approvalStore,
    issuedTaskApprovalMetadata: new Map(),
    codingToolApprovals: undefined,
    nowMs,
    nowIso,
    resolveWorkspaceRootAccess,
    openCodeLifecycleAdapter: undefined,
    codexLifecycleAdapter: undefined,
    startupOutput: undefined,
    lifecycleMonitorDispose: undefined,
    codexDetach: undefined,
    stdoutParser: undefined,
    stderrDrainer: undefined,
    outputSummary: createCodingRuntimeProcessSummaryAccumulator(),
    errorSummary: createCodingRuntimeProcessSummaryAccumulator(),
    streamDrainComplete: Promise.resolve(true),
    pendingApprovalReview: undefined,
    shutdownBarrierComplete: false,
    stopPromise: undefined,
    stopResultStatus: "succeeded",
    stopRequested: false,
    tearingDown: false,
    reconcilePromise: undefined,
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

const OPEN_CODE_STARTUP_MAILBOX_MAX_LINES = 64;

function createOpenCodeStartupMailbox(): OpenCodeStartupMailbox {
  const queued: string[] = [];
  let waiter: OpenCodeStartupWaiter | undefined;
  let terminalError: Error | undefined;
  return {
    nextLine(signal): Promise<string> {
      if (terminalError !== undefined) return Promise.reject(terminalError);
      const line = queued.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (signal?.aborted === true)
        return Promise.reject(new Error("runtime-startup-output-aborted"));
      if (waiter !== undefined)
        return Promise.reject(new Error("runtime-startup-output-concurrent-read"));
      return new Promise<string>((resolve, reject) => {
        const abort = (): void => {
          if (waiter?.reject === reject) {
            waiter = undefined;
            reject(new Error("runtime-startup-output-aborted"));
          }
        };
        waiter = { resolve, reject, signal, abort };
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
    offer(line): void {
      if (terminalError !== undefined) return;
      if (waiter !== undefined) {
        const pending = waiter;
        waiter = undefined;
        pending.signal?.removeEventListener("abort", pending.abort);
        pending.resolve(line);
        return;
      }
      if (queued.length >= OPEN_CODE_STARTUP_MAILBOX_MAX_LINES) {
        terminalError = new Error("runtime-startup-output-overflow");
        queued.length = 0;
        return;
      }
      queued.push(line);
    },
    close(): void {
      terminalError ??= new Error("runtime-startup-output-closed");
      queued.length = 0;
      const pending = waiter;
      waiter = undefined;
      pending?.signal?.removeEventListener("abort", pending.abort);
      pending?.reject(terminalError);
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

type SpawnWorkspaceRootProof = { readonly ok: true; readonly cwd: string } | { readonly ok: false };

/**
 * The exact managed-root proof taken immediately before a runtime spawn (#3347 owner P1).
 *
 * The run surface proves workspace access once, before backend construction, and OpenCode/Codex
 * preparation then awaits (qualification, prepare, egress). A worktree archived or identity-replaced
 * during those awaits would previously still receive a long-lived runtime tree, because the resolver
 * was only copied onto `ActiveRuntime` for later supervised file-event classification and was never
 * consulted at the spawn itself. This re-runs it and requires the same managed-task grant for the
 * identical admitted canonical root; the spawn then uses that proven path as its cwd.
 *
 * A run composed WITHOUT a resolver is not bound to a managed root (the same convention
 * `resolveSupervisedWorkspaceFs` follows for its node-fs fallback), so it keeps the request's own
 * root and its previous outcome.
 */
function proveSpawnWorkspaceRoot(
  resolveAccess: (() => WorkspaceRootAccess | undefined) | undefined,
  workspaceRoot: string,
): SpawnWorkspaceRootProof {
  if (resolveAccess === undefined) return { ok: true, cwd: workspaceRoot };
  try {
    const access = resolveAccess();
    return access?.kind === "managed-task" && access.canonicalRoot === workspaceRoot
      ? { ok: true, cwd: access.canonicalRoot }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function supervisorLaunchRequest(
  request: CodingRuntimeLaunchRequest,
  executable: string,
  env: Record<string, string>,
  args: readonly string[],
  // The canonical root of the capability proved immediately before this spawn (see
  // proveSpawnWorkspaceRoot): the long-lived tree starts in the path that just re-proved, not in
  // the request string admitted before the preparation awaits.
  cwd: string,
): Parameters<RuntimeProcessSupervisor["spawnOwnedTree"]>[0] {
  return {
    runId: request.runId,
    recoveryHandle: request.recoveryHandle ?? request.treeBindingId.slice(0, 32),
    treeBindingId: request.treeBindingId,
    executable,
    args,
    cwd,
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

function boundedExitCode(code: number | null): number | null {
  return code !== null && Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : null;
}

function exitResultStatus(code: number | null): CodingRuntimeRunResult["status"] {
  if (code === null) return "signalled";
  return code === 0 ? "succeeded" : "failed";
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
      effectiveMode: active.effectiveMode,
    };
  }
  if (kind === "runtime-stopped") {
    return {
      runtimeSource: active.context.runtimeSource,
      modelSource: active.context.modelSource,
      effectiveMode: active.effectiveMode,
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
  const unavailable = unavailableRuntimeActionEvent(active, sequence, event, request);
  if (unavailable !== undefined) return unavailable;
  const autonomous = autonomousDeliveryRuntimeEvent(active, sequence, event, request);
  if (autonomous !== undefined) return autonomous;
  const supervised = supervisedCodingRuntimeEvent(active, sequence, event, request);
  if (supervised !== undefined) return supervised;
  const decision = decideCodingWorkbenchActionForMode(
    active.effectiveMode,
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
  if (!observeCodingToolApproval(active, event, request.actionKind)) {
    return supervisedPolicyFailureEvent(active, sequence, "approval-proof-stale");
  }
  active.pendingApprovalReview = approvalReviewFacts(event);
  return runtimeEvent(active, sequence, "permission-requested", {
    permissionRequest: request,
  });
}

/**
 * The ADR-0138 D2 resource scope each action class belongs to. Total over the closed action-class
 * union so a new class cannot silently inherit a scope it was never assigned.
 */
const ACTION_CLASS_RESOURCE_SCOPE: Readonly<
  Record<CodingWorkbenchActionClass, CodingWorkbenchPolicyResourceScope>
> = Object.freeze({
  "workspace-read": "workspace-contained",
  "workspace-write": "workspace-contained",
  "command-execution": "workspace-contained",
  verification: "workspace-contained",
  "connector-access": "internet",
  "network-egress": "internet",
  "delivery-substrate": "delivery",
} as const satisfies Readonly<
  Record<CodingWorkbenchActionClass, CodingWorkbenchPolicyResourceScope>
>);

function unavailableRuntimeActionEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
  request: CodingWorkbenchPermissionRequest,
): CodingWorkbenchRuntimeEvent | undefined {
  if (active.stopRequested || event.operatorStopped === true) {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: "operator-stopped",
      failureSummary: "operator-stopped",
      retryable: false,
    });
  }
  if (request.actionClass === "connector-access") {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: "connector-access-denied",
      failureSummary: "connector-access-denied",
      retryable: false,
    });
  }
  if (request.actionClass === "delivery-substrate") {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: "delivery-denied",
      failureSummary: "delivery-denied",
      retryable: false,
    });
  }
  return undefined;
}

/**
 * Projects the reviewable changeset facts of a governed `file-edit` ask (#2802). The admission
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

/**
 * ADR-0138 D2 fixes a NORMATIVE monotonicity invariant: for a fixed (resource scope, risk) the
 * effect never becomes stricter as the mode rises. This branch previously hard-denied every action
 * whose class was not `workspace-read` with `delivery-denied` — which the orchestrator turns into a
 * terminal failed run — so a scoped file edit and an allowlisted verification command that
 * Supervised workspace admits outright killed the run under the WIDER Full access. Workspace-
 * contained actions therefore run the exact same dispatcher Supervised workspace runs, keeping the
 * independent containment and verifier-allowlist gates in force. Delivery and connector requests
 * are rejected before mode dispatch because no executor is mounted; remaining internet mutations
 * stay denied here, with mode-invariant gates composed stricter-wins (ADR-0125 D1).
 */ function autonomousDeliveryRuntimeEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
  request: CodingWorkbenchPermissionRequest,
): CodingWorkbenchRuntimeEvent | undefined {
  if (active.effectiveMode !== "autonomous-delivery") return undefined;
  if (active.stopRequested || event.operatorStopped === true) {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: "operator-stopped",
      failureSummary: "operator-stopped",
      retryable: false,
    });
  }
  if (ACTION_CLASS_RESOURCE_SCOPE[request.actionClass] !== "workspace-contained") {
    return runtimeEvent(active, sequence, "failure-redacted", {
      failureCode: "delivery-denied",
      failureSummary: "delivery-denied",
      retryable: false,
    });
  }
  if (request.actionClass === "workspace-read") return undefined;
  return governedActionRuntimeEvent(active, sequence, event, request);
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
  if (active.effectiveMode !== "supervised-coding") return undefined;
  return governedActionRuntimeEvent(active, sequence, event, request);
}

/**
 * The one action dispatcher both governed modes share, so Full access is structurally incapable of
 * being stricter than Supervised workspace for the same action.
 */
function governedActionRuntimeEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
  request: CodingWorkbenchPermissionRequest,
): CodingWorkbenchRuntimeEvent | undefined {
  if (request.actionKind === undefined) return undefined;
  if (request.actionKind === "file-edit") return supervisedFileEditEvent(active, sequence, event);
  if (request.actionKind === "verification-command") {
    return supervisedVerificationEvent(active, sequence, event);
  }
  return supervisedMutationEvent(active, sequence, event, request.actionKind);
}

// KEIKO-0557/#2906: classify BOTH the lexical sidecar-declared path AND the real,
// symlink-resolved target within the workspace. A benign-looking in-workspace symlink (e.g.
// `src/config-alias` -> `../.env`) stays root-contained -- so the containment gate alone would
// admit it -- while pointing at a deny-listed file the lexical name never reveals.
function classifySupervisedTargetSensitive(
  workspaceRoot: string,
  targetPath: string,
  fs: WorkspaceFs,
): boolean {
  if (isDenied(targetPath)) return true;
  const real = resolveEditTargetRealPath(workspaceRoot, targetPath, fs);
  return real.realRelative !== undefined && isDenied(real.realRelative);
}

function supervisedFileEditEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent {
  const targetPath = event.targetPath ?? "";
  const decision = decideSupervisedFileEdit({
    ...supervisedEvidenceContext(active, "file-edit"),
    workspaceRoot: active.context.workspaceRoot,
    ...supervisedFileTargetPolicy(active, targetPath),
    targetPath,
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

function supervisedFileTargetPolicy(
  active: ActiveRuntime,
  targetPath: string,
): Pick<SupervisedCodingFileEditRequest, "targetSensitive" | "workspaceFs"> {
  const workspaceFs = resolveSupervisedWorkspaceFs(active);
  if (workspaceFs === undefined) return { targetSensitive: true };
  return {
    workspaceFs,
    targetSensitive: classifySupervisedTargetSensitive(
      active.context.workspaceRoot,
      targetPath,
      workspaceFs,
    ),
  };
}

function resolveSupervisedWorkspaceFs(active: ActiveRuntime): WorkspaceFs | undefined {
  const resolveAccess = active.resolveWorkspaceRootAccess;
  if (resolveAccess === undefined) return nodeWorkspaceFs;
  try {
    const access = resolveAccess();
    return access?.canonicalRoot === active.context.workspaceRoot ? access.fs : undefined;
  } catch {
    return undefined;
  }
}

function supervisedVerificationEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent {
  const approvalFailure = invalidVerificationApprovalEvent(active, sequence, event);
  if (approvalFailure !== undefined) return approvalFailure;
  return supervisedVerificationOutcomeEvent(active, sequence, event);
}

function supervisedVerificationOutcomeEvent(
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

function invalidVerificationApprovalEvent(
  active: ActiveRuntime,
  sequence: number,
  event: SidecarPermissionEvent,
): CodingWorkbenchRuntimeEvent | undefined {
  if (event.approvalTokenMalformed === true) {
    return supervisedPolicyFailureEvent(active, sequence, "approval-proof-stale");
  }
  if (event.approvalToken === undefined) return undefined;
  const bindings = approvalBindingsForEvent(active, event, "verification-command");
  return consumePresentedApproval(active, event, bindings) === undefined
    ? supervisedPolicyFailureEvent(active, sequence, "approval-proof-stale")
    : undefined;
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
  const bindings = approvalBindingsForEvent(active, event, actionKind);
  const [binding] = bindings;
  const approval = consumePresentedApproval(active, event, bindings);
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
    if (!observeCodingToolApproval(active, event, actionKind)) {
      return supervisedPolicyFailureEvent(active, sequence, "approval-proof-stale");
    }
    return runtimeEvent(active, sequence, "permission-requested", {
      permissionRequest: decision.permissionRequest,
    });
  }
  if (decision.status === "allowed")
    return supervisedApprovalAcceptedEvent(active, sequence, decision);
  return supervisedFailureEvent(active, sequence, decision);
}

function observeCodingToolApproval(
  active: ActiveRuntime,
  event: SidecarPermissionEvent,
  actionKind: CodingWorkbenchSupervisedActionKind | undefined,
): boolean {
  const bridge = active.codingToolApprovals;
  if (bridge === undefined || actionKind !== "verification-command") return true;
  if (
    event.approvalId === undefined ||
    event.approvalDigest === undefined ||
    event.actionId === undefined ||
    event.idempotencyKey === undefined ||
    event.commandLabel === undefined
  ) {
    return false;
  }
  return bridge.observePermission({
    runId: active.context.runId,
    requestId: event.requestId,
    action: "verification",
    actionId: event.actionId,
    idempotencyKey: event.idempotencyKey,
    targetId: event.commandLabel,
    proof: { approvalId: event.approvalId, approvalDigest: event.approvalDigest },
    expiresAt: event.expiresAt,
    nowMs: active.nowMs(),
  });
}

function approvalBindingForIssue(
  active: ActiveRuntime,
  request: CodingRuntimeApprovalIssueRequest,
): SupervisedCodingApprovalBinding {
  const binding = approvalBinding({
    runId: active.context.runId,
    requestId: request.requestId,
    actionKind: request.actionKind,
    connectorScopes: request.connectorScopes,
  });
  return request.grantScope === "task" ? taskApprovalBinding(active, binding, request) : binding;
}

function issueSupervisedApproval(
  store: SupervisedCodingApprovalStore,
  binding: SupervisedCodingApprovalBinding,
  request: CodingRuntimeApprovalIssueRequest,
  nowMs: number,
): SupervisedCodingIssuedApproval | undefined {
  const input = {
    approvedByUserId: request.approvedByUserId,
    nowMs,
    ttlMs: request.ttlMs,
  };
  return binding.grantScope === "task"
    ? store.issueTaskGrant({ ...input, binding })
    : store.issue({ ...input, binding });
}

function activateIssuedToolApproval(
  bridge: CodingToolApprovalBridge | undefined,
  request: CodingRuntimeApprovalIssueRequest,
  issued: SupervisedCodingIssuedApproval,
): boolean {
  if (request.actionKind !== "verification-command" || bridge === undefined) return true;
  return bridge.activatePermission({
    runId: request.runId,
    requestId: request.requestId,
    approvalAuthorityDigest: issued.approvalDigest,
    expiresAtMs: issued.expiresAtMs,
    nowMs: issued.approvedAtMs,
  });
}

function rollbackIssuedApproval(
  store: SupervisedCodingApprovalStore,
  binding: SupervisedCodingApprovalBinding,
): void {
  // Task grants deliberately survive consumption, so consume cannot roll them back. A failed bridge
  // activation invalidates the run's approvals fail-closed; no just-issued reusable grant remains live.
  store.invalidateRun(binding.runId);
}

function rememberIssuedTaskApproval(
  active: ActiveRuntime,
  binding: SupervisedCodingApprovalBinding,
  approvalId: string,
): void {
  if (binding.grantScope !== "task") return;
  active.issuedTaskApprovalMetadata.set(approvalId, {
    commandTemplateId: binding.commandTemplateId,
    safeArgumentClasses: [...binding.safeArgumentClasses],
  });
}

function approvalBindingsForEvent(
  active: ActiveRuntime,
  event: SidecarPermissionEvent,
  actionKind: CodingWorkbenchSupervisedActionKind,
): readonly [SupervisedCodingApprovalBindingOnce, SupervisedCodingApprovalBindingTask] {
  const binding = approvalBinding({
    runId: active.context.runId,
    requestId: event.requestId,
    actionKind,
    connectorScopes: event.connectorScopes,
  });
  const issuedMetadata =
    event.approvalToken === undefined
      ? undefined
      : active.issuedTaskApprovalMetadata.get(event.approvalToken.approvalId);
  return [binding, taskApprovalBinding(active, binding, issuedMetadata ?? event)];
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

function taskApprovalBinding(
  active: ActiveRuntime,
  binding: SupervisedCodingApprovalBindingOnce,
  input: {
    readonly commandTemplateId?: string | undefined;
    readonly safeArgumentClasses?: readonly string[] | undefined;
    readonly commandLabel?: string | undefined;
  },
): SupervisedCodingApprovalBindingTask {
  const context = active.context;
  return {
    grantScope: "task",
    runId: binding.runId,
    requestId: binding.requestId,
    actionKind: binding.actionKind,
    scopeDigest: supervisedCodingTaskScopeDigest({
      runId: binding.runId,
      actionKind: binding.actionKind,
      connectorScopes: binding.connectorScopes,
    }),
    connectorScopes: binding.connectorScopes,
    commandTemplateId: input.commandTemplateId ?? input.commandLabel ?? binding.actionKind,
    safeArgumentClasses: input.safeArgumentClasses ?? [],
    workspaceDigest: supervisedCodingApprovalScopeDigest({
      runId: binding.runId,
      requestId: context.workspaceRoot,
      actionKind: binding.actionKind,
      connectorScopes: binding.connectorScopes,
    }),
    sourceDigest: supervisedCodingApprovalScopeDigest({
      runId: binding.runId,
      requestId: JSON.stringify({
        runtimeSource: context.runtimeSource,
        modelSource: context.modelSource,
      }),
      actionKind: binding.actionKind,
      connectorScopes: binding.connectorScopes,
    }),
    policyVersion: taskPolicyVersion(context, binding),
  };
}

function taskPolicyVersion(
  context: ActiveRuntime["context"],
  binding: SupervisedCodingApprovalBindingOnce,
): string {
  return supervisedCodingApprovalScopeDigest({
    runId: binding.runId,
    requestId: JSON.stringify({
      effectiveMode: context.effectiveMode,
      workspaceRoot: context.workspaceRoot,
    }),
    actionKind: binding.actionKind,
    connectorScopes: binding.connectorScopes,
  });
}

function consumePresentedApproval(
  active: ActiveRuntime,
  event: SidecarPermissionEvent,
  bindings: readonly SupervisedCodingApprovalBinding[],
): SupervisedCodingConsumedApproval | undefined {
  if (event.approvalToken === undefined) return undefined;
  for (const binding of bindings) {
    const consumed = active.approvalStore.consume({
      approval: event.approvalToken,
      binding,
      nowMs: active.nowMs(),
    });
    if (consumed !== undefined) return consumed;
  }
  return undefined;
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
    effectiveMode: active.effectiveMode,
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

function isOwnedGitApproval(request: CodingRuntimeApprovalIssueRequest): boolean {
  return (
    request.actionKind === "commit" ||
    request.actionKind === "git-stage" ||
    (request.requestId.startsWith("delivery-") &&
      (request.actionKind === "push" || request.actionKind === "pull-request"))
  );
}
function draftApprovalKindMatches(
  bridge: CodingToolApprovalBridge | undefined,
  request: CodingRuntimeApprovalIssueRequest,
): boolean {
  if (request.actionKind !== "push" && request.actionKind !== "pull-request") return true;
  const phase = bridge?.deliveryService?.review(request.requestId)?.record.phase;
  return phase === (request.actionKind === "push" ? "push-proposed" : "pr-proposed");
}
