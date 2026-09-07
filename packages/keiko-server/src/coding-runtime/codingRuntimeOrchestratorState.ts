import type {
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";

/**
 * The content-free auxiliary facts an ingested runtime event forwards onto its SSE frame. Both are
 * closed vocabularies, never content: the #2387 normalized outcome, and the #2637 trust
 * classification of the page text an accepted research read handed to the model. Without this the
 * fields exist on the SSE contract and are read by the timeline but are never populated, so an
 * exhausted budget renders like a plain success and a research read renders without its provenance.
 */
export interface AuxiliaryEventFacts {
  readonly auxiliaryOutcome?: CodingWorkbenchRuntimeEvent["auxiliaryOutcome"];
  readonly contentTrust?: CodingWorkbenchRuntimeEvent["contentTrust"];
}

/** Projects the forwardable auxiliary facts off an ingested runtime event. */
export function auxiliaryEventFacts(event: CodingWorkbenchRuntimeEvent): AuxiliaryEventFacts {
  return {
    ...(event.auxiliaryOutcome === undefined ? {} : { auxiliaryOutcome: event.auxiliaryOutcome }),
    ...(event.contentTrust === undefined ? {} : { contentTrust: event.contentTrust }),
  };
}

export class CodingRuntimeOrchestratorState {
  public constructor(
    private readonly deps: {
      readonly eventHub: CodingRuntimeEventHub;
      readonly now: () => Date;
      readonly pendingPermission: (
        runId: string,
      ) => CodingWorkbenchRuntimePendingPermission | undefined;
      readonly effectiveMode: (runId: string) => CodingWorkbenchMode | undefined;
    },
  ) {}

  public publicSnapshot(snapshot: CodingRuntimeSnapshot | undefined): PublicSnapshot {
    if (!snapshot) return this.idle();
    const effectiveMode = this.deps.effectiveMode(snapshot.runId);
    const out: PublicSnapshot = {
      schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
      state: snapshot.state,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      runId: snapshot.runId,
      requestedMode: snapshot.requestedMode,
      ...(effectiveMode === undefined ? {} : { effectiveMode }),
      runtimeSource: snapshot.runtimeSource,
      modelSource: snapshot.modelSource,
      ...(snapshot.failureCode ? { failureCode: snapshot.failureCode } : {}),
      ...(snapshot.state === "recovery-required" && snapshot.recoveryAcknowledgedAt
        ? { recoveryAcknowledged: true as const }
        : {}),
      ...(snapshot.state === "awaiting-approval" && this.deps.pendingPermission(snapshot.runId)
        ? { pendingPermission: this.deps.pendingPermission(snapshot.runId) }
        : {}),
      ...snapshotDetail(snapshot),
    };
    const validated = validateCodingWorkbenchRuntimeSnapshot(out);
    if (!validated.ok) {
      throw new Error(`invalid runtime snapshot projection: ${validated.errors.join(", ")}`);
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
    auxiliary?: AuxiliaryEventFacts,
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
            ...(auxiliary?.auxiliaryOutcome === undefined
              ? {}
              : { auxiliaryOutcome: auxiliary.auxiliaryOutcome }),
            ...(auxiliary?.contentTrust === undefined
              ? {}
              : { contentTrust: auxiliary.contentTrust }),
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

function snapshotDetail(snapshot: CodingRuntimeSnapshot): Partial<PublicSnapshot> {
  return {
    ...(snapshot.result === undefined ? {} : { result: snapshot.result }),
    ...(snapshot.issueBinding === undefined ? {} : { issueBinding: snapshot.issueBinding }),
    ...(snapshot.draftDelivery === undefined ? {} : { draftDelivery: snapshot.draftDelivery }),
    ...(snapshot.ciReadiness === undefined ? {} : { ciReadiness: snapshot.ciReadiness }),
    ...(snapshot.verifiedCommitResult === undefined
      ? {}
      : { verifiedCommitResult: snapshot.verifiedCommitResult }),
  };
}
