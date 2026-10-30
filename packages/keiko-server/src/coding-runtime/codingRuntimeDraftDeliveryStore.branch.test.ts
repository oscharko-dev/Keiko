import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

// ADR-0085 D1b: the owning runtime store keeps the branch-push record of a run that has no accepted
// issue, with the same compare-and-set revision, phase table and verified-commit binding as an
// issue-bound record, and refuses it for a run that does carry an issue.
const at = "2026-09-05T00:00:00.000Z";
const digest = "a".repeat(64);
const issue = {
  schemaVersion: "1",
  repositoryId: "repository-1",
  remoteDigest: digest,
  issueNumber: 1,
  issueIdDigest: digest,
  defaultBaseRef: "dev",
  contentRevisionDigest: digest,
  bindingDigest: digest,
} as const;
const commit: VerifiedCommitResult = {
  schemaVersion: "1",
  runId: "run-1",
  proposalId: "commit-1",
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
const proposed: DraftDeliveryRecord = {
  schemaVersion: "1",
  revision: 0,
  phase: "push-proposed",
  reason: "approval-required",
  proposalId: "push-1",
  proposalDigest: digest,
  recordedAt: at,
  binding: {
    kind: "branch-push",
    runId: "run-1",
    workspaceDigest: digest,
    runtimeAuthorityDigest: digest,
    envelopeDigest: digest,
    remoteDigest: digest,
    remoteAlias: "origin",
    baseRef: "dev",
    baseSha: "1".repeat(40),
    headRef: "claude/task-1",
    headSha: "3".repeat(40),
    verifiedCommitProposalId: "commit-1",
    recoveryId: "delivery-1",
  },
};

function storeWithRun(
  db: DatabaseSync,
  withIssue = false,
): ReturnType<typeof createCodingRuntimeSnapshotStore> {
  runMigrations(db);
  const store = createCodingRuntimeSnapshotStore(db);
  store.create({
    schemaVersion: "1",
    runId: "run-1",
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
    ...(withIssue ? { issueBinding: issue } : {}),
  });
  store.recordVerifiedCommit(withIssue ? { ...commit, issueBindingDigest: digest } : commit);
  return store;
}

describe("durable branch-push delivery in the owning runtime store", () => {
  it("retains the exact branch intent for an issue-free run across a reconstructed store", () => {
    const db = new DatabaseSync(":memory:");
    try {
      storeWithRun(db).recordDraftDelivery(proposed, null);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      expect(restored?.draftDelivery).toEqual(proposed);
      expect(restored?.issueBinding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("walks the push phases with the same compare-and-set revision and refuses a skipped phase", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const pushing = { ...proposed, phase: "pushing", reason: "in-flight", revision: 1 } as const;
      expect(() =>
        store.recordDraftDelivery({ ...pushing, phase: "pushed", reason: "completed" }, 0),
      ).toThrow("phase transition");
      store.recordDraftDelivery(pushing, 0);
      expect(() => store.recordDraftDelivery(pushing, 0)).toThrow("stale draft delivery revision");
      const pushed = { ...pushing, phase: "pushed", reason: "completed", revision: 2 } as const;
      store.recordDraftDelivery(pushed, 1);
      expect(store.get("run-1")?.draftDelivery).toEqual(pushed);
    } finally {
      db.close();
    }
  });

  it("refuses a branch-push record for a run that carries an accepted issue", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db, true);
      expect(() => store.recordDraftDelivery(proposed, null)).toThrow(TypeError);
      expect(store.get("run-1")?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([
    { headSha: "4".repeat(40) },
    { baseSha: "5".repeat(40) },
    { verifiedCommitProposalId: "other-commit" },
    { envelopeDigest: "b".repeat(64) },
    { remoteDigest: "b".repeat(64) },
    { runtimeAuthorityDigest: "b".repeat(64) },
    { workspaceDigest: "b".repeat(64) },
    { runId: "run-2" },
  ])("refuses branch intent that does not bind the run and verified commit %j", (overrides) => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      expect(() =>
        store.recordDraftDelivery(
          { ...proposed, binding: { ...proposed.binding, ...overrides } },
          null,
        ),
      ).toThrow(TypeError);
      expect(store.get("run-1")?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a pull-request phase for a branch binding", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const pushing = { ...proposed, phase: "pushing", reason: "in-flight", revision: 1 } as const;
      store.recordDraftDelivery(pushing, 0);
      store.recordDraftDelivery(
        { ...pushing, phase: "pushed", reason: "completed", revision: 2 },
        1,
      );
      expect(() =>
        store.recordDraftDelivery(
          { ...pushing, phase: "pr-proposed", reason: "approval-required", revision: 3 },
          2,
        ),
      ).toThrow(TypeError);
    } finally {
      db.close();
    }
  });
});
