import type { DebugLifecycleEvent, EvidenceStore } from "@oscharko-dev/keiko-contracts";
import { isDebugLifecycleEvent } from "@oscharko-dev/keiko-contracts/runtime/debug/debug-lifecycle";
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

// The contract now owns this guard (isDebugLifecycleEvent), so the sequence domain is stated once,
// where the type lives, instead of being re-derived by every consumer through a rest-spread.
function validEvent(event: DebugLifecycleEvent): boolean {
  return isDebugLifecycleEvent(event);
}

function projectionJson(projection: DebugLiveEvidenceProjection): string {
  return `${JSON.stringify({
    schemaVersion: "1",
    kind: "debugSessionLiveProjection",
    cumulativeEvictedCount: projection.cumulativeEvictedCount,
    records: projection.records,
  })}\n`;
}
