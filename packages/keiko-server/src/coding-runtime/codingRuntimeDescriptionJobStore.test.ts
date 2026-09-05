import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../store/schema.js";
import {
  createCodingRuntimeDescriptionJobStore,
  type WorkbenchDescriptionScope,
} from "./codingRuntimeDescriptionJobStore.js";
import type { WorkbenchDescriptionStatus } from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";

const REMOTE = "a".repeat(64);
const BASE = "1".repeat(40);
const HEAD_1 = "2".repeat(40);
const HEAD_2 = "3".repeat(40);
const NOW = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T00:05:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function openStore(
  maxConcurrent?: number,
): ReturnType<typeof createCodingRuntimeDescriptionJobStore> {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  runMigrations(db);
  return createCodingRuntimeDescriptionJobStore(db, maxConcurrent);
}

function scope(overrides: Partial<WorkbenchDescriptionScope> = {}): WorkbenchDescriptionScope {
  return { runId: "run-1", remoteDigest: REMOTE, baseSha: BASE, headSha: HEAD_1, ...overrides };
}

function generatedStatus(
  target: WorkbenchDescriptionScope,
  generationVersion: number,
): WorkbenchDescriptionStatus {
  return {
    schemaVersion: "1",
    runId: target.runId,
    remoteDigest: target.remoteDigest,
    baseSha: target.baseSha,
    headSha: target.headSha,
    generationVersion,
    state: "current",
    reason: "generated",
    snapshotDigest: "b".repeat(64),
    draftDigest: "c".repeat(64),
    artifactOutcome: "complete",
    observedAt: NOW,
  };
}

describe("codingRuntimeDescriptionJobStore — dispatch, dedup, coalesce, supersede", () => {
  it("dispatches exactly once for a stable successful head", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    expect(decision).toEqual({
      kind: "dispatch",
      generationVersion: 1,
      revision: 0,
      supersededPriorAttempt: false,
    });
    expect(store.current("run-1")).toBeUndefined();
  });

  it("coalesces a repeated identical signal while the attempt is still in flight (no new dispatch)", () => {
    const store = openStore();
    store.beginDispatch(scope(), NOW);
    const second = store.beginDispatch(scope(), NOW);
    expect(second).toEqual({ kind: "coalesced", status: undefined });
  });

  it("coalesces a repeated identical signal after the attempt has already settled", () => {
    const store = openStore();
    const first = store.beginDispatch(scope(), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const status = generatedStatus(scope(), first.generationVersion);
    expect(store.settle(scope(), first.generationVersion, first.revision, status, NOW)).toBe(true);
    const second = store.beginDispatch(scope(), LATER);
    expect(second).toEqual({ kind: "coalesced", status });
  });

  it("supersedes the prior attempt when a new head arrives and bumps the generation version", () => {
    const store = openStore();
    const first = store.beginDispatch(scope(), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const repaired = scope({ headSha: HEAD_2 });
    const second = store.beginDispatch(repaired, LATER);
    expect(second).toEqual({
      kind: "dispatch",
      generationVersion: 2,
      revision: 1,
      supersededPriorAttempt: true,
    });
  });

  it("discards a stale settle from a superseded attempt without overwriting the new one", () => {
    const store = openStore();
    const first = store.beginDispatch(scope(), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const repaired = scope({ headSha: HEAD_2 });
    store.beginDispatch(repaired, LATER);
    // The first attempt's late result arrives after it was superseded.
    const staleStatus = generatedStatus(scope(), first.generationVersion);
    const accepted = store.settle(
      scope(),
      first.generationVersion,
      first.revision,
      staleStatus,
      LATER,
    );
    expect(accepted).toBe(false);
    expect(store.current("run-1")).toBeUndefined();
  });

  it("rejects a budget-exhausted trigger without creating a row, and admits it once capacity frees", () => {
    const store = openStore(1);
    const first = store.beginDispatch(scope({ runId: "run-1" }), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const blocked = store.beginDispatch(scope({ runId: "run-2" }), NOW);
    expect(blocked).toEqual({ kind: "budget-exhausted" });
    expect(store.current("run-2")).toBeUndefined();
    store.settle(
      scope({ runId: "run-1" }),
      first.generationVersion,
      first.revision,
      generatedStatus(scope({ runId: "run-1" }), first.generationVersion),
      NOW,
    );
    const admitted = store.beginDispatch(scope({ runId: "run-2" }), LATER);
    expect(admitted).toMatchObject({ kind: "dispatch" });
  });

  it("records a closed blocked status without ever dispatching a generation attempt", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    if (decision.kind !== "dispatch") throw new Error("expected a dispatch decision");
    store.recordBlocked(
      scope(),
      "authority-expired",
      decision.generationVersion,
      decision.revision,
      NOW,
    );
    expect(store.current("run-1")).toMatchObject({ state: "blocked", reason: "authority-expired" });
  });

  it("reconciles an attempt still in flight at restart to a closed blocked status, never silently resumed", () => {
    const store = openStore();
    store.beginDispatch(scope(), NOW);
    expect(store.current("run-1")).toBeUndefined();
    const recovered = store.reconcileInterrupted(LATER);
    expect(recovered).toEqual(["run-1"]);
    expect(store.current("run-1")).toMatchObject({ state: "blocked", reason: "interrupted" });
  });

  it("never loses or re-dispatches a reconciled job on a later identical signal", () => {
    const store = openStore();
    store.beginDispatch(scope(), NOW);
    store.reconcileInterrupted(LATER);
    const again = store.beginDispatch(scope(), LATER);
    expect(again.kind).toBe("coalesced");
  });

  it("rejects a settle payload whose scope does not match the dispatched attempt", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    if (decision.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const mismatched = generatedStatus(scope({ headSha: HEAD_2 }), decision.generationVersion);
    expect(() =>
      store.settle(scope(), decision.generationVersion, decision.revision, mismatched, NOW),
    ).toThrow(TypeError);
  });
});
