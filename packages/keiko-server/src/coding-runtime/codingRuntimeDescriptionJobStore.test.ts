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

  // #3401 review finding 1: a budget-exhausted decision was never persisted, leaving the run
  // permanently without a descriptionStatus. Before this test's fix, `recordBudgetExhausted` did
  // not exist on the store at all — this call would fail to compile / throw "not a function".
  it("makes a budget-exhausted decision visible as a blocked status", () => {
    const store = openStore(1);
    store.beginDispatch(scope({ runId: "run-1" }), NOW);
    const blocked = store.beginDispatch(scope({ runId: "run-2" }), NOW);
    expect(blocked).toEqual({ kind: "budget-exhausted" });

    store.recordBudgetExhausted(scope({ runId: "run-2" }), NOW);

    expect(store.current("run-2")).toEqual({
      schemaVersion: "1",
      runId: "run-2",
      remoteDigest: REMOTE,
      baseSha: BASE,
      headSha: HEAD_1,
      generationVersion: 1,
      state: "blocked",
      reason: "budget-exhausted",
      snapshotDigest: null,
      draftDigest: null,
      artifactOutcome: null,
      observedAt: NOW,
    });
  });

  // #3401 review finding 2: the budget cap applied only to a brand-new run (`row === undefined`),
  // so a repaired-head regeneration for an already-settled run bypassed it entirely. Before the
  // fix this second `beginDispatch` returned `{ kind: "dispatch" }` even though the sole
  // concurrent slot was already occupied by "run-2".
  it("still applies the budget cap to a repaired head on an already-settled run", () => {
    const store = openStore(1);
    const first = store.beginDispatch(scope({ runId: "run-1" }), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    store.settle(
      scope({ runId: "run-1" }),
      first.generationVersion,
      first.revision,
      generatedStatus(scope({ runId: "run-1" }), first.generationVersion),
      NOW,
    );
    // "run-2" now occupies the sole concurrent slot.
    const second = store.beginDispatch(scope({ runId: "run-2" }), NOW);
    expect(second).toMatchObject({ kind: "dispatch" });

    // "run-1" is settled (not in flight), so its repaired head must still respect the cap.
    const repaired = store.beginDispatch(scope({ runId: "run-1", headSha: HEAD_2 }), LATER);
    expect(repaired).toEqual({ kind: "budget-exhausted" });
  });

  it("records a closed blocked status without ever dispatching a generation attempt", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    if (decision.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const accepted = store.recordBlocked(
      scope(),
      "authority-expired",
      decision.generationVersion,
      decision.revision,
      NOW,
    );
    expect(accepted).toBe(true);
    expect(store.current("run-1")).toMatchObject({ state: "blocked", reason: "authority-expired" });
  });

  // #3401 review finding 15: the orchestrator's async provider-failure branch must be able to tell
  // "this attempt is genuinely blocked" from "a newer head already superseded it" (mirroring
  // `settle`'s own CAS return), so a late provider rejection for an abandoned head never
  // overwrites the status of the head that superseded it.
  it("returns false from recordBlocked when a newer head superseded the attempt first", () => {
    const store = openStore();
    const first = store.beginDispatch(scope(), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const superseding = store.beginDispatch(scope({ headSha: HEAD_2 }), LATER);
    expect(superseding.kind).toBe("dispatch");

    const accepted = store.recordBlocked(
      scope(),
      "provider-failed",
      first.generationVersion,
      first.revision,
      LATER,
    );

    expect(accepted).toBe(false);
    // The superseding head's own in-flight attempt must be left untouched by the stale write.
    expect(store.current("run-1")).toBeUndefined();
  });

  // #3401 review finding F6: `recordBlocked` was the only public write path that skipped
  // `assertScope`, unlike `beginDispatch`, `settle` and `recordBudgetExhausted` — a malformed
  // scope reaching this path was written to `status_json` and the row's identity columns
  // unvalidated instead of being rejected at the trust boundary.
  it("rejects a malformed scope passed to recordBlocked instead of writing it unvalidated", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    if (decision.kind !== "dispatch") throw new Error("expected a dispatch decision");
    expect(() =>
      store.recordBlocked(
        scope({ runId: "not/a/valid/run-id" }),
        "provider-failed",
        decision.generationVersion,
        decision.revision,
        NOW,
      ),
    ).toThrow(TypeError);
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
