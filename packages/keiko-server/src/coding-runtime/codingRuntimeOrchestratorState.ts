import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  validateCodingWorkbenchRuntimeSnapshot,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimePendingPermission,
  type CodingWorkbenchRuntimeResearchGrant,
  type CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
} from "@oscharko-dev/keiko-contracts";

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
      /** Live #2387 research grant projection; undefined when no grant is active for the run. */
      readonly researchGrant: (runId: string) => CodingWorkbenchRuntimeResearchGrant | undefined;
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
      ...projectedResearchGrant(this.deps.researchGrant, snapshot),
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

// The grant rides only on states where the run's authority is still live; terminal and
// recovery-required snapshots never show internet reach (the registry is invalidated on
// revoke/terminate anyway, so this is belt-and-braces at the projection boundary).
const GRANT_VISIBLE_STATES: ReadonlySet<CodingRuntimeSnapshot["state"]> = new Set([
  "starting",
  "ready",
  "running",
  "awaiting-approval",
  "paused",
  "stopping",
]);

function projectedResearchGrant(
  resolve: (runId: string) => CodingWorkbenchRuntimeResearchGrant | undefined,
  snapshot: CodingRuntimeSnapshot,
): Pick<PublicSnapshot, "researchGrant"> {
  if (!GRANT_VISIBLE_STATES.has(snapshot.state)) return {};
  const grant = resolve(snapshot.runId);
  return grant === undefined ? {} : { researchGrant: grant };
}
