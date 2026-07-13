import {
  isDebugLifecycleEvidence,
  type DebugLifecycleEvent,
  type EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
import type { DebugLiveEvidenceProjection } from "./dapLifecycleLedger.js";

export interface DapEvidenceProjector {
  project(workspacePartitionKey: string, projection: DebugLiveEvidenceProjection): Promise<void>;
}

export function createDapEvidenceProjector(store: EvidenceStore): DapEvidenceProjector {
  return {
    project: (partition, projection): Promise<void> =>
      Promise.resolve().then(() => {
        validateProjection(partition, projection);
        store.put(`debug-session-live-${partition}`, projectionJson(projection));
      }),
  };
}

function validateProjection(partition: string, projection: DebugLiveEvidenceProjection): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(partition) ||
    !Number.isSafeInteger(projection.cumulativeEvictedCount) ||
    projection.cumulativeEvictedCount < 0 ||
    projection.records.length > 128 ||
    !projection.records.every(validEvent)
  ) {
    throw new Error("INVALID_DEBUG_EVIDENCE");
  }
}

function validEvent(event: DebugLifecycleEvent): boolean {
  const { sequence, ...evidence } = event;
  return Number.isSafeInteger(sequence) && sequence > 0 && isDebugLifecycleEvidence(evidence);
}

function projectionJson(projection: DebugLiveEvidenceProjection): string {
  return `${JSON.stringify({
    schemaVersion: "1",
    kind: "debugSessionLiveProjection",
    cumulativeEvictedCount: projection.cumulativeEvictedCount,
    records: projection.records,
  })}\n`;
}
