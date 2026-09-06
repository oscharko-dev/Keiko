/** Server-owned, single-slot lifecycle coordinator for the Coding Workbench (issue #2256). */
import { createHash, randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeApprovalDecisionRequest,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimePendingApprovalReview,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimePendingResearch,
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeResult,
  CodingWorkbenchRuntimeStartRequest,
  CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  CodingWorkbenchRuntimeStateName,
  CodingWorkbenchIssueBinding,
} from "@oscharko-dev/keiko-contracts";
import { isLegalCodingWorkbenchRuntimeTransition } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeResumeRequest,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeResearchRevokeRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type {
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeFailureCode,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import { reviewableResearchAsk } from "./researchApprovalIssuance.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { isIdentityProofFailure } from "../task-workspace/errors.js";
import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import {
  auxiliaryEventFacts,
  CodingRuntimeOrchestratorState,
  type AuxiliaryEventFacts,
} from "./codingRuntimeOrchestratorState.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { errorKindOf, type ServerLogSink } from "../observability/server-log.js";
import type {
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";
import { classifyLaunchRejection, launchRejectionDiagnosticReason } from "./launchFailure.js";
import type { CodingRuntimeTaskOutcome } from "./productionCodingRuntimeHost.js";
import {
  admitCodingRuntimeIssue,
  type CodingRuntimeIssueAttachment,
} from "./codingRuntimeIssueIntake.js";
import { renderInitialTurnContext } from "./productionCodingRuntimePorts.js";
import type {
  CodingRuntimeDescriptionJobStore,
  WorkbenchDescriptionScope,
} from "./codingRuntimeDescriptionJobStore.js";
import type { PrDescriptionDraftPreview } from "../gitDelivery/prDescriptionTypes.js";
import {
  WORKBENCH_DESCRIPTION_REASON_STATES,
  type WorkbenchDescriptionReason,
  type WorkbenchDescriptionStatus,
  type WorkbenchDescriptionGenerationBinding,
} from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
export type { CodingRuntimeIssueIntake } from "./codingRuntimeIssueIntake.js";

function descriptionGenerationBinding(
  snapshot: CodingRuntimeSnapshot,
): WorkbenchDescriptionGenerationBinding {
  return {
    taskDigest: snapshot.taskDigest,
    authorityDigest: snapshot.authorityDigest,
    runtimeBindingDigest: snapshot.bindingDigest,
    deliveryBindingDigest:
      snapshot.draftDelivery === undefined
        ? null
        : sha256Hex(canonicalise(snapshot.draftDelivery.binding)),
  };
}

function descriptionComparisonRefs(
  snapshot: CodingRuntimeSnapshot,
  workspace: ActiveWorkspaceView | undefined,
  fallback: { readonly baseRef: string; readonly headRef: string },
): { readonly baseRef: string; readonly headRef: string } {
  const delivery = snapshot.draftDelivery?.binding;
  if (delivery !== undefined) return { baseRef: delivery.baseRef, headRef: delivery.headRef };
  return {
    baseRef: workspace?.instance.baseBranch ?? fallback.baseRef,
    headRef: workspace?.instance.taskBranch ?? fallback.headRef,
  };
}

function descriptionApplicationTarget(
  snapshot: CodingRuntimeSnapshot,
  workspace: ActiveWorkspaceView | undefined,
  headSha: string,
): WorkbenchDescriptionScope["applicationTarget"] {
  const delivery = snapshot.draftDelivery;
  const pullRequest = delivery?.pullRequest;
  const repository = delivery?.binding.repository;
  if (
    workspace === undefined ||
    pullRequest?.state !== "open" ||
    repository === undefined ||
    pullRequest.headSha !== headSha ||
    pullRequest.repository.toLowerCase() !== repository.toLowerCase()
  ) {
    return undefined;
  }
  return {
    projectId: workspace.binding.activeRoot,
    ownerAndRepo: pullRequest.repository,
    prNumber: pullRequest.number,
  };
}

function sameDescriptionStatusScope(
  status: WorkbenchDescriptionStatus,
  scope: WorkbenchDescriptionScope,
): boolean {
  return (
    status.runId === scope.runId &&
    status.remoteDigest === scope.remoteDigest &&
    status.baseSha === scope.baseSha &&
    status.headSha === scope.headSha &&
    canonicalise(status.generationBinding) === canonicalise(scope.generationBinding)
  );
}

// #3401: the outcome a wired generator reports for one dispatched scope. `snapshotDigest` and
// `draftDigest` are present only for the reasons that produce them (see
// `WORKBENCH_DESCRIPTION_REASON_STATES`); the caller never invents a digest a reason does not use.
export interface WorkbenchDescriptionDispatchOutcome {
  readonly reason: WorkbenchDescriptionReason;
  readonly snapshotDigest?: string;
  readonly draftDigest?: string;
  readonly artifactOutcome?: "complete" | "partial" | "fallback" | "failed";
  readonly proposalId?: string;
}

/**
 * The one seam this orchestrator calls to actually generate a description (#3397 snapshot capture,
 * #3399 description-authority admission and model-egress check, #3398 narrative rendering). It is
 * deliberately NOT part of `CodingRuntimeOrchestratorDeps`: this file owns only the dedup/coalesce/
 * supersede dispatch DECISION, never the generation itself, so a fake in a unit test can stand in
 * for the full chain without this file depending on the model gateway or #3399's routes.
 */
export interface WorkbenchDescriptionDispatcher {
  readonly generate: (
    scope: WorkbenchDescriptionScope,
    signal: AbortSignal,
  ) => Promise<WorkbenchDescriptionDispatchOutcome>;
  readonly hasProposal?: (
    scope: WorkbenchDescriptionScope,
    proposalId: string,
    snapshotDigest: string,
  ) => boolean;
  readonly reviewDraft?: (
    scope: WorkbenchDescriptionScope,
    proposalId: string,
    snapshotDigest: string,
  ) => PrDescriptionDraftPreview | undefined;
}

/** Optional support the terminal-run hook consumes; absent means the feature is not yet wired. */
export interface CodingRuntimeDescriptionSupport {
  readonly jobs: CodingRuntimeDescriptionJobStore;
  readonly dispatcher?: WorkbenchDescriptionDispatcher;
}

function isRetainedDescriptionProposal(
  support: CodingRuntimeDescriptionSupport | undefined,
  scope: WorkbenchDescriptionScope | undefined,
  status: WorkbenchDescriptionStatus,
  proposalId: string,
  snapshotDigest: string,
): boolean {
  const hasProposal = support?.dispatcher?.hasProposal;
  if (hasProposal === undefined || scope === undefined) return false;
  return (
    sameDescriptionStatusScope(status, scope) && hasProposal(scope, proposalId, snapshotDigest)
  );
}

function matchesDescriptionProposal(
  status: WorkbenchDescriptionStatus | undefined,
  proposalId: string,
  snapshotDigest: string,
): status is WorkbenchDescriptionStatus {
  return status?.proposalId === proposalId && status.snapshotDigest === snapshotDigest;
}

function runtimePauseFailureCode(
  code:
    | "authority-expired"
    | "authority-resolution-failed"
    | "runtime-run-mismatch"
    | "runtime-stopped",
): CodingWorkbenchRuntimeFailureCode {
  if (code === "runtime-run-mismatch") return "authority-resolution-failed";
  // KEIKO-0386: a pause/resume rejected because the runtime was mid-teardown surfaces on the
  // orchestrator as `runtime-failed`, matching how issueApproval's runtime-stopped rejection is
  // projected (see runtimeApprovalIssueFailureCode). Both refuse further operator input on an
  // active that is disposing.
  if (code === "runtime-stopped") return "runtime-failed";
  return code;
}

type CodingRuntimeApprovalIssueFailureCode = Extract<
  CodingRuntimeApprovalIssueResult,
  { readonly ok: false }
>["failureCode"];

function runtimeApprovalIssueFailureCode(
  code: CodingRuntimeApprovalIssueFailureCode,
): CodingWorkbenchRuntimeFailureCode {
  if (code === "approval-activation-failed") return code;
  return code === "runtime-run-mismatch" ? "authority-resolution-failed" : "runtime-failed";
}

type RuntimeStartFailureReason =
  | CodingRuntimeFailureCode
  | "initial-turn-dispatch"
  | "initial-turn-recovery"
  | "launch-resolution"
  | "manager-exception"
  | "run-mismatch";

type RuntimeLifecycleFailureReason = "failure-redacted" | "runtime-stopped-live";

function runtimeDiagnosticCorrelationId(runId: string): string {
  return isValidCorrelationId(runId) ? runId : UNKNOWN_CORRELATION_ID;
}

function isExactRunRevision(
  snapshot: CodingRuntimeSnapshot | undefined,
  runId: string,
  revision: number,
): snapshot is CodingRuntimeSnapshot {
  return snapshot?.runId === runId && snapshot.revision === revision;
}

function recordRuntimeStartFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: RuntimeStartFailureReason,
  error?: unknown,
): void {
  const launchReason =
    reason === "launch-resolution" ? launchRejectionDiagnosticReason(error) : undefined;
  const diagnosticCode = `stage=start:reason=${reason}`;
  emitServerDiagnostic(diagnostics, {
    correlationId: runtimeDiagnosticCorrelationId(runId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.start",
    source: "coding-runtime-orchestrator.start",
    errorClass: error === undefined ? "CodingRuntimeStartFailure" : contentFreeErrorClass(error),
    message: "runtime-start-failed",
    code: launchReason === undefined ? diagnosticCode : `${diagnosticCode}:${launchReason}`,
  });
}

function recordRuntimeLifecycleFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: RuntimeLifecycleFailureReason,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runtimeDiagnosticCorrelationId(runId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.lifecycle",
    source: "coding-runtime-orchestrator.ingest",
    errorClass: "CodingRuntimeLifecycleFailure",
    message: "runtime-lifecycle-failed",
    code: `stage=lifecycle:reason=${reason}`,
  });
}

function recordRuntimeStopFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: runtimeDiagnosticCorrelationId(runId),
      operation: "coding-runtime.stop",
      source: "coding-runtime-orchestrator.permission-denied",
      error,
      redact: () => "Coding runtime stop failed.",
    }),
  );
}

