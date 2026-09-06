import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { DraftDeliveryFixture } from "../gitDelivery/draftDeliveryServiceTestSupport.js";
import type { CodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import { computeStoreFingerprint } from "../store/db.js";
import { runMigrations } from "../store/schema.js";
import { rewindSchemaFixture } from "../store/legacySchemaTestFixture.js";
import {
  createCodingRuntimeSnapshotStore,
  type CodingRuntimeSnapshot,
  type CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import { createCodingRuntimeCiRepairBudgetStore } from "./codingRuntimeCiRepairBudgetStore.js";
import {
  CI_REPAIR_WRITE_RESERVE_BYTES,
  type CiRepairBegin,
  type CiRepairChargeInput,
  type CiRepairSettle,
  type CiRepairBudgetContext,
  type CiRepairBudgetRecord,
  type CiRepairBudgetResult,
} from "./codingRuntimeCiRepairBudgetTypes.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { redactLogFields } from "../observability/log-redaction.js";

import { chargeCiRepairAttempt, newCiRepairAttempt } from "./codingRuntimeCiRepairBudgetPolicy.js";
import { CodingRuntimeCiRepairController } from "./codingRuntimeCiRepairController.js";
import { createCodingRuntimeCiReadinessStore } from "./codingRuntimeCiReadinessStore.js";

let template: CodingRuntimeSnapshot;
beforeAll(async () => {
  const fixture = new DraftDeliveryFixture();
  try {
    await fixture.recordVerifiedCommit();
    await execute(fixture, await fixture.service.proposePush());
    await execute(fixture, await fixture.service.proposePullRequest("feat: bounded change"));
    const snapshot = fixture.snapshots.get("run-1");
    if (snapshot === undefined) throw new Error("missing production draft fixture");
    template = snapshot;
  } finally {
    fixture.close();
  }
});
async function execute(
  fixture: DraftDeliveryFixture,
  value: CodingRuntimeDeliveryResult,
): Promise<void> {
  if (value.status !== "recorded") throw new Error("missing production proposal");
  const id = value.record.proposalId;
  fixture.service.issueApproval(id);
  const lease = fixture.service.consumeApproval(id);
  if (lease === undefined) throw new Error("missing production approval");
  await fixture.service.executeApproved(id, lease, { check: () => true });
}
let db: DatabaseSync;
let snapshots: CodingRuntimeSnapshotStore;
let budget: ReturnType<typeof createCodingRuntimeCiRepairBudgetStore>;
let events: ServerLogEvent[];
let now: number;
let live: boolean;
let context: CiRepairBudgetContext;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  snapshots = createCodingRuntimeSnapshotStore(db);
  snapshots.create(template);
  events = [];
  now = Date.parse("2026-09-05T00:00:00.000Z");
  live = true;
  context = {
    runId: "run-1",
    remoteDigest: template.issueBinding?.remoteDigest ?? "",
    prNumber: 17,
    correlationId: "11111111-2222-4333-8444-555555555555",
    limits: { maxRuntimeMs: 60_000, maxToolCalls: 10, maxPromptTokens: 1_000 },
    stillAuthorized: (): boolean => live,
  };
  budget = createCodingRuntimeCiRepairBudgetStore({
    db,
    snapshots,
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
    now: () => now,
  });
});
afterEach(() => {
  db.close();
});
function record(value: CiRepairBudgetResult): CiRepairBudgetRecord {
  if (value.record === undefined) throw new Error("missing repair budget record");
  return value.record;
}
function begin(
  attemptId: string,
  expectedRevision: number | null,
  scope = context,
): CiRepairBudgetResult {
  const draft = snapshots.get(scope.runId)?.draftDelivery;
  if (draft === undefined) throw new Error("missing current draft");
  return budget.begin(scope, {
    attemptId,
    expectedRevision,
    kind: "workspace-edit",
    failureSignatureDigest: attemptId === "attempt-1" ? "a".repeat(64) : "b".repeat(64),
    headSha: draft.binding.headSha,
    baseSha: draft.binding.baseSha,
  });
}
function stored(): CiRepairBudgetRecord {
  const row = db.prepare("SELECT record_json FROM coding_runtime_ci_repair_budgets").get();
  if (typeof row?.record_json !== "string") throw new Error("missing persisted budget");
  return JSON.parse(row.record_json) as CiRepairBudgetRecord;
}
function charge(
  expectedRevision: number,
  toolCalls = 1,
  promptTokens = 10,
  scope = context,
): CiRepairBudgetResult {
  return budget.charge(scope, {
    attemptId: "attempt-1",
    chargeId: `charge-${String(expectedRevision)}`,
    expectedRevision,
    toolCalls,
    promptTokens,
  });
}
function successor(runId: string, headSha?: string): CiRepairBudgetContext {
  snapshots.markNonterminalRecoveryRequired("2026-09-05T00:00:00.000Z");
  const old = snapshots.get(context.runId);
  if (old?.draftDelivery === undefined) throw new Error("missing predecessor");
  snapshots.acknowledgeRecovery(old.runId, "2026-09-05T00:00:00.000Z");
  // Linked successor creation settles this acknowledged predecessor atomically with its insert.
  const {
    verifiedCommitResult: _receipt,
    terminalAt: _terminal,
    recoveryAcknowledgedAt: _ack,
    ...shared
  } = old;
  expect(_receipt?.runId ?? old.runId).toBe(old.runId);
  expect(_terminal).toBeUndefined();
  expect(_ack).toBeUndefined();
  snapshots.create({
    ...shared,
    runId,
    predecessorRunId: old.runId,
    state: "running",
    revision: 0,
    authorityDigest: "b".repeat(64),
    draftDelivery: {
      ...old.draftDelivery,
      ...(headSha === undefined || old.draftDelivery.pullRequest === undefined
        ? {}
        : { pullRequest: { ...old.draftDelivery.pullRequest, headSha } }),
      binding: {
        ...old.draftDelivery.binding,
        runId,
        runtimeAuthorityDigest: "b".repeat(64),
        envelopeDigest: "b".repeat(64),
        ...(headSha === undefined ? {} : { headSha }),
      },
    },
  });
  return { ...context, runId };
}

