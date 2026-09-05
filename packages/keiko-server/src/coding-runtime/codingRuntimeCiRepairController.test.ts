import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { isDraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  createDraftRun,
  readySnapshot,
  AT,
  COMMIT,
} from "../gitDelivery/ciObservationTest/_support.js";
import { createCodingRuntimeCiReadinessStore } from "./codingRuntimeCiReadinessStore.js";
import { createCodingRuntimeCiRepairBudgetStore } from "./codingRuntimeCiRepairBudgetStore.js";
import type {
  CiRepairBudgetContext,
  CiRepairBudgetRecord,
  CiRepairLimits,
} from "./codingRuntimeCiRepairBudgetTypes.js";
import { CodingRuntimeCiRepairController } from "./codingRuntimeCiRepairController.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { reservePromptWithCiRepair } from "./ciRepairPromptReservation.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function failed(): ReadinessSnapshot {
  return {
    ...readySnapshot(),
    state: "failed",
    failureSignatureDigest: "b".repeat(64),
    reason: "required-checks-failed",
    requiredChecks: { total: 1, passed: 0, failed: 1, pending: 0, blocked: 0, unknown: 0 },
  };
}
function fixture(
  limits: Partial<CiRepairLimits> = {},
  notifyVerifiedHeadAdvanced?: (runId: string) => void,
): {
  readonly controller: CodingRuntimeCiRepairController;
  readonly context: CiRepairBudgetContext;
  readonly store: ReturnType<typeof createCodingRuntimeCiRepairBudgetStore>;
  readonly readiness: ReturnType<typeof createCodingRuntimeCiReadinessStore>;
  readonly db: DatabaseSync;
  readonly logs: ServerLogEvent[];
  readonly clock: { now: number; live: boolean; samples: number[] };
} {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const snapshots = createDraftRun(db);
  const readiness = createCodingRuntimeCiReadinessStore(db, snapshots);
  expect(readiness.complete(readiness.begin("run-1"), failed())).toBe(true);
  const clock = { now: Date.parse(AT), live: true, samples: [] as number[] };
  const now = (): number => clock.samples.shift() ?? clock.now;
  const logs: ServerLogEvent[] = [];
  const context: CiRepairBudgetContext = {
    runId: "run-1",
    remoteDigest: "a".repeat(64),
    prNumber: 17,
    correlationId: "correlation-1",
    stillAuthorized: () => clock.live,
    limits: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 1000, ...limits },
  };
  const store = createCodingRuntimeCiRepairBudgetStore({
    db,
    snapshots,
    now,
    activityLog: {
      write: (event): void => {
        logs.push(event);
      },
    },
  });
  const controller = new CodingRuntimeCiRepairController({
    store,
    readiness,
    context: (): CiRepairBudgetContext => context,
    now,
    ...(notifyVerifiedHeadAdvanced === undefined ? {} : { notifyVerifiedHeadAdvanced }),
  });
  return { db, controller, context, store, readiness, clock, logs };
}
function firstAttempt(
  test: Pick<ReturnType<typeof fixture>, "store" | "context">,
): CiRepairBudgetRecord["attempts"][number] | undefined {
  return test.store.read(test.context).record?.attempts[0];
}
function hasSettlementLog(
  logs: readonly ServerLogEvent[],
  status: string,
  attemptStatus: string,
): boolean {
  return logs.some(
    (event) =>
      event.op === "git.ci-repair.budget" &&
      event.extra?.phase === "settle" &&
      event.extra.status === status &&
      event.extra.attemptStatus === attemptStatus,
  );
}
const verify = (
  id: string,
): {
  readonly action: "verification";
  readonly verifierId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
} => ({ action: "verification", verifierId: "test", actionId: id, idempotencyKey: id });
describe("CI repair accounting around admitted model work", () => {
  it("retains a clock denial instead of resampling forward to validate an active lease", () => {
    const test = fixture();
    const lease = test.controller.admitTool(verify("verify-1"));
    expect(lease?.check()).toBe(true);
    test.clock.samples.push(test.clock.now - 1, test.clock.now);
    expect(lease?.check()).toBe(false);
  });
  it("does not retry a clock-denied read into a new repair admission", () => {
    const test = fixture();
    test.controller.admitTool(verify("verify-1"))?.settle({ status: "failed" });
    expect(test.readiness.complete(test.readiness.begin("run-1"), failed())).toBe(true);
    test.clock.samples.push(test.clock.now - 1, test.clock.now);
    expect(test.controller.admitTool(verify("verify-2"))).toBeUndefined();
  });
  it("retains failure accounting when an observation remains in flight", () => {
    const test = fixture();
    test.readiness.begin("run-1");
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    expect(test.store.read(test.context).record?.toolCalls).toBe(1);
  });
  it.each(["pending", "unknown", "blocked"] as const)(
    "requires fresh usable CI before treating %s as ordinary post-PR work",
    (state) => {
      const test = fixture();
      const reason = {
        pending: "required-checks-pending",
        unknown: "required-checks-unknown",
        blocked: "required-checks-blocked",
      } as const;
      const snapshot = {
        ...readySnapshot(),
        state,
        reason: reason[state],
        requiredChecks: {
          total: 1,
          passed: 0,
          failed: 0,
          pending: 0,
          blocked: 0,
          unknown: 0,
          [state]: 1,
        },
      };
      expect(test.readiness.complete(test.readiness.begin("run-1"), snapshot)).toBe(true);
      expect(test.controller.admitTool(verify("verify-1"))).toBeUndefined();
      expect(test.store.read(test.context).record).toBeUndefined();
    },
  );
  it("cannot start unbudgeted post-PR work without a CI observation", () => {
    const test = fixture();
    expect(test.readiness.invalidate("run-1")).toBe(true);
    expect(test.controller.admitTool(verify("verify-1"))).toBeUndefined();
  });
  it("allows a child using the last tool credit to reserve its bounded model prompt", () => {
    const test = fixture({ maxToolCalls: 1, maxPromptTokens: 10 });
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    expect(test.controller.chargePrompt(8)).toBe(true);
    expect(test.controller.chargePrompt(3)).toBe(false);
    expect(test.controller.chargeDelegatedRead("child-1", "read-1")).toBe(false);
  });
  it("settles a started attempt if readiness invalidation fails before the first effect", () => {
    const test = fixture();
    vi.spyOn(test.readiness, "invalidate").mockReturnValue(false);
    expect(test.controller.admitTool(verify("verify-1"))).toBeUndefined();
    expect(test.store.read(test.context).record).toMatchObject({
      failedAttempts: 1,
      toolCalls: 0,
      attempts: [{ status: "failed" }],
    });
  });
  it("does not charge observations or pre-repair reads and starts at the first selected verification", () => {
    const test = fixture();
    expect(
      test.controller
        .admitTool({ action: "git", operation: "ci", actionId: "poll", idempotencyKey: "poll" })
        ?.check(),
    ).toBe(true);
    expect(
      test.controller
        .admitTool({
          action: "read",
          relativePath: "src.ts",
          actionId: "read",
          idempotencyKey: "read",
        })
        ?.check(),
    ).toBe(true);
    expect(test.store.read(test.context).record).toBeUndefined();
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    expect(test.store.read(test.context).record).toMatchObject({
      failedAttempts: 0,
      toolCalls: 1,
      attempts: [{ kind: "verification", status: "active" }],
    });
    expect(test.readiness.get("run-1")).toBeUndefined();
    expect(test.logs.every((event) => event.correlationId === "correlation-1")).toBe(true);
    expect(redactLogFields(test.logs.at(-1)?.extra ?? {})).toMatchObject({
      toolCallCount: 1,
      attemptKind: "verification",
      failedAttemptCount: 0,
    });
  });
  it("allows the last admitted tool credit to finish while denying every further effect", () => {
    const test = fixture({ maxToolCalls: 1 });
    const lease = test.controller.admitTool(verify("verify-1"));
    expect(lease?.check()).toBe(true);
    expect(test.controller.admitTool(verify("verify-2"))).toBeUndefined();
    expect(lease?.check()).toBe(true);
    test.clock.live = false;
    expect(lease?.check()).toBe(false);
  });
  it("charges accepted gateway prompt reservations exactly and forbids overflow before dispatch", () => {
    const test = fixture({ maxPromptTokens: 10 });
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    expect(test.controller.chargePrompt(10)).toBe(true);
    expect(test.controller.chargePrompt(1)).toBe(false);
    expect(test.store.read(test.context).record?.promptTokens).toBe(10);
  });
  it("counts three failed attempts cumulatively without counting repeated observations", () => {
    const test = fixture();
    for (let index = 1; index <= 3; index++) {
      expect(test.readiness.complete(test.readiness.begin("run-1"), failed())).toBe(true);
      test.controller.observed(failed());
      const lease = test.controller.admitTool(verify(`verify-${String(index)}`));
      expect(lease?.check()).toBe(true);
      lease?.settle({ status: "failed" });
      lease?.settle({ status: "failed" });
      expect(test.store.read(test.context).record?.failedAttempts).toBe(index);
    }
    expect(test.controller.admitTool(verify("verify-4"))).toBeUndefined();
    expect(
      test.controller
        .admitTool({ action: "git", operation: "ci", actionId: "poll", idempotencyKey: "poll" })
        ?.check(),
    ).toBe(true);
  });
  it("keeps a repair active while its fresh commit waits for human approval", () => {
    const test = fixture();
    const lease = test.controller.admitTool({
      action: "delivery",
      intent: "commit",
      phase: "propose",
      actionId: "commit",
      idempotencyKey: "commit",
    });
    lease?.settle({
      status: "completed",
      verifiedCommit: { ...COMMIT, status: "approval-required", reason: "approval-required" },
    });
    expect(test.store.read(test.context).record?.failedAttempts).toBe(0);
    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("active");
  });
  it("binds a repair attempt to the newly observed base instead of an old delivery base", () => {
    const test = fixture();
    const snapshot = { ...failed(), baseSha: "5".repeat(40) };
    expect(test.readiness.complete(test.readiness.begin("run-1"), snapshot)).toBe(true);
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    expect(test.store.read(test.context).record?.attempts[0]?.baseSha).toBe(snapshot.baseSha);
  });
  it("denies stale failures and expires an already admitted lease at the original deadline", () => {
    const test = fixture({ maxRuntimeMs: 100 });
    const lease = test.controller.admitTool(verify("verify-1"));
    test.clock.now += 100;
    expect(lease?.check()).toBe(false);
    expect(test.controller.admitTool(verify("verify-2"))).toBeUndefined();
  });
  it("requires a fresh observation instead of treating an expired failure as ordinary unbudgeted work", () => {
    const test = fixture();
    test.clock.now += 60_000;
    expect(test.controller.admitTool(verify("verify-1"))).toBeUndefined();
    expect(test.store.read(test.context).record).toBeUndefined();
  });
  it("also counts child reads and gateway reservations through the existing parent owners", () => {
    const test = fixture({ maxToolCalls: 2, maxPromptTokens: 10 });
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    const reservePromptTokens = (): { readonly ok: true; readonly runId: string } => ({
      ok: true,
      runId: "run-1",
    });
    expect(
      reservePromptWithCiRepair({ reservePromptTokens }, () => test.controller, "capability", 9).ok,
    ).toBe(true);
    expect(
      reservePromptWithCiRepair({ reservePromptTokens }, () => test.controller, "capability", 2),
    ).toEqual({ ok: false, reason: "authority-budget-exceeded" });
    expect(test.controller.chargeDelegatedRead("child-1", "read-1")).toBe(true);
    expect(test.controller.chargeDelegatedRead("child-2", "read-2")).toBe(false);
    expect(test.store.read(test.context).record).toMatchObject({ toolCalls: 2, promptTokens: 9 });
  });
  // #3401: a repaired head after CI repair must regenerate the run's automatic description, since
  // the orchestrator's one-time terminal dispatch already fired for the original (failing) head.
  it("notifies notifyVerifiedHeadAdvanced exactly once a repaired head is observed CI-green", () => {
    const notify = vi.fn();
    const test = fixture({}, notify);
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    // Simulate the CI-repair loop (#3388) pushing a new commit for the SAME draft PR: the draft
    // binding's head advances to the repaired commit, then CI reports that repaired head green.
    // Bypasses the draft-delivery write-path's phase-transition guard with a direct row patch
    // (irrelevant to this controller's own contract) — exactly like `readySnapshot()`/`failed()`
    // already construct fixture state directly rather than replaying a full delivery lifecycle.
    const repairedHeadSha = "4".repeat(40);
    const row = test.db
      .prepare("SELECT draft_delivery_record FROM coding_runtime_snapshots WHERE run_id = ?")
      .get("run-1") as { draft_delivery_record: string };
    const draft: unknown = JSON.parse(row.draft_delivery_record);
    if (!isDraftDeliveryRecord(draft)) throw new Error("expected a valid draft delivery record");
    const repairedCommit = JSON.stringify({ ...COMMIT, headSha: repairedHeadSha });
    test.db
      .prepare(
        "UPDATE coding_runtime_snapshots SET draft_delivery_record = ?, verified_commit_result = ?, draft_delivery_source_receipt = ? WHERE run_id = ?",
      )
      .run(
        JSON.stringify({
          ...draft,
          binding: { ...draft.binding, headSha: repairedHeadSha },
          pullRequest:
            draft.pullRequest === undefined
              ? undefined
              : { ...draft.pullRequest, headSha: repairedHeadSha },
        }),
        repairedCommit,
        repairedCommit,
        "run-1",
      );
    const repaired = { ...readySnapshot(), headSha: repairedHeadSha };
    expect(test.readiness.complete(test.readiness.begin("run-1"), repaired)).toBe(true);
    test.controller.observed(repaired);
    expect(notify).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("succeeded");
  });
  it("never notifies notifyVerifiedHeadAdvanced when a repair attempt settles failed", () => {
    const notify = vi.fn();
    const test = fixture({}, notify);
    test.controller.admitTool(verify("verify-1"))?.settle({ status: "failed" });
    expect(notify).not.toHaveBeenCalled();
  });
  it("settles a verification repair when the exact current head becomes technical-ready", () => {
    const notify = vi.fn();
    const test = fixture({}, notify);
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    const repaired = readySnapshot();
    expect(test.readiness.complete(test.readiness.begin("run-1"), repaired)).toBe(true);

    test.controller.observed(repaired);

    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("succeeded");
    expect(notify).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(hasSettlementLog(test.logs, "recorded", "succeeded")).toBe(true);
  });
  it("ignores a same-head technical-ready observation carrying stale evidence", () => {
    const test = fixture();
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    const current = readySnapshot();
    expect(test.readiness.complete(test.readiness.begin("run-1"), current)).toBe(true);

    test.controller.observed({ ...current, evidenceRef: "ci-observation-stale" });

    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("active");
  });
  it("ignores duplicate same-signature failure but settles a changed failure on the same head", () => {
    const test = fixture();
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    const duplicate = failed();
    expect(test.readiness.complete(test.readiness.begin("run-1"), duplicate)).toBe(true);
    test.controller.observed(duplicate);
    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("active");

    const changed = { ...duplicate, failureSignatureDigest: "c".repeat(64) };
    expect(test.readiness.complete(test.readiness.begin("run-1"), changed)).toBe(true);
    test.controller.observed(changed);

    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("failed");
    expect(hasSettlementLog(test.logs, "recorded", "failed")).toBe(true);
  });
  // Review repair (#3401 accepted-review minor 3b): a rejected CAS (stale revision -- a
  // concurrent write already moved the record past the revision this settle read) must never be
  // mistaken for a successful settle. `result.status` alone cannot carry this: a write that DID
  // apply can still come back "blocked" purely from `persist()`'s own post-write exhaustion
  // policy (pinned by the "exactly once" test above, which uses the same repaired-head scenario
  // but with the real store) -- so the rejected-CAS case is reproduced by wrapping the REAL store
  // and forcing only `settle` to return the record exactly as a stale-revision rejection would:
  // unchanged, with the attempt still "active".
  it("never notifies notifyVerifiedHeadAdvanced when the settling CAS is rejected (stale revision)", () => {
    const notify = vi.fn();
    const test = fixture({}, notify);
    expect(test.controller.admitTool(verify("verify-1"))?.check()).toBe(true);
    const repairedHeadSha = "4".repeat(40);
    const row = test.db
      .prepare("SELECT draft_delivery_record FROM coding_runtime_snapshots WHERE run_id = ?")
      .get("run-1") as { draft_delivery_record: string };
    const draft: unknown = JSON.parse(row.draft_delivery_record);
    if (!isDraftDeliveryRecord(draft)) throw new Error("expected a valid draft delivery record");
    const repairedCommit = JSON.stringify({ ...COMMIT, headSha: repairedHeadSha });
    test.db
      .prepare(
        "UPDATE coding_runtime_snapshots SET draft_delivery_record = ?, verified_commit_result = ?, draft_delivery_source_receipt = ? WHERE run_id = ?",
      )
      .run(
        JSON.stringify({
          ...draft,
          binding: { ...draft.binding, headSha: repairedHeadSha },
          pullRequest:
            draft.pullRequest === undefined
              ? undefined
              : { ...draft.pullRequest, headSha: repairedHeadSha },
        }),
        repairedCommit,
        repairedCommit,
        "run-1",
      );
    const repaired = { ...readySnapshot(), headSha: repairedHeadSha };
    expect(test.readiness.complete(test.readiness.begin("run-1"), repaired)).toBe(true);
    const staleRecord = test.store.read(test.context).record;
    if (staleRecord === undefined) throw new Error("expected an active repair record");
    const rejectingStore: typeof test.store = {
      read: test.store.read.bind(test.store),
      accept: test.store.accept.bind(test.store),
      begin: test.store.begin.bind(test.store),
      charge: test.store.charge.bind(test.store),
      settle: (): ReturnType<typeof test.store.settle> => ({
        status: "blocked",
        reason: "stale-revision",
        record: staleRecord,
      }),
    };
    const controller = new CodingRuntimeCiRepairController({
      store: rejectingStore,
      readiness: test.readiness,
      context: (): CiRepairBudgetContext => test.context,
      now: (): number => test.clock.now,
      notifyVerifiedHeadAdvanced: notify,
    });
    controller.observed(repaired);
    expect(notify).not.toHaveBeenCalled();
    // The real store was never actually written through the rejecting wrapper, so the attempt it
    // began is still active in the underlying storage -- the assertion above is not vacuous.
    expect(test.store.read(test.context).record?.attempts[0]?.status).toBe("active");
  });
  // Final-audit F25: the specific out-of-order settle race the CAS guard at settleScope() (lines
  // 299-311 of codingRuntimeCiRepairBudgetStore.ts) exists to prevent, exercised against the REAL
  // store (unlike the two tests above, which wrap or force the store's response). A tool-failure
  // settle('failed') closes the attempt first; a LATE, out-of-order settle for the SAME attemptId
  // reporting the opposite outcome (a stale "technical-ready" CI observation that resolves only
  // after the tool's own failure already closed the attempt) must be rejected as `attempt-replayed`,
  // never silently accepted as a second, conflicting settlement -- and the controller's own
  // `observed()` path, driven by that same stale CI signal, must never resurrect the closed attempt
  // or fire `notifyVerifiedHeadAdvanced` for it.
  it("rejects a late out-of-order settle for an attempt the tool's own failure already closed", () => {
    const notify = vi.fn();
    const test = fixture({}, notify);
    const lease = test.controller.admitTool(verify("verify-1"));
    const attemptId = firstAttempt(test)?.attemptId;
    if (attemptId === undefined) throw new Error("expected an active repair attempt");
    expect(firstAttempt(test)?.status).toBe("active");

    // Closes the attempt as "failed" -- exactly the lease callback path admitTool() wires up.
    lease?.settle({ status: "failed" });
    expect(firstAttempt(test)?.status).toBe("failed");

    // The late, out-of-order settle for the SAME attemptId, reporting the opposite outcome: the
    // real store's CAS guard must reject it rather than treat it as a fresh settlement.
    const revision = test.store.read(test.context).record?.revision ?? 0;
    const late = test.store.settle(test.context, {
      attemptId,
      outcome: "succeeded",
      expectedRevision: revision,
    });
    expect(late).toMatchObject({ status: "blocked", reason: "attempt-replayed" });
    expect(firstAttempt(test)?.status).toBe("failed");

    // The same race arriving through the controller's own `observed()` path (a stale CI snapshot
    // for a repaired head, delivered after the tool failure already closed the attempt) must
    // neither resurrect the attempt nor notify.
    test.controller.observed({ ...readySnapshot(), headSha: "4".repeat(40) });
    expect(notify).not.toHaveBeenCalled();
    expect(firstAttempt(test)?.status).toBe("failed");
  });
});