function recordRuntimeRunStarted(
  activityLog: ServerLogSink | undefined,
  snapshot: CodingRuntimeSnapshot,
  effectiveMode: CodingWorkbenchMode,
): void {
  activityLog?.write({
    category: "process",
    op: "coding-runtime.run.started",
    correlationId: runtimeDiagnosticCorrelationId(snapshot.runId),
    extra: {
      runId: snapshot.runId,
      state: snapshot.state,
      revision: snapshot.revision,
      requestedMode: snapshot.requestedMode,
      effectiveMode,
      runtimeSource: snapshot.runtimeSource,
      modelSource: snapshot.modelSource,
      hasPredecessor: snapshot.predecessorRunId !== undefined,
    },
  });
}

function recordRuntimeApprovalWaiting(
  activityLog: ServerLogSink | undefined,
  runId: string,
  revision: number,
  permission: CodingWorkbenchRuntimePendingPermission,
  queuePosition?: number,
): void {
  activityLog?.write({
    category: "process",
    op: "coding-runtime.approval.waiting",
    correlationId: runtimeDiagnosticCorrelationId(runId),
    extra: {
      runId,
      revision,
      requestId: permission.requestId,
      permissionKind: permission.kind,
      actionClass: permission.actionClass,
      actionKind: permission.actionKind,
      ...(queuePosition === undefined ? {} : { queuePosition }),
    },
  });
}

function recordRuntimeVerificationSummary(
  activityLog: ServerLogSink | undefined,
  event: CodingWorkbenchRuntimeEvent,
): void {
  if (event.kind !== "verification-summarized") return;
  activityLog?.write({
    category: "process",
    op: "coding-runtime.verification-summarized",
    correlationId: runtimeDiagnosticCorrelationId(event.runId),
    extra: {
      runId: event.runId,
      verificationEventId: event.eventId,
      verificationKind: event.verificationKind,
      verificationStatus: event.verificationStatus,
      passedCount: event.passedCount,
      failedCount: event.failedCount,
      skippedCount: event.skippedCount,
    },
  });
}

function recordRuntimeRunSettled(
  activityLog: ServerLogSink | undefined,
  snapshot: CodingRuntimeSnapshot,
  state: CodingWorkbenchRuntimeStateName,
  failureCode?: CodingWorkbenchRuntimeFailureCode,
): void {
  activityLog?.write({
    category: "process",
    op: "coding-runtime.run.settled",
    correlationId: runtimeDiagnosticCorrelationId(snapshot.runId),
    extra: {
      runId: snapshot.runId,
      state,
      revision: snapshot.revision,
      requestedMode: snapshot.requestedMode,
      runtimeSource: snapshot.runtimeSource,
      modelSource: snapshot.modelSource,
      terminal: TERMINAL_STATES.has(state),
      ...(failureCode === undefined ? {} : { failureCode }),
      ...runtimeResultLogFields(snapshot.result),
    },
  });
}

function descriptionSettleOp(
  reason: WorkbenchDescriptionReason,
): "generated" | "blocked" | "failed" | "stale" {
  const state = WORKBENCH_DESCRIPTION_REASON_STATES[reason];
  if (state === "failed") return "failed";
  if (state === "stale") return "stale";
  return state === "blocked" ? "blocked" : "generated";
}

function runtimeResultLogFields(
  result: CodingWorkbenchRuntimeResult | undefined,
): Readonly<Record<string, unknown>> {
  if (result === undefined) return {};
  return {
    taskOutcomeStatus: result.status,
    exitCode: result.exitCode,
    outputByteCount: result.output.byteCount,
    outputLineCount: result.output.lineCount,
    outputDigest: result.output.sha256,
    outputTruncated: result.output.truncated,
    diagnosticByteCount: result.error.byteCount,
    diagnosticLineCount: result.error.lineCount,
    diagnosticDigest: result.error.sha256,
    diagnosticTruncated: result.error.truncated,
  };
}

export type {
  CodingRuntimeApprovalAuthority,
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";

interface ApprovalChallenge {
  readonly revision: number;
  readonly expiresAt: number;
  readonly permission: CodingWorkbenchRuntimePendingPermission;
  used: boolean;
}

interface ResumeAdmission {
  readonly current: CodingRuntimeSnapshot;
  readonly requestedMode: CodingWorkbenchMode;
}

const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

/**
 * Server-side ceiling on how long one approval challenge may live.
 *
 * The lifetime arrives on the runtime child's `permission-requested` event as
 * `permissionRequest.expiresAt`. The child is on the untrusted side of the boundary — it is the
 * process the approval is being asked ABOUT — so it must not choose its own security lifetime. This
 * ceiling is the trusted counterpart of the 5-minute value the generated child-side tool source
 * happens to send today: a child that asks for longer (or a tampered one that asks for a year) is
 * clamped here, before the instant becomes the challenge expiry, the operator-visible deadline on
 * the approval card, and the TTL of the minted approval authority. All three derive from this one
 * clamped instant, so the card can never display a deadline the server does not enforce.
 */
export const MAX_APPROVAL_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const MAX_QUEUED_APPROVALS_PER_RUN = 64;

const DIGEST = (value: string): string => createHash("sha256").update(value).digest("hex");
const GRANT_VISIBLE_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "starting",
  "ready",
  "running",
  "awaiting-approval",
  "paused",
  "stopping",
]);

/**
 * Keeps all lifecycle mutation behind one promise tail. This deliberately provides no replay API:
 * after a process restart durable active rows are recovery-required until an operator starts anew.
 */
export class CodingRuntimeOrchestrator {
  private tail: Promise<void> = Promise.resolve();
  private activeRunId: string | undefined;
  /**
   * The most recently settled run, kept as the public status until the next run is admitted. A
   * poller or a reloaded window that arrives after settlement still sees the run, its terminal
   * state and its body-free result instead of an `idle` snapshot with no runId (#3257 Wave 0).
   */
  private settledRunId: string | undefined;
  private activeEffectiveMode: CodingWorkbenchMode | undefined;
  /** Last accepted mode retained only for same-process post-terminal description work. */
  private readonly settledEffectiveModes = new Map<string, CodingWorkbenchMode>();
  private readonly approvals = new Map<string, ApprovalChallenge>();
  private readonly queuedApprovals = new Map<string, ApprovalChallenge[]>();
  private readonly operations: CodingRuntimeOperationCoordinator;
  private readonly projection: CodingRuntimeOrchestratorState;
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly descriptionDispatchAbort = new Map<string, AbortController>();

  constructor(
    private readonly deps: CodingRuntimeOrchestratorDeps,
    private description?: CodingRuntimeDescriptionSupport,
  ) {
    this.now = deps.now ?? ((): Date => new Date());
    // The run id becomes `authority.runId` inside the minted Authority Envelope, whose contract
    // admits only content-free evidence-safe labels; a raw UUID's hex segments are rejected there,
    // so the default identity is the approved `run-<decimal>` projection of the UUID's 128 bits.
    this.newRunId =
      deps.newRunId ??
      ((): string => {
        const decimal = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString(10);
        return `run-${decimal}`;
      });
    this.projection = new CodingRuntimeOrchestratorState({
      eventHub: deps.eventHub,
      now: this.now,
      pendingPermission: (runId: string): CodingWorkbenchRuntimePendingPermission | undefined =>
        this.approvals.get(runId)?.permission,
      effectiveMode: (runId: string): CodingWorkbenchMode | undefined =>
        this.activeRunId === runId ? this.activeEffectiveMode : undefined,
    });
    this.operations = new CodingRuntimeOperationCoordinator({
      current: (): CodingRuntimeSnapshot | undefined => this.current(),
      serial: <T>(work: () => Promise<T>): Promise<T> => this.serial(work),
      advanceRevision: (current, eventKind): CodingRuntimeOrchestratorResult =>
        this.advanceRevision(current, eventKind),
      publicSnapshot: (current): PublicSnapshot => this.publicSnapshotWithDescription(current),
      taskDispatcher: deps.taskDispatcher,
      settleTask: (runId, outcome): void => {
        this.queueTaskSettlement(runId, outcome);
      },
      questionPort: deps.questionPort,
      manager: deps.manager,
      // [P1] review 3941746512: this seam was never wired, so every question/follow-up transport
      // failure silently fell back to processServerLogSink() instead of the composed ServerLogSink
      // production actually reads.
      activityLog: deps.activityLog,
    });
    // Production bootstrap marks stale active rows recovery-required before composition. Restore only
    // that content-free slot; no adapter turn or productive action is ever replayed.
    this.activeRunId = deps.snapshots.listRecentActive(1)[0]?.runId;
    this.settledRunId =
      this.activeRunId === undefined ? latestSettledRunId(deps.snapshots) : undefined;
  }

