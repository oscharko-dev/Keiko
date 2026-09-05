import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { WorkbenchDescriptionStatus } from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";

const digest = "a".repeat(64);
const STATUS: WorkbenchDescriptionStatus = {
  schemaVersion: "1",
  runId: "run-1",
  remoteDigest: digest,
  baseSha: "1".repeat(40),
  headSha: "3".repeat(40),
  generationVersion: 1,
  state: "current",
  reason: "generated",
  snapshotDigest: "b".repeat(64),
  draftDigest: "c".repeat(64),
  artifactOutcome: "complete",
  observedAt: "2026-09-05T00:00:00.000Z",
};

export function descriptionStatusSnapshot(
  overrides: Partial<WorkbenchDescriptionStatus> = {},
): CodingWorkbenchRuntimeSnapshot {
  return structuredClone({
    schemaVersion: "1",
    state: "succeeded",
    revision: 1,
    updatedAt: "2026-09-05T00:00:00.000Z",
    runId: "run-1",
    descriptionStatus: { ...STATUS, ...overrides },
  });
}
