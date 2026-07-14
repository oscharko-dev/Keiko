/** Server-owned, single-slot lifecycle coordinator for the Coding Workbench (issue #2256). */
import { createHash, randomUUID } from "node:crypto";
import {
  isLegalCodingWorkbenchRuntimeTransition,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimePendingPermission,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
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
    this.newRunId = deps.newRunId ?? ((): string => randomUUID());
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

  // eslint-disable-next-line max-lines-per-function -- Closed approval state transition.
  decideApproval(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    // eslint-disable-next-line complexity, max-lines-per-function -- Closed approval state transition.
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
        if (!principal) return this.transition(current, "failed", "authority-resolution-failed");
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
          this.approvals.delete(current.runId);
          try {
            const stopped = await this.deps.manager.stop(current.runId);
            return stopped.ok
              ? this.transition(current, "failed", "authority-resolution-failed")
              : this.transition(current, "recovery-required", "recovery-required");
          } catch {
            return this.transition(current, "recovery-required", "recovery-required");
          }
        }
        if (!issued.ok) return this.transition(current, "failed", "runtime-failed");
      }
      this.approvals.delete(current.runId);
      return this.transition(
        current,
        parsed.value.decision === "approved" ? "running" : "failed",
        parsed.value.decision === "approved" ? undefined : "revoked",
      );
    });
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
    // eslint-disable-next-line complexity -- Closed runtime event state transition.
    return this.serialValue(() => {
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
      if (event.kind === "task-submitted") {
        return current.state === "running"
          ? this.projection.publish(current, event.kind)
            ? { ok: true, snapshot: this.projection.publicSnapshot(current) }
            : this.transition(current, "recovery-required", "recovery-required")
          : this.transition(current, "running");
      }
      if (event.kind === "runtime-stopped") return this.transition(current, "cancelled");
      if (event.kind === "failure-redacted")
        return this.transition(current, "failed", "runtime-failed");
      return this.projection.publish(current, event.kind)
        ? { ok: true, snapshot: this.projection.publicSnapshot(current) }
        : this.transition(current, "recovery-required", "recovery-required");
    });
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
    }
    this.pruneSettled();
    this.activeRunId = this.deps.snapshots.listRecentActive(1)[0]?.runId;
  }
  shutdown(): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    return current
      ? this.end("stop", current.runId, { requestId: current.runId })
      : Promise.resolve({ ok: true, snapshot: this.projection.idle() });
  }

  // eslint-disable-next-line complexity, max-lines-per-function -- Closed lifecycle state transition.
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
    const now = this.now().toISOString();
    let launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>;
    try {
      launch = this.deps.launchResolver.resolve({
        runId,
        requestId: parsed.value.requestId,
        taskIntent: parsed.value.taskIntent,
        requestedMode: parsed.value.requestedMode,
        ...(parsed.value.runtimePreference
          ? { runtimePreference: parsed.value.runtimePreference }
          : {}),
        workspaceId: active.instance.workspaceId,
        workspaceRoot: active.binding.activeRoot,
        serverPrincipal: principal,
      });
    } catch {
      return this.fail("authority-resolution-failed");
    }
    const snapshot: CodingRuntimeSnapshot = {
      schemaVersion: "1",
      runId,
      state: "starting",
      revision: 1,
      requestedMode: parsed.value.requestedMode,
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
    this.deps.snapshots.create(snapshot);
    this.activeRunId = runId;
    this.projection.publish(snapshot);
    let result: Awaited<ReturnType<CodingRuntimeManager["start"]>>;
    try {
      result = await this.deps.manager.start({
        ...launch,
        runId,
        workspaceRoot: active.binding.activeRoot,
        requestedMode: parsed.value.requestedMode,
      });
    } catch {
      try {
        await this.deps.manager.reconcile(runId);
      } catch {
        // Recovery-required remains the only safe projection when host containment cannot be proven.
      }
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (result.ok && result.runId !== runId) {
      try {
        await this.deps.manager.reconcile(result.runId);
      } catch {
        // A mismatched host success cannot be trusted; recovery remains fail-closed.
      }
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (!result.ok) return this.transitionActive("failed", "runtime-failed");
    const ready = this.transitionActive("ready");
    if (!ready.ok) return ready;
    const initialTurn = await this.operations.startInitialTurn({
      runId,
      requestId: parsed.value.requestId,
      expectedRevision: ready.snapshot.revision,
      taskIntent: parsed.value.taskIntent,
    });
    return initialTurn === "accepted"
      ? this.transitionActive("running")
      : initialTurn === "failed"
        ? this.transitionActive("failed", "runtime-failed")
        : this.transitionActive("recovery-required", "recovery-required");
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
    return result?.ok
      ? this.transitionActive(kind === "stop" ? "cancelled" : "taken-over")
      : this.transitionActive("recovery-required", "recovery-required");
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
