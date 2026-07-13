/** Server-owned, single-slot lifecycle coordinator for the Coding Workbench (issue #2256). */
import { randomBytes } from "node:crypto";
import {
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import { startFreshRuntime, type ExecutionContext } from "./codingRuntimeOrchestratorExecution.js";
import {
  createRuntimeStateOperations,
  type RuntimeStateOperations,
} from "./codingRuntimeOrchestratorState.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type {
  ApprovalChallenge,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeRecoveryResult,
} from "./codingRuntimeOrchestratorTypes.js";

export type {
  CodingRuntimeApprovalAuthority,
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeRecoveryPort,
  CodingRuntimeRecoveryResult,
  CodingRuntimeTaskDispatcher,
  CodingRuntimeTaskDispatchResult,
  CodingRuntimeTaskOutcome,
} from "./codingRuntimeOrchestratorTypes.js";

function newRuntimeRunId(): string {
  return `run-${BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10)}`;
}

/**
 * Keeps all lifecycle mutation behind one promise tail. This deliberately provides no replay API:
 * after a process restart durable active rows are recovery-required until an operator starts anew.
 */
export class CodingRuntimeOrchestrator {
  private tail: Promise<void> = Promise.resolve();
  private activeRunId: string | undefined;
  private readonly approvals = new Map<string, ApprovalChallenge>();
  private readonly containments = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly state: RuntimeStateOperations;

  constructor(private readonly deps: CodingRuntimeOrchestratorDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.newRunId = deps.newRunId ?? newRuntimeRunId;
    this.state = createRuntimeStateOperations({
      deps,
      now: this.now,
      approvals: this.approvals,
      containments: this.containments,
      activeRunId: () => this.activeRunId,
      setActiveRunId: (runId: string | undefined): void => {
        this.activeRunId = runId;
      },
      current: () => this.current(),
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
      if (
        prior?.state !== "recovery-required" ||
        !prior.recoveryAcknowledgedAt ||
        prior.recoveryHandle !== undefined
      )
        return this.fail("invalid-intent");
      if (this.activeRunId !== undefined && this.activeRunId !== runId)
        return this.fail("active-run-conflict");
      this.deps.snapshots.releaseRecoveryForRetry(runId, this.now().toISOString());
      this.pruneSettled();
      this.activeRunId = undefined;
      return this.startFresh(input, runId);
    });
  }
  snapshot(): PublicSnapshot {
    return this.activeRunId ? this.public(this.deps.snapshots.get(this.activeRunId)) : this.idle();
  }
  status(): PublicSnapshot {
    return this.snapshot();
  }
  getSnapshot(runId: string): PublicSnapshot | undefined {
    const snapshot = this.deps.snapshots.get(runId);
    return snapshot ? this.public(snapshot) : undefined;
  }

  decideApproval(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    // eslint-disable-next-line complexity -- Closed approval state transition.
    return this.serial(async () => {
      const parsed = parseCodingWorkbenchRuntimeApprovalDecisionRequest(input);
      const current = this.current();
      const challenge = this.approvals.get(current?.runId ?? "");
      if (
        !parsed.ok ||
        current?.runId !== runId ||
        current.state !== "awaiting-approval" ||
        challenge?.permission.requestId !== parsed.value.requestId ||
        challenge.used ||
        !challenge.permission.actionKind ||
        challenge.revision !== parsed.value.expectedRevision ||
        challenge.expiresAt <= this.now().getTime()
      )
        return this.fail("invalid-intent");
      challenge.used = true;
      if (parsed.value.decision === "approved") {
        const principal = this.deps.serverPrincipal();
        if (!principal)
          return this.terminateAndSettle(current, "failed", "authority-resolution-failed", true);
        let issued: CodingRuntimeApprovalIssueResult;
        try {
          issued = this.deps.approvalAuthority.issue({
            runId: current.runId,
            requestId: challenge.permission.requestId,
            actionKind: challenge.permission.actionKind,
            ...(challenge.permission.connectorScopes
              ? { connectorScopes: challenge.permission.connectorScopes }
              : {}),
            approvedByUserId: principal,
            ttlMs: Math.max(1, challenge.expiresAt - this.now().getTime()),
          });
        } catch {
          return this.terminateAndSettle(current, "failed", "authority-resolution-failed", true);
        }
        if (!issued.ok) return this.terminateAndSettle(current, "failed", "runtime-failed", true);
      }
      this.approvals.delete(current.runId);
      return parsed.value.decision === "approved"
        ? this.transition(current, "running")
        : this.terminateAndSettle(current, "failed", "revoked", true);
    });
  }

