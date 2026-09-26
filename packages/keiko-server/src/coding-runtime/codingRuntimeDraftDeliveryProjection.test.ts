import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import { CodingRuntimeOrchestratorState } from "./codingRuntimeOrchestratorState.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";

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
  issueBindingDigest: digest,
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
    runId: "run-1",
    workspaceDigest: digest,
    runtimeAuthorityDigest: digest,
    envelopeDigest: digest,
    remoteDigest: digest,
    issueBindingDigest: digest,
    issueIdDigest: digest,
    issueNumber: 1,
    repository: "owner/repository",
    remoteAlias: "origin",
    baseRef: "dev",
    baseSha: "1".repeat(40),
    headRef: "feature/issue-1",
    headSha: "3".repeat(40),
    verifiedCommitProposalId: "commit-1",
    recoveryId: "delivery-1",
  },
};

function storeWithRun(db: DatabaseSync): ReturnType<typeof createCodingRuntimeSnapshotStore> {
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
    issueBinding: issue,
  });
  store.recordVerifiedCommit(commit);
  return store;
}

function publicState(): CodingRuntimeOrchestratorState {
  return new CodingRuntimeOrchestratorState({
    eventHub: new CodingRuntimeEventHub(),
    now: (): Date => new Date(at),
    pendingPermission: (): undefined => undefined,
    effectiveMode: (): "governed-assist" => "governed-assist",
  });
}

describe("draft delivery public runtime projection", () => {
  it("retains the durable issue-bound intent after SQLite reconstruction", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      const snapshot = publicState().publicSnapshot(restored);
      expect(snapshot).toMatchObject({ state: "running", draftDelivery: proposed });
      expect(validateCodingWorkbenchRuntimeSnapshot(snapshot).ok).toBe(true);
    } finally {
      db.close();
    }
  });
  it("restores the confirmed remote identity after every persisted delivery phase", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const phases = [
        ["pushing", "in-flight"],
        ["pushed", "completed"],
        ["pr-proposed", "approval-required"],
        ["creating-pr", "in-flight"],
        ["draft-created", "completed"],
      ] as const;
      const pullRequest = {
        number: 7,
        externalId: "PR_fixture7",
        url: "https://github.com/owner/repository/pull/7",
        repository: proposed.binding.repository,
        headRepository: proposed.binding.repository,
        headRef: proposed.binding.headRef,
        headSha: proposed.binding.headSha,
        baseRef: proposed.binding.baseRef,
        baseSha: proposed.binding.baseSha,
        state: "open",
        isDraft: true,
      } as const;
      for (const [index, [phase, reason]] of phases.entries()) {
        store.recordDraftDelivery(
          {
            ...proposed,
            phase,
            reason,
            revision: index + 1,
            ...(phase === "draft-created" ? { pullRequest } : {}),
          },
          index,
        );
      }
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      const snapshot = publicState().publicSnapshot(restored);
      expect(snapshot.draftDelivery).toMatchObject({
        phase: "draft-created",
        revision: 5,
        pullRequest,
      });
      expect(validateCodingWorkbenchRuntimeSnapshot(snapshot).ok).toBe(true);
      expect(JSON.stringify(snapshot)).not.toMatch(/"(?:approvalToken|message|body|command)":/u);
    } finally {
      db.close();
    }
  });

  it("refuses to project an internally mismatched frozen issue tuple", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const restored = store.get("run-1");
      if (restored === undefined) throw new Error("Fixture requires a run");
      expect(() =>
        publicState().publicSnapshot({ ...restored, issueBinding: { ...issue, issueNumber: 2 } }),
      ).toThrow("draftDelivery must match");
    } finally {
      db.close();
    }
  });
});