  /**
   * A plain "Start coding run" is also the reachable path once the operator has acknowledged a
   * `recovery-required` predecessor: the acknowledgement itself is the human reconciliation
   * ADR-0137 D5 requires before a replacement run may occupy the slot, so `start` auto-detects it
   * and takes the same predecessor-superseding path `retry` uses. Any other occupied slot
   * (running, or an unacknowledged recovery) still fails closed as `active-run-conflict` inside
   * `startFresh`.
   */
  start(input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() =>
      this.startFreshAgainstPredecessor(input, this.acknowledgedRecoveryPredecessorId()),
    );
  }

  private acknowledgedRecoveryPredecessorId(): string | undefined {
    const current = this.current();
    return current?.state === "recovery-required" && current.recoveryAcknowledgedAt !== undefined
      ? current.runId
      : undefined;
  }

  private async startFreshAgainstPredecessor(
    input: unknown,
    predecessorRunId: string | undefined,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (predecessorRunId === undefined) return this.startFresh(input);
    this.activeRunId = undefined;
    this.activeEffectiveMode = undefined;
    try {
      return await this.startFresh(input, predecessorRunId);
    } finally {
      this.restoreUnsettledRecoverySlot(predecessorRunId);
    }
  }

  retry(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      if (!parseCodingWorkbenchRuntimeStartRequest(input).ok) return this.fail("invalid-intent");
      const prior = this.deps.snapshots.get(runId);
      if (prior?.state !== "recovery-required" || !prior.recoveryAcknowledgedAt)
        return this.fail("invalid-intent");
      if (this.activeRunId !== undefined && this.activeRunId !== runId)
        return this.fail("active-run-conflict");
      return this.startFreshAgainstPredecessor(input, runId);
    });
  }

  /**
   * A retry settles its predecessor's recovery row only once the fresh run has actually been
   * admitted to the ledger (`settlePredecessorRecovery`). When the start never gets that far — the
   * authority mint still refuses while the predecessor's process tree is unreaped, or no workspace
   * is bound — the recovery row is untouched and the orchestrator must keep pointing at it.
   * Without this the slot would fall back to the unbound idle projection, and every readiness
   * surface would offer "Ready to start" for a runtime whose every start is rejected.
   */
  private restoreUnsettledRecoverySlot(runId: string): void {
    if (this.activeRunId !== undefined) return;
    const prior = this.deps.snapshots.get(runId);
    if (prior?.state !== "recovery-required" || prior.terminalAt !== undefined) return;
    this.activeRunId = runId;
  }

  /** Finalizes recovery cleanup once — and only once — its successor holds the active slot. */
  private settlePredecessorRecovery(predecessorRunId: string): void {
    const prior = this.deps.snapshots.get(predecessorRunId);
    if (prior?.state !== "recovery-required") return;
    if (prior.terminalAt === undefined)
      this.deps.snapshots.releaseRecoveryForRetry(predecessorRunId, this.now().toISOString());
    this.deps.safeActivityProjection?.purge(predecessorRunId, "stop");
    this.pruneSettled();
  }
  snapshot(): PublicSnapshot {
    const visibleRunId = this.activeRunId ?? this.settledRunId;
    return visibleRunId === undefined
      ? this.projection.idle()
      : this.publicSnapshotWithDescription(this.deps.snapshots.get(visibleRunId));
  }
  status(): PublicSnapshot {
    return this.snapshot();
  }
  getSnapshot(runId: string): PublicSnapshot | undefined {
    const snapshot = this.deps.snapshots.get(runId);
    return snapshot ? this.publicSnapshotWithDescription(snapshot) : undefined;
  }

  submitFollowUp(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.submitFollowUp(runId, input, correlationId);
  }

  listQuestions(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeQuestionOperationResult> {
    return this.operations.listQuestions(runId, input, correlationId);
  }

  answerQuestion(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.answerQuestion(runId, input, correlationId);
  }

  rejectQuestion(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.rejectQuestion(runId, input, correlationId);
  }

  /**
   * Pause halts admission of new tool mutations without terminating the run: it is serialized like
   * stop, and only a running run may be paused. A paused run still accepts inline answer/reject and
   * stop; it never accepts a widening mode change. Resume returns a paused run to running.
   */
  pause(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const current = this.current();
      const parsed = parseCodingWorkbenchRuntimeStopRequest(input);
      if (!parsed.ok || parsed.value.requestId !== runId || current?.state !== "running") {
        return this.fail("invalid-intent");
      }
      const paused = this.deps.manager.pause(runId);
      return paused.ok
        ? this.transition(current, "paused")
        : this.fail(runtimePauseFailureCode(paused.failureCode));
    });
  }

  resume(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.resumeCurrent(runId, input));
  }

  private async resumeCurrent(
    runId: string,
    input: unknown,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const admitted = resumeAdmission(this.current(), runId, input, this.activeEffectiveMode);
    if (admitted === undefined) return this.fail("invalid-intent");
    const approval = this.approvals.get(runId);
    if (approval !== undefined && approval.expiresAt <= this.now().getTime()) {
      this.approvals.delete(runId);
      return this.stopExpiredPausedRuntime(admitted.current);
    }
    const effectiveMode = admitted.requestedMode;
    this.activeEffectiveMode = effectiveMode;
    const nextState = approval === undefined ? "running" : "awaiting-approval";
    const transitioned = this.transition(admitted.current, nextState);
    if (!transitioned.ok || transitioned.snapshot.state !== nextState) {
      await this.containPausedRuntime(runId);
      return transitioned;
    }
    const resumeFailure = await this.resumeManagerAfterTransition(runId, effectiveMode);
    if (resumeFailure !== undefined) return resumeFailure;
    this.activeEffectiveMode = effectiveModeAfterResume(transitioned, effectiveMode);
    if (approval !== undefined) {
      recordRuntimeApprovalWaiting(
        this.deps.activityLog,
        runId,
        transitioned.snapshot.revision,
        approval.permission,
      );
    }
    return transitioned;
  }

  private async resumeManagerAfterTransition(
    runId: string,
    effectiveMode: CodingWorkbenchMode,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    let resumed: ReturnType<CodingRuntimeManager["resume"]>;
    try {
      resumed = this.deps.manager.resume(runId, effectiveMode);
    } catch {
      return this.stopAfterResumeFailure(runtimePauseFailureCode("authority-resolution-failed"));
    }
    if (!resumed.ok) {
      return this.stopAfterResumeFailure(runtimePauseFailureCode(resumed.failureCode));
    }
    if (resumed.effectiveMode !== undefined && resumed.effectiveMode !== effectiveMode) {
      return this.stopAfterResumeFailure("authority-resolution-failed");
    }
    return undefined;
  }

  private async stopAfterResumeFailure(
    failureCode: CodingWorkbenchRuntimeFailureCode,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    return current === undefined
      ? this.fail(failureCode)
      : this.stopAfterIssueFailure(current, failureCode);
  }

  private async containPausedRuntime(runId: string): Promise<void> {
    try {
      await this.deps.manager.stop(runId, "failed");
    } catch {
      // The failed state publish already put the run in recovery-required; containment stays open.
    }
  }

  private async stopExpiredPausedRuntime(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    try {
      const stopped = await this.deps.manager.stop(current.runId, "failed");
      return stopped.ok
        ? this.transition(current, "failed", "authority-expired")
        : this.transition(current, "recovery-required", "recovery-required");
    } catch {
      return this.transition(current, "recovery-required", "recovery-required");
    }
  }

  /**
   * Drops every live #2387 research grant for the run (parent and children share the run-bound
   * registry entry) in one revision bump. Bound to the observed revision and a live grant id, so a
   * stale or forged revoke fails closed. Runtime snapshots never carry grant content (#2644).
   */
  revokeResearch(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const registry = this.deps.researchGrants;
      const parsed = parseCodingWorkbenchRuntimeResearchRevokeRequest(input);
      const current = this.current();
      if (registry === undefined || !parsed.ok || current?.runId !== runId)
        return this.fail("invalid-intent");
      if (parsed.value.expectedRevision !== current.revision) return this.fail("invalid-intent");
      const live = registry.activeGrants(runId, this.now().getTime());
      if (!live.some((grant) => grant.grantId === parsed.value.grantId))
        return this.fail("invalid-intent");
      registry.invalidateRun(runId);
      return this.advanceRevision(current);
    });
  }

  /**
   * The reviewable facts of the run's live research ask, for the AUTHENTICATED research channel
   * only (#2387 "visible sanitized queries"). Never reaches the unauthenticated status or SSE
   * projection: the host and request line are model-chosen text and those surfaces stay
   * content-free. Returns undefined when nothing is pending, the ask expired, or the run is not
   * the current one — a stale panel can never review an ask that is no longer approvable.
   */
  pendingResearchAsk(runId: string): CodingWorkbenchRuntimePendingResearch | undefined {
    const store = this.deps.pendingResearchApprovals;
    if (store === undefined || this.current()?.runId !== runId) return undefined;
    const pending = store.peek(runId, this.now().getTime());
    if (pending === undefined) return undefined;
    const reviewable = reviewableResearchAsk(pending);
    if (reviewable === undefined) return undefined;
    return {
      requestId: pending.requestId,
      host: reviewable.host,
      requestLine: reviewable.requestLine,
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
    };
  }

  /**
   * The reviewable changeset facts of the approval the operator is being asked to decide, for the
   * AUTHENTICATED approval-review channel only (#2802). A human cannot exercise control over a
   * change they are not shown (ADR-0129 D1), so the path list and the change magnitude reach the
   * card — but never through the unauthenticated status or SSE projection, which stay content-free
   * (#2644), and never a byte of the patch.
   *
   * Fails closed in every stale shape: a run that is not the current one, a run that is no longer
   * awaiting a decision, a challenge that was already consumed or has expired, and a review the
   * manager no longer binds to the live request id.
   */
  pendingApprovalReview(runId: string): CodingWorkbenchRuntimePendingApprovalReview | undefined {
    const current = this.current();
    if (current?.runId !== runId || current.state !== "awaiting-approval") return undefined;
    const challenge = this.approvals.get(runId);
    if (challenge === undefined || challenge.used) return undefined;
    if (challenge.expiresAt <= this.now().getTime()) return undefined;
    return this.deps.manager.pendingApprovalReview(runId, challenge.permission.requestId);
  }

  /**
   * Aggregates live grants for the authenticated research channel. General runtime snapshots are
   * structurally unable to carry this model-selected host content (#2644).
   */
  researchGrant(runId: string): CodingWorkbenchRuntimeResearchGrant | undefined {
    const current = this.current();
    if (current?.runId !== runId || !GRANT_VISIBLE_STATES.has(current.state)) {
      return undefined;
    }
    const registry = this.deps.researchGrants;
    if (registry === undefined) return undefined;
    const grants = registry.activeGrants(runId, this.now().getTime());
    const newest = grants.at(-1);
    if (newest === undefined) return undefined;
    // The UI shows one row per authenticated research channel, so we project the newest live
    // grant exclusively. Previously we unioned domains from every live grant while pairing the
    // newest grant's id, which misrepresented an older grant's authority as belonging to the
    // newest one. #3099 P2 follow-up: also drop the older grants' domains — grant id, domains,
    // and expiry must all describe the SAME underlying grant record (a domain that belongs to
    // a still-live older grant would otherwise be shown with the newest grant's expiry, then
    // "unexpectedly reappear" with the older expiry once the newest grant is pruned).
    const domains = [...new Set(newest.domains)].sort((left, right) => left.localeCompare(right));
    return {
      grantId: newest.grantId,
      domains,
      expiresAt: new Date(newest.expiresAtMs).toISOString(),
    };
  }

  decideApproval(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      const admitted = this.validateApprovalDecision(runId, input);
      if (admitted === undefined) return this.fail("invalid-intent");
      const { decision, current, challenge, actionKind, request } = admitted;
      challenge.used = true;
      if (decision === "approved") {
        const rejection = await this.issueApprovedAuthority(
          current,
          challenge,
          actionKind,
          request,
        );
        if (rejection !== undefined) return rejection;
      }
      const permissionSettled = await this.resolveRuntimePermission(
        current.runId,
        challenge.permission.requestId,
        decision,
      );
      if (!permissionSettled) return this.stopAfterApprovalFailure(current);
      if (decision === "denied") return this.stopAfterPermissionDenied(current);
      this.approvals.delete(current.runId);
      const running = this.transition(current, "running");
      if (!running.ok) return running;
      const live = this.current();
      return live === undefined ? running : await this.promoteQueuedApproval(live);
    });
  }

  private async resolveRuntimePermission(
    runId: string,
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<boolean> {
    if (this.deps.permissionPort === undefined) return true;
    try {
      return await this.deps.permissionPort.resolve({ runId, requestId, decision });
    } catch {
      return false;
    }
  }

  private validateApprovalDecision(
    runId: string,
    input: unknown,
  ):
    | {
        readonly decision: CodingWorkbenchRuntimeApprovalDecisionRequest["decision"];
        readonly current: CodingRuntimeSnapshot;
        readonly challenge: ApprovalChallenge;
        readonly actionKind: NonNullable<CodingWorkbenchRuntimePendingPermission["actionKind"]>;
        readonly request: CodingWorkbenchRuntimeApprovalDecisionRequest;
      }
    | undefined {
    const parsed = parseCodingWorkbenchRuntimeApprovalDecisionRequest(input);
    const current = this.current();
    const challenge = this.approvals.get(current?.runId ?? "");
    if (
      !parsed.ok ||
      current?.runId !== runId ||
      current.state !== "awaiting-approval" ||
      !this.approvalChallengeMatches(challenge, parsed.value) ||
      !challenge.permission.actionKind
    )
      return undefined;
    return {
      decision: parsed.value.decision,
      current,
      challenge,
      actionKind: challenge.permission.actionKind,
      request: parsed.value,
    };
  }

  private approvalChallengeMatches(
    challenge: ApprovalChallenge | undefined,
    decision: { readonly requestId: string; readonly expectedRevision: number },
  ): challenge is ApprovalChallenge {
    return (
      challenge?.permission.requestId === decision.requestId &&
      !challenge.used &&
      challenge.revision === decision.expectedRevision &&
      challenge.expiresAt > this.now().getTime()
    );
  }

  /** Returns the failure transition when issuing approved authority did not succeed. */
  private async issueApprovedAuthority(
    current: CodingRuntimeSnapshot,
    challenge: ApprovalChallenge,
    actionKind: NonNullable<CodingWorkbenchRuntimePendingPermission["actionKind"]>,
    request: CodingWorkbenchRuntimeApprovalDecisionRequest,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    const principal = this.deps.serverPrincipal();
    if (!principal) return this.stopAfterApprovalFailure(current);
    let issued: CodingRuntimeApprovalIssueResult;
    try {
      issued = this.deps.approvalAuthority.issue({
        runId: current.runId,
        requestId: challenge.permission.requestId,
        actionKind,
        ...(challenge.permission.connectorScopes
          ? { connectorScopes: challenge.permission.connectorScopes }
          : {}),
        approvedByUserId: principal,
        grantScope: request.grantScope ?? "once",
        ...(request.commandTemplateId === undefined
          ? {}
          : { commandTemplateId: request.commandTemplateId }),
        ...(request.safeArgumentClasses === undefined
          ? {}
          : { safeArgumentClasses: request.safeArgumentClasses }),
        ttlMs: Math.max(1, challenge.expiresAt - this.now().getTime()),
        boundRevision: challenge.revision,
      });
    } catch {
      return this.stopAfterApprovalFailure(current);
    }
    if (!issued.ok) {
      return this.stopAfterApprovalFailure(
        current,
        runtimeApprovalIssueFailureCode(issued.failureCode),
      );
    }
    return undefined;
  }

  private async stopAfterIssueFailure(
    current: CodingRuntimeSnapshot,
    failureCode: CodingWorkbenchRuntimeFailureCode = "authority-resolution-failed",
  ): Promise<CodingRuntimeOrchestratorResult> {
    try {
      const stopped = await this.deps.manager.stop(current.runId, "failed");
      return stopped.ok
        ? this.transition(current, "failed", failureCode)
        : this.transition(current, "recovery-required", "recovery-required");
    } catch {
      return this.transition(current, "recovery-required", "recovery-required");
    }
  }

  private async stopAfterPermissionDenied(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const stopping = this.transition(current, "stopping");
    if (!stopping.ok) return stopping;
    this.approvals.delete(current.runId);
    try {
      const stopped = await this.deps.manager.stop(current.runId);
      const live = this.current();
      if (live === undefined) return this.fail("runtime-failed");
      return stopped.ok
        ? this.transition(live, "failed", "revoked")
        : this.transition(live, "recovery-required", "recovery-required");
    } catch (error: unknown) {
      recordRuntimeStopFailure(this.deps.diagnostics, current.runId, error);
      const live = this.current();
      return live === undefined
        ? this.fail("runtime-failed")
        : this.transition(live, "recovery-required", "recovery-required");
    }
  }

  private stopAfterApprovalFailure(
    current: CodingRuntimeSnapshot,
    failureCode: CodingWorkbenchRuntimeFailureCode = "authority-resolution-failed",
  ): Promise<CodingRuntimeOrchestratorResult> {
    const stopping = this.transition(current, "stopping");
    if (!stopping.ok) return Promise.resolve(stopping);
    this.approvals.delete(current.runId);
    this.queuedApprovals.delete(current.runId);
    const live = this.current();
    return live === undefined
      ? Promise.resolve(this.fail("runtime-failed"))
      : this.stopAfterIssueFailure(live, failureCode);
  }

  stop(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.end("stop", runId, input);
  }
  takeover(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.end("takeover", runId, input);
  }
  acknowledgeRecovery(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const parsed = parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(input);
      const current = this.current();
      if (
        !parsed.ok ||
        current?.runId !== runId ||
        parsed.value.requestId !== runId ||
        current.state !== "recovery-required"
      )
        return this.fail("invalid-intent");
      const acknowledged = this.deps.snapshots.acknowledgeRecovery(
        current.runId,
        this.now().toISOString(),
      );
      this.deps.activityLog?.write({
        category: "process",
        op: "coding-runtime.run.recovery-acknowledged",
        correlationId: runtimeDiagnosticCorrelationId(acknowledged.runId),
        extra: { runId: acknowledged.runId, revision: acknowledged.revision },
      });
      return { ok: true, snapshot: this.publicSnapshotWithDescription(acknowledged) };
    });
  }

  /** Accepts only manager events for the current slot and projects no event content into durable state. */
  ingest(event: CodingWorkbenchRuntimeEvent): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.ingestCurrent(event));
  }

  private async ingestCurrent(
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    if (event.runId !== current?.runId) return this.fail("invalid-intent");
    if (event.kind === "failure-redacted") {
      recordRuntimeLifecycleFailure(this.deps.diagnostics, current.runId, "failure-redacted");
      return this.stopAfterIssueFailure(current, "runtime-failed");
    }
    const paused = await this.ingestPausedEvent(current, event);
    return paused ?? this.ingestActiveEvent(current, event);
  }

  private async ingestPausedEvent(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    const terminal = event.kind === "runtime-stopped" || event.kind === "failure-redacted";
    if (current.state !== "paused" || terminal) return undefined;
    if (event.kind === "permission-requested") {
      const challenge = this.approvalChallenge(current, event);
      if (challenge === undefined) return this.fail("invalid-intent");
      if (this.approvals.has(current.runId)) return await this.queueApproval(current, challenge);
      this.approvals.set(current.runId, challenge);
    }
    return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
  }

  private async ingestActiveEvent(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (event.kind === "permission-requested") {
      return await this.ingestPermissionRequested(current, event);
    }
    if (event.kind === "task-submitted") return this.ingestTaskSubmitted(current);
    if (event.kind === "runtime-stopped") return this.ingestRuntimeStopped(current);
    recordRuntimeVerificationSummary(this.deps.activityLog, event);
    return this.publishOrRecover(current, event.kind, auxiliaryEventFacts(event));
  }

  /**
   * The runtime process is gone. `cancelled` is legal only from the states an operator-initiated
   * stop passes through — `stopping` here; from every other live state this ingest rejects it, so
   * it used to fail closed SILENTLY — no transition, no evidence record, no SSE frame — and a dead
   * runtime kept presenting as `running` until the separate task-settlement wait gave up
   * (OPEN_CODE_MAX_TURN_WAIT_MS, 30 minutes). A runtime that exits under a live run terminates that
   * run, the same terminal projection a non-zero exit already produces through `failure-redacted`;
   * the exit code itself reaches the operator diagnostic sink, not this content-free lifecycle
   * projection.
   *
   * The shared LEGAL_TRANSITIONS contract also legalizes `starting` -> `cancelled` (KEIKO-0618),
   * but that edge is not reachable through this ingest path: `serial()`/`startFresh()` serialize
   * every operation on `this.tail`, so `start()` has already advanced `current.state` past
   * `starting` before any externally-ingested event can reach `ingestRuntimeStopped`. That edge is
   * genuinely used elsewhere — runtimeAuthorityService.ts's `REAP_SETTLEMENT_TRANSITIONS["starting"]`,
   * reached via `confirmReaped` when a Codex/OpenCode sidecar fails its startup handshake — so do
   * not remove it from the shared contract on the strength of this call site alone.
   */
  private ingestRuntimeStopped(current: CodingRuntimeSnapshot): CodingRuntimeOrchestratorResult {
    if (isLegalCodingWorkbenchRuntimeTransition(current.state, "cancelled")) {
      return this.transition(current, "cancelled");
    }
    recordRuntimeLifecycleFailure(this.deps.diagnostics, current.runId, "runtime-stopped-live");
    return this.transition(current, "failed", "runtime-failed");
  }

  private async ingestPermissionRequested(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const challenge = this.approvalChallenge(current, event);
    if (challenge === undefined) return this.fail("invalid-intent");
    if (current.state === "awaiting-approval") {
      return await this.queueApproval(current, challenge);
    }
    this.approvals.set(current.runId, challenge);
    const next = this.transition(current, "awaiting-approval");
    if (!next.ok) {
      this.approvals.delete(current.runId);
    } else {
      recordRuntimeApprovalWaiting(
        this.deps.activityLog,
        current.runId,
        next.snapshot.revision,
        challenge.permission,
      );
    }
    return next;
  }

  private approvalChallenge(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): ApprovalChallenge | undefined {
    if (!event.permissionRequest?.actionKind) return undefined;
    const requested = Date.parse(event.permissionRequest.expiresAt);
    const nowMs = this.now().getTime();
    if (!Number.isFinite(requested) || requested <= nowMs) return undefined;
    // Clamp the child-declared lifetime to the server ceiling and re-publish the clamped instant on
    // the permission itself, so the challenge expiry, the operator-visible deadline, and the minted
    // approval TTL are one value the server owns (MAX_APPROVAL_CHALLENGE_TTL_MS).
    const expiresAt = Math.min(requested, nowMs + MAX_APPROVAL_CHALLENGE_TTL_MS);
    return {
      revision: current.revision + 1,
      expiresAt,
      permission: { ...event.permissionRequest, expiresAt: new Date(expiresAt).toISOString() },
      used: false,
    };
  }

  private async queueApproval(
    current: CodingRuntimeSnapshot,
    challenge: ApprovalChallenge,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (!this.approvals.has(current.runId)) {
      return this.stopAfterApprovalFailure(current);
    }
    const queued = this.queuedApprovals.get(current.runId) ?? [];
    const requestId = challenge.permission.requestId;
    if (
      this.approvals.get(current.runId)?.permission.requestId === requestId ||
      queued.some((candidate) => candidate.permission.requestId === requestId)
    ) {
      return this.fail("invalid-intent");
    }
    if (queued.length >= MAX_QUEUED_APPROVALS_PER_RUN) {
      return this.stopAfterApprovalFailure(current);
    }
    queued.push(challenge);
    this.queuedApprovals.set(current.runId, queued);
    recordRuntimeApprovalWaiting(
      this.deps.activityLog,
      current.runId,
      current.revision,
      challenge.permission,
      queued.length,
    );
    return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
  }

  private async promoteQueuedApproval(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const queued = this.queuedApprovals.get(current.runId);
    if (queued === undefined) {
      this.queuedApprovals.delete(current.runId);
      return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
    }
    const challenge = queued.shift();
    if (challenge === undefined) {
      this.queuedApprovals.delete(current.runId);
      return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
    }
    if (challenge.expiresAt <= this.now().getTime()) {
      this.queuedApprovals.delete(current.runId);
      return this.stopAfterApprovalFailure(current, "authority-expired");
    }
    if (queued.length === 0) this.queuedApprovals.delete(current.runId);
    const promoted = { ...challenge, revision: current.revision + 1 };
    this.approvals.set(current.runId, promoted);
    const waiting = this.transition(current, "awaiting-approval");
    if (!waiting.ok) this.approvals.delete(current.runId);
    else
      recordRuntimeApprovalWaiting(
        this.deps.activityLog,
        current.runId,
        waiting.snapshot.revision,
        promoted.permission,
      );
    return waiting;
  }

  private ingestTaskSubmitted(current: CodingRuntimeSnapshot): CodingRuntimeOrchestratorResult {
    if (current.state !== "running") return this.transition(current, "running");
    return this.publishOrRecover(current, "task-submitted");
  }

  private queueTaskSettlement(runId: string, outcome: CodingRuntimeTaskOutcome): void {
    const settlement = this.serial(() => this.settleTask(runId, outcome));
    void settlement.then(
      (): void => undefined,
      (): void => this.deps.safeActivityProjection?.markUnavailable(runId),
    );
  }

  private async settleTask(runId: string, outcome: CodingRuntimeTaskOutcome): Promise<void> {
    const current = this.current();
    if (current?.runId !== runId) return;
    const stopped = await this.stopForSettlement(runId, outcome);
    const live = this.current();
    if (live?.runId !== runId) return;
    const terminalResult = this.deps.manager.result(runId);
    if (!stopped || terminalResult?.status !== outcome) {
      this.transition(live, "recovery-required", "recovery-required");
      return;
    }
    const target = taskOutcomeState(outcome);
    if (!isLegalCodingWorkbenchRuntimeTransition(live.state, target.state)) {
      this.transition(live, "recovery-required", "recovery-required");
      return;
    }
    this.transition(live, target.state, target.failureCode);
  }

  private async stopForSettlement(
    runId: string,
    outcome: CodingRuntimeTaskOutcome,
  ): Promise<boolean> {
    try {
      return (await this.deps.manager.stop(runId, outcome)).ok;
    } catch {
      return false;
    }
  }

  private publishOrRecover(
    current: CodingRuntimeSnapshot,
    eventKind: CodingWorkbenchRuntimeEvent["kind"],
    auxiliary?: AuxiliaryEventFacts,
  ): CodingRuntimeOrchestratorResult {
    return this.projection.publish(current, eventKind, auxiliary)
      ? { ok: true, snapshot: this.publicSnapshotWithDescription(current) }
      : this.transition(current, "recovery-required", "recovery-required");
  }

  /** Startup containment: persisted nonterminal executions are never replayed. */
  startupReconcile(): Promise<void> {
    return this.serial(() => {
      this.startupReconcileNow();
      return Promise.resolve();
    });
  }

  /** Synchronous bootstrap boundary used before the HTTP dependency graph becomes observable. */
  startupReconcileNow(): void {
    this.deps.snapshots.markNonterminalRecoveryRequired(this.now().toISOString());
    // #3401: a description attempt still `dispatched` from a prior process has no live promise to
    // resume — it is reconciled to a closed blocked status, never silently re-run or lost.
    this.reconcileInterruptedDescriptionJobs(this.description);
    for (const snapshot of this.deps.snapshots
      .listRecentActive(1)
      .filter(({ state }) => state === "recovery-required")) {
      this.deps.evidence.observe(snapshot.runId, {
        kind: "state-transition",
        state: "recovery-required",
        failureCode: "recovery-required",
      });
      this.deps.evidence.settle({
        runId: snapshot.runId,
        state: "recovery-required",
        revision: snapshot.revision,
        settledAt: snapshot.updatedAt,
        failureCode: "recovery-required",
        taskDigest: snapshot.taskDigest,
        workspaceDigest: snapshot.workspaceDigest,
        operatorDigest: snapshot.operatorDigest,
        authorityDigest: snapshot.authorityDigest,
        bindingDigest: snapshot.bindingDigest,
        provenanceDigest: snapshot.provenanceDigest,
      });
      this.deps.safeActivityProjection?.markUnavailable(snapshot.runId);
    }
    this.pruneSettled();
    this.activeRunId = this.deps.snapshots.listRecentActive(1)[0]?.runId;
    this.settledRunId =
      this.activeRunId === undefined ? latestSettledRunId(this.deps.snapshots) : undefined;
  }
  shutdown(): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    if (current) return this.end("stop", current.runId, { requestId: current.runId });
    this.deps.safeActivityProjection?.purgeAll("shutdown");
    return Promise.resolve({ ok: true, snapshot: this.projection.idle() });
  }

  // A proof that could not run (IDENTITY_PROOF_FAILED, logged at its source) is an authority the
  // start cannot resolve right now — fail closed, never launch against an unproven workspace.
  private activeWorkspaceOrUndefined(): ActiveWorkspaceView | undefined {
    try {
      return this.deps.workspaceLifecycle.getActive();
    } catch (error) {
      if (isIdentityProofFailure(error)) return undefined;
      throw error;
    }
  }

  private async startFresh(
    input: unknown,
    predecessorRunId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const parsed = parseCodingWorkbenchRuntimeStartRequest(input);
    if (!parsed.ok || this.activeRunId)
      return this.fail(parsed.ok ? "active-run-conflict" : "invalid-intent");
    // A proof that could not run (IDENTITY_PROOF_FAILED, logged at its source) is an authority the
    // start cannot resolve right now — fail closed, never launch against an unproven workspace.
    const active = this.activeWorkspaceOrUndefined();
    const principal = this.deps.serverPrincipal();
    if (!active || !principal) return this.fail("authority-resolution-failed");
    const runId = this.newRunId();
    const issue = await this.admitIssue(parsed.value, active, runId, predecessorRunId);
    if (!issue.ok) return issue;
    const resolved = await this.resolveLaunch(
      parsed.value,
      active,
      principal,
      runId,
      issue.binding,
    );
    if (!resolved.ok) return this.fail(resolved.failureCode);
    const launch = resolved.launch;
    const snapshot = this.buildStartSnapshot(
      parsed.value,
      active,
      principal,
      runId,
      launch,
      predecessorRunId,
      issue.binding,
    );
    this.deps.snapshots.create(snapshot);
    this.activeRunId = runId;
    this.settledRunId = undefined;
    this.activeEffectiveMode = launch.effectiveMode;
    recordRuntimeRunStarted(this.deps.activityLog, snapshot, launch.effectiveMode);
    if (predecessorRunId !== undefined) this.settlePredecessorRecovery(predecessorRunId);
    this.projection.publish(snapshot);
    const started = await this.startManagedRuntime(parsed.value, active, runId, launch);
    if (started !== undefined) return started;
    return this.runInitialTurn(parsed.value, runId, issue.attachment);
  }

  private admitIssue(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
    predecessorRunId?: string,
  ): ReturnType<typeof admitCodingRuntimeIssue> {
    return admitCodingRuntimeIssue({
      request,
      active,
      runId,
      priorBinding:
        predecessorRunId === undefined
          ? undefined
          : this.deps.snapshots.get(predecessorRunId)?.issueBinding,
      intake: this.deps.issueIntake,
      activityLog: this.deps.activityLog,
      deploymentCeiling: this.deps.deploymentCeiling,
    });
  }

  private async runInitialTurn(
    request: CodingWorkbenchRuntimeStartRequest,
    runId: string,
    attachment?: CodingRuntimeIssueAttachment,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const ready = this.transitionActive("ready");
    if (!ready.ok) return ready;
    // #3390: this orchestrator-local snapshot is a separate object from runtimeAuthorityService's
    // runtimeState (synced independently by productionCodingRuntimePorts.ts's
    // startProductionRuntime, well before this method runs) -- moving this transition earlier
    // does NOT itself admit the reservePromptTokens race; that race is closed in
    // runtimeAuthorityService.ts (PROMPT_RESERVATION_ADMISSIBLE_STATES, which now also admits
    // "starting", the actual runtimeState during the managed runtime's own start()). What this
    // move does fix is the run's own public projection: settling into "running" BEFORE dispatch,
    // instead of only after the sidecar accepts, means an operator never observes "ready" while
    // this orchestrator has already asked the sidecar to run a model turn. "running" is a legal
    // target out of "ready" (LEGAL_TRANSITIONS), and "running" itself still has legal "failed" /
    // "recovery-required" exits, so the dispatch-failure branches below are unaffected.
    const running = this.transitionActive("running");
    if (!running.ok) return running;
    // Captured now, not re-read after the dispatch: this is the exact internal snapshot the
    // dispatch below is admitted against (running.snapshot.revision), so advancing FROM it on
    // acceptance is guaranteed to move the live revision exactly one step past what the dispatch
    // consumed.
    const runningInternal = this.current();
    if (!isExactRunRevision(runningInternal, runId, running.snapshot.revision)) {
      return this.transitionActive("recovery-required", "recovery-required");
    }
    const initialTurn = await this.operations.startInitialTurn({
      runId,
      requestId: request.requestId,
      expectedRevision: runningInternal.revision,
      taskIntent: request.taskIntent,
      ...(attachment === undefined ? {} : { initialContext: renderInitialTurnContext(attachment) }),
    });
    if (initialTurn === "accepted" && attachment !== undefined) {
      this.deps.activityLog?.write({
        category: "process",
        op: "coding-runtime.run.issue-context-attached",
        correlationId: runId,
        extra: {
          runId,
          issueNumber: attachment.issueNumber,
          itemCount: attachment.itemCount,
          byteCount: attachment.byteCount,
        },
      });
    }
    // Every OTHER guarded mutation (follow-up dispatch, question answer/reject) advances the live
    // revision in the SAME call that commits its production-guard reservation
    // (codingRuntimeOperationCoordinator.ts's submitFollowUp/applyAnswer via advanceRevision) --
    // the per-run ProductionRuntimeOperationGuard (productionCodingRuntimePorts.ts) depends on that
    // invariant: it marks the committed expectedRevision as consumed and admits only a STRICTLY
    // newer revision afterward (any read or mutation included -- #2386's own regression pin
    // spells this out: "the mutation consumed revision 3: stale reads and stale mutations both
    // stay rejected"). The initial turn's own dispatch is a guarded mutation exactly like those,
    // but used to return the unchanged `running` snapshot on acceptance -- the one guarded mutation
    // that never advanced the live revision. That left every read (question listing) or write
    // (answer/reject) issued at the run's own still-current revision permanently rejected as
    // authority-resolution-failed, from the moment the initial turn was accepted onward (epic
    // #3384). Advancing here restores the same one-bump-per-accepted-dispatch invariant every
    // other guarded mutation already provides.
    if (initialTurn === "accepted") return this.advanceRevision(runningInternal, "task-submitted");
    if (initialTurn === "failed") {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "initial-turn-dispatch");
      return this.transitionActive("failed", "runtime-failed");
    }
    recordRuntimeStartFailure(this.deps.diagnostics, runId, "initial-turn-recovery");
    return this.transitionActive("recovery-required", "recovery-required");
  }

  private async resolveLaunch(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    principal: string,
    runId: string,
    issueBinding?: CodingWorkbenchIssueBinding,
  ): Promise<
    | { readonly ok: true; readonly launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]> }
    | { readonly ok: false; readonly failureCode: CodingWorkbenchRuntimeFailureCode }
  > {
    try {
      const input = {
        runId,
        requestId: request.requestId,
        taskIntent: request.taskIntent,
        requestedMode: request.requestedMode,
        ...(request.runtimePreference ? { runtimePreference: request.runtimePreference } : {}),
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        workspaceId: active.instance.workspaceId,
        workspaceRoot: active.binding.activeRoot,
        serverPrincipal: principal,
        ...(issueBinding === undefined ? {} : { issueBinding }),
      };
      await this.deps.launchResolver.prepare?.(input);
      const launch = this.deps.launchResolver.resolve(input);
      return { ok: true, launch };
    } catch (error) {
      // Never a bare `catch {}`: a rejected launch used to lose its identity here and surface as
      // `authority-resolution-failed` whatever the real cause was (KEIKO-0150).
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "launch-resolution", error);
      return { ok: false, failureCode: classifyLaunchRejection(error) };
    }
  }

  private buildStartSnapshot(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    principal: string,
    runId: string,
    launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>,
    predecessorRunId?: string,
    issueBinding?: CodingWorkbenchIssueBinding,
  ): CodingRuntimeSnapshot {
    const now = this.now().toISOString();
    return {
      schemaVersion: "1",
      runId,
      state: "starting",
      revision: 1,
      requestedMode: request.requestedMode,
      runtimeSource: launch.runtimeSource,
      modelSource: launch.modelSource,
      createdAt: now,
      updatedAt: now,
      taskDigest: DIGEST(launch.taskRef),
      workspaceDigest: DIGEST(active.binding.activeRoot),
      operatorDigest: DIGEST(principal),
      authorityDigest: DIGEST(launch.treeBindingId),
      bindingDigest: DIGEST(active.instance.workspaceId),
      provenanceDigest: DIGEST(`${launch.adapterKind}:${launch.executablePath}`),
      toolCallCount: 0,
      patchByteCount: 0,
      modelRequestCount: 0,
      ...(predecessorRunId ? { predecessorRunId } : {}),
      ...(issueBinding === undefined ? {} : { issueBinding }),
    };
  }

  /** Returns the failure transition when the managed runtime did not reach a trusted start. */
  private async startManagedRuntime(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
    launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    let result: Awaited<ReturnType<CodingRuntimeManager["start"]>>;
    try {
      result = await this.deps.manager.start({
        ...launch,
        runId,
        workspaceRoot: active.binding.activeRoot,
        requestedMode: request.requestedMode,
      });
    } catch (error) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "manager-exception", error);
      // Recovery-required remains the only safe projection when host containment cannot be proven.
      await this.reconcileQuietly(runId);
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (result.ok && result.runId !== runId) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "run-mismatch");
      // A mismatched host success cannot be trusted; recovery remains fail-closed.
      await this.reconcileQuietly(result.runId);
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (!result.ok) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, result.failureCode);
      return this.transitionActive("failed", "runtime-failed");
    }
    return undefined;
  }

  private async reconcileQuietly(runId: string): Promise<void> {
    try {
      await this.deps.manager.reconcile(runId);
    } catch {
      // Recovery-required remains the only safe projection when host containment cannot be proven.
    }
  }

  private advanceRevision(
    current: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ): CodingRuntimeOrchestratorResult {
    const next = this.deps.snapshots.transition(current.runId, {
      state: current.state,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    return this.projection.publish(next, eventKind)
      ? { ok: true, snapshot: this.publicSnapshotWithDescription(next) }
      : this.transition(next, "recovery-required", "recovery-required");
  }

  private async end(
    kind: "stop" | "takeover",
    runId: string,
    input: unknown,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const parsed = this.parseEndRequest(kind, input);
    const current = this.current();
    if (!this.isEndRequestConsistent(parsed, runId, current)) return this.fail("invalid-intent");
    if (!current) return this.stopSettledRun(kind, runId);
    if (current.state === "recovery-required") return this.fail("recovery-required");
    this.deps.safeActivityProjection?.purge(runId, kind === "stop" ? "stop" : "takeover");
    const stopping = this.createEndStoppingTransition(kind, current);
    if (!stopping.ok) return stopping;
    const result = await this.executeEndRequest(kind, current.runId);
    return this.completeEndRequest(kind, runId, result);
  }

  private stopSettledRun(
    kind: "stop" | "takeover",
    runId: string,
  ): CodingRuntimeOrchestratorResult {
    const settled = kind === "stop" ? this.deps.snapshots.get(runId) : undefined;
    if (settled === undefined || !TERMINAL_STATES.has(settled.state)) {
      return { ok: true, snapshot: this.projection.idle() };
    }
    this.deps.safeActivityProjection?.purge(runId, "stop");
    return { ok: true, snapshot: this.projection.idle() };
  }

  private completeEndRequest(
    kind: "stop" | "takeover",
    runId: string,
    result: Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined,
  ): CodingRuntimeOrchestratorResult {
    if (this.hasActiveRunChanged(runId)) return this.fail("runtime-failed");
    if (result?.ok) {
      const settled = this.endSettledResult(runId);
      if (settled !== undefined) return settled;
      return this.transitionActive(this.endSuccessState(kind));
    }
    return this.transitionActive("recovery-required", "recovery-required");
  }

  private parseEndRequest(
    kind: "stop" | "takeover",
    input: unknown,
  ):
    | ReturnType<typeof parseCodingWorkbenchRuntimeStopRequest>
    | ReturnType<typeof parseCodingWorkbenchRuntimeTakeoverRequest> {
    return kind === "stop"
      ? parseCodingWorkbenchRuntimeStopRequest(input)
      : parseCodingWorkbenchRuntimeTakeoverRequest(input);
  }

  private isEndRequestConsistent(
    parsed:
      | ReturnType<typeof parseCodingWorkbenchRuntimeStopRequest>
      | ReturnType<typeof parseCodingWorkbenchRuntimeTakeoverRequest>,
    runId: string,
    current: CodingRuntimeSnapshot | undefined,
  ): boolean {
    if (!parsed.ok || parsed.value.requestId !== runId) return false;
    return current === undefined || current.runId === runId;
  }

  private createEndStoppingTransition(
    kind: "stop" | "takeover",
    current: CodingRuntimeSnapshot,
  ): CodingRuntimeOrchestratorResult {
    return kind === "stop"
      ? this.transition(current, "stopping")
      : { ok: true as const, snapshot: this.publicSnapshotWithDescription(current) };
  }

  private async executeEndRequest(
    kind: "stop" | "takeover",
    runId: string,
  ): Promise<Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined> {
    try {
      return kind === "stop"
        ? await this.deps.manager.stop(runId)
        : await this.deps.manager.takeover(runId);
    } catch {
      this.recordEndRequestException(runId);
      // Recovery-required remains the only safe projection when stop/takeover cannot be trusted.
      return undefined;
    }
  }

  private recordEndRequestException(runId: string): void {
    this.deps.evidence.observe(runId, {
      kind: "state-transition",
      state: "recovery-required",
      failureCode: "recovery-required",
    });
  }

  private hasActiveRunChanged(runId: string): boolean {
    return this.activeRunId !== undefined && this.activeRunId !== runId;
  }

  private endSettledResult(runId: string): CodingRuntimeOrchestratorResult | undefined {
    const settled = this.deps.snapshots.get(runId);
    if (
      this.activeRunId === undefined &&
      settled !== undefined &&
      TERMINAL_STATES.has(settled.state)
    ) {
      return { ok: true, snapshot: this.publicSnapshotWithDescription(settled) };
    }
    return undefined;
  }

  private endSuccessState(kind: "stop" | "takeover"): CodingWorkbenchRuntimeStateName {
    return kind === "stop" ? "cancelled" : "taken-over";
  }

  private transitionActive(
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    const current = this.current();
    return current ? this.transition(current, state, failureCode) : this.fail("runtime-failed");
  }
  private transition(
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    if (!isLegalCodingWorkbenchRuntimeTransition(current.state, state)) {
      return this.fail("invalid-intent");
    }
    const next = this.createTransitionSnapshot(current, state, failureCode);
    const published = this.publishTransition(next);
    this.recordTransitionEvidence(next, state, failureCode);
    if (this.shouldTransitionToRecoveryRequired(published, state)) {
      return this.transition(next, "recovery-required", "recovery-required");
    }
    this.finalizeTransitionIfTerminal(next, state, failureCode);
    return { ok: true, snapshot: this.publicSnapshotWithDescription(next) };
  }

  private createTransitionSnapshot(
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeSnapshot {
    const result = TERMINAL_STATES.has(state) ? this.deps.manager.result(current.runId) : undefined;
    return this.deps.snapshots.transition(current.runId, {
      state,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
      ...(failureCode ? { failureCode } : {}),
      ...(result === undefined ? {} : { result }),
    });
  }

  private publishTransition(next: CodingRuntimeSnapshot): boolean {
    return this.projection.publish(next);
  }

  private recordTransitionEvidence(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    this.deps.evidence.observe(next.runId, {
      kind: "state-transition",
      state,
      ...(failureCode ? { failureCode } : {}),
    });
  }

  private shouldTransitionToRecoveryRequired(
    published: boolean,
    state: CodingWorkbenchRuntimeStateName,
  ): boolean {
    return !published && !TERMINAL_STATES.has(state) && state !== "recovery-required";
  }

  private finalizeTransitionIfTerminal(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    if (state === "recovery-required") {
      this.deps.safeActivityProjection?.markUnavailable(next.runId);
    } else if (!TERMINAL_STATES.has(state)) {
      return;
    } else {
      this.purgeExplicitlyEndedActivity(next.runId, state);
    }
    recordRuntimeRunSettled(this.deps.activityLog, next, state, failureCode);
    this.publishSettlement(next, state, failureCode);
    if (state === "succeeded") this.dispatchDescriptionIfEligible(next);
  }

  /**
   * #3401: overlays the durable description status onto every public snapshot projection. The
   * underlying value is read fresh from the job store on every call (never cached on
   * `CodingRuntimeSnapshot`), so a status written by an in-flight dispatch after `next`/`current`
   * was captured is still visible on the very next poll or transition response.
   */
  private publicSnapshotWithDescription(
    snapshot: CodingRuntimeSnapshot | undefined,
  ): PublicSnapshot {
    const base = this.projection.publicSnapshot(snapshot);
    const persisted =
      snapshot === undefined ? undefined : this.description?.jobs.current(snapshot.runId);
    const status =
      snapshot === undefined || persisted === undefined
        ? persisted
        : this.reconcileDescriptionProposal(snapshot, persisted);
    return status === undefined ? base : { ...base, descriptionStatus: status };
  }

  private reconcileDescriptionProposal(
    snapshot: CodingRuntimeSnapshot,
    status: WorkbenchDescriptionStatus,
  ): WorkbenchDescriptionStatus {
    if (status.proposalId === undefined || status.snapshotDigest === null) return status;
    const support = this.description;
    const scope = this.descriptionScope(snapshot);
    if (
      isRetainedDescriptionProposal(
        support,
        scope,
        status,
        status.proposalId,
        status.snapshotDigest,
      )
    ) {
      return status;
    }
    const stale = support?.jobs.markProposalLost(
      snapshot.runId,
      status.proposalId,
      this.now().toISOString(),
    );
    if (stale?.reason === "stale-snapshot" && stale.proposalId === undefined) {
      this.logDescriptionEvent(scope ?? { runId: snapshot.runId }, "stale", {
        reason: "stale-snapshot",
        proposalRetained: false,
      });
    }
    return stale ?? status;
  }

  /**
   * #3401 AC "a repaired head after CI repair regenerates": the CI-repair loop (#3388) pushes a new
   * verified commit for an ALREADY-succeeded run, well after this orchestrator's one-time terminal
   * transition already fired. That owner calls this after recording the new successful commit so
   * the same dedup/coalesce/supersede path in `dispatchDescriptionIfEligible` reconsiders the
   * bound run's description job for the new head — a public seam rather than a second dispatcher.
   */
  notifyVerifiedHeadAdvanced(runId: string): void {
    const snapshot = this.deps.snapshots.get(runId);
    if (snapshot !== undefined) this.dispatchDescriptionIfEligible(snapshot);
  }

  /** Returns an exact transient generic draft only while its durable status remains current. */
  reviewDescriptionDraft(
    runId: string,
    proposalId: string,
    snapshotDigest: string,
  ): PrDescriptionDraftPreview | undefined {
    const support = this.description;
    if (support === undefined) return undefined;
    const snapshot = this.deps.snapshots.get(runId);
    if (snapshot === undefined) return undefined;
    const status = support.jobs.current(runId);
    if (!matchesDescriptionProposal(status, proposalId, snapshotDigest)) return undefined;
    const scope = this.descriptionScope(snapshot);
    if (scope === undefined || scope.applicationTarget !== undefined) return undefined;
    if (!isRetainedDescriptionProposal(support, scope, status, proposalId, snapshotDigest))
      return undefined;
    const reviewDraft = support.dispatcher?.reviewDraft;
    if (reviewDraft === undefined) return undefined;
    const review = reviewDraft(scope, proposalId, snapshotDigest);
    if (review !== undefined)
      this.logDescriptionEvent(scope, "reviewed", { proposalRetained: true });
    return review;
  }

  /**
   * #3401 composition seam: `createCodingRuntimeOrchestrator`'s constructor is called from
   * `codingRuntimeControlPlane.ts` before the real dispatcher (deps.ts's snapshot capture +
   * description authority + Model Gateway generation chain) can be composed, so production wiring
   * cannot pass `description` at construction time. This lets deps.ts attach it immediately after
   * control-plane construction instead. Runs the SAME startup reconciliation
   * `startupReconcileNow` already ran with `description` absent, so an attempt left `dispatched` by
   * a prior process is still closed to `blocked`/`interrupted` exactly once, never resumed or lost
   * regardless of how late in composition the real support arrives.
   */
  attachDescriptionSupport(support: CodingRuntimeDescriptionSupport): void {
    this.description = support;
    this.reconcileInterruptedDescriptionJobs(support);
  }

  private reconcileInterruptedDescriptionJobs(
    support: CodingRuntimeDescriptionSupport | undefined,
  ): void {
    for (const runId of support?.jobs.reconcileInterrupted(this.now().toISOString()) ?? []) {
      this.logDescriptionEvent({ runId }, "blocked", { reason: "interrupted" });
    }
  }

  // #3401: fires only for a stable succeeded head with a persisted VerifiedCommitResult (correction
  // 5 — the workspace's best-effort `lastVerifiedHead` is never the trigger). Dispatches AT MOST
  // ONE generation attempt per (runId, remoteDigest, baseSha, headSha); a repeated identical signal
  // or a still-in-flight attempt for the same head coalesces, and a new head supersedes.
  private dispatchDescriptionIfEligible(next: CodingRuntimeSnapshot): void {
    const support = this.description;
    if (support === undefined) return;
    const scope = this.descriptionScope(next);
    if (scope === undefined) return;
    const nowIso = this.now().toISOString();
    const decision = support.jobs.beginDispatch(scope, nowIso);
    if (decision.kind === "coalesced") {
      this.logDescriptionEvent(scope, "coalesced", {
        generationVersion: decision.status?.generationVersion,
      });
      return;
    }
    if (decision.kind === "budget-exhausted") {
      support.jobs.recordBudgetExhausted(scope, nowIso);
      this.logDescriptionEvent(scope, "blocked", { reason: "budget-exhausted" as const });
      return;
    }
    if (decision.supersededPriorAttempt) this.logDescriptionEvent(scope, "superseded", {});
    this.runDescriptionDispatch(
      support,
      scope,
      decision.generationVersion,
      decision.revision,
      nowIso,
    );
  }

  private descriptionScope(next: CodingRuntimeSnapshot): WorkbenchDescriptionScope | undefined {
    if (next.state !== "succeeded") return undefined;
    const commit = this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(next.runId);
    if (commit?.headSha === undefined) return undefined;
    const workspace = this.activeWorkspaceOrUndefined();
    const applicationTarget = descriptionApplicationTarget(next, workspace, commit.headSha);
    const acceptedMode = this.settledEffectiveModes.get(next.runId);
    return {
      runId: next.runId,
      remoteDigest: commit.repositoryDigest,
      baseSha: commit.baseSha,
      headSha: commit.headSha,
      ...(acceptedMode === undefined ? {} : { acceptedMode }),
      ...descriptionComparisonRefs(next, workspace, {
        baseRef: commit.baseSha,
        headRef: commit.headSha,
      }),
      generationBinding: descriptionGenerationBinding(next),
      ...(applicationTarget === undefined ? {} : { applicationTarget }),
    };
  }

  private runDescriptionDispatch(
    support: CodingRuntimeDescriptionSupport,
    scope: WorkbenchDescriptionScope,
    generationVersion: number,
    revision: number,
    nowIso: string,
  ): void {
    this.logDescriptionEvent(scope, "dispatched", { generationVersion });
    if (support.dispatcher === undefined) {
      support.jobs.recordBlocked(
        scope,
        "generation-unavailable",
        generationVersion,
        revision,
        nowIso,
      );
      this.logDescriptionEvent(scope, "blocked", { reason: "generation-unavailable" as const });
      return;
    }
    const controller = new AbortController();
    this.descriptionDispatchAbort.get(scope.runId)?.abort();
    this.descriptionDispatchAbort.set(scope.runId, controller);
    support.dispatcher
      .generate(scope, controller.signal)
      .then((outcome) => {
        this.settleDescriptionDispatch(support, scope, generationVersion, revision, outcome);
      })
      .catch((error: unknown) => {
        const accepted = support.jobs.recordBlocked(
          scope,
          "provider-failed",
          generationVersion,
          revision,
          this.now().toISOString(),
        );
        this.logDescriptionEvent(
          scope,
          accepted ? "blocked" : "superseded",
          { reason: "provider-failed" as const },
          errorKindOf(error),
        );
      });
  }

  private isDescriptionScopeCurrent(scope: WorkbenchDescriptionScope): boolean {
    const current = this.deps.snapshots.get(scope.runId);
    const commit = this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(scope.runId);
    return (
      current?.state === "succeeded" &&
      commit?.headSha === scope.headSha &&
      commit.baseSha === scope.baseSha &&
      commit.repositoryDigest === scope.remoteDigest &&
      canonicalise(descriptionGenerationBinding(current)) === canonicalise(scope.generationBinding)
    );
  }

  private settleDescriptionDispatch(
    support: CodingRuntimeDescriptionSupport,
    scope: WorkbenchDescriptionScope,
    generationVersion: number,
    revision: number,
    outcome: WorkbenchDescriptionDispatchOutcome,
  ): void {
    const observedAt = this.now().toISOString();
    const reason = this.isDescriptionScopeCurrent(scope) ? outcome.reason : "stale-snapshot";
    const status: WorkbenchDescriptionStatus = {
      schemaVersion: "1",
      runId: scope.runId,
      remoteDigest: scope.remoteDigest,
      baseSha: scope.baseSha,
      headSha: scope.headSha,
      ...(scope.generationBinding === undefined
        ? {}
        : { generationBinding: scope.generationBinding }),
      generationVersion,
      state: WORKBENCH_DESCRIPTION_REASON_STATES[reason],
      reason,
      snapshotDigest: outcome.snapshotDigest ?? null,
      draftDigest: outcome.draftDigest ?? null,
      artifactOutcome: outcome.artifactOutcome ?? null,
      ...(reason === outcome.reason && outcome.proposalId !== undefined
        ? { proposalId: outcome.proposalId }
        : {}),
      observedAt,
    };
    const accepted = support.jobs.settle(scope, generationVersion, revision, status, observedAt);
    this.logDescriptionEvent(scope, accepted ? descriptionSettleOp(reason) : "superseded", {
      generationVersion,
      reason,
    });
  }

  // #3401 review: `op` used to be a template literal (`coding-runtime.description.${event}`),
  // which the op-catalog generator cannot resolve to a fixed set of literals and which
  // `support-analyze.ts`'s issue-to-PR journey phase map cannot recognise under any name. One
  // fixed literal op with `event` carried in `extra` (mirroring how every other dispatch-lifecycle
  // event on this file's sibling ops is distinguished by an `extra` field, not by the op string
  // itself) keeps this catalog-resolvable and journey-reconstructable.
  private logDescriptionEvent(
    identity: Pick<WorkbenchDescriptionScope, "runId" | "generationBinding"> & {
      readonly remoteDigest?: string;
    },
    event:
      | "dispatched"
      | "coalesced"
      | "superseded"
      | "blocked"
      | "generated"
      | "failed"
      | "stale"
      | "reviewed",
    extra: Readonly<Record<string, unknown>>,
    errorKind?: string,
  ): void {
    this.deps.activityLog?.write({
      category: "process",
      op: "coding-runtime.description",
      correlationId: runtimeDiagnosticCorrelationId(identity.runId),
      ...(errorKind === undefined ? {} : { errorKind }),
      extra: {
        runId: identity.runId,
        remoteDigest: identity.remoteDigest,
        event,
        ...extra,
        ...(identity.generationBinding === undefined
          ? {}
          : {
              generationBindingDigest: sha256Hex(canonicalise(identity.generationBinding)),
            }),
      },
    });
  }

  private purgeExplicitlyEndedActivity(
    runId: string,
    state: CodingWorkbenchRuntimeStateName,
  ): void {
    if (state !== "cancelled" && state !== "taken-over") return;
    this.deps.safeActivityProjection?.purge(runId, state === "taken-over" ? "takeover" : "stop");
  }

  private publishSettlement(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    this.deps.evidence.settle({
      runId: next.runId,
      state,
      revision: next.revision,
      settledAt: next.updatedAt,
      ...(failureCode ? { failureCode } : {}),
      taskDigest: next.taskDigest,
      workspaceDigest: next.workspaceDigest,
      operatorDigest: next.operatorDigest,
      authorityDigest: next.authorityDigest,
      bindingDigest: next.bindingDigest,
      provenanceDigest: next.provenanceDigest,
    });
    if (TERMINAL_STATES.has(state)) {
      if (this.activeEffectiveMode !== undefined) {
        this.settledEffectiveModes.set(next.runId, this.activeEffectiveMode);
      }
      this.activeRunId = undefined;
      this.settledRunId = next.runId;
    }
    if (TERMINAL_STATES.has(state) || state === "recovery-required")
      this.activeEffectiveMode = undefined;
    this.approvals.delete(next.runId);
    this.queuedApprovals.delete(next.runId);
    this.operations.clear(next.runId);
    this.pruneSettled();
  }
  private pruneSettled(): void {
    const pruned = this.deps.snapshots.listPrunableSettled();
    if (pruned.length > 0) {
      this.deps.evidence.deletePruned(pruned);
      this.deps.eventHub.deleteRuns(pruned);
      this.deps.snapshots.deletePruned(pruned);
      // #3401 review: descriptionDispatchAbort is per-run bookkeeping like the three stores above
      // and must not outlive a pruned run. #3401 review finding F7: a dispatch still in flight for
      // a pruned run must be cancelled, not merely forgotten, mirroring the supersede path above
      // (this.descriptionDispatchAbort.get(scope.runId)?.abort()) — otherwise the outstanding
      // Model Gateway/snapshot-capture call keeps running to completion after nothing references
      // it any more.
      for (const runId of pruned) {
        this.descriptionDispatchAbort.get(runId)?.abort();
        this.descriptionDispatchAbort.delete(runId);
        this.settledEffectiveModes.delete(runId);
      }
    }
  }
  private current(): CodingRuntimeSnapshot | undefined {
    return this.activeRunId ? this.deps.snapshots.get(this.activeRunId) : undefined;
  }
  private fail(failureCode: CodingWorkbenchRuntimeFailureCode): CodingRuntimeOrchestratorResult {
    return { ok: false, failureCode };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private serialValue<T>(work: () => T): Promise<T> {
    return this.serial(() => Promise.resolve(work()));
  }
}

function taskOutcomeState(outcome: CodingRuntimeTaskOutcome): {
  readonly state: "failed" | "succeeded";
  readonly failureCode?: "runtime-failed" | undefined;
} {
  return outcome === "succeeded"
    ? { state: "succeeded" }
    : { state: "failed", failureCode: "runtime-failed" };
}

function effectiveModeAfterResume(
  result: CodingRuntimeOrchestratorResult,
  effectiveMode: CodingWorkbenchMode,
): CodingWorkbenchMode | undefined {
  return result.ok &&
    (result.snapshot.state === "running" || result.snapshot.state === "awaiting-approval")
    ? effectiveMode
    : undefined;
}

function resumeAdmission(
  current: CodingRuntimeSnapshot | undefined,
  runId: string,
  input: unknown,
  activeEffectiveMode: CodingWorkbenchMode | undefined,
): ResumeAdmission | undefined {
  const parsed = parseCodingWorkbenchRuntimeResumeRequest(input);
  if (!parsed.ok || parsed.value.requestId !== runId || current?.state !== "paused") {
    return undefined;
  }
  return {
    current,
    requestedMode: parsed.value.requestedMode ?? activeEffectiveMode ?? current.requestedMode,
  };
}

export function createCodingRuntimeOrchestrator(
  deps: CodingRuntimeOrchestratorDeps,
  description?: CodingRuntimeDescriptionSupport,
): CodingRuntimeOrchestrator {
  return new CodingRuntimeOrchestrator(deps, description);
}

/** The most recently updated terminal row, if any — the run a restarted BFF still shows as settled. */
function latestSettledRunId(
  snapshots: Pick<CodingRuntimeSnapshotStore, "listAll">,
): string | undefined {
  return snapshots.listAll(1).find((row) => row.terminalAt !== undefined)?.runId;
}
