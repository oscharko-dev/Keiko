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
