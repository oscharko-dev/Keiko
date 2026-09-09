import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { buildBinding } from "../task-workspace/binding.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { processServerLogSink } from "../process-log-sink.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { MIGRATIONS, runMigrations } from "../store/schema.js";
import {
  createCodingRuntimeSnapshotStore,
  type CodingRuntimeSnapshot,
} from "./codingRuntimeSnapshotStore.js";
import {
  productionRuntimeAuthorityFacts,
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
  type ProductionWorkspaceAuthorityInput,
} from "./productionRuntimeWorkspaceAuthority.js";

const at = "2026-09-05T01:00:00.000Z";
const digest = "a".repeat(64);
const databases: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function authorityFixture(store: ReturnType<typeof createCodingRuntimeSnapshotStore>): {
  readonly matches: () => boolean;
  readonly advance: (sha: string) => void;
  readonly workspaceDigest: string;
} {
  const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-commit-authority-")));
  roots.push(managed);
  const root = join(managed, "workspace");
  mkdirSync(root);
  let head = "1".repeat(40);
  const input: ProductionWorkspaceAuthorityInput = {
    managedTaskWorkspaceRoot: managed,
    deploymentCeiling: "autonomous-delivery",
    readWorkspaceHead: () => head,
    verifiedCommitResult: (runId) => store.getLastSuccessfulVerifiedCommit?.(runId),
    workspaceLifecycle: { getActive: () => activeWorkspace(root, head) },
  };
  const context = resolveProductionRuntimeContext(input, {
    runId: "run-1",
    requestId: "request-1",
    taskIntent: "Verify repeated commits",
    requestedMode: "autonomous-delivery",
    workspaceId: "workspace-1",
    workspaceRoot: root,
    serverPrincipal: "operator-1",
  });
  return {
    matches: () => productionWorkspaceMatches(input, context),
    advance: (sha): void => {
      head = sha;
    },
    workspaceDigest: productionRuntimeAuthorityFacts(input, context).binding.workspaceRootDigest,
  };
}

function activeWorkspace(root: string, head: string): ActiveWorkspaceView {
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    repositoryRoot: root,
    managedWorktreePath: root,
    taskId: "task-1",
    taskBranch: "issue/3388",
    baseBranch: "main",
    lastVerifiedHead: head,
    lifecycleState: "active",
    health: "healthy",
    driftMarkers: [],
    recoveryHints: [],
    gitdirIdentity: digest,
    lock: null,
    createdAt: at,
    updatedAt: at,
    auditCorrelationId: "fixture-1",
  };
  return {
    instance,
    binding: buildBinding(instance),
    pointer: { workspaceId: instance.workspaceId, setBy: "operator-1", setAt: at, updatedAt: at },
  };
}
function snapshot(): CodingRuntimeSnapshot {
  return {
    schemaVersion: "1",
    runId: "run-1",
    state: "running",
    revision: 1,
    requestedMode: "autonomous-delivery",
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
  };
}
function receipt(): VerifiedCommitResult {
  return {
    schemaVersion: "1",
    runId: "run-1",
    proposalId: "commit-1",
    envelopeDigest: digest,
    runtimeAuthorityDigest: digest,
    workspaceDigest: digest,
    repositoryDigest: digest,
    baseSha: "1".repeat(40),
    parentSha: "1".repeat(40),
    headSha: "2".repeat(40),
    stagedTreeDigest: digest,
    committedTreeDigest: digest,
    verificationEvidenceId: "verification-1",
    messageDigest: digest,
    status: "succeeded",
    reason: "completed",
    recordedAt: at,
  };
}
function pending(prior = receipt()): VerifiedCommitResult {
  const { headSha, committedTreeDigest, ...binding } = prior;
  if (committedTreeDigest !== prior.stagedTreeDigest)
    throw new Error("Expected successful fixture commit");
  return {
    ...binding,
    proposalId: "commit-2",
    parentSha: headSha ?? prior.parentSha,
    status: "approval-required",
    reason: "approval-required",
  };
}
function setup(): { db: DatabaseSync; store: ReturnType<typeof createCodingRuntimeSnapshotStore> } {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  runMigrations(db);
  const store = createCodingRuntimeSnapshotStore(db);
  store.create(snapshot());
  return { db, store };
}

