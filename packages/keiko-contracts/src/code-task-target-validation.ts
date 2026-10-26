// Private code-task identity and parent-target validation shared by the governance contracts.
// This file is intentionally not a package export; governance re-exports the existing public API.
import { ownField } from "./code-task-acceptance.js";

declare const codeTaskGovernanceBrand: unique symbol;

/** Type-level brand; branded values stay JSON-serializable primitive strings at runtime. */
export type CodeTaskGovernanceBranded<Name extends string> = string & {
  readonly [codeTaskGovernanceBrand]: Name;
};

export type CodeTaskTaskId = CodeTaskGovernanceBranded<"CodeTaskTaskId">;
export type CodeTaskRunId = CodeTaskGovernanceBranded<"CodeTaskRunId">;
export type CodeTaskWorkspaceId = CodeTaskGovernanceBranded<"CodeTaskWorkspaceId">;
export type CodeTaskGrantId = CodeTaskGovernanceBranded<"CodeTaskGrantId">;
export type CodeTaskQuestionId = CodeTaskGovernanceBranded<"CodeTaskQuestionId">;
export type CodeTaskIdempotencyKey = CodeTaskGovernanceBranded<"CodeTaskIdempotencyKey">;
export type CodeTaskPolicyVersion = CodeTaskGovernanceBranded<"CodeTaskPolicyVersion">;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isCodeTaskTaskId(value: unknown): value is CodeTaskTaskId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskRunId(value: unknown): value is CodeTaskRunId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskWorkspaceId(value: unknown): value is CodeTaskWorkspaceId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskGrantId(value: unknown): value is CodeTaskGrantId {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
export function isCodeTaskIdempotencyKey(value: unknown): value is CodeTaskIdempotencyKey {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate the shared parent identity/revision fields; callers retain schema admission. */
export function validateCodeTaskParentTarget(
  errors: string[],
  value: Record<string, unknown>,
): boolean {
  const targetErrors: string[] = [];
  if (!isCodeTaskTaskId(ownField(value, "taskId"))) targetErrors.push("taskId is invalid");
  if (!isCodeTaskRunId(ownField(value, "runId"))) targetErrors.push("runId is invalid");
  if (!isCodeTaskWorkspaceId(ownField(value, "workspaceId"))) {
    targetErrors.push("workspaceId is invalid");
  }
  if (!isNonNegativeInteger(ownField(value, "stateRevision"))) {
    targetErrors.push("stateRevision must be a non-negative integer");
  }
  errors.push(...targetErrors);
  return targetErrors.length === 0;
}

/** Validate the shared identity header; callers retain their distinct target/revision policies. */
export function validateCodeTaskIdentityHeader(
  errors: string[],
  value: Record<string, unknown>,
  expectedKind: string,
  expectedSchemaVersion: 1,
): boolean {
  let valid = true;
  if (ownField(value, "kind") !== expectedKind) {
    errors.push(`kind must be ${expectedKind}`);
    valid = false;
  }
  if (ownField(value, "schemaVersion") !== expectedSchemaVersion) {
    errors.push("schemaVersion must be the literal 1");
    valid = false;
  }
  if (!isCodeTaskTaskId(ownField(value, "taskId"))) {
    errors.push("taskId is invalid");
    valid = false;
  }
  if (!isCodeTaskRunId(ownField(value, "runId"))) {
    errors.push("runId is invalid");
    valid = false;
  }
  return valid;
}
