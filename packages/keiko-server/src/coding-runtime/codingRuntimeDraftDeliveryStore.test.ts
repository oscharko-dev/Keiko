import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { runMigrations } from "../store/schema.js";
import { rewindSchemaFixture } from "../store/legacySchemaTestFixture.js";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
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

function retainedSource(db: DatabaseSync): unknown {
  const row = db
    .prepare(
      "SELECT draft_delivery_source_receipt FROM coding_runtime_snapshots WHERE run_id='run-1'",
    )
    .get() as { draft_delivery_source_receipt: string | null };
  return row.draft_delivery_source_receipt === null
    ? null
    : (JSON.parse(row.draft_delivery_source_receipt) as unknown);
}

describe("durable draft delivery in the owning runtime store", () => {
  it("migrates bounded remote phase storage alongside the verified commit receipt", () => {
    const db = new DatabaseSync(":memory:");
    try {
      storeWithRun(db);
      const columns = db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all();
      expect(columns.map((column) => column.name)).toContain("draft_delivery_record");
    } finally {
      db.close();
    }
  });

  it("retains exact issue-bound push intent when the store is reconstructed", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      expect(restored?.draftDelivery).toEqual(proposed);
      expect(restored?.verifiedCommitResult).toEqual(commit);
    } finally {
      db.close();
    }
  });

  it("migrates an already populated version 23 database without losing issue or commit facts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      storeWithRun(db);
      rewindSchemaFixture(db, 23);
      runMigrations(db);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      expect(restored?.verifiedCommitResult).toEqual(commit);
      expect(restored?.issueBinding).toEqual(issue);
      expect(restored?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("uses a separate compare-and-set revision and refuses duplicate dispatch or skipped phases", () => {
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
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      expect(restored?.draftDelivery).toEqual(pushing);
      expect(restored?.revision).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each([
    { headSha: "4".repeat(40) },
    { baseSha: "5".repeat(40) },
    { verifiedCommitProposalId: "other-commit" },
    { envelopeDigest: "b".repeat(64) },
    { issueIdDigest: "b".repeat(64) },
    { remoteDigest: "b".repeat(64) },
    { runtimeAuthorityDigest: "b".repeat(64) },
    { workspaceDigest: "b".repeat(64) },
    { issueNumber: 2 },
    { baseRef: "main" },
  ])("refuses intent that does not bind the accepted run and verified commit %j", (overrides) => {
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

  it("refuses reusable approval material and payload drift in the dispatch transition", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      const contaminated = { ...proposed, approvalToken: "fixture-not-to-persist" };
      expect(() => store.recordDraftDelivery(contaminated, null)).toThrow("invalid draft delivery");
      store.recordDraftDelivery(proposed, null);
      expect(() =>
        store.recordDraftDelivery(
          {
            ...proposed,
            phase: "pushing",
            reason: "in-flight",
            revision: 1,
            proposalDigest: "b".repeat(64),
          },
          0,
        ),
      ).toThrow("payload changed before dispatch");
      expect(store.get("run-1")?.draftDelivery).toEqual(proposed);
    } finally {
      db.close();
    }
  });

  it("does not turn an interrupted push into a repeated effect during startup recovery", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const pushing = { ...proposed, phase: "pushing", reason: "in-flight", revision: 1 } as const;
      store.recordDraftDelivery(pushing, 0);
      store.markNonterminalRecoveryRequired(at);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-1");
      expect(restored?.state).toBe("recovery-required");
      expect(restored?.draftDelivery).toEqual(pushing);
    } finally {
      db.close();
    }
  });
});

