import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  isLegalCodingWorkbenchRuntimeTransition,
  validateCodingWorkbenchRuntimeSnapshot,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type {
  ApprovalChallenge,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
} from "./codingRuntimeOrchestratorTypes.js";

const terminal = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

export interface RuntimeStateOperations {
  readonly beginContainment: (runId: string) => void;
  readonly fail: (
    failureCode: CodingWorkbenchRuntimeFailureCode,
  ) => CodingRuntimeOrchestratorResult;
  readonly idle: () => PublicSnapshot;
  readonly public: (snapshot: CodingRuntimeSnapshot | undefined) => PublicSnapshot;
  readonly pruneSettled: () => void;
  readonly publish: (
    snapshot: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ) => boolean;
  readonly published: (
    snapshot: CodingRuntimeSnapshot,
    eventKind: CodingWorkbenchRuntimeEvent["kind"],
  ) => CodingRuntimeOrchestratorResult;
  readonly recoverAfterPublicationFailure: (
    snapshot: CodingRuntimeSnapshot,
  ) => CodingRuntimeOrchestratorResult;
  readonly transition: (
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ) => CodingRuntimeOrchestratorResult;
  readonly transitionActive: (
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ) => CodingRuntimeOrchestratorResult;
}

interface RuntimeStateContext {
  readonly deps: CodingRuntimeOrchestratorDeps;
  readonly now: () => Date;
  readonly approvals: Map<string, ApprovalChallenge>;
  readonly containments: Map<string, Promise<void>>;
  readonly activeRunId: () => string | undefined;
  readonly setActiveRunId: (runId: string | undefined) => void;
  readonly current: () => CodingRuntimeSnapshot | undefined;
}

// eslint-disable-next-line max-lines-per-function -- Cohesive state transition closure shares one mutable lifecycle context.
export function createRuntimeStateOperations(context: RuntimeStateContext): RuntimeStateOperations {
  const fail = (
    failureCode: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult => ({
    ok: false,
    failureCode,
  });
  const idle = (): PublicSnapshot => ({
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    state: "idle",
    revision: 0,
    updatedAt: context.now().toISOString(),
  });
  const publicSnapshot = (snapshot: CodingRuntimeSnapshot | undefined): PublicSnapshot => {
    if (!snapshot) return idle();
    const out: PublicSnapshot = {
      schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
      state: snapshot.state,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      runId: snapshot.runId,
      requestedMode: snapshot.requestedMode,
      runtimeSource: snapshot.runtimeSource,
      modelSource: snapshot.modelSource,
      ...(snapshot.failureCode ? { failureCode: snapshot.failureCode } : {}),
      ...(snapshot.state === "recovery-required" && snapshot.recoveryAcknowledgedAt
        ? { recoveryAcknowledged: true as const }
        : {}),
      ...(snapshot.state === "awaiting-approval" && context.approvals.get(snapshot.runId)
        ? { pendingPermission: context.approvals.get(snapshot.runId)?.permission }
        : {}),
    };
    if (!validateCodingWorkbenchRuntimeSnapshot(out).ok)
      throw new Error("invalid runtime snapshot projection");
    return out;
  };
  const publish = (
    snapshot: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ): boolean =>
    context.deps.eventHub.publish(
      eventKind
        ? {
            schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
            kind: "runtime-event",
            runId: snapshot.runId,
            state: snapshot.state,
            revision: snapshot.revision,
            eventKind,
          }
        : {
            schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
            kind: "status",
            runId: snapshot.runId,
            state: snapshot.state,
            revision: snapshot.revision,
            ...(snapshot.failureCode ? { failureCode: snapshot.failureCode } : {}),
          },
    ).ok;
  const pruneSettled = (): void => {
    const pruned = context.deps.snapshots.listPrunableSettled();
    if (pruned.length > 0) {
      context.deps.evidence.deletePruned(pruned);
      context.deps.eventHub.deleteRuns(pruned);
      context.deps.snapshots.deletePruned(pruned);
    }
  };
  const beginContainment = (runId: string): void => {
    if (context.containments.has(runId)) return;
    const containment = containRuntime(context, runId);
    context.containments.set(runId, containment);
    void containment.then(() => {
      if (context.containments.get(runId) === containment) context.containments.delete(runId);
    });
  };
  const transition = (
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult => {
    if (!isLegalCodingWorkbenchRuntimeTransition(current.state, state))
      return fail("invalid-intent");
    const next = context.deps.snapshots.transition(current.runId, {
      state,
      revision: current.revision + 1,
      updatedAt: context.now().toISOString(),
      ...(failureCode ? { failureCode } : {}),
    });
    const published = publish(next);
    context.deps.evidence.observe(next.runId, {
      kind: "state-transition",
      state,
      ...(failureCode ? { failureCode } : {}),
    });
    if (!published && !terminal.has(state) && state !== "recovery-required") {
      beginContainment(next.runId);
      return transition(next, "recovery-required", "recovery-required");
    }
    if (terminal.has(state) || state === "recovery-required")
      settleRuntime(context, next, state, failureCode, pruneSettled);
    return { ok: true, snapshot: publicSnapshot(next) };
  };
  const transitionActive = (
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult => {
    const current = context.current();
    return current ? transition(current, state, failureCode) : fail("runtime-failed");
  };
  const recoverAfterPublicationFailure = (
    snapshot: CodingRuntimeSnapshot,
  ): CodingRuntimeOrchestratorResult => {
    beginContainment(snapshot.runId);
    return transition(snapshot, "recovery-required", "recovery-required");
  };
  const published = (
    snapshot: CodingRuntimeSnapshot,
    eventKind: CodingWorkbenchRuntimeEvent["kind"],
  ): CodingRuntimeOrchestratorResult =>
    publish(snapshot, eventKind)
      ? { ok: true, snapshot: publicSnapshot(snapshot) }
      : recoverAfterPublicationFailure(snapshot);
  return {
    beginContainment,
    fail,
    idle,
    public: publicSnapshot,
    pruneSettled,
    publish,
    published,
    recoverAfterPublicationFailure,
    transition,
    transitionActive,
  };
}

async function containRuntime(context: RuntimeStateContext, runId: string): Promise<void> {
  try {
    await context.deps.taskDispatcher.abort(runId);
  } catch {
    /* Manager reconciliation remains mandatory before recovery clears. */
  }
  try {
    await context.deps.manager.stop(runId);
  } catch {
    /* Recovery acknowledgement requires both reconciliations. */
  }
}

function settleRuntime(
  context: RuntimeStateContext,
  snapshot: CodingRuntimeSnapshot,
  state: CodingWorkbenchRuntimeStateName,
  failureCode: CodingWorkbenchRuntimeFailureCode | undefined,
  pruneSettled: () => void,
): void {
  context.deps.evidence.settle({
    runId: snapshot.runId,
    state,
    revision: snapshot.revision,
    settledAt: snapshot.updatedAt,
    ...(failureCode ? { failureCode } : {}),
    taskDigest: snapshot.taskDigest,
    workspaceDigest: snapshot.workspaceDigest,
    operatorDigest: snapshot.operatorDigest,
    authorityDigest: snapshot.authorityDigest,
    bindingDigest: snapshot.bindingDigest,
    provenanceDigest: snapshot.provenanceDigest,
  });
  if (terminal.has(state)) context.setActiveRunId(undefined);
  context.approvals.delete(snapshot.runId);
  pruneSettled();
}