describe("cumulative Code-task CI repair accounting", () => {
  it("durably adopts narrower accepted successor limits through the runtime controller", () => {
    const first = record(begin("attempt-1", null));
    budget.settle(context, {
      attemptId: "attempt-1",
      outcome: "failed",
      expectedRevision: first.revision,
    });
    const recovered = successor("run-2");
    const narrow = {
      ...recovered,
      limits: { maxRuntimeMs: 10_000, maxToolCalls: 1, maxPromptTokens: 80 },
    };
    const controller = new CodingRuntimeCiRepairController({
      store: budget,
      readiness: createCodingRuntimeCiReadinessStore(db, snapshots),
      context: (): CiRepairBudgetContext => narrow,
      now: (): number => now,
    });
    expect(
      controller
        .admitTool({ action: "git", operation: "ci", actionId: "poll", idempotencyKey: "poll" })
        ?.check(),
    ).toBe(true);
    expect(stored().limits).toEqual(narrow.limits);
    expect(budget.read(recovered).record?.limits).toEqual(narrow.limits);
    expect(stored().attempts).toHaveLength(1);
  });
  it("does not create or charge a repair attempt while polling", () => {
    expect(budget.read(context)).toEqual({ status: "available", record: undefined });
    expect(budget.read(context)).toEqual({ status: "available", record: undefined });
    expect(
      db.prepare("SELECT count(*) AS count FROM coding_runtime_ci_repair_budgets").get()?.count,
    ).toBe(0);
  });
  it("starts one immutable-deadline attempt and deduplicates accounting delivery", () => {
    const first = record(begin("attempt-1", null));
    expect(first.deadlineMs).toBe(now + context.limits.maxRuntimeMs);
    expect(begin("attempt-1", null)).toMatchObject({ status: "replayed", record: { revision: 0 } });
    const charge = {
      attemptId: "attempt-1",
      chargeId: "charge-1",
      toolCalls: 1,
      promptTokens: 100,
      expectedRevision: 0,
    };
    expect(budget.charge(context, charge)).toMatchObject({
      status: "recorded",
      record: { toolCalls: 1, promptTokens: 100, revision: 1 },
    });
    expect(budget.charge(context, charge)).toMatchObject({
      status: "replayed",
      record: { toolCalls: 1, promptTokens: 100, revision: 1 },
    });
    expect(record(budget.read(context)).deadlineMs).toBe(first.deadlineMs);
  });
  it("keeps three failed attempts cumulative across run, head and failure-signature changes", () => {
    begin("attempt-1", null);
    budget.settle(context, { attemptId: "attempt-1", outcome: "failed", expectedRevision: 0 });
    const fresh = successor("run-2", "c".repeat(40));
    begin("attempt-2", 1, fresh);
    budget.settle(fresh, { attemptId: "attempt-2", outcome: "failed", expectedRevision: 2 });
    begin("attempt-3", 3, fresh);
    budget.settle(fresh, { attemptId: "attempt-3", outcome: "failed", expectedRevision: 4 });
    expect(begin("attempt-4", 5, fresh)).toMatchObject({
      status: "blocked",
      reason: "attempt-budget-exhausted",
      record: { failedAttempts: 3 },
    });
    expect(record(budget.read(fresh)).attempts).toHaveLength(3);
  });
  it("emits correlated body-free accounting on the existing activity log", () => {
    begin("attempt-1", null);
    const event = events.find(
      (line) => line.op === "git.ci-repair.budget" && line.extra?.phase === "begin",
    );
    expect(event?.correlationId).toBe(context.correlationId);
    expect(event?.extra).toMatchObject({ revision: 0, attemptCount: 1, failedAttemptCount: 0 });
    expect(redactLogFields(event?.extra ?? {})).toEqual(event?.extra);
    expect(JSON.stringify(events)).not.toContain("feat: bounded change");
  });
  // #3384 B3-16: this is the last line of defense before the write -- server-log.ts never
  // shape-validates the primary `correlationId` field -- so a malformed value reaching this call
  // site must be downgraded here rather than logged verbatim.
  it("downgrades a malformed correlation id instead of logging it raw", () => {
    begin("attempt-1", null, { ...context, correlationId: "not a valid id!" });
    const event = events.find(
      (line) => line.op === "git.ci-repair.budget" && line.extra?.phase === "begin",
    );
    expect(event?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
});

describe("CI repair restart and monotonic limits", () => {
  it("charges interrupted work once only at live accepted recovery and never during polling", () => {
    const first = record(begin("attempt-1", null));
    charge(0, 2, 100);
    const fresh = successor("run-2");
    const before = stored();
    budget.read(fresh);
    expect(stored()).toEqual(before);
    live = false;
    expect(budget.accept(fresh, 1)).toMatchObject({
      status: "blocked",
      reason: "authority-denied",
    });
    expect(stored()).toEqual(before);
    live = true;
    expect(budget.accept(fresh, 1)).toMatchObject({
      status: "blocked",
      reason: "recovery-required",
      record: { revision: 2, failedAttempts: 1, toolCalls: 2, promptTokens: 100 },
    });
    expect(budget.accept(fresh, 2)).toMatchObject({
      status: "replayed",
      record: { failedAttempts: 1 },
    });
    expect(begin("attempt-2", 2, fresh)).toMatchObject({ status: "recorded" });
    expect(stored().deadlineMs).toBe(first.deadlineMs);
    expect(stored().attempts[0]).toMatchObject({
      status: "interrupted",
      runId: "run-1",
      charges: [],
    });
    expect(JSON.stringify(stored())).not.toMatch(/authority|approval|capability|token"/iu);
  });
  it("persists narrower accepted recovery budgets even when no new effect can begin", () => {
    const first = record(begin("attempt-1", null));
    charge(0, 2, 100);
    const narrow = {
      ...context,
      limits: { maxRuntimeMs: 10_000, maxToolCalls: 1, maxPromptTokens: 80 },
    };
    expect(budget.read(narrow)).toMatchObject({
      status: "blocked",
      reason: "tool-budget-exhausted",
    });
    expect(stored().limits).toEqual(context.limits);
    expect(budget.accept(narrow, 1)).toMatchObject({
      status: "blocked",
      reason: "tool-budget-exhausted",
    });
    expect(stored()).toMatchObject({
      revision: 2,
      deadlineMs: first.startedAtMs + 10_000,
      limits: narrow.limits,
    });
    expect(budget.accept(context, 2)).toMatchObject({
      status: "blocked",
      reason: "tool-budget-exhausted",
    });
    expect(stored().limits).toEqual(narrow.limits);
  });
  it("never refreshes an expired deadline through polls, accepts or new heads", () => {
    const first = record(begin("attempt-1", null));
    budget.settle(context, { attemptId: "attempt-1", outcome: "succeeded", expectedRevision: 0 });
    const fresh = successor("run-2", "c".repeat(40));
    now = first.deadlineMs;
    for (const result of [
      budget.read(fresh),
      budget.accept(fresh, 1),
      begin("attempt-2", 1, fresh),
    ]) {
      expect(result).toMatchObject({ status: "blocked", reason: "deadline-exhausted" });
    }
    expect(stored().deadlineMs).toBe(first.deadlineMs);
    expect(stored().attempts).toHaveLength(1);
  });
  it("rejects rollback and invalid clocks without changing stored truth", () => {
    begin("attempt-1", null);
    now += 100;
    charge(0);
    const before = stored();
    now -= 1;
    expect(budget.read(context)).toMatchObject({ reason: "clock-drift" });
    expect(budget.accept(context, 1)).toMatchObject({ reason: "clock-drift" });
    expect(charge(1)).toMatchObject({ reason: "clock-drift" });
    now = Number.NaN;
    expect(budget.read(context)).toMatchObject({ reason: "invalid-input" });
    expect(stored()).toEqual(before);
  });
  it.each([
    [10, 10, "tool-budget-exhausted"],
    [1, 1_000, "prompt-budget-exhausted"],
  ] as const)("persists admitted usage %i/%i before reporting %s", (calls, tokens, reason) => {
    begin("attempt-1", null);
    expect(charge(0, calls, tokens)).toMatchObject({ status: "blocked", reason });
    expect(stored()).toMatchObject({ toolCalls: calls, promptTokens: tokens, revision: 1 });
    expect(begin("attempt-2", 1)).toMatchObject({ reason: "attempt-active" });
    budget.settle(context, { attemptId: "attempt-1", outcome: "failed", expectedRevision: 1 });
    expect(begin("attempt-2", 2)).toMatchObject({ reason });
  });
});

describe("CI repair accounting CAS and hostile input", () => {
  it("rejects stale concurrent charges, altered retry payloads and settled attempt replay", () => {
    begin("attempt-1", null);
    expect(charge(0)).toMatchObject({ status: "recorded" });
    expect(
      budget.charge(context, {
        attemptId: "attempt-1",
        chargeId: "other",
        expectedRevision: 0,
        toolCalls: 1,
        promptTokens: 10,
      }),
    ).toMatchObject({ reason: "stale-revision" });
    expect(charge(0, 2)).toMatchObject({ reason: "invalid-input" });
    expect(stored()).toMatchObject({ revision: 1, toolCalls: 1, promptTokens: 10 });
    expect(
      budget.settle(context, { attemptId: "attempt-1", outcome: "succeeded", expectedRevision: 1 }),
    ).toMatchObject({ status: "recorded" });
    expect(
      budget.settle(context, { attemptId: "attempt-1", outcome: "succeeded", expectedRevision: 1 }),
    ).toMatchObject({ status: "replayed" });
    expect(begin("attempt-1", 2)).toMatchObject({ reason: "attempt-replayed" });
    expect(
      budget.settle(context, { attemptId: "attempt-1", outcome: "failed", expectedRevision: 2 }),
    ).toMatchObject({ reason: "attempt-replayed" });
  });
  it("refuses drifted current PR, remote, head, limits and terminal runs", () => {
    expect(budget.read({ ...context, prNumber: 18 })).toMatchObject({ reason: "invalid-binding" });
    expect(budget.read({ ...context, remoteDigest: "d".repeat(64) })).toMatchObject({
      reason: "invalid-binding",
    });
    expect(
      budget.read({ ...context, limits: { ...context.limits, maxToolCalls: 0 } }),
    ).toMatchObject({ reason: "invalid-binding" });
    const draft = template.draftDelivery;
    if (draft === undefined) throw new Error("missing draft");
    expect(
      budget.begin(context, {
        attemptId: "attempt-1",
        failureSignatureDigest: "a".repeat(64),
        expectedRevision: null,
        kind: "commit",
        headSha: "c".repeat(40),
        baseSha: draft.binding.baseSha,
      }),
    ).toMatchObject({ reason: "invalid-binding" });
    snapshots.markNonterminalRecoveryRequired("2026-09-05T00:00:00.000Z");
    expect(begin("attempt-1", null)).toMatchObject({ reason: "invalid-binding" });
    expect(
      db.prepare("SELECT count(*) AS count FROM coding_runtime_ci_repair_budgets").get()?.count,
    ).toBe(0);
  });
  it("rechecks authority at the synchronous database mutation boundary", () => {
    let checks = 0;
    const revoked = { ...context, stillAuthorized: (): boolean => ++checks === 1 };
    expect(begin("attempt-1", null, revoked)).toMatchObject({ reason: "authority-denied" });
    expect(
      db.prepare("SELECT count(*) AS count FROM coding_runtime_ci_repair_budgets").get()?.count,
    ).toBe(0);
  });
  it.each(["body", "prompt", "token", "authority", "approval"])(
    "refuses persisted nested %s fields with correlated diagnostics",
    (field) => {
      const value = record(begin("attempt-1", null));
      const corrupted = {
        ...value,
        attempts: value.attempts.map((attempt) => ({
          ...attempt,
          [field]: "hostile private body",
        })),
      };
      db.prepare("UPDATE coding_runtime_ci_repair_budgets SET record_json=?").run(
        JSON.stringify(corrupted),
      );
      expect(budget.read(context)).toEqual({ status: "blocked", reason: "storage-unavailable" });
      expect(events.at(-1)).toMatchObject({
        op: "git.ci-repair.budget",
        correlationId: context.correlationId,
        errorKind: "internal",
        extra: { reason: "storage-unavailable" },
      });
      expect(JSON.stringify(events)).not.toContain("hostile private body");
    },
  );
  // #3384 B3-16: the storage-unavailable catch path is a second, separate write site guarded by
  // the same helper -- prove it independently of the "begin" phase's write above.
  it("downgrades a malformed correlation id on the storage-unavailable catch path", () => {
    const value = record(begin("attempt-1", null));
    db.prepare("UPDATE coding_runtime_ci_repair_budgets SET record_json=?").run(
      JSON.stringify({ ...value, attempts: value.attempts.map((a) => ({ ...a, body: "x" })) }),
    );
    expect(budget.read({ ...context, correlationId: "not a valid id!" })).toEqual({
      status: "blocked",
      reason: "storage-unavailable",
    });
    expect(events.at(-1)).toMatchObject({
      op: "git.ci-repair.budget",
      correlationId: UNKNOWN_CORRELATION_ID,
      errorKind: "internal",
      extra: { reason: "storage-unavailable" },
    });
  });
  it("reports enough body-free evidence to identify the charged repair attempt", () => {
    begin("attempt-1", null);
    charge(0, 2, 100);
    expect(events.at(-1)?.extra).toMatchObject({
      attemptId: "attempt-1",
      failureSignatureDigest: "a".repeat(64),
      headSha: template.draftDelivery?.binding.headSha,
      toolCallCount: 2,
      promptTokenCount: 100,
      maxToolCalls: 10,
      maxPromptTokens: 1_000,
    });
    expect(redactLogFields(events.at(-1)?.extra ?? {})).toEqual(events.at(-1)?.extra);
  });
});

describe("CI repair durable bounds and migration", () => {
  it("uses the actual SQL CAS if another writer wins immediately before persistence", () => {
    begin("attempt-1", null);
    let checks = 0;
    const racing = {
      ...context,
      stillAuthorized: (): boolean => {
        checks += 1;
        if (checks === 2) expect(charge(0, 1, 10)).toMatchObject({ status: "recorded" });
        return true;
      },
    };
    expect(
      budget.charge(racing, {
        attemptId: "attempt-1",
        chargeId: "loser",
        expectedRevision: 0,
        toolCalls: 2,
        promptTokens: 50,
      }),
    ).toMatchObject({ reason: "stale-revision" });
    expect(stored()).toMatchObject({ revision: 1, toolCalls: 1, promptTokens: 10 });
    expect(stored().attempts[0]?.charges).toHaveLength(1);
  });
  it("never prunes completed attempt identities to evade the 32-receipt limit", () => {
    let revision: number | null = null;
    for (let index = 0; index < 32; index += 1) {
      const attemptId = `receipt-${String(index)}`;
      const next = record(begin(attemptId, revision));
      const settled = record(
        budget.settle(context, {
          attemptId,
          expectedRevision: next.revision,
          outcome: "succeeded",
        }),
      );
      revision = settled.revision;
    }
    expect(begin("receipt-33", revision)).toMatchObject({ reason: "storage-capacity" });
    expect(stored().attempts).toHaveLength(32);
    expect(stored().attempts[0]?.attemptId).toBe("receipt-0");
  });
  it("retains 256 active charge identities and refuses the next without refund", () => {
    const roomy = { ...context, limits: { ...context.limits, maxToolCalls: 1_000 } };
    begin("attempt-1", null, roomy);
    for (let index = 0; index < 256; index += 1) charge(index, 1, 0, roomy);
    expect(charge(256, 1, 0, roomy)).toMatchObject({ reason: "storage-capacity" });
    expect(stored()).toMatchObject({ toolCalls: 256, revision: 256 });
    expect(stored().attempts[0]?.charges).toHaveLength(256);
    expect(budget.read(roomy)).toMatchObject({ reason: "storage-capacity" });
  });
  it("exhausts before a next admitted maximum-size receipt could exceed the JSON bound", () => {
    const roomy = {
      ...successor("r".repeat(128)),
      limits: { ...context.limits, maxToolCalls: 1_000 },
    };
    let revision: number | null = null;
    for (let index = 0; index < 31; index += 1) {
      const attemptId = String(index).padEnd(128, "a");
      const value = record(begin(attemptId, revision, roomy));
      revision = record(
        budget.settle(roomy, { attemptId, expectedRevision: value.revision, outcome: "succeeded" }),
      ).revision;
    }
    const value = record(begin("attempt-1", revision, roomy));
    let current = value;
    let stopped = false;
    for (let index = 0; index < 256; index += 1) {
      const result = budget.charge(roomy, {
        attemptId: "attempt-1",
        expectedRevision: current.revision,
        chargeId: String(index).padEnd(128, "a"),
        toolCalls: 1,
        promptTokens: 0,
      });
      current = record(result);
      if (result.status === "blocked") {
        stopped = true;
        break;
      }
    }
    expect(stopped).toBe(true);
    expect(stored().attempts.at(-1)?.charges.length).toBeLessThan(256);
    expect(budget.read(roomy)).toMatchObject({ reason: "storage-capacity" });
    expect(Buffer.byteLength(JSON.stringify(stored()))).toBeLessThanOrEqual(65_536);
  });
  it("migrates V25 without altering existing draft, receipt or issue truth", () => {
    const before = snapshots.get(context.runId);
    rewindSchemaFixture(db, 25);
    runMigrations(db);
    expect(snapshots.get(context.runId)).toEqual(before);
    expect(budget.read(context)).toEqual({ status: "available", record: undefined });
    begin("attempt-1", null);
    expect(computeStoreFingerprint(db).tableRowCounts.coding_runtime_ci_repair_budgets).toBe(1);
    expect(() =>
      db.prepare("UPDATE coding_runtime_snapshots SET ci_observation_revision=1000001").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE coding_runtime_snapshots SET ci_readiness_record=?").run("invalid-json"),
    ).toThrow();
    expect(() =>
      db
        .prepare("UPDATE coding_runtime_snapshots SET ci_readiness_record=?")
        .run(JSON.stringify("a".repeat(8_192))),
    ).toThrow();
  });
  it.each(["revision", "toolCalls", "failedAttempts", "deadlineMs"])(
    "fails closed on inconsistent stored %s",
    (field) => {
      const original = record(begin("attempt-1", null));
      db.prepare("UPDATE coding_runtime_ci_repair_budgets SET record_json=?").run(
        JSON.stringify({
          ...original,
          [field]: original[field as keyof CiRepairBudgetRecord] === 0 ? 1 : 0,
        }),
      );
      expect(budget.read(context)).toMatchObject({ reason: "storage-unavailable" });
    },
  );
});

describe("CI repair closed retry inputs", () => {
  it("validates revision fields even for otherwise identical idempotent replays", () => {
    const initial = record(begin("attempt-1", null));
    const attempt = initial.attempts[0];
    if (attempt === undefined) throw new Error("missing attempt");
    const input = {
      attemptId: attempt.attemptId,
      failureSignatureDigest: attempt.failureSignatureDigest,
      kind: attempt.kind,
      headSha: attempt.headSha,
      baseSha: attempt.baseSha,
      expectedRevision: undefined,
    } as unknown as CiRepairBegin;
    expect(budget.begin(context, input)).toMatchObject({ reason: "invalid-input" });
    charge(0);
    expect(
      budget.charge(context, {
        attemptId: "attempt-1",
        chargeId: "charge-0",
        toolCalls: 1,
        promptTokens: 10,
        expectedRevision: undefined,
      } as unknown as CiRepairChargeInput),
    ).toMatchObject({ reason: "invalid-input" });
    budget.settle(context, { attemptId: "attempt-1", outcome: "succeeded", expectedRevision: 1 });
    expect(
      budget.settle(context, {
        attemptId: "attempt-1",
        outcome: "succeeded",
        expectedRevision: undefined,
      } as unknown as CiRepairSettle),
    ).toMatchObject({ reason: "invalid-input" });
    expect(stored()).toMatchObject({ revision: 2, toolCalls: 1, promptTokens: 10 });
  });
});

describe("CI repair accounting serialization reserve", () => {
  it("fits a maximum-size production attempt and usage receipt inside the reserved space", () => {
    const current = record(begin("attempt-1", null));
    const attemptId = "a".repeat(128);
    const attempt = newCiRepairAttempt(
      "r".repeat(128),
      {
        attemptId,
        kind: "workspace-edit",
        expectedRevision: current.revision,
        failureSignatureDigest: "f".repeat(64),
        headSha: "c".repeat(64),
        baseSha: "b".repeat(64),
      },
      Number.MAX_SAFE_INTEGER,
    );
    const added = { ...current, attempts: [...current.attempts, attempt] };
    const charged = chargeCiRepairAttempt(
      added,
      {
        attemptId,
        chargeId: "c".repeat(128),
        toolCalls: Number.MAX_SAFE_INTEGER,
        promptTokens: Number.MAX_SAFE_INTEGER,
        expectedRevision: current.revision,
      },
      Number.MAX_SAFE_INTEGER,
    );
    const growth =
      Buffer.byteLength(JSON.stringify(charged)) - Buffer.byteLength(JSON.stringify(current));
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThan(CI_REPAIR_WRITE_RESERVE_BYTES);
  });
});
