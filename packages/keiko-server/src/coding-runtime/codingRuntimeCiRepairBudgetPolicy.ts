import {
  CI_REPAIR_MAX_ATTEMPTS,
  CI_REPAIR_MAX_CHARGES,
  CI_REPAIR_MAX_FAILED_ATTEMPTS,
  CI_REPAIR_MAX_RECORD_BYTES,
  CI_REPAIR_WRITE_RESERVE_BYTES,
  type CiRepairAttempt,
  type CiRepairBegin,
  type CiRepairBudgetBlockReason,
  type CiRepairBudgetRecord,
  type CiRepairChargeInput,
  type CiRepairLimits,
} from "./codingRuntimeCiRepairBudgetTypes.js";

export function tightenedCiRepairBudget(
  record: CiRepairBudgetRecord,
  accepted: CiRepairLimits,
): CiRepairBudgetRecord {
  const limits = {
    maxRuntimeMs: Math.min(record.limits.maxRuntimeMs, accepted.maxRuntimeMs),
    maxToolCalls: Math.min(record.limits.maxToolCalls, accepted.maxToolCalls),
    maxPromptTokens: Math.min(record.limits.maxPromptTokens, accepted.maxPromptTokens),
  };
  return { ...record, limits, deadlineMs: record.startedAtMs + limits.maxRuntimeMs };
}
export function ciRepairExhaustion(
  record: CiRepairBudgetRecord,
  now: number,
): CiRepairBudgetBlockReason | undefined {
  if (now < record.updatedAtMs) return "clock-drift";
  if (now >= record.deadlineMs) return "deadline-exhausted";
  if (record.failedAttempts >= CI_REPAIR_MAX_FAILED_ATTEMPTS) return "attempt-budget-exhausted";
  if (record.toolCalls >= record.limits.maxToolCalls) return "tool-budget-exhausted";
  if (record.promptTokens >= record.limits.maxPromptTokens) return "prompt-budget-exhausted";
  // Admission retains room for one maximum-size attempt plus its next usage receipt. The
  // already-admitted delta can therefore be recorded before capacity stops the next effect.
  if (
    Buffer.byteLength(JSON.stringify(record), "utf8") >
    CI_REPAIR_MAX_RECORD_BYTES - CI_REPAIR_WRITE_RESERVE_BYTES
  )
    return "storage-capacity";
  return receiptExhaustion(record);
}
function receiptExhaustion(record: CiRepairBudgetRecord): CiRepairBudgetBlockReason | undefined {
  const active = record.attempts.find((attempt) => attempt.status === "active");
  if (active === undefined && record.attempts.length >= CI_REPAIR_MAX_ATTEMPTS)
    return "storage-capacity";
  if (active !== undefined && active.charges.length >= CI_REPAIR_MAX_CHARGES)
    return "storage-capacity";
  return undefined;
}
export function newCiRepairAttempt(
  runId: string,
  input: CiRepairBegin,
  now: number,
): CiRepairAttempt {
  return {
    attemptId: input.attemptId,
    runId,
    failureSignatureDigest: input.failureSignatureDigest,
    headSha: input.headSha,
    baseSha: input.baseSha,
    kind: input.kind,
    status: "active",
    startedAtMs: now,
    finishedAtMs: null,
    toolCalls: 0,
    promptTokens: 0,
    charges: [],
  };
}
export function chargeCiRepairAttempt(
  record: CiRepairBudgetRecord,
  charge: CiRepairChargeInput,
  now: number,
): CiRepairBudgetRecord {
  const { chargeId, toolCalls, promptTokens } = charge;
  const attempts = record.attempts.map((attempt): CiRepairAttempt =>
    attempt.attemptId !== charge.attemptId
      ? attempt
      : {
          ...attempt,
          toolCalls: attempt.toolCalls + toolCalls,
          promptTokens: attempt.promptTokens + promptTokens,
          charges: [...attempt.charges, { chargeId, toolCalls, promptTokens }],
        },
  );
  return {
    ...record,
    revision: record.revision + 1,
    updatedAtMs: now,
    attempts,
    toolCalls: record.toolCalls + toolCalls,
    promptTokens: record.promptTokens + promptTokens,
  };
}
export function settleCiRepairAttempt(
  record: CiRepairBudgetRecord,
  attemptId: string,
  status: "succeeded" | "failed" | "interrupted",
  now: number,
): CiRepairBudgetRecord {
  return {
    ...record,
    revision: record.revision + 1,
    updatedAtMs: now,
    failedAttempts: record.failedAttempts + Number(status !== "succeeded"),
    attempts: record.attempts.map((attempt): CiRepairAttempt =>
      attempt.attemptId !== attemptId
        ? attempt
        : {
            ...attempt,
            status,
            finishedAtMs: now,
            charges: [],
          },
    ),
  };
}
