import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  CI_REPAIR_MAX_ATTEMPTS,
  CI_REPAIR_MAX_CHARGES,
  CI_REPAIR_MAX_RECORD_BYTES,
  ciRepairCount,
  ciRepairDigest,
  ciRepairId,
  validCiRepairLimits,
  type CiRepairAttempt,
  type CiRepairBudgetRecord,
  type CiRepairCharge,
  type CiRepairLimits,
} from "./codingRuntimeCiRepairBudgetTypes.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).length === set.size && Object.keys(value).every((key) => set.has(key));
}
function charge(value: unknown): value is CiRepairCharge {
  return (
    object(value) &&
    keys(value, ["chargeId", "toolCalls", "promptTokens"]) &&
    ciRepairId(value.chargeId) &&
    ciRepairCount(value.toolCalls) &&
    ciRepairCount(value.promptTokens)
  );
}
function charges(value: unknown): value is readonly CiRepairCharge[] {
  if (!Array.isArray(value) || value.length > CI_REPAIR_MAX_CHARGES) return false;
  const items: unknown[] = value;
  return items.every(charge) && new Set(items.map((item) => item.chargeId)).size === items.length;
}
function attemptIdentity(value: Record<string, unknown>): boolean {
  return [
    ciRepairId(value.attemptId),
    ciRepairId(value.runId),
    ciRepairDigest(value.failureSignatureDigest),
    isGitObjectId(value.headSha),
    isGitObjectId(value.baseSha),
    typeof value.kind === "string" &&
      new Set(["workspace-edit", "verification", "commit"]).has(value.kind),
  ].every(Boolean);
}
function attemptUsage(value: CiRepairAttempt): boolean {
  if (
    !ciRepairCount(value.startedAtMs) ||
    !ciRepairCount(value.toolCalls) ||
    !ciRepairCount(value.promptTokens)
  )
    return false;
  if (value.status === "active")
    return (
      value.finishedAtMs === null &&
      value.toolCalls === value.charges.reduce((sum, item) => sum + item.toolCalls, 0) &&
      value.promptTokens === value.charges.reduce((sum, item) => sum + item.promptTokens, 0)
    );
  return (
    new Set(["succeeded", "failed", "interrupted"]).has(value.status) &&
    value.charges.length === 0 &&
    ciRepairCount(value.finishedAtMs) &&
    value.finishedAtMs >= value.startedAtMs
  );
}
function attempt(value: unknown): value is CiRepairAttempt {
  if (
    !object(value) ||
    !keys(value, [
      "attemptId",
      "runId",
      "failureSignatureDigest",
      "headSha",
      "baseSha",
      "kind",
      "status",
      "startedAtMs",
      "finishedAtMs",
      "toolCalls",
      "promptTokens",
      "charges",
    ])
  )
    return false;
  return (
    attemptIdentity(value) &&
    charges(value.charges) &&
    attemptUsage(value as unknown as CiRepairAttempt)
  );
}
function recordShape(value: Record<string, unknown>): boolean {
  return (
    keys(value, [
      "schemaVersion",
      "revision",
      "taskDigest",
      "remoteDigest",
      "issueBindingDigest",
      "prNumber",
      "startedAtMs",
      "updatedAtMs",
      "deadlineMs",
      "limits",
      "toolCalls",
      "promptTokens",
      "failedAttempts",
      "attempts",
    ]) &&
    value.schemaVersion === "1" &&
    ciRepairDigest(value.taskDigest) &&
    ciRepairDigest(value.remoteDigest) &&
    ciRepairDigest(value.issueBindingDigest)
  );
}
function recordCounts(value: CiRepairBudgetRecord): boolean {
  return (
    [
      value.revision,
      value.prNumber,
      value.startedAtMs,
      value.updatedAtMs,
      value.deadlineMs,
      value.toolCalls,
      value.promptTokens,
      value.failedAttempts,
    ].every(ciRepairCount) &&
    value.prNumber > 0 &&
    value.prNumber <= 1_000_000_000 &&
    value.updatedAtMs >= value.startedAtMs &&
    value.deadlineMs === value.startedAtMs + value.limits.maxRuntimeMs
  );
}
function attemptTotals(value: CiRepairBudgetRecord): boolean {
  const attempts = value.attempts;
  const active = attempts.filter((item) => item.status === "active");
  return [
    active.length <= 1,
    active.length === 0 || active[0] === attempts.at(-1),
    new Set(attempts.map((item) => item.attemptId)).size === attempts.length,
    value.toolCalls === attempts.reduce((sum, item) => sum + item.toolCalls, 0),
    value.promptTokens === attempts.reduce((sum, item) => sum + item.promptTokens, 0),
    value.failedAttempts ===
      attempts.filter((item) => item.status === "failed" || item.status === "interrupted").length,
    attempts.every(
      (item) =>
        item.startedAtMs >= value.startedAtMs &&
        (item.finishedAtMs ?? item.startedAtMs) <= value.updatedAtMs,
    ),
  ].every(Boolean);
}
export function isCiRepairBudgetRecord(value: unknown): value is CiRepairBudgetRecord {
  if (!object(value) || !recordShape(value) || !object(value.limits)) return false;
  if (!validCiRepairLimits(value.limits as unknown as CiRepairLimits)) return false;
  if (
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > CI_REPAIR_MAX_ATTEMPTS
  )
    return false;
  const items: unknown[] = value.attempts;
  if (!items.every(attempt)) return false;
  const record = value as unknown as CiRepairBudgetRecord;
  return recordCounts(record) && attemptTotals(record);
}
export function parseCiRepairBudgetRecord(value: string): CiRepairBudgetRecord {
  if (Buffer.byteLength(value, "utf8") > CI_REPAIR_MAX_RECORD_BYTES)
    throw new TypeError("Oversized CI repair budget");
  const parsed: unknown = JSON.parse(value);
  if (!isCiRepairBudgetRecord(parsed)) throw new TypeError("Invalid persisted CI repair budget");
  return parsed;
}
