import { randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { CodingToolActionRequest } from "./codingToolIpc.js";
import type { GovernedCodingToolResult } from "./codingToolGovernedDelegate.js";
import type { CodingRuntimeCiReadinessStore } from "./codingRuntimeCiReadinessStore.js";
import type {
  CiRepairAttemptKind,
  CiRepairBudgetContext,
  CiRepairBudgetRecord,
  CiRepairBudgetResult,
  CiRepairCharge,
  CodingRuntimeCiRepairBudgetStore,
} from "./codingRuntimeCiRepairBudgetTypes.js";

export interface CiRepairExecutionLease {
  readonly check: () => boolean;
  readonly settle: (result: GovernedCodingToolResult | undefined) => void;
}
export interface CiRepairExecutionBudget {
  /** Called only after the existing authority owner admits the concrete tool action. */
  readonly admitTool: (request: CodingToolActionRequest) => CiRepairExecutionLease | undefined;
  /** The existing gateway has accepted this prompt reservation; false prevents provider dispatch. */
  readonly chargePrompt: (promptTokens: number) => boolean;
  readonly chargeDelegatedRead?: (delegationId: string, idempotencyKey: string) => boolean;
  readonly observed: (snapshot: ReadinessSnapshot) => void;
}
interface Dependencies {
  readonly store: CodingRuntimeCiRepairBudgetStore;
  readonly readiness: CodingRuntimeCiReadinessStore;
  readonly context: () => CiRepairBudgetContext | undefined;
  readonly now: () => number;
  /**
   * #3401: called exactly once a repair attempt is settled `succeeded` (`observed` saw the
   * repaired head reach `technical-ready`) — the CI-repair loop (#3388) has just pushed a new
   * verified commit for an ALREADY-succeeded run, well after the orchestrator's one-time terminal
   * dispatch already fired for the original head. Forwards to
   * `CodingRuntimeOrchestrator.notifyVerifiedHeadAdvanced` (a public seam, never a second
   * dispatcher) so the SAME dedup/coalesce/supersede path reconsiders the run's description job
   * for the repaired head. Absent is a deliberate closed default: accounting proceeds exactly as
   * before when no owner is wired.
   */
  readonly notifyVerifiedHeadAdvanced?: (runId: string) => void;
}
function attemptKind(request: CodingToolActionRequest): CiRepairAttemptKind | undefined {
  if (request.action === "edit" || request.action === "command") return "workspace-edit";
  if (request.action === "verification") return "verification";
  if (request.action === "delivery" && request.intent === "commit") return "commit";
  return request.action === "git" && request.operation === "stage" && request.phase === "execute"
    ? "workspace-edit"
    : undefined;
}
function active(
  record: CiRepairBudgetRecord | undefined,
): CiRepairBudgetRecord["attempts"][number] | undefined {
  return record?.attempts.find((attempt) => attempt.status === "active");
}
function failedTool(
  request: CodingToolActionRequest,
  result: GovernedCodingToolResult | undefined,
): boolean {
  if (attemptKind(request) === undefined) return false;
  if (result === undefined || result.status === "failed") return true;
  return (
    result.verifiedCommit !== undefined &&
    result.verifiedCommit.status !== "succeeded" &&
    result.verifiedCommit.status !== "approval-required"
  );
}
function currentFailure(
  snapshot: ReadinessSnapshot | undefined,
  now: number,
): snapshot is ReadinessSnapshot & {
  readonly state: "failed";
  readonly failureSignatureDigest: string;
} {
  return (
    snapshot?.state === "failed" &&
    snapshot.failureSignatureDigest !== undefined &&
    snapshot.requiredChecks.failed > 0 &&
    fresh(snapshot, now)
  );
}
function fresh(snapshot: ReadinessSnapshot, now: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= Date.parse(snapshot.observedAt) &&
    now < Date.parse(snapshot.expiresAt)
  );
}
function observedOutcome(
  attempt: CiRepairBudgetRecord["attempts"][number],
  snapshot: ReadinessSnapshot,
): "succeeded" | "failed" | undefined {
  if (snapshot.state === "technical-ready") return "succeeded";
  if (snapshot.state !== "failed") return undefined;
  return attempt.headSha !== snapshot.headSha ||
    attempt.failureSignatureDigest !== snapshot.failureSignatureDigest
    ? "failed"
    : undefined;
}
function noChargeLease(context: CiRepairBudgetContext | undefined): CiRepairExecutionLease {
  return { check: () => context?.stillAuthorized() ?? true, settle: () => undefined };
}
const TIGHTENABLE_EXHAUSTION = new Set([
  "deadline-exhausted",
  "tool-budget-exhausted",
  "prompt-budget-exhausted",
  "attempt-budget-exhausted",
]);
function admittedCredit(result: CiRepairBudgetResult): boolean {
  return (
    result.status !== "blocked" ||
    result.reason === "tool-budget-exhausted" ||
    result.reason === "prompt-budget-exhausted"
  );
}

