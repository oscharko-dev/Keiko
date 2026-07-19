/** Server-owned, single-slot lifecycle coordinator for the Coding Workbench (issue #2256). */
import { createHash, randomUUID } from "node:crypto";
import {
  isLegalCodingWorkbenchRuntimeTransition,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  type CodingWorkbenchRuntimeApprovalDecisionRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimePendingPermission,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeStartRequest,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import { CodingRuntimeOrchestratorState } from "./codingRuntimeOrchestratorState.js";
import type {
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";

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

const DIGEST = (value: string): string => createHash("sha256").update(value).digest("hex");
const terminal = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

/**
 * Keeps all lifecycle mutation behind one promise tail. This deliberately provides no replay API:
 * after a process restart durable active rows are recovery-required until an operator starts anew.
 */
export class CodingRuntimeOrchestrator {
  private tail: Promise<void> = Promise.resolve();
  private activeRunId: string | undefined;
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
    });
    this.operations = new CodingRuntimeOperationCoordinator({
      current: (): CodingRuntimeSnapshot | undefined => this.current(),
      serial: <T>(work: () => Promise<T>): Promise<T> => this.serial(work),
      advanceRevision: (current, eventKind): CodingRuntimeOrchestratorResult =>
        this.advanceRevision(current, eventKind),
      publicSnapshot: (current): PublicSnapshot => this.projection.publicSnapshot(current),
      taskDispatcher: deps.taskDispatcher,
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
      this.deps.snapshots.releaseRecoveryForRetry(runId, this.now().toISOString());
      this.deps.safeActivityProjection?.purge(runId, "stop");
      this.pruneSettled();
      this.activeRunId = undefined;
      return this.startFresh(input, runId);
    });
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
      const result = this.transitionLifecycle(runId, input, "running", "paused");
      // Make pause load-bearing: quiesce the manager's mutation admission. A run-mismatch here
      // means no active runtime remains, so nothing can be admitted anyway; the paused state stands.
      if (result.ok) this.deps.manager.pause(runId);
      return result;
    });
  }

  resume(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const result = this.transitionLifecycle(runId, input, "paused", "running");
      if (result.ok) this.deps.manager.resume(runId);
      return result;
    });
  }

  private transitionLifecycle(
    runId: string,
    input: unknown,
    from: CodingWorkbenchRuntimeStateName,
    to: CodingWorkbenchRuntimeStateName,
  ): CodingRuntimeOrchestratorResult {
    const parsed = parseCodingWorkbenchRuntimeStopRequest(input);
    const current = this.current();
    if (!parsed.ok || parsed.value.requestId !== runId) return this.fail("invalid-intent");
    if (current?.runId !== runId || current.state !== from) return this.fail("invalid-intent");
    return this.transition(current, to);
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
      this.approvals.delete(current.runId);
      return this.transition(
        current,
        decision === "approved" ? "running" : "failed",
        decision === "approved" ? undefined : "revoked",
      );
    });
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
    return this.serialValue(() => {
      const current = this.current();
      if (event.runId !== current?.runId) return this.fail("invalid-intent");
      // A paused run is sticky: adapter events never auto-resume it or open a new approval. Only an
      // explicit resume/answer/stop, or a terminal runtime outcome, leaves the paused state.
      if (
        current.state === "paused" &&
        event.kind !== "runtime-stopped" &&
        event.kind !== "failure-redacted"
      ) {
        return { ok: true, snapshot: this.projection.publicSnapshot(current) };
      }
      if (event.kind === "permission-requested") {
        return this.ingestPermissionRequested(current, event);
      }
      if (event.kind === "task-submitted") return this.ingestTaskSubmitted(current);
      if (event.kind === "runtime-stopped") return this.transition(current, "cancelled");
      if (event.kind === "failure-redacted")
        return this.transition(current, "failed", "runtime-failed");
      return this.publishOrRecover(current, event.kind);
    });
  }

  private ingestPermissionRequested(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): CodingRuntimeOrchestratorResult {
    if (!event.permissionRequest?.actionKind) return this.fail("invalid-intent");
    const expiresAt = Date.parse(event.permissionRequest.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime())
      return this.fail("invalid-intent");
    this.approvals.set(current.runId, {
      revision: current.revision + 1,
      expiresAt,
      permission: event.permissionRequest,
      used: false,
    });
    const next = this.transition(current, "awaiting-approval");
    if (!next.ok) this.approvals.delete(current.runId);
    return next;
  }

  private ingestTaskSubmitted(current: CodingRuntimeSnapshot): CodingRuntimeOrchestratorResult {
    if (current.state !== "running") return this.transition(current, "running");
    return this.publishOrRecover(current, "task-submitted");
  }

  private publishOrRecover(
    current: CodingRuntimeSnapshot,
    eventKind: CodingWorkbenchRuntimeEvent["kind"],
  ): CodingRuntimeOrchestratorResult {
    return this.projection.publish(current, eventKind)
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

  // eslint-disable-next-line complexity -- Closed stop/takeover state transition.
  private async end(
    kind: "stop" | "takeover",
    runId: string,
    input: unknown,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const parsed =
      kind === "stop"
        ? parseCodingWorkbenchRuntimeStopRequest(input)
        : parseCodingWorkbenchRuntimeTakeoverRequest(input);
    const current = this.current();
    if (!parsed.ok || parsed.value.requestId !== runId) return this.fail("invalid-intent");
    if (!current) return { ok: true, snapshot: this.projection.idle() };
    if (current.runId !== runId) return this.fail("invalid-intent");
    if (current.state === "recovery-required") return this.fail("recovery-required");
    this.deps.safeActivityProjection?.purge(runId, kind === "stop" ? "stop" : "takeover");
    const stopping =
      kind === "stop"
        ? this.transition(current, "stopping")
        : { ok: true as const, snapshot: this.projection.publicSnapshot(current) };
    if (!stopping.ok) return stopping;
    let result: Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined;
    try {
      result =
        kind === "stop"
          ? await this.deps.manager.stop(current.runId)
          : await this.deps.manager.takeover(current.runId);
    } catch {
      result = undefined;
    }
    if (result?.ok) {
      // The manager emits `runtime-stopped` while its stop settles; when that ingest already
      // completed the terminal transition, report the settled snapshot instead of failing a stop
      // that provably succeeded. Any non-terminal outcome still falls through fail-closed.
      const settled = this.deps.snapshots.get(runId);
      if (this.activeRunId === undefined && settled !== undefined && terminal.has(settled.state)) {
        return { ok: true, snapshot: this.projection.publicSnapshot(settled) };
      }
      return this.transitionActive(kind === "stop" ? "cancelled" : "taken-over");
    }
    return this.transitionActive("recovery-required", "recovery-required");
  }
  private transitionActive(
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    const current = this.current();
    return current ? this.transition(current, state, failureCode) : this.fail("runtime-failed");
  }
  // eslint-disable-next-line complexity -- Closed runtime state transition.
  private transition(
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    if (!isLegalCodingWorkbenchRuntimeTransition(current.state, state))
      return this.fail("invalid-intent");
    const next = this.deps.snapshots.transition(current.runId, {
      state,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
      ...(failureCode ? { failureCode } : {}),
    });
    const published = this.projection.publish(next);
    this.deps.evidence.observe(next.runId, {
      kind: "state-transition",
      state,
      ...(failureCode ? { failureCode } : {}),
    });
    if (!published && !terminal.has(state) && state !== "recovery-required") {
      return this.transition(next, "recovery-required", "recovery-required");
    }
    if (terminal.has(state) || state === "recovery-required") {
      if (state === "recovery-required")
        this.deps.safeActivityProjection?.markUnavailable(next.runId);
      else
        this.deps.safeActivityProjection?.purge(
          next.runId,
          state === "taken-over" ? "takeover" : "stop",
        );
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
      this.approvals.delete(next.runId);
      this.operations.clear(next.runId);
      this.pruneSettled();
    }
    return { ok: true, snapshot: this.projection.publicSnapshot(next) };
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

export function createCodingRuntimeOrchestrator(
  deps: CodingRuntimeOrchestratorDeps,
): CodingRuntimeOrchestrator {
  return new CodingRuntimeOrchestrator(deps);
}
