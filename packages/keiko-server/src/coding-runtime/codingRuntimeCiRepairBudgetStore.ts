import type { DatabaseSync } from "node:sqlite";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { describeError } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import {
  CI_REPAIR_MAX_CHARGES,
  CI_REPAIR_MAX_RECORD_BYTES,
  ciRepairCount,
  ciRepairDigest,
  ciRepairId,
  validCiRepairLimits,
  type CiRepairBegin,
  type CiRepairBudgetBlockReason,
  type CiRepairBudgetContext,
  type CiRepairBudgetRecord,
  type CiRepairBudgetResult,
  type CiRepairChargeInput,
  type CiRepairSettle,
  type CodingRuntimeCiRepairBudgetStore,
} from "./codingRuntimeCiRepairBudgetTypes.js";
import {
  isCiRepairBudgetRecord,
  parseCiRepairBudgetRecord,
} from "./codingRuntimeCiRepairBudgetValidation.js";
import {
  chargeCiRepairAttempt,
  ciRepairExhaustion,
  newCiRepairAttempt,
  settleCiRepairAttempt,
  tightenedCiRepairBudget,
} from "./codingRuntimeCiRepairBudgetPolicy.js";

interface Dependencies {
  readonly db: DatabaseSync;
  readonly snapshots: Pick<CodingRuntimeSnapshotStore, "get">;
  readonly activityLog: ServerLogSink;
  readonly now?: () => number;
}
interface Scope {
  readonly context: CiRepairBudgetContext;
  readonly snapshot: CodingRuntimeSnapshot;
  readonly now: number;
  readonly current: CiRepairBudgetRecord | undefined;
}
type Phase = "read" | "accept" | "begin" | "charge" | "settle";
function blocked(
  reason: CiRepairBudgetBlockReason,
  record?: CiRepairBudgetRecord,
): CiRepairBudgetResult {
  return { status: "blocked", reason, ...(record === undefined ? {} : { record }) };
}
function sameLimits(a: CiRepairBudgetRecord, b: CiRepairBudgetRecord): boolean {
  return (
    a.limits.maxRuntimeMs === b.limits.maxRuntimeMs &&
    a.limits.maxToolCalls === b.limits.maxToolCalls &&
    a.limits.maxPromptTokens === b.limits.maxPromptTokens
  );
}
function expected(current: CiRepairBudgetRecord | undefined, revision: number | null): boolean {
  return (revision === null || ciRepairCount(revision)) && (current?.revision ?? null) === revision;
}
function keys(value: object, allowed: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => allowed.includes(key));
}
function beginRefusal(
  scope: Scope,
  input: CiRepairBegin,
): Extract<CiRepairBudgetBlockReason, "invalid-input" | "invalid-binding"> | undefined {
  if (!validBegin(input)) return "invalid-input";
  const draft = scope.snapshot.draftDelivery;
  const observedBase = scope.snapshot.ciReadiness?.baseSha ?? draft?.binding.baseSha;
  if (input.headSha !== draft?.binding.headSha || input.baseSha !== observedBase)
    return "invalid-binding";
  return undefined;
}
function validBegin(value: CiRepairBegin): boolean {
  return (
    keys(value, [
      "attemptId",
      "failureSignatureDigest",
      "headSha",
      "baseSha",
      "kind",
      "expectedRevision",
    ]) &&
    [
      ciRepairId(value.attemptId),
      value.expectedRevision === null || ciRepairCount(value.expectedRevision),
      ciRepairDigest(value.failureSignatureDigest),
      isGitObjectId(value.headSha),
      isGitObjectId(value.baseSha),
      new Set(["workspace-edit", "verification", "commit"]).has(value.kind),
    ].every(Boolean)
  );
}
function validCharge(value: CiRepairChargeInput): boolean {
  return (
    keys(value, ["attemptId", "chargeId", "toolCalls", "promptTokens", "expectedRevision"]) &&
    ciRepairId(value.attemptId) &&
    ciRepairId(value.chargeId) &&
    ciRepairCount(value.expectedRevision) &&
    ciRepairCount(value.toolCalls) &&
    ciRepairCount(value.promptTokens) &&
    value.toolCalls + value.promptTokens > 0
  );
}
function validSettle(value: CiRepairSettle): boolean {
  return (
    keys(value, ["attemptId", "outcome", "expectedRevision"]) &&
    ciRepairId(value.attemptId) &&
    ciRepairCount(value.expectedRevision) &&
    new Set<string>(["succeeded", "failed"]).has(value.outcome)
  );
}
function validContext(context: CiRepairBudgetContext): boolean {
  return [
    ciRepairId(context.runId),
    ciRepairDigest(context.remoteDigest),
    ciRepairCount(context.prNumber),
    context.prNumber >= 1,
    context.prNumber <= 1_000_000_000,
    validCiRepairLimits(context.limits),
  ].every(Boolean);
}
function validTime(now: number, context: CiRepairBudgetContext): boolean {
  return ciRepairCount(now) && Number.isSafeInteger(now + context.limits.maxRuntimeMs);
}

