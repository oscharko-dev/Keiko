import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  validateCodingWorkbenchRuntimeSnapshot,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimePendingPermission,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
} from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";

export class CodingRuntimeOrchestratorState {
  public constructor(
    private readonly deps: {
      readonly eventHub: CodingRuntimeEventHub;
      readonly now: () => Date;
      readonly pendingPermission: (
        runId: string,
      ) => CodingWorkbenchRuntimePendingPermission | undefined;
    },
  ) {}

  public publicSnapshot(snapshot: CodingRuntimeSnapshot | undefined): PublicSnapshot {
    if (!snapshot) return this.idle();
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
      ...(snapshot.state === "awaiting-approval" && this.deps.pendingPermission(snapshot.runId)
        ? { pendingPermission: this.deps.pendingPermission(snapshot.runId) }
        : {}),
    };
    if (!validateCodingWorkbenchRuntimeSnapshot(out).ok) {
      throw new Error("invalid runtime snapshot projection");
    }
    return out;
  }

  public idle(): PublicSnapshot {
    return {
      schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
      state: "idle",
      revision: 0,
      updatedAt: this.deps.now().toISOString(),
    };
  }

  public publish(
    snapshot: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ): boolean {
    return this.deps.eventHub.publish(
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
  }
}
