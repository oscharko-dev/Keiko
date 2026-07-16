import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../store/schema.js";
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

describe("CodingRuntimeSnapshotStore", () => {
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