function priorChargeResult(
  record: CiRepairBudgetRecord,
  input: CiRepairChargeInput,
): CiRepairBudgetResult | undefined {
  const prior = record.attempts
    .find((attempt) => attempt.attemptId === input.attemptId)
    ?.charges.find((charge) => charge.chargeId === input.chargeId);
  if (prior === undefined) return undefined;
  return prior.toolCalls === input.toolCalls && prior.promptTokens === input.promptTokens
    ? { status: "replayed", record }
    : blocked("invalid-input", record);
}

function liveSnapshot(snapshot: CodingRuntimeSnapshot, context: CiRepairBudgetContext): boolean {
  const draft = snapshot.draftDelivery;
  return [
    snapshot.terminalAt === undefined,
    new Set(["ready", "running", "awaiting-approval"]).has(snapshot.state),
    snapshot.issueBinding?.remoteDigest === context.remoteDigest,
    draft?.binding.runId === context.runId,
    draft?.binding.remoteDigest === context.remoteDigest,
    draft?.binding.issueBindingDigest === snapshot.issueBinding?.bindingDigest,
    draft?.pullRequest?.number === context.prNumber,
    draft?.pullRequest?.state === "open",
  ].every(Boolean);
}

class SqliteCiRepairBudgetStore implements CodingRuntimeCiRepairBudgetStore {
  public constructor(private readonly deps: Dependencies) {}
  public read(context: CiRepairBudgetContext): CiRepairBudgetResult {
    return this.run(context, "read", (scope) => {
      if (scope.current === undefined) return { status: "available", record: undefined };
      const effective = tightenedCiRepairBudget(scope.current, context.limits);
      const reason = ciRepairExhaustion(effective, scope.now);
      return reason === undefined
        ? { status: "available", record: effective }
        : blocked(reason, effective);
    });
  }
  public accept(context: CiRepairBudgetContext, revision: number | null): CiRepairBudgetResult {
    return this.run(context, "accept", (scope) => this.acceptScope(scope, revision));
  }
  public begin(context: CiRepairBudgetContext, input: CiRepairBegin): CiRepairBudgetResult {
    return this.run(context, "begin", (scope) => this.beginScope(scope, input));
  }
  public charge(context: CiRepairBudgetContext, input: CiRepairChargeInput): CiRepairBudgetResult {
    return this.run(context, "charge", (scope) => this.chargeScope(scope, input));
  }
  public settle(context: CiRepairBudgetContext, input: CiRepairSettle): CiRepairBudgetResult {
    return this.run(context, "settle", (scope) => this.settleScope(scope, input));
  }
  private run(
    context: CiRepairBudgetContext,
    phase: Phase,
    work: (scope: Scope) => CiRepairBudgetResult,
  ): CiRepairBudgetResult {
    try {
      const scope = this.scope(context);
      const result = "status" in scope ? scope : work(scope);
      this.log(context, phase, result);
      return result;
    } catch (error) {
      this.deps.activityLog.write({
        category: "process",
        op: "git.ci-repair.budget",
        level: "warn",
        correlationId: context.correlationId,
        errorKind: "internal",
        extra: { phase, reason: "storage-unavailable", ...describeError(error) },
      });
      return blocked("storage-unavailable");
    }
  }
  private scope(context: CiRepairBudgetContext): Scope | CiRepairBudgetResult {
    if (!context.stillAuthorized()) return blocked("authority-denied");
    if (!validContext(context)) return blocked("invalid-binding");
    const snapshot = this.deps.snapshots.get(context.runId);
    if (snapshot === undefined || !liveSnapshot(snapshot, context))
      return blocked("invalid-binding");
    const now = this.deps.now?.() ?? Date.now();
    if (!validTime(now, context)) return blocked("invalid-input");
    const current = this.load(snapshot, context);
    if (current !== undefined && now < current.updatedAtMs) return blocked("clock-drift", current);
    return { context, snapshot, now, current };
  }
  private load(
    snapshot: CodingRuntimeSnapshot,
    context: CiRepairBudgetContext,
  ): CiRepairBudgetRecord | undefined {
    const taskDigest = snapshot.taskDigest;
    const row = this.deps.db
      .prepare(
        "SELECT revision, record_json FROM coding_runtime_ci_repair_budgets WHERE task_digest=? AND remote_digest=? AND pr_number=?",
      )
      .get(taskDigest, context.remoteDigest, context.prNumber) as
      { revision: number; record_json: string } | undefined;
    if (row === undefined) return undefined;
    const value = parseCiRepairBudgetRecord(row.record_json);
    if (
      value.taskDigest !== taskDigest ||
      value.remoteDigest !== context.remoteDigest ||
      value.prNumber !== context.prNumber ||
      value.revision !== row.revision ||
      value.issueBindingDigest !== snapshot.issueBinding?.bindingDigest
    )
      throw new TypeError("CI repair budget row binding mismatch");
    return value;
  }
  private acceptScope(scope: Scope, revision: number | null): CiRepairBudgetResult {
    const current = scope.current;
    if (!expected(current, revision)) return blocked("stale-revision", current);
    if (current === undefined) return { status: "available", record: undefined };
    const effective = tightenedCiRepairBudget(current, scope.context.limits);
    const active = effective.attempts.find((attempt) => attempt.status === "active");
    if (active !== undefined && active.runId !== scope.context.runId) {
      const interrupted = settleCiRepairAttempt(
        effective,
        active.attemptId,
        "interrupted",
        scope.now,
      );
      return this.persist(scope, interrupted, "recovery-required");
    }
    if (sameLimits(current, effective)) {
      const reason = ciRepairExhaustion(effective, scope.now);
      return reason === undefined
        ? { status: "replayed", record: current }
        : blocked(reason, current);
    }
    return this.persist(scope, {
      ...effective,
      revision: current.revision + 1,
      updatedAtMs: scope.now,
    });
  }
  private beginScope(scope: Scope, input: CiRepairBegin): CiRepairBudgetResult {
    const refusal = beginRefusal(scope, input);
    if (refusal !== undefined) return blocked(refusal, scope.current);
    const prior = scope.current?.attempts.find((attempt) => attempt.attemptId === input.attemptId);
    if (prior !== undefined) return this.replayedBegin(scope, input, prior);
    if (!expected(scope.current, input.expectedRevision))
      return blocked("stale-revision", scope.current);
    if (scope.current === undefined) return this.firstAttempt(scope, input);
    return this.nextAttempt(scope, input, scope.current);
  }
  private nextAttempt(
    scope: Scope,
    input: CiRepairBegin,
    current: CiRepairBudgetRecord,
  ): CiRepairBudgetResult {
    const record = tightenedCiRepairBudget(current, scope.context.limits);
    const active = record.attempts.find((attempt) => attempt.status === "active");
    if (active !== undefined)
      return active.runId === scope.context.runId
        ? blocked("attempt-active", record)
        : this.acceptScope(scope, input.expectedRevision);
    const reason = ciRepairExhaustion(record, scope.now);
    if (reason !== undefined) return this.persistTightening(scope, record, reason);
    return this.persist(scope, {
      ...record,
      revision: record.revision + 1,
      updatedAtMs: scope.now,
      attempts: [...record.attempts, newCiRepairAttempt(scope.context.runId, input, scope.now)],
    });
  }
  private replayedBegin(
    scope: Scope,
    input: CiRepairBegin,
    prior: CiRepairBudgetRecord["attempts"][number],
  ): CiRepairBudgetResult {
    const matches = [
      prior.status === "active",
      prior.runId === scope.context.runId,
      prior.headSha === input.headSha,
      prior.baseSha === input.baseSha,
      prior.failureSignatureDigest === input.failureSignatureDigest,
      prior.kind === input.kind,
    ].every(Boolean);
    if (!matches || scope.current === undefined) return blocked("attempt-replayed", scope.current);
    const record = tightenedCiRepairBudget(scope.current, scope.context.limits);
    const reason = ciRepairExhaustion(record, scope.now);
    return reason === undefined ? { status: "replayed", record } : blocked(reason, record);
  }
  private firstAttempt(scope: Scope, input: CiRepairBegin): CiRepairBudgetResult {
    const count = this.deps.db
      .prepare("SELECT count(*) AS count FROM coding_runtime_ci_repair_budgets")
      .get() as { count: number };
    if (count.count >= 10_000) return blocked("storage-capacity");
    return this.persist(scope, {
      schemaVersion: "1",
      revision: 0,
      taskDigest: scope.snapshot.taskDigest,
      remoteDigest: scope.context.remoteDigest,
      issueBindingDigest: scope.snapshot.issueBinding?.bindingDigest ?? "",
      prNumber: scope.context.prNumber,
      startedAtMs: scope.now,
      updatedAtMs: scope.now,
      deadlineMs: scope.now + scope.context.limits.maxRuntimeMs,
      limits: { ...scope.context.limits },
      toolCalls: 0,
      promptTokens: 0,
      failedAttempts: 0,
      attempts: [newCiRepairAttempt(scope.context.runId, input, scope.now)],
    });
  }
  private chargeScope(scope: Scope, input: CiRepairChargeInput): CiRepairBudgetResult {
    if (!validCharge(input)) return blocked("invalid-input", scope.current);
    const record = scope.current;
    const active = record?.attempts.find(
      (attempt) => attempt.attemptId === input.attemptId && attempt.status === "active",
    );
    if (record === undefined || active === undefined) return blocked("attempt-missing", record);
    if (active.runId !== scope.context.runId) return blocked("recovery-required", record);
    const prior = priorChargeResult(record, input);
    if (prior !== undefined) return prior;
    if (!expected(record, input.expectedRevision)) return blocked("stale-revision", record);
    if (active.charges.length >= CI_REPAIR_MAX_CHARGES) return blocked("storage-capacity", record);
    const next = chargeCiRepairAttempt(
      tightenedCiRepairBudget(record, scope.context.limits),
      input,
      scope.now,
    );
    return this.persist(scope, next);
  }
  private settleScope(scope: Scope, input: CiRepairSettle): CiRepairBudgetResult {
    if (!validSettle(input)) return blocked("invalid-input", scope.current);
    const current = scope.current;
    const attempt = current?.attempts.find((value) => value.attemptId === input.attemptId);
    if (current === undefined || attempt === undefined) return blocked("attempt-missing", current);
    if (attempt.runId !== scope.context.runId) return blocked("recovery-required", current);
    if (attempt.status !== "active")
      return attempt.status === input.outcome
        ? { status: "replayed", record: current }
        : blocked("attempt-replayed", current);
    if (!expected(current, input.expectedRevision)) return blocked("stale-revision", current);
    return this.persist(
      scope,
      settleCiRepairAttempt(
        tightenedCiRepairBudget(current, scope.context.limits),
        input.attemptId,
        input.outcome,
        scope.now,
      ),
    );
  }
  private persistTightening(
    scope: Scope,
    record: CiRepairBudgetRecord,
    reason: CiRepairBudgetBlockReason,
  ): CiRepairBudgetResult {
    if (scope.current === undefined || sameLimits(scope.current, record))
      return blocked(reason, record);
    return this.persist(
      scope,
      { ...record, revision: record.revision + 1, updatedAtMs: scope.now },
      reason,
    );
  }
  private persist(
    scope: Scope,
    record: CiRepairBudgetRecord,
    reason?: CiRepairBudgetBlockReason,
  ): CiRepairBudgetResult {
    if (!scope.context.stillAuthorized()) return blocked("authority-denied", scope.current);
    if (!isCiRepairBudgetRecord(record)) return blocked("storage-capacity", scope.current);
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json, "utf8") > CI_REPAIR_MAX_RECORD_BYTES)
      return blocked("storage-capacity", scope.current);
    const changes = this.write(scope, record, json);
    if (changes !== 1) return blocked("stale-revision", scope.current);
    const blockedReason = reason ?? ciRepairExhaustion(record, scope.now);
    return blockedReason === undefined
      ? { status: "recorded", record }
      : blocked(blockedReason, record);
  }
  private write(scope: Scope, record: CiRepairBudgetRecord, json: string): number {
    const result =
      scope.current === undefined
        ? this.deps.db
            .prepare(
              "INSERT INTO coding_runtime_ci_repair_budgets (task_digest,remote_digest,pr_number,revision,record_json) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
            )
            .run(record.taskDigest, record.remoteDigest, record.prNumber, record.revision, json)
        : this.deps.db
            .prepare(
              "UPDATE coding_runtime_ci_repair_budgets SET revision=?,record_json=? WHERE task_digest=? AND remote_digest=? AND pr_number=? AND revision=?",
            )
            .run(
              record.revision,
              json,
              record.taskDigest,
              record.remoteDigest,
              record.prNumber,
              scope.current.revision,
            );
    return Number(result.changes);
  }
  private log(context: CiRepairBudgetContext, phase: Phase, result: CiRepairBudgetResult): void {
    const record = result.record;
    const attempt = record?.attempts.at(-1);
    this.deps.activityLog.write({
      category: "process",
      op: "git.ci-repair.budget",
      correlationId: context.correlationId,
      extra: {
        phase,
        status: result.status,
        ...(result.status === "blocked" ? { reason: result.reason } : {}),
        ...(ciRepairId(context.runId) ? { runId: context.runId } : {}),
        ...(attempt === undefined
          ? {}
          : {
              attemptId: attempt.attemptId,
              attemptRunId: attempt.runId,
              attemptStatus: attempt.status,
              attemptKind: attempt.kind,
              failureSignatureDigest: attempt.failureSignatureDigest,
              headSha: attempt.headSha,
              baseSha: attempt.baseSha,
            }),
        ...(record === undefined
          ? {}
          : {
              taskDigest: record.taskDigest,
              remoteDigest: record.remoteDigest,
              prNumber: record.prNumber,
              revision: record.revision,
              attemptCount: record.attempts.length,
              failedAttemptCount: record.failedAttempts,
              toolCallCount: record.toolCalls,
              promptTokenCount: record.promptTokens,
              deadlineMs: record.deadlineMs,
              maxRuntimeMs: record.limits.maxRuntimeMs,
              maxToolCalls: record.limits.maxToolCalls,
              maxPromptTokens: record.limits.maxPromptTokens,
            }),
      },
    });
  }
}

export function createCodingRuntimeCiRepairBudgetStore(
  deps: Dependencies,
): CodingRuntimeCiRepairBudgetStore {
  return new SqliteCiRepairBudgetStore(deps);
}
