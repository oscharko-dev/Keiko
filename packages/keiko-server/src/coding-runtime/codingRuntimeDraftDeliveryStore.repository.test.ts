import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  DraftDeliveryRecord,
  DraftDeliveryRepositoryBinding,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

// ADR-0086 D13: the owning runtime store keeps the repository-bound record of an issue-free run on a
// verified github.com origin through the push AND the pull-request phases under one unchanging
// target - the persistence layer pins the target across every transition - and refuses it for a run
// that carries an accepted issue.
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
const binding: DraftDeliveryRepositoryBinding = {
  kind: "github-repository",
  runId: "run-1",
  workspaceDigest: digest,
  runtimeAuthorityDigest: digest,
  envelopeDigest: digest,
  remoteDigest: digest,
  repository: "owner/repository",
  remoteAlias: "origin",
  baseRef: "dev",
  baseSha: "1".repeat(40),
  headRef: "claude/task-1",
  headSha: "3".repeat(40),
  verifiedCommitProposalId: "commit-1",
  recoveryId: "delivery-1",
};
const proposed: DraftDeliveryRecord = {
  schemaVersion: "1",
  revision: 0,
  phase: "push-proposed",
  reason: "approval-required",
  proposalId: "push-1",
  proposalDigest: digest,
  recordedAt: at,
  binding,
};
const pullRequest = {
  number: 7,
  externalId: "PR_fixture7",
  url: "https://github.com/owner/repository/pull/7",
  repository: "owner/repository",
  headRepository: "owner/repository",
  headRef: "claude/task-1",
  headSha: "3".repeat(40),
  baseRef: "dev",
  baseSha: "1".repeat(40),
  state: "open",
  isDraft: true,
} as const;

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

describe("durable repository-bound delivery in the owning runtime store", () => {
  it("walks the push and the draft pull request phases under one target", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const steps = [
        { phase: "pushing", reason: "in-flight" },
        { phase: "pushed", reason: "completed" },
        { phase: "pr-proposed", reason: "approval-required" },
        { phase: "creating-pr", reason: "in-flight" },
      ] as const;
      let previous = proposed;
      for (const [index, step] of steps.entries()) {
        const next: DraftDeliveryRecord = { ...previous, ...step, revision: index + 1 };
        store.recordDraftDelivery(next, previous.revision);
        previous = next;
      }
      const created: DraftDeliveryRecord = {
        ...previous,
        phase: "draft-created",
        reason: "completed",
        revision: previous.revision + 1,
        pullRequest,
      };
      store.recordDraftDelivery(created, previous.revision);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      expect(restored?.draftDelivery).toEqual(created);
      expect(restored?.issueBinding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a repository-bound record for a run that carries an accepted issue", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db, true);
      expect(() => store.recordDraftDelivery(proposed, null)).toThrow(TypeError);
      expect(store.get("run-1")?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to change the record's target kind or repository between phases", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const { repository: _repository, ...rest } = binding;
      const branch = { ...rest, kind: "branch-push" } as const;
      const pushing = { ...proposed, phase: "pushing", reason: "in-flight", revision: 1 } as const;
      expect(() => store.recordDraftDelivery({ ...pushing, binding: branch }, 0)).toThrow(
        "target changed",
      );
      expect(() =>
        store.recordDraftDelivery(
          { ...pushing, binding: { ...binding, repository: "other/repository" } },
          0,
        ),
      ).toThrow("target changed");
    } finally {
      db.close();
    }
  });
});