function chargeFits(record: CiRepairBudgetRecord, charge: CiRepairCharge): boolean {
  return (
    Number.isSafeInteger(charge.promptTokens) &&
    charge.promptTokens >= 0 &&
    record.toolCalls + charge.toolCalls <= record.limits.maxToolCalls &&
    record.promptTokens + charge.promptTokens <= record.limits.maxPromptTokens
  );
}

/** Accounting around the existing tool loop; observation never starts or consumes a repair attempt. */
export class CodingRuntimeCiRepairController implements CiRepairExecutionBudget {
  public constructor(private readonly deps: Dependencies) {}
  public admitTool(request: CodingToolActionRequest): CiRepairExecutionLease | undefined {
    const context = this.deps.context();
    if (context === undefined) return noChargeLease(undefined);
    if (!context.stillAuthorized()) return undefined;
    if (request.action === "git" && request.operation === "ci") {
      this.accepted(context);
      return noChargeLease(context);
    }
    const result = this.prepare(context, attemptKind(request));
    if (result.status === "blocked") return undefined;
    const attempt = active(result.record);
    if (attempt === undefined) return noChargeLease(context);
    const charge = {
      chargeId: `tool-${sha256Hex(canonicalise([request.actionId, request.idempotencyKey]))}`,
      toolCalls: 1,
      promptTokens: 0,
    };
    const record = this.charge(context, result.record, charge);
    if (record === undefined) return undefined;
    return {
      check: () => this.chargeIsCurrent(context, attempt.attemptId, charge),
      settle: (value): void => {
        if (failedTool(request, value)) this.settle(context, attempt.attemptId, "failed");
      },
    };
  }
  public chargePrompt(promptTokens: number): boolean {
    const context = this.deps.context();
    if (context === undefined) return true;
    if (!context.stillAuthorized()) return false;
    const result = this.accepted(context);
    if (active(result.record) === undefined) return result.status !== "blocked";
    return (
      (result.status !== "blocked" || result.reason === "tool-budget-exhausted") &&
      this.charge(context, result.record, {
        chargeId: `prompt-${randomUUID()}`,
        toolCalls: 0,
        promptTokens,
      }) !== undefined
    );
  }
  public chargeDelegatedRead(delegationId: string, idempotencyKey: string): boolean {
    const context = this.deps.context();
    if (context === undefined) return true;
    if (!context.stillAuthorized()) return false;
    const result = this.accepted(context);
    if (active(result.record) === undefined) return result.status !== "blocked";
    return (
      result.status !== "blocked" &&
      this.charge(context, result.record, {
        chargeId: `child-${sha256Hex(canonicalise([delegationId, idempotencyKey]))}`,
        toolCalls: 1,
        promptTokens: 0,
      }) !== undefined
    );
  }
  public observed(snapshot: ReadinessSnapshot): void {
    const context = this.deps.context();
    if (!context?.stillAuthorized()) return;
    const current = this.deps.readiness.get(context.runId);
    if (current?.evidenceRef !== snapshot.evidenceRef) return;
    const attempt = active(this.accepted(context).record);
    if (attempt?.runId !== context.runId) return;
    const outcome = observedOutcome(attempt, snapshot);
    if (outcome !== undefined) this.settle(context, attempt.attemptId, outcome);
  }
  private prepare(
    context: CiRepairBudgetContext,
    kind: CiRepairAttemptKind | undefined,
  ): CiRepairBudgetResult {
    const result = this.accepted(context);
    const prior = active(result.record);
    if (result.status === "blocked" || prior !== undefined || kind === undefined) return result;
    return this.beginRepair(context, kind, result);
  }
  private beginRepair(
    context: CiRepairBudgetContext,
    kind: CiRepairAttemptKind,
    prior: CiRepairBudgetResult,
  ): CiRepairBudgetResult {
    const snapshot = this.deps.readiness.get(context.runId);
    if (!currentFailure(snapshot, this.deps.now()))
      return snapshot?.state === "technical-ready" && fresh(snapshot, this.deps.now())
        ? prior
        : {
            status: "blocked",
            reason: "invalid-binding",
            ...(prior.record === undefined ? {} : { record: prior.record }),
          };
    const result = this.deps.store.begin(context, {
      attemptId: `repair-${randomUUID()}`,
      headSha: snapshot.headSha,
      baseSha: snapshot.baseSha,
      kind,
      failureSignatureDigest: snapshot.failureSignatureDigest,
      expectedRevision: prior.record?.revision ?? null,
    });
    if (result.status !== "blocked" && !this.invalidate(context, result.record))
      return { status: "blocked", reason: "storage-unavailable" };
    return result;
  }
  private accepted(context: CiRepairBudgetContext): CiRepairBudgetResult {
    const current = this.deps.store.read(context);
    if (
      current.record === undefined ||
      (current.status === "blocked" && !TIGHTENABLE_EXHAUSTION.has(current.reason))
    )
      return current;
    const next = this.deps.store.accept(context, current.record.revision);
    if (current.status !== "blocked" || next.status === "blocked") return next;
    return { ...current, ...(next.record === undefined ? {} : { record: next.record }) };
  }
  private invalidate(
    context: CiRepairBudgetContext,
    record: CiRepairBudgetRecord | undefined,
  ): boolean {
    let invalidated = false;
    try {
      invalidated = this.deps.readiness.invalidate(context.runId);
      return invalidated;
    } finally {
      const attempt = active(record);
      if (!invalidated && attempt !== undefined) this.settle(context, attempt.attemptId, "failed");
    }
  }
  private charge(
    context: CiRepairBudgetContext,
    record: CiRepairBudgetRecord | undefined,
    charge: CiRepairCharge,
  ): CiRepairBudgetRecord | undefined {
    const attempt = active(record);
    if (record === undefined || attempt?.runId !== context.runId) return undefined;
    if (!chargeFits(record, charge)) return undefined;
    const result = this.deps.store.charge(context, {
      ...charge,
      attemptId: attempt.attemptId,
      expectedRevision: record.revision,
    });
    return admittedCredit(result) &&
      result.record !== undefined &&
      this.receiptWithinBudget(result.record, attempt.attemptId, charge)
      ? result.record
      : undefined;
  }
  private chargeIsCurrent(
    context: CiRepairBudgetContext,
    attemptId: string,
    charge: CiRepairCharge,
  ): boolean {
    if (!context.stillAuthorized()) return false;
    const result = this.deps.store.read(context);
    return (
      admittedCredit(result) &&
      result.record !== undefined &&
      this.receiptWithinBudget(result.record, attemptId, charge)
    );
  }
  private receiptWithinBudget(
    record: CiRepairBudgetRecord,
    attemptId: string,
    charge: CiRepairCharge,
  ): boolean {
    const now = this.deps.now();
    const attempt = active(record);
    return (
      attempt?.attemptId === attemptId &&
      Number.isSafeInteger(now) &&
      now >= record.updatedAtMs &&
      now < record.deadlineMs &&
      record.toolCalls <= record.limits.maxToolCalls &&
      record.promptTokens <= record.limits.maxPromptTokens &&
      attempt.charges.some(
        (item) =>
          item.chargeId === charge.chargeId &&
          item.toolCalls === charge.toolCalls &&
          item.promptTokens === charge.promptTokens,
      )
    );
  }
  private settle(
    context: CiRepairBudgetContext,
    attemptId: string,
    outcome: "succeeded" | "failed",
  ): void {
    const record = this.deps.store.read(context).record;
    if (record === undefined) return;
    const result = this.deps.store.settle(context, {
      attemptId,
      outcome,
      expectedRevision: record.revision,
    });
    // A rejected CAS (stale revision, unknown attempt, a replay of a DIFFERENT outcome, ...)
    // returns the record as it stood BEFORE this call, so the settled attempt never actually
    // reached `outcome` in it. `result.status` alone cannot tell the two apart: a write that DID
    // apply can still report "blocked" when it also just exhausted the budget (`persist()`'s own
    // post-write policy check) -- checking the returned attempt's own status is the one signal
    // that is true exactly when the CAS actually applied this outcome to this attempt.
    const applied = result.record?.attempts.some(
      (attempt) => attempt.attemptId === attemptId && attempt.status === outcome,
    );
    if (outcome === "succeeded" && applied === true)
      this.deps.notifyVerifiedHeadAdvanced?.(context.runId);
  }
}
