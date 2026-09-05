import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { CodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_FAILURE_CODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { restoreV13SchemaFixture } from "../store/legacySchemaTestFixture.js";
import { runMigrations, SCHEMA_VERSION } from "../store/schema.js";
import {
  createCodingRuntimeSnapshotStore,
  type CodingRuntimeSnapshot,
} from "./codingRuntimeSnapshotStore.js";

const at = "2026-07-13T10:00:00.000Z";
const digest = "a".repeat(64);
function snapshot(runId = "run-1"): CodingRuntimeSnapshot {
  return {
    schemaVersion: "1",
    runId,
    state: "starting",
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
  };
}
function store(): ReturnType<typeof createCodingRuntimeSnapshotStore> {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return createCodingRuntimeSnapshotStore(db);
}

const ISSUE_BINDING: CodingWorkbenchIssueBinding = {
  schemaVersion: "1",
  repositoryId: "repository-0123456789abcdef",
  remoteDigest: "1".repeat(64),
  issueNumber: 3385,
  issueIdDigest: "2".repeat(64),
  defaultBaseRef: "dev",
  contentRevisionDigest: "3".repeat(64),
  bindingDigest: "4".repeat(64),
};

// The seven v22 columns, in migration order. Content-free by construction: an id the task workspace
// already derives, four digests, a number and a branch name — never a title, body, URL or remote.
const ISSUE_COLUMNS = [
  "issue_repository_id",
  "issue_remote_digest",
  "issue_number",
  "issue_id_digest",
  "issue_default_base_ref",
  "issue_content_revision_digest",
  "issue_binding_digest",
] as const;

function columnNames(db: DatabaseSync): readonly string[] {
  return (
    db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
  ).map((row) => row.name);
}

describe("CodingRuntimeSnapshotStore", () => {
  it("round-trips only the bounded terminal process result", () => {
    const s = store();
    s.create(snapshot());
    const result = {
      status: "failed" as const,
      exitCode: 9,
      output: { byteCount: 12, lineCount: 1, sha256: "b".repeat(64), truncated: false },
      error: { byteCount: 99, lineCount: 3, sha256: "c".repeat(64), truncated: true },
    };
    s.transition("run-1", { state: "failed", revision: 1, updatedAt: at, result });

    expect(s.get("run-1")?.result).toEqual(result);
    expect(JSON.stringify(s.get("run-1"))).not.toContain("stdout body");
  });

  // #2906 round-3 review (KEIKO-0532): coding_runtime_snapshots.failure_code is a hand-maintained
  // CHECK constraint copy of CODING_WORKBENCH_RUNTIME_FAILURE_CODES. A contract literal the
  // constraint does not also list makes an otherwise-valid terminal transition fail with
  // SQLITE_CONSTRAINT instead of recording the failure. Round-trip every literal so the two lists
  // are pinned in sync, not just the ones a hand-picked example happens to cover.
  it("round-trips every CODING_WORKBENCH_RUNTIME_FAILURE_CODES literal as a terminal failure_code", () => {
    for (const failureCode of CODING_WORKBENCH_RUNTIME_FAILURE_CODES) {
      const s = store();
      s.create(snapshot());
      const failed = s.transition("run-1", {
        state: "failed",
        revision: 1,
        updatedAt: at,
        failureCode,
      });
      expect(failed.failureCode).toBe(failureCode);
      expect(s.get("run-1")?.failureCode).toBe(failureCode);
    }
  });

  it("persists only lifecycle snapshots and holds the recovery slot after acknowledgement", () => {
    const s = store();
    s.create(snapshot());
    expect(s.markNonterminalRecoveryRequired("2026-07-13T10:01:00.000Z")).toEqual(["run-1"]);
    expect(s.acknowledgeRecovery("run-1", "2026-07-13T10:02:00.000Z").state).toBe(
      "recovery-required",
    );
    expect(() => s.create(snapshot("run-2"))).toThrow();
    const released = s.releaseRecoveryForRetry("run-1", "2026-07-13T10:03:00.000Z");
    expect(released).toMatchObject({
      state: "recovery-required",
      terminalAt: "2026-07-13T10:03:00.000Z",
      revision: 2,
    });
    expect(s.create(snapshot("run-2")).runId).toBe("run-2");
    expect(s.get("run-1")).toEqual(released);
  });

  it("does not release recovery for retry before explicit acknowledgement", () => {
    const s = store();
    s.create(snapshot());
    s.markNonterminalRecoveryRequired("2026-07-13T10:01:00.000Z");
    expect(() => s.releaseRecoveryForRetry("run-1", "2026-07-13T10:02:00.000Z")).toThrow(
      "acknowledged recovery runtime snapshot was not found",
    );
  });
  it("prunes oldest settled entries in one bounded transaction", () => {
    const s = store();
    for (let i = 0; i < 10_001; i += 1) {
      const run = snapshot(`run-${String(i)}`);
      s.create(run);
      s.transition(run.runId, { state: "succeeded", revision: 1, updatedAt: at, terminalAt: at });
    }
    const prunable = s.listPrunableSettled();
    expect(prunable).toEqual(["run-0"]);
    expect(s.get("run-0")).toBeDefined();
    s.deletePruned(prunable);
    expect(s.get("run-0")).toBeUndefined();
    expect(s.listAll(10_000)).toHaveLength(10_000);
    const started = performance.now();
    expect(s.listAll(25)).toHaveLength(25);
    // The indexed, bounded query must not degrade into loading the retained 10k-row ledger.
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("CodingRuntimeSnapshotStore fail-closed validation", () => {
  // #2386 regression: "paused" is a persistable lifecycle state. The store's own state allowlist
  // silently rejected it (throw → opaque 400 at the route), so a green contract-level state
  // machine still could not pause a real run.
  it("persists the paused state through a running round-trip", () => {
    const s = store();
    s.create(snapshot());
    s.transition("run-1", { state: "running", revision: 1, updatedAt: at });
    expect(s.transition("run-1", { state: "paused", revision: 2, updatedAt: at }).state).toBe(
      "paused",
    );
    expect(s.get("run-1")?.state).toBe("paused");
    expect(s.transition("run-1", { state: "running", revision: 3, updatedAt: at }).state).toBe(
      "running",
    );
  });

  it("rejects a transition that does not increase the revision", () => {
    const s = store();
    s.create(snapshot());
    s.transition("run-1", { state: "ready", revision: 1, updatedAt: at });
    expect(() => s.transition("run-1", { state: "running", revision: 1, updatedAt: at })).toThrow(
      "runtime revision must increase",
    );
  });

  it("rejects acknowledging recovery for a run that never entered recovery", () => {
    const s = store();
    s.create(snapshot());
    expect(() => s.acknowledgeRecovery("run-1", at)).toThrow(
      "recovery-required runtime snapshot was not found",
    );
    expect(() => s.acknowledgeRecovery("run-9", at)).toThrow(
      "recovery-required runtime snapshot was not found",
    );
  });

  it("deletes a snapshot row by run id", () => {
    const s = store();
    s.create(snapshot());
    s.transition("run-1", { state: "succeeded", revision: 1, updatedAt: at, terminalAt: at });
    s.delete("run-1");
    expect(s.get("run-1")).toBeUndefined();
    expect(() => {
      s.delete("bad id!");
    }).toThrow();
  });

  it("rejects snapshots with unknown states, oversized counters, and bad limits", () => {
    const s = store();
    expect(() =>
      s.create({ ...snapshot(), state: "exploded" as CodingRuntimeSnapshot["state"] }),
    ).toThrow("invalid runtime snapshot state");
    expect(() => s.create({ ...snapshot(), toolCallCount: -1 })).toThrow("invalid toolCallCount");
    expect(() => s.create({ ...snapshot(), patchByteCount: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      "invalid patchByteCount",
    );
    expect(() => s.listAll(0)).toThrow("invalid list limit");
    expect(() => s.listRecentActive(10_001)).toThrow("invalid list limit");
  });

  it("rolls back the whole prune transaction when any run id is malformed", () => {
    const s = store();
    s.create(snapshot());
    s.transition("run-1", { state: "succeeded", revision: 1, updatedAt: at, terminalAt: at });
    expect(() => {
      s.deletePruned(["run-1", "bad id!"]);
    }).toThrow();
    expect(s.get("run-1")).toBeDefined();
    s.deletePruned([]);
    expect(s.get("run-1")).toBeDefined();
  });
});

describe("issue-bound snapshots (#3385, schema v22)", () => {
  it("round-trips the content-free issue binding and keeps it through transitions and recovery", () => {
    const s = store();
    s.create({ ...snapshot(), issueBinding: ISSUE_BINDING });

    expect(s.get("run-1")?.issueBinding).toEqual(ISSUE_BINDING);
    expect(s.listRecentActive(1)[0]?.issueBinding).toEqual(ISSUE_BINDING);
    expect(
      s.transition("run-1", { state: "running", revision: 1, updatedAt: at }).issueBinding,
    ).toEqual(ISSUE_BINDING);
    expect(s.markNonterminalRecoveryRequired("2026-07-13T10:01:00.000Z")).toEqual(["run-1"]);
    const recovered = s.get("run-1");
    expect(recovered?.state).toBe("recovery-required");
    expect(recovered?.issueBinding).toEqual(ISSUE_BINDING);
    expect(s.listAll(1)[0]?.issueBinding).toEqual(ISSUE_BINDING);
  });

  it("persists no issue columns for a generic run", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const s = createCodingRuntimeSnapshotStore(db);
    s.create(snapshot());

    expect(s.get("run-1")?.issueBinding).toBeUndefined();
    expect("issueBinding" in (s.get("run-1") ?? {})).toBe(false);
    const row = db
      .prepare(`SELECT ${ISSUE_COLUMNS.join(", ")} FROM coding_runtime_snapshots WHERE run_id = ?`)
      .get("run-1") as Record<string, unknown>;
    for (const column of ISSUE_COLUMNS) expect(row[column], column).toBeNull();
  });

  it("refuses a malformed issue binding field by field", () => {
    const rejected: readonly Partial<Record<keyof CodingWorkbenchIssueBinding, unknown>>[] = [
      { schemaVersion: "2" },
      { repositoryId: "" },
      { repositoryId: "../escape" },
      { repositoryId: "a".repeat(129) },
      { remoteDigest: "not-a-digest" },
      { remoteDigest: "A".repeat(64) },
      { issueNumber: 0 },
      { issueNumber: 2.5 },
      { issueNumber: 1_000_000_001 },
      { issueIdDigest: "2".repeat(63) },
      { defaultBaseRef: "" },
      { defaultBaseRef: "dev branch" },
      { defaultBaseRef: "feature/../x" },
      { defaultBaseRef: "-dev" },
      { contentRevisionDigest: 42 },
      { bindingDigest: "4".repeat(65) },
    ];
    for (const override of rejected) {
      const s = store();
      expect(
        () =>
          s.create({
            ...snapshot(),
            issueBinding: { ...ISSUE_BINDING, ...override } as CodingWorkbenchIssueBinding,
          }),
        JSON.stringify(override),
      ).toThrow(/issue/u);
      expect(s.get("run-1")).toBeUndefined();
    }
  });

  it("fails closed on a partially persisted issue binding row instead of projecting a generic run", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const s = createCodingRuntimeSnapshotStore(db);
    s.create({ ...snapshot(), issueBinding: ISSUE_BINDING });
    db.exec("UPDATE coding_runtime_snapshots SET issue_number = NULL WHERE run_id = 'run-1'");

    expect(() => s.get("run-1")).toThrow(/issue binding/u);
    expect(() => s.listRecentActive(1)).toThrow(/issue binding/u);
  });

  // D9-style migration pin: forward-only in production, and the reverse fixture must remove exactly
  // what v22 added so a v13 database migrates to the same shape a fresh one has.
  it("adds the seven issue columns forward-only and the legacy fixture removes them", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const fresh = columnNames(db);
    for (const column of ISSUE_COLUMNS) expect(fresh, column).toContain(column);

    restoreV13SchemaFixture(db);
    const legacy = columnNames(db);
    for (const column of ISSUE_COLUMNS) expect(legacy, column).not.toContain(column);

    runMigrations(db);
    expect(columnNames(db)).toEqual(fresh);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    const s = createCodingRuntimeSnapshotStore(db);
    s.create({ ...snapshot(), issueBinding: ISSUE_BINDING });
    expect(s.get("run-1")?.issueBinding).toEqual(ISSUE_BINDING);
  });

  it("holds the SQL bounds on every issue column, not only the store's own validation", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const s = createCodingRuntimeSnapshotStore(db);
    s.create({ ...snapshot(), issueBinding: ISSUE_BINDING });
    for (const [column, value] of [
      ["issue_repository_id", "''"],
      ["issue_remote_digest", "'abc'"],
      ["issue_number", "0"],
      ["issue_number", "1000000001"],
      ["issue_id_digest", `'${"x".repeat(65)}'`],
      ["issue_default_base_ref", "''"],
      ["issue_content_revision_digest", "'short'"],
      ["issue_binding_digest", "'short'"],
    ] as const) {
      expect(() => {
        db.exec(`UPDATE coding_runtime_snapshots SET ${column} = ${value} WHERE run_id = 'run-1'`);
      }, `${column}=${value}`).toThrow(/CHECK/u);
    }
  });
});

function commitReceipt(): import("@oscharko-dev/keiko-contracts").VerifiedCommitResult {
  return {
    schemaVersion: "1",
    proposalId: "commit-1",
    runId: "run-1",
    envelopeDigest: "b".repeat(64),
    runtimeAuthorityDigest: digest,
    workspaceDigest: digest,
    repositoryDigest: "c".repeat(64),
    baseSha: "1".repeat(40),
    parentSha: "2".repeat(40),
    stagedTreeDigest: "d".repeat(64),
    verificationEvidenceId: "verification-1",
    messageDigest: "e".repeat(64),
    status: "recovery-required",
    reason: "execution-uncertain",
    recordedAt: at,
  };
}

describe("verified commit persistence (#3386, schema v23)", () => {
  it("round-trips the closed receipt through recovery without saving a live approval", () => {
    const s = store();
    s.create(snapshot());
    const receipt = commitReceipt();
    expect(s.recordVerifiedCommit(receipt).verifiedCommitResult).toEqual(receipt);
    s.markNonterminalRecoveryRequired(at);
    expect(s.get("run-1")?.verifiedCommitResult).toEqual(receipt);
    expect(JSON.stringify(s.get("run-1"))).not.toContain("approvalToken");
  });
  it.each([
    "approvalToken",
    "approval",
    "command",
    "args",
    "env",
    "message",
    "output",
    "diff",
    "path",
    "secret",
  ])("rejects hostile %s on write, initial create, and persisted read", (field) => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const s = createCodingRuntimeSnapshotStore(db);
    const hostile = { ...commitReceipt(), [field]: { body: "private fixture" } };
    expect(() => s.create({ ...snapshot(), verifiedCommitResult: hostile })).toThrow(
      "invalid verified commit",
    );
    s.create(snapshot());
    expect(() => s.recordVerifiedCommit(hostile)).toThrow("invalid verified commit");
    expect(s.get("run-1")?.verifiedCommitResult).toBeUndefined();
    db.prepare("UPDATE coding_runtime_snapshots SET verified_commit_result = ?").run(
      JSON.stringify(hostile),
    );
    expect(() => s.get("run-1")).toThrow("invalid persisted verified commit");
    db.close();
  });
  it("refuses nested-body substitution and mismatched accepted run bindings", () => {
    const s = store();
    s.create(snapshot());
    for (const change of [
      { messageDigest: { secret: "private fixture" } },
      { workspaceDigest: "0".repeat(64) },
      { runtimeAuthorityDigest: "0".repeat(64) },
      { issueBindingDigest: "0".repeat(64) },
      { runId: "run-2" },
    ]) {
      const value = {
        ...commitReceipt(),
        ...change,
      } as import("@oscharko-dev/keiko-contracts").VerifiedCommitResult;
      expect(() => s.recordVerifiedCommit(value)).toThrow();
    }
    expect(s.get("run-1")?.verifiedCommitResult).toBeUndefined();
  });
  it("enforces bounded valid JSON in SQLite as well as the typed persistence boundary", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    createCodingRuntimeSnapshotStore(db).create(snapshot());
    const update = db.prepare("UPDATE coding_runtime_snapshots SET verified_commit_result = ?");
    expect(() => update.run("not-json")).toThrow();
    expect(() => update.run(JSON.stringify({ body: "x".repeat(8192) }))).toThrow();
    db.close();
  });
});