describe("retained verified HEAD authority", () => {
  it("keeps actual runtime HEAD admission alive during a second proposal and still rejects unrelated HEAD drift", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    runMigrations(db);
    const store = createCodingRuntimeSnapshotStore(db);
    const authority = authorityFixture(store);
    const successful = { ...receipt(), workspaceDigest: authority.workspaceDigest };
    store.create({ ...snapshot(), workspaceDigest: authority.workspaceDigest });
    expect(authority.matches()).toBe(true);
    store.recordVerifiedCommit(successful);
    authority.advance("2".repeat(40));
    expect(authority.matches()).toBe(true);
    store.recordVerifiedCommit(pending(successful));
    expect(authority.matches()).toBe(true);
    authority.advance("3".repeat(40));
    expect(authority.matches()).toBe(false);
  });
  it("records correlated body-free retained provenance and structured corruption diagnostics", () => {
    const log = vi.spyOn(processServerLogSink(), "write");
    const { db, store } = setup();
    store.recordVerifiedCommit(receipt());
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "git.verified-commit.authority",
        correlationId: "run-1",
        extra: {
          phase: "retained",
          runId: "run-1",
          proposalId: "commit-1",
          headSha: "2".repeat(40),
        },
      }),
    );
    db.prepare("UPDATE coding_runtime_snapshots SET last_successful_verified_commit = ?").run(
      JSON.stringify({ ...receipt(), message: "private fixture" }),
    );
    expect(() => store.getLastSuccessfulVerifiedCommit?.("run-1")).toThrow();
    const diagnostic = log.mock.calls.at(-1)?.[0];
    expect(diagnostic).toMatchObject({
      op: "git.verified-commit.authority",
      correlationId: "run-1",
      errorKind: "internal",
      extra: { phase: "read", runId: "run-1" },
    });
    expect(Array.isArray(diagnostic?.extra?.frames)).toBe(true);
    expect(JSON.stringify(redactLogFields(diagnostic?.extra ?? {}))).not.toContain(
      "private fixture",
    );
  });
  it("retains successful provenance across another proposal and reconstruction without changing the public receipt", () => {
    const { db, store } = setup();
    const successful = receipt();
    store.recordVerifiedCommit(successful);
    store.recordVerifiedCommit(pending(successful));
    const reopened = createCodingRuntimeSnapshotStore(db);
    expect(reopened.getLastSuccessfulVerifiedCommit?.("run-1")).toEqual(successful);
    expect(reopened.get("run-1")?.verifiedCommitResult).toEqual(pending(successful));
    expect(reopened.get("run-1")).not.toHaveProperty("lastSuccessfulVerifiedCommit");
    const next = {
      ...successful,
      proposalId: "commit-2",
      parentSha: "2".repeat(40),
      headSha: "3".repeat(40),
    };
    reopened.recordVerifiedCommit(next);
    expect(reopened.getLastSuccessfulVerifiedCommit?.("run-1")).toEqual(next);
  });
  it("never invents success from pending, failed, recovery, absent or another run", () => {
    const { store } = setup();
    for (const candidate of [
      pending(),
      { ...pending(), status: "failed", reason: "execution-failed" } as const,
      { ...pending(), status: "recovery-required", reason: "execution-uncertain" } as const,
    ]) {
      store.recordVerifiedCommit(candidate);
      expect(store.getLastSuccessfulVerifiedCommit?.("run-1")).toBeUndefined();
    }
    expect(store.getLastSuccessfulVerifiedCommit?.("run-2")).toBeUndefined();
  });
  it.each([
    {
      status: "approval-required",
      reason: "approval-required",
      headSha: undefined,
      committedTreeDigest: undefined,
    },
    { runId: "run-2" },
    { workspaceDigest: "b".repeat(64) },
    { runtimeAuthorityDigest: "b".repeat(64) },
    { issueBindingDigest: "b".repeat(64) },
    { message: "private fixture" },
    { approvalToken: "private fixture" },
  ])(
    "rejects a corrupted retained receipt without falling back to latest success: %j",
    (override) => {
      const { db, store } = setup();
      store.recordVerifiedCommit(receipt());
      db.prepare("UPDATE coding_runtime_snapshots SET last_successful_verified_commit = ?").run(
        JSON.stringify({ ...receipt(), ...override }),
      );
      expect(() => store.getLastSuccessfulVerifiedCommit?.("run-1")).toThrow();
    },
  );
  it("does not accept retained authority in the ordinary snapshot create operation", () => {
    const { store } = setup();
    store.create({
      ...snapshot(),
      runId: "run-2",
      state: "cancelled",
      terminalAt: at,
      lastSuccessfulVerifiedCommit: receipt(),
    } as CodingRuntimeSnapshot);
    expect(store.getLastSuccessfulVerifiedCommit?.("run-2")).toBeUndefined();
  });
  it.each([true, false])(
    "upgrades an applied v25 ledger with only reconstructable successful history (%s)",
    (successful) => {
      const db = new DatabaseSync(":memory:");
      databases.push(db);
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 25)) {
        db.exec(migration.sql);
        migration.apply?.(db);
      }
      db.exec("PRAGMA user_version = 25");
      // The actual old schema has no new columns. Insert only its mandatory lifecycle fields.
      const row = snapshot();
      db.prepare(
        `INSERT INTO coding_runtime_snapshots
      (run_id,schema_version,state,revision,requested_mode,runtime_source,model_source,
       created_at,updated_at,task_digest,workspace_digest,operator_digest,authority_digest,
       binding_digest,provenance_digest,tool_call_count,patch_byte_count,model_request_count,
       verified_commit_result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.runId,
        row.schemaVersion,
        row.state,
        row.revision,
        row.requestedMode,
        row.runtimeSource,
        row.modelSource,
        row.createdAt,
        row.updatedAt,
        row.taskDigest,
        row.workspaceDigest,
        row.operatorDigest,
        row.authorityDigest,
        row.bindingDigest,
        row.provenanceDigest,
        0,
        0,
        0,
        JSON.stringify(successful ? receipt() : pending()),
      );
      runMigrations(db);
      const reopened = createCodingRuntimeSnapshotStore(db);
      expect(reopened.getLastSuccessfulVerifiedCommit?.("run-1")).toEqual(
        successful ? receipt() : undefined,
      );
      reopened.recordVerifiedCommit(pending());
      expect(
        createCodingRuntimeSnapshotStore(db).getLastSuccessfulVerifiedCommit?.("run-1"),
      ).toEqual(successful ? receipt() : undefined);
    },
  );
});