  stop(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.end("stop", runId, input));
  }
  takeover(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.end("takeover", runId, input));
  }
  acknowledgeRecovery(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      const parsed = parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(input);
      const current = this.current();
      if (
        !parsed.ok ||
        current?.runId !== runId ||
        parsed.value.requestId !== runId ||
        current.state !== "recovery-required"
      )
        return this.fail("invalid-intent");
      if (!(await this.reconcileRecovery(current))) return this.fail("recovery-required");
      this.deps.snapshots.acknowledgeRecovery(current.runId, this.now().toISOString());
      return { ok: true, snapshot: this.public(this.current()) };
    });
  }

  /** Accepts only manager events for the current slot and projects no event content into durable state. */
  ingest(event: CodingWorkbenchRuntimeEvent): Promise<CodingRuntimeOrchestratorResult> {
    // eslint-disable-next-line complexity -- Closed runtime event state transition.
    return this.serial(async () => {
      const current = this.current();
      if (event.runId !== current?.runId) return this.fail("invalid-intent");
      if (event.kind === "permission-requested") {
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
      if (event.kind === "task-submitted")
        return current.state === "running"
          ? this.published(current, event.kind)
          : this.transition(current, "running");
      if (event.kind === "runtime-stopped") return this.transition(current, "cancelled");
      if (event.kind === "failure-redacted")
        return this.terminateAndSettle(current, "failed", "runtime-failed", true);
      return this.publish(current, event.kind)
        ? { ok: true, snapshot: this.public(current) }
        : this.recoverAfterPublicationFailure(current);
    });
  }

  /** Startup containment: persisted nonterminal executions are never replayed. */
  startupReconcile(): Promise<void> {
    return this.serial(async () => {
      this.startupReconcileNow();
      const current = this.current();
      if (current?.state === "recovery-required") await this.reconcileRecovery(current);
    });
  }

  reconcileStartupRecovery(): Promise<void> {
    return this.serial(async () => {
      const current = this.current();
      if (current?.state === "recovery-required") await this.reconcileRecovery(current);
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
    }
    this.pruneSettled();
    this.activeRunId = this.deps.snapshots.listRecentActive(1)[0]?.runId;
  }
  shutdown(): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    return current
      ? this.stop(current.runId, { requestId: current.runId })
      : Promise.resolve({ ok: true, snapshot: this.idle() });
  }

  private async reconcileRecovery(snapshot: CodingRuntimeSnapshot): Promise<boolean> {
    if (snapshot.recoveryHandle === undefined) return true;
    await this.containments.get(snapshot.runId);
    let managerResult: Awaited<ReturnType<CodingRuntimeManager["reconcile"]>>;
    try {
      managerResult = await this.deps.manager.reconcile(snapshot.runId);
    } catch {
      return false;
    }
    if (!managerResult.ok) return false;
    let result: CodingRuntimeRecoveryResult;
    try {
      result = await this.deps.recovery.reconcile(snapshot.runId, snapshot.recoveryHandle);
    } catch {
      return false;
    }
    if (result.status !== "reaped" || result.recoveryHandle !== snapshot.recoveryHandle)
      return false;
    this.deps.snapshots.clearRecoveryHandle(
      snapshot.runId,
      snapshot.recoveryHandle,
      this.now().toISOString(),
    );
    this.containments.delete(snapshot.runId);
    return true;
  }

  private executionContext(): ExecutionContext {
    return {
      deps: this.deps,
      now: this.now,
      newRunId: this.newRunId,
      activeRunId: () => this.activeRunId,
      setActiveRunId: (runId: string | undefined): void => {
        this.activeRunId = runId;
      },
      current: () => this.current(),
      fail: (failureCode) => this.fail(failureCode),
      publish: (snapshot) => this.publish(snapshot),
      transition: (current, state, failureCode) => this.transition(current, state, failureCode),
      transitionActive: (state, failureCode) => this.transitionActive(state, failureCode),
      terminateAndSettle: (current, state, failureCode, abortTask) =>
        this.terminateAndSettle(current, state, failureCode, abortTask),
      serial: <T>(work: () => Promise<T>) => this.serial(work),
    };
  }

  private async startFresh(
    input: unknown,
    predecessorRunId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return startFreshRuntime(this.executionContext(), input, predecessorRunId);
  }

  private async terminateAndSettle(
    current: CodingRuntimeSnapshot,
    state: Extract<CodingWorkbenchRuntimeStateName, "cancelled" | "failed" | "succeeded">,
    failureCode: CodingWorkbenchRuntimeFailureCode | undefined,
    abortTask: boolean,
  ): Promise<CodingRuntimeOrchestratorResult> {
    this.approvals.delete(current.runId);
    if (abortTask) {
      try {
        await this.deps.taskDispatcher.abort(current.runId);
      } catch {
        // The manager result below remains the authoritative full-tree reap proof.
      }
    }
    let stopped: Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined;
    try {
      stopped = await this.deps.manager.stop(current.runId);
    } catch {
      stopped = undefined;
    }
    return stopped?.ok
      ? this.transition(current, state, failureCode)
      : this.transition(current, "recovery-required", "recovery-required");
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
    if (!current) return { ok: true, snapshot: this.idle() };
    if (current.runId !== runId) return this.fail("invalid-intent");
    if (current.state === "recovery-required") return this.fail("recovery-required");
    const stopping =
      kind === "stop"
        ? this.transition(current, "stopping")
        : { ok: true as const, snapshot: this.public(current) };
    if (!stopping.ok) return stopping;
    try {
      await this.deps.taskDispatcher.abort(current.runId);
    } catch {
      // The manager remains authoritative for revocation and complete-tree reap.
    }
    let result: Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined;
    try {
      result =
        kind === "stop"
          ? await this.deps.manager.stop(current.runId)
          : await this.deps.manager.takeover(current.runId);
    } catch {
      result = undefined;
    }
    return result?.ok
      ? this.transitionActive(kind === "stop" ? "cancelled" : "taken-over")
      : this.transitionActive("recovery-required", "recovery-required");
  }
  private transitionActive(
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    return this.state.transitionActive(state, failureCode);
  }
  private transition(
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    return this.state.transition(current, state, failureCode);
  }
  private beginContainment(runId: string): void {
    this.state.beginContainment(runId);
  }
  private publish(
    snapshot: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ): boolean {
    return this.state.publish(snapshot, eventKind);
  }
  private published(
    snapshot: CodingRuntimeSnapshot,
    eventKind: CodingWorkbenchRuntimeEvent["kind"],
  ): CodingRuntimeOrchestratorResult {
    return this.state.published(snapshot, eventKind);
  }
  private recoverAfterPublicationFailure(
    snapshot: CodingRuntimeSnapshot,
  ): CodingRuntimeOrchestratorResult {
    return this.state.recoverAfterPublicationFailure(snapshot);
  }
  private pruneSettled(): void {
    this.state.pruneSettled();
  }
  private current(): CodingRuntimeSnapshot | undefined {
    return this.activeRunId ? this.deps.snapshots.get(this.activeRunId) : undefined;
  }
  private public(snapshot: CodingRuntimeSnapshot | undefined): PublicSnapshot {
    return this.state.public(snapshot);
  }
  private idle(): PublicSnapshot {
    return this.state.idle();
  }
  private fail(failureCode: CodingWorkbenchRuntimeFailureCode): CodingRuntimeOrchestratorResult {
    return this.state.fail(failureCode);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createCodingRuntimeOrchestrator(
  deps: CodingRuntimeOrchestratorDeps,
): CodingRuntimeOrchestrator {
  return new CodingRuntimeOrchestrator(deps);
}
