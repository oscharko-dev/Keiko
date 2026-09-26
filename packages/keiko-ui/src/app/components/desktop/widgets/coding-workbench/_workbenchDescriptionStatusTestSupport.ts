import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { WorkbenchDescriptionStatus } from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
import type { PrDescriptionArtifact } from "@oscharko-dev/keiko-contracts/runtime/pr-description";

const digest = "a".repeat(64);
const ARTIFACT_KINDS = {
  add: 0,
  modify: 1,
  delete: 0,
  rename: 0,
  copy: 0,
  "mode-change": 0,
  binary: 0,
  submodule: 0,
} as const;
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

export function genericDescriptionArtifact(): PrDescriptionArtifact {
  const evidenceId = "e".repeat(64);
  return {
    schemaVersion: "1",
    renderingVersion: "1",
    binding: {
      repositoryId: "repository-1",
      baseRef: "dev",
      baseSha: "1".repeat(40),
      headRef: "feature",
      headSha: "2".repeat(40),
      mergeBaseSha: "1".repeat(40),
      snapshotDigest: "b".repeat(64),
    },
    language: "en",
    outcome: "complete",
    reason: "none",
    coverage: {
      snapshot: {
        totalFiles: 1,
        files: 1,
        hunks: 1,
        bytes: 10,
        omittedFiles: 0,
        omittedHunks: 0,
        truncatedFiles: 0,
        kinds: ARTIFACT_KINDS,
        omissions: [],
      },
      suppliedEvidenceCount: 1,
      processedEvidenceCount: 1,
      omittedEvidenceCount: 0,
    },
    candidate: {
      summary: [{ text: "Generic Workbench draft", evidenceIds: [evidenceId] }],
      keyChanges: [{ text: "One bounded change", evidenceIds: [evidenceId] }],
      risks: [],
      reviewerFocus: [],
    },
    markdown: "## Summary\n\nGeneric Workbench draft",
    artifactDigest: "c".repeat(64),
  };
}
