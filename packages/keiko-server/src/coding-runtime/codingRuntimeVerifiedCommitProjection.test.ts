import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { runMigrations } from "../store/schema.js";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import { CodingRuntimeOrchestratorState } from "./codingRuntimeOrchestratorState.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

const at = "2026-09-04T10:00:00.000Z";
const digest = "a".repeat(64);
const receipt: VerifiedCommitResult = {
  schemaVersion: "1",
  proposalId: "commit-1",
  runId: "run-1",
  envelopeDigest: digest,
  runtimeAuthorityDigest: digest,
  workspaceDigest: digest,
  repositoryDigest: digest,
  baseSha: "1".repeat(40),
  parentSha: "2".repeat(40),
  stagedTreeDigest: digest,
  verificationEvidenceId: "verification-1",
  messageDigest: digest,
  status: "succeeded",
  reason: "completed",
  headSha: "3".repeat(40),
  committedTreeDigest: digest,
  recordedAt: at,
};

function persistedSnapshot(
  db: DatabaseSync,
): ReturnType<ReturnType<typeof createCodingRuntimeSnapshotStore>["get"]> {
  runMigrations(db);
  const store = createCodingRuntimeSnapshotStore(db);
  store.create({
    schemaVersion: "1",
    runId: receipt.runId,
    state: "running",
    revision: 0,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: at,
    updatedAt: at,
    taskDigest: digest,
    workspaceDigest: digest,
    operatorDigest: digest,
    authorityDigest: digest,
    bindingDigest: digest,
    provenanceDigest: digest,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  });
  store.recordVerifiedCommit(receipt);
  return createCodingRuntimeSnapshotStore(db).get(receipt.runId);
}

describe("verified commit public runtime receipt", () => {
  it("projects durable commit truth after store reconstruction while the run is still active", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const state = new CodingRuntimeOrchestratorState({
        eventHub: new CodingRuntimeEventHub(),
        now: (): Date => new Date(at),
        pendingPermission: (): undefined => undefined,
        effectiveMode: (): "governed-assist" => "governed-assist",
      });
      const snapshot = state.publicSnapshot(persistedSnapshot(db));
      expect(snapshot).toMatchObject({ state: "running", verifiedCommitResult: receipt });
      expect(validateCodingWorkbenchRuntimeSnapshot(snapshot).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("admits only a closed receipt belonging to the enclosing run", () => {
    const snapshot = {
      schemaVersion: "1",
      state: "running",
      revision: 1,
      updatedAt: at,
      runId: receipt.runId,
      requestedMode: "governed-assist",
      verifiedCommitResult: receipt,
    };
    expect(validateCodingWorkbenchRuntimeSnapshot(snapshot).ok).toBe(true);
    for (const override of [
      { runId: "another-run" },
      { runId: undefined },
      { verifiedCommitResult: { ...receipt, approvalToken: "private fixture" } },
      { verifiedCommitResult: { ...receipt, message: "private fixture" } },
      { verifiedCommitResult: { ...receipt, reason: "approval-required" } },
    ]) {
      expect(validateCodingWorkbenchRuntimeSnapshot({ ...snapshot, ...override }).ok).toBe(false);
    }
  });
});