function successor(
  store: CodingRuntimeSnapshotStore,
  predecessorRunId = "run-1",
  runId = "run-2",
): CodingRuntimeSnapshot {
  store.markNonterminalRecoveryRequired(at);
  store.acknowledgeRecovery(predecessorRunId, at);
  store.releaseRecoveryForRetry(predecessorRunId, at);
  const prior = store.get(predecessorRunId);
  if (prior === undefined) throw new Error("missing test predecessor");
  const shared = Object.fromEntries(
    Object.entries(prior).filter(
      ([key]) =>
        !new Set([
          "draftDelivery",
          "verifiedCommitResult",
          "terminalAt",
          "recoveryAcknowledgedAt",
          "failureCode",
        ]).has(key),
    ),
  ) as Omit<
    CodingRuntimeSnapshot,
    | "draftDelivery"
    | "verifiedCommitResult"
    | "terminalAt"
    | "recoveryAcknowledgedAt"
    | "failureCode"
  >;
  return store.create({
    ...shared,
    runId,
    predecessorRunId,
    state: "running",
    revision: 0,
    authorityDigest: runId === "run-2" ? "b".repeat(64) : "c".repeat(64),
  });
}
function recovery(snapshot: CodingRuntimeSnapshot): DraftDeliveryRecord {
  return {
    ...proposed,
    revision: 0,
    phase: "recovery-required",
    reason: "restart-reconciliation",
    proposalId: `recovery-${snapshot.runId}`,
    proposalDigest: "d".repeat(64),
    binding: {
      ...proposed.binding,
      runId: snapshot.runId,
      runtimeAuthorityDigest: snapshot.authorityDigest,
      envelopeDigest: snapshot.authorityDigest,
    },
  };
}

describe("draft delivery predecessor recovery", () => {
  it("retains verified draft provenance after a later blocked commit and requires a fresh proposal after restart", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const { headSha, committedTreeDigest, ...binding } = commit;
      expect(headSha).toBe(proposed.binding.headSha);
      expect(committedTreeDigest).toBe(commit.stagedTreeDigest);
      store.recordVerifiedCommit({
        ...binding,
        proposalId: "commit-later",
        status: "blocked",
        reason: "message-policy",
      });
      const fresh = successor(store);
      const adopted = recovery(fresh);
      expect(store.adoptDraftDeliveryFromPredecessor(adopted).draftDelivery).toEqual(adopted);
      expect(store.get("run-2")?.verifiedCommitResult).toBeUndefined();
      expect(() =>
        store.recordDraftDelivery(
          { ...adopted, phase: "pushing", reason: "in-flight", revision: 1 },
          0,
        ),
      ).toThrow();
      const next = {
        ...adopted,
        phase: "push-proposed",
        reason: "approval-required",
        revision: 1,
        proposalId: "fresh-push",
      } as const;
      expect(store.recordDraftDelivery(next, 0).draftDelivery).toEqual(next);
      expect(store.get("run-1")?.verifiedCommitResult?.status).toBe("blocked");
    } finally {
      db.close();
    }
  });

  it("adopts only durable verified intent under the fresh run without restoring approval or dispatch", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      store.recordDraftDelivery(
        { ...proposed, phase: "pushing", reason: "in-flight", revision: 1 },
        0,
      );
      const fresh = successor(store);
      const sourceBefore = store.get("run-1");
      const adopted = recovery(fresh);
      store.adoptDraftDeliveryFromPredecessor(adopted);
      const restored = createCodingRuntimeSnapshotStore(db).get("run-2");
      expect(restored?.draftDelivery).toEqual(adopted);
      expect(restored?.verifiedCommitResult).toBeUndefined();
      expect(restored?.revision).toBe(0);
      expect(store.get("run-1")).toEqual(sourceBefore);
      expect(() => store.adoptDraftDeliveryFromPredecessor(adopted)).toThrow();
      expect(() =>
        store.recordDraftDelivery(
          { ...adopted, phase: "pushing", reason: "in-flight", revision: 1 },
          0,
        ),
      ).toThrow();
      const reproposed = {
        ...adopted,
        phase: "push-proposed",
        reason: "approval-required",
        revision: 1,
      } as const;
      expect(store.recordDraftDelivery(reproposed, 0).draftDelivery).toEqual(reproposed);
    } finally {
      db.close();
    }
  });

  it("retains the original verified provenance across a second acknowledged restart", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      store.adoptDraftDeliveryFromPredecessor(recovery(successor(store)));
      const next = recovery(successor(store, "run-2", "run-3"));
      expect(store.adoptDraftDeliveryFromPredecessor(next).draftDelivery).toEqual(next);
      expect(() =>
        store.recordDraftDelivery(
          {
            ...next,
            revision: 1,
            phase: "push-proposed",
            reason: "approval-required",
            binding: { ...next.binding, headSha: "8".repeat(40) },
          },
          0,
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    [
      "no predecessor",
      "UPDATE coding_runtime_snapshots SET predecessor_run_id=NULL WHERE run_id='run-2'",
    ],
    [
      "missing predecessor",
      "UPDATE coding_runtime_snapshots SET predecessor_run_id='missing' WHERE run_id='run-2'",
    ],
    [
      "different task",
      "UPDATE coding_runtime_snapshots SET task_digest='" +
        "e".repeat(64) +
        "' WHERE run_id='run-2'",
    ],
    [
      "unacknowledged recovery",
      "UPDATE coding_runtime_snapshots SET recovery_acknowledged_at=NULL WHERE run_id='run-1'",
    ],
    [
      "source authority mismatch",
      "UPDATE coding_runtime_snapshots SET verified_commit_result=json_set(verified_commit_result, '$.runtimeAuthorityDigest', '" +
        "e".repeat(64) +
        "') WHERE run_id='run-1'",
    ],
    [
      "settled run instead of recovery",
      "UPDATE coding_runtime_snapshots SET state='succeeded' WHERE run_id='run-1'",
    ],
    [
      "missing source receipt",
      "UPDATE coding_runtime_snapshots SET verified_commit_result=NULL, draft_delivery_source_receipt=NULL WHERE run_id='run-1'",
    ],
    [
      "missing remote intent",
      "UPDATE coding_runtime_snapshots SET draft_delivery_record=NULL WHERE run_id='run-1'",
    ],
    [
      "cycle",
      "UPDATE coding_runtime_snapshots SET predecessor_run_id='run-2' WHERE run_id='run-2'",
    ],
  ])("refuses %s without installing a fresh remote intent", (_name, sql) => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const fresh = successor(store);
      db.exec(sql);
      expect(() => store.adoptDraftDeliveryFromPredecessor(recovery(fresh))).toThrow();
      expect(store.get("run-2")?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([
    { headSha: "8".repeat(40) },
    { baseSha: "9".repeat(40) },
    { headRef: "feature/different-task" },
    { repository: "other/repository" },
    { recoveryId: "other-recovery" },
    { verifiedCommitProposalId: "other-commit" },
    { envelopeDigest: digest },
    { runtimeAuthorityDigest: digest },
  ])("refuses changed historical target or reused authority %j", (change) => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const next = recovery(successor(store));
      expect(() =>
        store.adoptDraftDeliveryFromPredecessor({
          ...next,
          binding: { ...next.binding, ...change },
        }),
      ).toThrow();
      expect(store.get("run-2")?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses source chains beyond the bound while preserving the last valid checkpoint", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      for (let index = 2; index <= 33; index += 1) {
        const next = recovery(successor(store, `run-${String(index - 1)}`, `run-${String(index)}`));
        const envelopeDigest = index.toString(16).padStart(64, "0");
        store.adoptDraftDeliveryFromPredecessor({
          ...next,
          binding: { ...next.binding, envelopeDigest },
        });
      }
      const overBound = recovery(successor(store, "run-33", "run-34"));
      expect(() => store.adoptDraftDeliveryFromPredecessor(overBound)).toThrow(
        "bounded verified predecessor",
      );
      expect(store.get("run-34")?.draftDelivery).toBeUndefined();
      expect(store.get("run-33")?.draftDelivery).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("does not prune predecessor proof still referenced by a successor", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      store.adoptDraftDeliveryFromPredecessor(recovery(successor(store)));
      store.deletePruned(["run-1"]);
      expect(store.get("run-1")?.verifiedCommitResult).toEqual(commit);
    } finally {
      db.close();
    }
  });
});

