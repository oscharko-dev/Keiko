import type { CodingWorkbenchBudget } from "@oscharko-dev/keiko-contracts";

export type CiRepairLimits = Pick<
  CodingWorkbenchBudget,
  "maxRuntimeMs" | "maxToolCalls" | "maxPromptTokens"
>;
export type CiRepairAttemptKind = "workspace-edit" | "verification" | "commit";
export type CiRepairAttemptStatus = "active" | "succeeded" | "failed" | "interrupted";
export interface CiRepairCharge {
  readonly chargeId: string;
  readonly toolCalls: number;
  readonly promptTokens: number;
}
export interface CiRepairAttempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly failureSignatureDigest: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly kind: CiRepairAttemptKind;
  readonly status: CiRepairAttemptStatus;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly toolCalls: number;
  readonly promptTokens: number;
  readonly charges: readonly CiRepairCharge[];
}
/** Internal content-free accounting. Neither authority nor approval can be serialized here. */
export interface CiRepairBudgetRecord {
  readonly schemaVersion: "1";
  readonly revision: number;
  readonly taskDigest: string;
  readonly remoteDigest: string;
  readonly issueBindingDigest: string;
  readonly prNumber: number;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly deadlineMs: number;
  readonly limits: CiRepairLimits;
  readonly toolCalls: number;
  readonly promptTokens: number;
  readonly failedAttempts: number;
  readonly attempts: readonly CiRepairAttempt[];
}
export interface CiRepairBudgetContext {
  readonly runId: string;
  readonly remoteDigest: string;
  readonly prNumber: number;
  readonly correlationId: string;
  readonly limits: CiRepairLimits;
  readonly stillAuthorized: () => boolean;
}
export type CiRepairBudgetBlockReason =
  | "authority-denied"
  | "invalid-binding"
  | "invalid-input"
  | "stale-revision"
  | "clock-drift"
  | "deadline-exhausted"
  | "tool-budget-exhausted"
  | "prompt-budget-exhausted"
  | "attempt-budget-exhausted"
  | "storage-capacity"
  | "attempt-active"
  | "attempt-replayed"
  | "attempt-missing"
  | "recovery-required"
  | "storage-unavailable";
export type CiRepairBudgetResult =
  | { readonly status: "available"; readonly record: CiRepairBudgetRecord | undefined }
  | { readonly status: "recorded" | "replayed"; readonly record: CiRepairBudgetRecord }
  | {
      readonly status: "blocked";
      readonly reason: CiRepairBudgetBlockReason;
      readonly record?: CiRepairBudgetRecord;
    };
export interface CiRepairBegin {
  readonly attemptId: string;
  readonly failureSignatureDigest: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly kind: CiRepairAttemptKind;
  readonly expectedRevision: number | null;
}
export interface CiRepairChargeInput extends CiRepairCharge {
  readonly attemptId: string;
  readonly expectedRevision: number;
}
export interface CiRepairSettle {
  readonly attemptId: string;
  readonly outcome: "succeeded" | "failed";
  readonly expectedRevision: number;
}
export interface CodingRuntimeCiRepairBudgetStore {
  readonly read: (context: CiRepairBudgetContext) => CiRepairBudgetResult;
  readonly accept: (
    context: CiRepairBudgetContext,
    expectedRevision: number | null,
  ) => CiRepairBudgetResult;
  readonly begin: (context: CiRepairBudgetContext, input: CiRepairBegin) => CiRepairBudgetResult;
  readonly charge: (
    context: CiRepairBudgetContext,
    input: CiRepairChargeInput,
  ) => CiRepairBudgetResult;
  readonly settle: (context: CiRepairBudgetContext, input: CiRepairSettle) => CiRepairBudgetResult;
}
export const CI_REPAIR_MAX_ATTEMPTS = 32;
export const CI_REPAIR_MAX_CHARGES = 256;
export const CI_REPAIR_MAX_RECORD_BYTES = 65_536;
export const CI_REPAIR_WRITE_RESERVE_BYTES = 2_048;
export const CI_REPAIR_MAX_FAILED_ATTEMPTS = 3;

export function ciRepairId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
export function ciRepairDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
export function ciRepairCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function validCiRepairLimits(value: CiRepairLimits): boolean {
  return (
    Object.keys(value).length === 3 &&
    [value.maxRuntimeMs, value.maxToolCalls, value.maxPromptTokens].every(
      (limit) => ciRepairCount(limit) && limit > 0,
    )
  );
}
