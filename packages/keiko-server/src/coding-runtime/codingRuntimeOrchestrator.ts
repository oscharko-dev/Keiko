/** Server-owned, single-slot lifecycle coordinator for the Coding Workbench (issue #2256). */
import { createHash, randomUUID } from "node:crypto";
import {
  isLegalCodingWorkbenchRuntimeTransition,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeResumeRequest,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeResearchRevokeRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeApprovalDecisionRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimePendingApprovalReview,
  type CodingWorkbenchRuntimePendingPermission,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimePendingResearch,
  type CodingWorkbenchRuntimeResearchGrant,
  type CodingWorkbenchRuntimeStartRequest,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import { reviewableResearchAsk } from "./researchApprovalIssuance.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import {
  auxiliaryEventFacts,
  CodingRuntimeOrchestratorState,
  type AuxiliaryEventFacts,
} from "./codingRuntimeOrchestratorState.js";
import type {
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";
import type { CodingRuntimeTaskOutcome } from "./productionCodingRuntimeHost.js";

function runtimePauseFailureCode(
  code: "authority-expired" | "authority-resolution-failed" | "runtime-run-mismatch",
): CodingWorkbenchRuntimeFailureCode {
  return code === "runtime-run-mismatch" ? "authority-resolution-failed" : code;
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

const DIGEST = (value: string): string => createHash("sha256").update(value).digest("hex");
const terminal = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);
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
  private activeEffectiveMode: CodingWorkbenchMode | undefined;
  private readonly approvals = new Map<string, ApprovalChallenge>();
  private readonly operations: CodingRuntimeOperationCoordinator;
  private readonly projection: CodingRuntimeOrchestratorState;
  private readonly now: () => Date;
  private readonly newRunId: () => string;

  constructor(private readonly deps: CodingRuntimeOrchestratorDeps) {
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
      publicSnapshot: (current): PublicSnapshot => this.projection.publicSnapshot(current),
      taskDispatcher: deps.taskDispatcher,
      settleTask: (runId, outcome): void => {
        this.queueTaskSettlement(runId, outcome);
      },
      questionPort: deps.questionPort,
      manager: deps.manager,
    });
    // Production bootstrap marks stale active rows recovery-required before composition. Restore only
    // that content-free slot; no adapter turn or productive action is ever replayed.
    this.activeRunId = deps.snapshots.listRecentActive(1)[0]?.runId;
  }

  start(input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.startFresh(input));
  }
  retry(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      if (!parseCodingWorkbenchRuntimeStartRequest(input).ok) return this.fail("invalid-intent");
      const prior = this.deps.snapshots.get(runId);
      if (prior?.state !== "recovery-required" || !prior.recoveryAcknowledgedAt)
        return this.fail("invalid-intent");
      if (this.activeRunId !== undefined && this.activeRunId !== runId)
        return this.fail("active-run-conflict");
      this.activeRunId = undefined;
      this.activeEffectiveMode = undefined;
      try {
        return await this.startFresh(input, runId);
      } finally {
        this.restoreUnsettledRecoverySlot(runId);
      }
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

  /** Settles the retried predecessor once — and only once — its successor holds the active slot. */
  private settlePredecessorRecovery(predecessorRunId: string): void {
    const prior = this.deps.snapshots.get(predecessorRunId);
    if (prior?.state !== "recovery-required" || prior.terminalAt !== undefined) return;
    this.deps.snapshots.releaseRecoveryForRetry(predecessorRunId, this.now().toISOString());
    this.deps.safeActivityProjection?.purge(predecessorRunId, "stop");
    this.pruneSettled();
  }
  snapshot(): PublicSnapshot {
    return this.activeRunId
      ? this.projection.publicSnapshot(this.deps.snapshots.get(this.activeRunId))
      : this.projection.idle();
  }
  status(): PublicSnapshot {
    return this.snapshot();
  }
  getSnapshot(runId: string): PublicSnapshot | undefined {
    const snapshot = this.deps.snapshots.get(runId);
    return snapshot ? this.projection.publicSnapshot(snapshot) : undefined;
  }

  submitFollowUp(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.submitFollowUp(runId, input);
  }

  listQuestions(runId: string, input: unknown): Promise<CodingRuntimeQuestionOperationResult> {
    return this.operations.listQuestions(runId, input);
  }

  answerQuestion(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.answerQuestion(runId, input);
  }

  rejectQuestion(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.rejectQuestion(runId, input);
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
    return this.serialValue(() => this.resumeCurrent(runId, input));
  }

  private resumeCurrent(runId: string, input: unknown): CodingRuntimeOrchestratorResult {
    const admitted = resumeAdmission(this.current(), runId, input, this.activeEffectiveMode);
    if (admitted === undefined) return this.fail("invalid-intent");
    const approval = this.approvals.get(runId);
    if (approval !== undefined && approval.expiresAt <= this.now().getTime()) {
      this.approvals.delete(runId);
      return this.transition(admitted.current, "failed", "authority-expired");
    }
    const resumed = this.deps.manager.resume(runId, admitted.requestedMode);
    if (!resumed.ok) return this.fail(runtimePauseFailureCode(resumed.failureCode));
    const effectiveMode = resumed.effectiveMode ?? admitted.requestedMode;
    this.activeEffectiveMode = effectiveMode;
    const nextState = approval === undefined ? "running" : "awaiting-approval";
    const transitioned = this.transition(admitted.current, nextState);
    this.activeEffectiveMode = effectiveModeAfterResume(transitioned, effectiveMode);
    return transitioned;
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
    const domains = [...new Set(grants.flatMap((grant) => grant.domains))].sort((left, right) =>
      left.localeCompare(right),
    );
    const expiresAtMs = Math.max(...grants.map((grant) => grant.expiresAtMs));
    return { grantId: newest.grantId, domains, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  decideApproval(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      const admitted = this.validateApprovalDecision(runId, input);
      if (admitted === undefined) return this.fail("invalid-intent");
      const { decision, current, challenge, actionKind } = admitted;
      challenge.used = true;
      if (decision === "approved") {
        const rejection = await this.issueApprovedAuthority(current, challenge, actionKind);
        if (rejection !== undefined) return rejection;
      }
      const permissionSettled = await this.resolveRuntimePermission(
        current.runId,
        challenge.permission.requestId,
        decision,
      );
      if (!permissionSettled) {
        this.approvals.delete(current.runId);
        return this.stopAfterIssueFailure(current);
      }
      this.approvals.delete(current.runId);
      if (decision === "denied") {
        const stopped = await this.deps.manager.stop(current.runId);
        if (!stopped.ok) {
          return this.transition(current, "recovery-required", "recovery-required");
        }
      }
      return this.transition(
        current,
        decision === "approved" ? "running" : "failed",
        decision === "approved" ? undefined : "revoked",
      );
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
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    const principal = this.deps.serverPrincipal();
    if (!principal) return this.transition(current, "failed", "authority-resolution-failed");
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
        ttlMs: Math.max(1, challenge.expiresAt - this.now().getTime()),
        boundRevision: challenge.revision,
      });
    } catch {
      this.approvals.delete(current.runId);
      return this.stopAfterIssueFailure(current);
    }
    if (!issued.ok) return this.transition(current, "failed", "runtime-failed");
    return undefined;
  }

  private async stopAfterIssueFailure(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    try {
      const stopped = await this.deps.manager.stop(current.runId);
      return stopped.ok
        ? this.transition(current, "failed", "authority-resolution-failed")
        : this.transition(current, "recovery-required", "recovery-required");
    } catch {
      return this.transition(current, "recovery-required", "recovery-required");
    }
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
      this.deps.snapshots.acknowledgeRecovery(current.runId, this.now().toISOString());
      return { ok: true, snapshot: this.projection.publicSnapshot(this.current()) };
    });
  }

  /** Accepts only manager events for the current slot and projects no event content into durable state. */
  ingest(event: CodingWorkbenchRuntimeEvent): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => this.ingestCurrent(event));
  }

  private ingestCurrent(event: CodingWorkbenchRuntimeEvent): CodingRuntimeOrchestratorResult {
    const current = this.current();
    if (event.runId !== current?.runId) return this.fail("invalid-intent");
    const paused = this.ingestPausedEvent(current, event);
    return paused ?? this.ingestActiveEvent(current, event);
  }

  private ingestPausedEvent(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): CodingRuntimeOrchestratorResult | undefined {
    const terminal = event.kind === "runtime-stopped" || event.kind === "failure-redacted";
    if (current.state !== "paused" || terminal) return undefined;
    if (event.kind === "permission-requested" && !this.stashApproval(current, event)) {
      return this.fail("invalid-intent");
    }
    return { ok: true, snapshot: this.projection.publicSnapshot(current) };
  }

  private ingestActiveEvent(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): CodingRuntimeOrchestratorResult {
    if (event.kind === "permission-requested") {
      return this.ingestPermissionRequested(current, event);
    }
    if (event.kind === "task-submitted") return this.ingestTaskSubmitted(current);
    if (event.kind === "runtime-stopped") return this.ingestRuntimeStopped(current);
    if (event.kind === "failure-redacted") {
      return this.transition(current, "failed", "runtime-failed");
    }
    return this.publishOrRecover(current, event.kind, auxiliaryEventFacts(event));
  }

  /**
   * The runtime process is gone. `cancelled` is legal only from the states an operator-initiated
   * stop passes through (`starting`, `stopping`); from every live state the machine rejects it, so
   * this ingest used to fail closed SILENTLY — no transition, no evidence record, no SSE frame —
   * and a dead runtime kept presenting as `running` until the separate task-settlement wait gave
   * up (OPEN_CODE_MAX_TURN_WAIT_MS, 30 minutes). A runtime that exits under a live run terminates
   * that run, the same terminal projection a non-zero exit already produces through
   * `failure-redacted`; the exit code itself reaches the operator diagnostic sink, not this
   * content-free lifecycle projection.
   */
  private ingestRuntimeStopped(current: CodingRuntimeSnapshot): CodingRuntimeOrchestratorResult {
    return isLegalCodingWorkbenchRuntimeTransition(current.state, "cancelled")
      ? this.transition(current, "cancelled")
      : this.transition(current, "failed", "runtime-failed");
  }

  private ingestPermissionRequested(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): CodingRuntimeOrchestratorResult {
    if (!this.stashApproval(current, event)) return this.fail("invalid-intent");
    const next = this.transition(current, "awaiting-approval");
    if (!next.ok) this.approvals.delete(current.runId);
    return next;
  }

  private stashApproval(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): boolean {
    if (!event.permissionRequest?.actionKind) return false;
    const requested = Date.parse(event.permissionRequest.expiresAt);
    const nowMs = this.now().getTime();
    if (!Number.isFinite(requested) || requested <= nowMs) return false;
    // Clamp the child-declared lifetime to the server ceiling and re-publish the clamped instant on
    // the permission itself, so the challenge expiry, the operator-visible deadline, and the minted
    // approval TTL are one value the server owns (MAX_APPROVAL_CHALLENGE_TTL_MS).
    const expiresAt = Math.min(requested, nowMs + MAX_APPROVAL_CHALLENGE_TTL_MS);
    this.approvals.set(current.runId, {
      revision: current.revision + 1,
      expiresAt,
      permission: { ...event.permissionRequest, expiresAt: new Date(expiresAt).toISOString() },
      used: false,
    });
    return true;
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
      ? { ok: true, snapshot: this.projection.publicSnapshot(current) }
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
  }
  shutdown(): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    if (current) return this.end("stop", current.runId, { requestId: current.runId });
    this.deps.safeActivityProjection?.purgeAll("shutdown");
    return Promise.resolve({ ok: true, snapshot: this.projection.idle() });
  }

  private async startFresh(
    input: unknown,
    predecessorRunId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const parsed = parseCodingWorkbenchRuntimeStartRequest(input);
    if (!parsed.ok || this.activeRunId)
      return this.fail(parsed.ok ? "active-run-conflict" : "invalid-intent");
    const active = this.deps.workspaceLifecycle.getActive();
    const principal = this.deps.serverPrincipal();
    if (!active || !principal) return this.fail("authority-resolution-failed");
    const runId = this.newRunId();
    const launch = this.resolveLaunch(parsed.value, active, principal, runId);
    if (launch === undefined) return this.fail("authority-resolution-failed");
    const snapshot = this.buildStartSnapshot(
      parsed.value,
      active,
      principal,
      runId,
      launch,
      predecessorRunId,
    );
    this.deps.snapshots.create(snapshot);
    this.activeRunId = runId;
    this.activeEffectiveMode = launch.effectiveMode;
    if (predecessorRunId !== undefined) this.settlePredecessorRecovery(predecessorRunId);
    this.projection.publish(snapshot);
    const started = await this.startManagedRuntime(parsed.value, active, runId, launch);
    if (started !== undefined) return started;
    return this.runInitialTurn(parsed.value, runId);
  }

  private async runInitialTurn(
    request: CodingWorkbenchRuntimeStartRequest,
    runId: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const ready = this.transitionActive("ready");
    if (!ready.ok) return ready;
    const initialTurn = await this.operations.startInitialTurn({
      runId,
      requestId: request.requestId,
      expectedRevision: ready.snapshot.revision,
      taskIntent: request.taskIntent,
    });
    if (initialTurn === "accepted") return this.transitionActive("running");
    if (initialTurn === "failed") return this.transitionActive("failed", "runtime-failed");
    return this.transitionActive("recovery-required", "recovery-required");
  }

  private resolveLaunch(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    principal: string,
    runId: string,
  ): ReturnType<CodingRuntimeLaunchResolver["resolve"]> | undefined {
    try {
      return this.deps.launchResolver.resolve({
        runId,
        requestId: request.requestId,
        taskIntent: request.taskIntent,
        requestedMode: request.requestedMode,
        ...(request.runtimePreference ? { runtimePreference: request.runtimePreference } : {}),
        workspaceId: active.instance.workspaceId,
        workspaceRoot: active.binding.activeRoot,
        serverPrincipal: principal,
      });
    } catch {
      return undefined;
    }
  }

  private buildStartSnapshot(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    principal: string,
    runId: string,
    launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>,
    predecessorRunId?: string,
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
    } catch {
      // Recovery-required remains the only safe projection when host containment cannot be proven.
      await this.reconcileQuietly(runId);
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (result.ok && result.runId !== runId) {
      // A mismatched host success cannot be trusted; recovery remains fail-closed.
      await this.reconcileQuietly(result.runId);
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (!result.ok) return this.transitionActive("failed", "runtime-failed");
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
      ? { ok: true, snapshot: this.projection.publicSnapshot(next) }
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
    if (!current) return { ok: true, snapshot: this.projection.idle() };
    if (current.state === "recovery-required") return this.fail("recovery-required");
    this.deps.safeActivityProjection?.purge(runId, kind === "stop" ? "stop" : "takeover");
    const stopping = this.createEndStoppingTransition(kind, current);
    if (!stopping.ok) return stopping;
    const result = await this.executeEndRequest(kind, current.runId);
    return this.completeEndRequest(kind, runId, result);
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
      : { ok: true as const, snapshot: this.projection.publicSnapshot(current) };
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
    if (this.activeRunId === undefined && settled !== undefined && terminal.has(settled.state)) {
      return { ok: true, snapshot: this.projection.publicSnapshot(settled) };
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
    return { ok: true, snapshot: this.projection.publicSnapshot(next) };
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
    return !published && !terminal.has(state) && state !== "recovery-required";
  }

  private finalizeTransitionIfTerminal(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    if (state === "recovery-required") {
      this.deps.safeActivityProjection?.markUnavailable(next.runId);
    } else if (!terminal.has(state)) {
      return;
    } else {
      this.purgeExplicitlyEndedActivity(next.runId, state);
    }
    this.publishSettlement(next, state, failureCode);
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
    if (terminal.has(state)) this.activeRunId = undefined;
    if (terminal.has(state) || state === "recovery-required") this.activeEffectiveMode = undefined;
    this.approvals.delete(next.runId);
    this.operations.clear(next.runId);
    this.pruneSettled();
  }
  private pruneSettled(): void {
    const pruned = this.deps.snapshots.listPrunableSettled();
    if (pruned.length > 0) {
      this.deps.evidence.deletePruned(pruned);
      this.deps.eventHub.deleteRuns(pruned);
      this.deps.snapshots.deletePruned(pruned);
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
  return result.ok && result.snapshot.state === "running" ? effectiveMode : undefined;
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
): CodingRuntimeOrchestrator {
  return new CodingRuntimeOrchestrator(deps);
}