describe("internal durable draft source receipt", () => {
  it("does not promote the historical source into the adopted run's authority", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      store.adoptDraftDeliveryFromPredecessor(recovery(successor(store)));
      const row = db
        .prepare(
          "SELECT draft_delivery_source_receipt FROM coding_runtime_snapshots WHERE run_id='run-2'",
        )
        .get();
      expect(row?.draft_delivery_source_receipt).toBeNull();
      db.prepare(
        "UPDATE coding_runtime_snapshots SET draft_delivery_source_receipt=? WHERE run_id='run-2'",
      ).run(JSON.stringify(commit));
      expect(() => store.get("run-2")).toThrow("invalid persisted draft delivery source");
      expect(retainedSource(db)).toEqual(commit);
    } finally {
      db.close();
    }
  });

  it("rejects a contract-valid blocked result as historical proof", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const { headSha, committedTreeDigest, ...binding } = commit;
      expect(headSha).toBe(proposed.binding.headSha);
      expect(committedTreeDigest).toBe(commit.stagedTreeDigest);
      const blocked = { ...binding, status: "blocked", reason: "message-policy" } as const;
      store.recordVerifiedCommit(blocked);
      db.prepare(
        "UPDATE coding_runtime_snapshots SET draft_delivery_source_receipt=? WHERE run_id='run-1'",
      ).run(JSON.stringify(blocked));
      expect(() => store.get("run-1")).toThrow("invalid persisted draft delivery source");
    } finally {
      db.close();
    }
  });

  it("migrates an existing v24 draft and captures its still-valid receipt on the next transition", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      rewindSchemaFixture(db, 24);
      runMigrations(db);
      expect(retainedSource(db)).toBeNull();
      expect(createCodingRuntimeSnapshotStore(db).get("run-1")?.draftDelivery).toEqual(proposed);
      store.recordDraftDelivery(
        { ...proposed, phase: "pushing", reason: "in-flight", revision: 1 },
        0,
      );
      expect(retainedSource(db)).toEqual(commit);
      expect(store.get("run-1")).not.toHaveProperty("draftDeliverySourceReceipt");
    } finally {
      db.close();
    }
  });

  it("writes the draft and its source atomically and leaves both absent on a failed update", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      db.exec(
        "CREATE TRIGGER fail_draft_update AFTER UPDATE OF draft_delivery_record ON coding_runtime_snapshots BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END",
      );
      expect(() => store.recordDraftDelivery(proposed, null)).toThrow("fixture rejection");
      expect(store.get("run-1")?.draftDelivery).toBeUndefined();
      expect(retainedSource(db)).toBeNull();
      db.exec("DROP TRIGGER fail_draft_update");
      store.recordDraftDelivery(proposed, null);
      expect(retainedSource(db)).toEqual(commit);
    } finally {
      db.close();
    }
  });

  it("replaces the source only with the new successful commit bound to the next push proposal", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      store.recordDraftDelivery(
        { ...proposed, phase: "recovery-required", reason: "provider-failed", revision: 1 },
        0,
      );
      const nextCommit = { ...commit, headSha: "4".repeat(40), proposalId: "commit-2" };
      store.recordVerifiedCommit(nextCommit);
      expect(retainedSource(db)).toEqual(commit);
      const next = {
        ...proposed,
        revision: 2,
        binding: {
          ...proposed.binding,
          headSha: nextCommit.headSha,
          verifiedCommitProposalId: nextCommit.proposalId,
        },
      };
      store.recordDraftDelivery(next, 1);
      expect(retainedSource(db)).toEqual(nextCommit);
      expect(() => store.recordDraftDelivery({ ...proposed, revision: 3 }, 2)).toThrow();
      expect(retainedSource(db)).toEqual(nextCommit);
    } finally {
      db.close();
    }
  });

  it.each([
    { runtimeAuthorityDigest: "e".repeat(64) },
    { envelopeDigest: "e".repeat(64) },
    { headSha: "8".repeat(40) },
    { baseSha: "8".repeat(40) },
    { proposalId: "other-commit" },
    { runId: "other-run" },
    { workspaceDigest: "e".repeat(64) },
    { repositoryDigest: "e".repeat(64) },
    { issueBindingDigest: "e".repeat(64) },
    { approvalToken: "fixture-not-a-token" },
    { message: "fixture private body" },
    { evidence: { body: "fixture private body" } },
    { preflightFindings: [{ code: "conflict-markers", body: "fixture private body" }] },
    { status: "approval-required", reason: "approval-required" },
  ])("rejects corrupted or body-bearing historical proof at read and adoption %j", (change) => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const fresh = successor(store);
      db.prepare(
        "UPDATE coding_runtime_snapshots SET draft_delivery_source_receipt=? WHERE run_id='run-1'",
      ).run(JSON.stringify({ ...commit, ...change }));
      expect(() => store.get("run-1")).toThrow("invalid persisted draft delivery source");
      expect(() => store.adoptDraftDeliveryFromPredecessor(recovery(fresh))).toThrow();
      expect(store.get("run-2")?.draftDelivery).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses oversized or invalid source JSON at the database boundary", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = storeWithRun(db);
      store.recordDraftDelivery(proposed, null);
      const update = db.prepare(
        "UPDATE coding_runtime_snapshots SET draft_delivery_source_receipt=? WHERE run_id='run-1'",
      );
      expect(() => update.run("invalid-json")).toThrow();
      expect(() => update.run(JSON.stringify({ body: "x".repeat(8192) }))).toThrow();
      expect(retainedSource(db)).toEqual(commit);
    } finally {
      db.close();
    }
  });
});
