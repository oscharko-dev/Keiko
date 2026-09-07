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
  return {
    runId: "run-00000001",
    remoteDigest: REMOTE,
    baseSha: BASE,
    headSha: HEAD_1,
    ...overrides,
  };
}

function generatedStatus(
  target: WorkbenchDescriptionScope,
  generationVersion: number,
  proposalId?: string,
): WorkbenchDescriptionStatus {
  return {
    schemaVersion: "1",
    runId: target.runId,
    remoteDigest: target.remoteDigest,
    baseSha: target.baseSha,
    headSha: target.headSha,
    ...(target.generationBinding === undefined
      ? {}
      : { generationBinding: target.generationBinding }),
    generationVersion,
    state: "current",
    reason: "generated",
    snapshotDigest: "b".repeat(64),
    draftDigest: "c".repeat(64),
    artifactOutcome: "complete",
    ...(proposalId === undefined ? {} : { proposalId }),
    observedAt: NOW,
  };
}

describe("codingRuntimeDescriptionJobStore — dispatch, dedup, coalesce, supersede", () => {
  it("retains generation binding through recovery and rejects settlement with a different binding", () => {
    const store = openStore();
    const target = scope({
      generationBinding: {
        taskDigest: "a".repeat(64),
        authorityDigest: "b".repeat(64),
        runtimeBindingDigest: "c".repeat(64),
        deliveryBindingDigest: "d".repeat(64),
      },
    });
    const attempt = store.beginDispatch(target, NOW);
    if (attempt.kind !== "dispatch") throw new Error("expected dispatch");
    expect(() =>
      store.settle(target, 1, attempt.revision, generatedStatus(scope(), 1), NOW),
    ).toThrow(/scope/u);
    expect(store.reconcileInterrupted(LATER)).toEqual([target.runId]);
    expect(store.current(target.runId)).toMatchObject({
      generationBinding: target.generationBinding,
      state: "blocked",
      reason: "interrupted",
    });
  });

  it.each(["taskDigest", "authorityDigest", "runtimeBindingDigest", "deliveryBindingDigest"])(
    "supersedes an unchanged head when %s changes",
    (field) => {
      const store = openStore();
      const generationBinding = {
        taskDigest: "a".repeat(64),
        authorityDigest: "b".repeat(64),
        runtimeBindingDigest: "c".repeat(64),
        deliveryBindingDigest: null,
      };
      store.beginDispatch({ ...scope(), generationBinding }, NOW);
      const next = store.beginDispatch(
        { ...scope(), generationBinding: { ...generationBinding, [field]: "d".repeat(64) } },
        LATER,
      );
      expect(next).toMatchObject({ kind: "dispatch", generationVersion: 2, revision: 1 });
    },
  );

  it("dispatches exactly once for a stable successful head", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    expect(decision).toEqual({
      kind: "dispatch",
      generationVersion: 1,
      revision: 0,
      supersededPriorAttempt: false,
    });
    expect(store.current("run-00000001")).toBeUndefined();
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

  it("durably marks a generated status stale when its process-local proposal is lost", () => {
    const store = openStore();
    const attempt = store.beginDispatch(scope(), NOW);
    if (attempt.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const status = generatedStatus(scope(), attempt.generationVersion, "pr-description-1");
    store.settle(scope(), attempt.generationVersion, attempt.revision, status, NOW);

    expect(store.markProposalLost(scope().runId, "pr-description-1", LATER)).toMatchObject({
      state: "stale",
      reason: "stale-snapshot",
      observedAt: LATER,
    });
    expect(store.current(scope().runId)).not.toHaveProperty("proposalId");
    expect(store.markProposalLost(scope().runId, "different-proposal", LATER)).toEqual(
      store.current(scope().runId),
    );
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
    expect(store.current("run-00000001")).toBeUndefined();
  });

  it("rejects a budget-exhausted trigger without creating a row, and admits it once capacity frees", () => {
    const store = openStore(1);
    const first = store.beginDispatch(scope({ runId: "run-00000001" }), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const blocked = store.beginDispatch(scope({ runId: "run-00000002" }), NOW);
    expect(blocked).toEqual({ kind: "budget-exhausted" });
    expect(store.current("run-00000002")).toBeUndefined();
    store.settle(
      scope({ runId: "run-00000001" }),
      first.generationVersion,
      first.revision,
      generatedStatus(scope({ runId: "run-00000001" }), first.generationVersion),
      NOW,
    );
    const admitted = store.beginDispatch(scope({ runId: "run-00000002" }), LATER);
    expect(admitted).toMatchObject({ kind: "dispatch" });
  });

  // #3401 review finding 1: a budget-exhausted decision was never persisted, leaving the run
  // permanently without a descriptionStatus. Before this test's fix, `recordBudgetExhausted` did
  // not exist on the store at all — this call would fail to compile / throw "not a function".
  it("makes a budget-exhausted decision visible as a blocked status", () => {
    const store = openStore(1);
    store.beginDispatch(scope({ runId: "run-00000001" }), NOW);
    const blocked = store.beginDispatch(scope({ runId: "run-00000002" }), NOW);
    expect(blocked).toEqual({ kind: "budget-exhausted" });

    store.recordBudgetExhausted(scope({ runId: "run-00000002" }), NOW);

    expect(store.current("run-00000002")).toEqual({
      schemaVersion: "1",
      runId: "run-00000002",
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
  // concurrent slot was already occupied by "run-00000002".
  it("still applies the budget cap to a repaired head on an already-settled run", () => {
    const store = openStore(1);
    const first = store.beginDispatch(scope({ runId: "run-00000001" }), NOW);
    if (first.kind !== "dispatch") throw new Error("expected a dispatch decision");
    store.settle(
      scope({ runId: "run-00000001" }),
      first.generationVersion,
      first.revision,
      generatedStatus(scope({ runId: "run-00000001" }), first.generationVersion),
      NOW,
    );
    // "run-00000002" now occupies the sole concurrent slot.
    const second = store.beginDispatch(scope({ runId: "run-00000002" }), NOW);
    expect(second).toMatchObject({ kind: "dispatch" });

    // "run-00000001" is settled (not in flight), so its repaired head must still respect the cap.
    const repaired = store.beginDispatch(scope({ runId: "run-00000001", headSha: HEAD_2 }), LATER);
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
    expect(store.current("run-00000001")).toMatchObject({
      state: "blocked",
      reason: "authority-expired",
    });
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
    expect(store.current("run-00000001")).toBeUndefined();
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
    expect(store.current("run-00000001")).toBeUndefined();
    const recovered = store.reconcileInterrupted(LATER);
    expect(recovered).toEqual(["run-00000001"]);
    expect(store.current("run-00000001")).toMatchObject({
      state: "blocked",
      reason: "interrupted",
    });
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

  // Owner audit of PR #3394, finding b1-18: `settleRow` guarded only on `revision`, so a SECOND
  // `settle` for the same revision (a late duplicate completion racing its own prior result, not a
  // supersede by a newer head) silently overwrote the already-durable status instead of being
  // rejected as stale. Before the `AND phase = 'dispatched'` guard, the second `settle` below
  // returned `true` and `store.current` reflected the duplicate's payload, not the first's.
  it("rejects a second settle for the same revision instead of overwriting the durable status", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    if (decision.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const first = generatedStatus(scope(), decision.generationVersion);
    expect(store.settle(scope(), decision.generationVersion, decision.revision, first, NOW)).toBe(
      true,
    );
    const duplicate = generatedStatus(scope(), decision.generationVersion);
    const accepted = store.settle(
      scope(),
      decision.generationVersion,
      decision.revision,
      duplicate,
      LATER,
    );
    expect(accepted).toBe(false);
    expect(store.current("run-00000001")).toEqual(first);
  });

  // Same b1-18 guard, exercised through `recordBlocked` — the sibling settle path.
  it("rejects a duplicate recordBlocked for a revision that has already settled", () => {
    const store = openStore();
    const decision = store.beginDispatch(scope(), NOW);
    if (decision.kind !== "dispatch") throw new Error("expected a dispatch decision");
    const settled = generatedStatus(scope(), decision.generationVersion);
    store.settle(scope(), decision.generationVersion, decision.revision, settled, NOW);
    const accepted = store.recordBlocked(
      scope(),
      "provider-failed",
      decision.generationVersion,
      decision.revision,
      LATER,
    );
    expect(accepted).toBe(false);
    expect(store.current("run-00000001")).toEqual(settled);
  });

  // Owner audit of PR #3394, finding b3-22: `runId` is threaded downstream as a log
  // `correlationId`, but the old `RUN_ID` pattern admitted colons that `correlation.ts`'s
  // `SAFE_CORRELATION_ID` rejects — a persisted scope could carry a run id the log pipeline
  // silently downgrades to `UNKNOWN_CORRELATION_ID`. This id was accepted by the old pattern;
  // `assertScope` now rejects it at the trust boundary instead.
  it("rejects a run id containing a colon, which the correlation-id log pipeline also rejects", () => {
    const store = openStore();
    expect(() => store.beginDispatch(scope({ runId: "run:0000001" }), NOW)).toThrow(TypeError);
  });

  // Owner audit of PR #3394, finding b3-22 (residual): the colon fix above narrowed the gap from
  // two causes to one -- a run id shorter than correlation.ts's 8-character SAFE_CORRELATION_ID
  // floor still passed the old local RUN_ID pattern (minimum length 1) and was silently downgraded
  // to UNKNOWN_CORRELATION_ID by any downstream logger. Reusing isValidCorrelationId directly
  // (rather than a second, hand-tuned copy of its length/alphabet) closes this for good: the two
  // validators can no longer drift apart.
  it("rejects a run id shorter than the correlation-id log pipeline's 8-character floor", () => {
    const store = openStore();
    expect(() => store.beginDispatch(scope({ runId: "run-1" }), NOW)).toThrow(TypeError);
  });
});
