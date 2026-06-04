// Pure validators for memory retrieval (Epic #204, Issue #205). Sibling of
// `memory-operations-validation.ts`. Split into its own module so each file stays under
// the 400-LOC budget, and so the retrieval surface — which downstream packages (#210)
// will iterate on more aggressively than the rest — has a stable, narrow import path.
//
// `isScopeReachable` lives here next to the retrieval-request validator because the same
// caller that constructs the request needs to verify, before issuing it, that each scope
// it intends to query is in the authorized set. Both helpers are pure and clock-free.

import type { MemoryRetrievalRequest } from "./memory-operations.js";
import type { MemoryScope } from "./memory.js";
import { MEMORY_STATUSES, MEMORY_TYPES } from "./memory.js";
import { validateMemoryScope, type MemoryValidation } from "./memory-validation.js";
import {
  MEMORY_BODY_MAX_CHARS,
  isFiniteNonNegativeNumber,
  isFinitePositiveInteger,
  isMember,
  isRecord,
  isSafeText,
  pushNestedErrors,
  validateSchemaVersionLiteral,
  validateTags,
} from "./memory-internal.js";

function validateRetrievalScopes(input: unknown, errors: string[]): void {
  if (!Array.isArray(input) || input.length === 0) {
    errors.push("retrieval.scopes must be a non-empty array");
    return;
  }
  for (const candidate of input) {
    pushNestedErrors("retrieval", validateMemoryScope(candidate), errors);
  }
}

function validateRetrievalEnumFilter(
  field: string,
  values: unknown,
  allowed: readonly string[],
  errors: string[],
): void {
  if (values === undefined) {
    return;
  }
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`retrieval.${field} must be a non-empty array when set`);
    return;
  }
  for (const value of values) {
    if (!isMember(value, allowed)) {
      errors.push(`retrieval.${field} entry must be one of ${allowed.join("|")}`);
      return;
    }
  }
}

function validateRetrievalNumericLimit(field: string, value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isFinitePositiveInteger(value)) {
    errors.push(`retrieval.${field} must be a positive integer when set`);
  }
}

function validateRetrievalFilters(input: Record<string, unknown>, errors: string[]): void {
  validateRetrievalEnumFilter("typeFilter", input.typeFilter, MEMORY_TYPES, errors);
  validateRetrievalEnumFilter("statusFilter", input.statusFilter, MEMORY_STATUSES, errors);
  if (input.textQuery !== undefined && !isSafeText(input.textQuery, MEMORY_BODY_MAX_CHARS)) {
    errors.push("retrieval.textQuery must be a bounded control-free string when set");
  }
  if (input.tagsFilter !== undefined) {
    validateTags(input.tagsFilter, errors);
  }
}

function validateRetrievalBudgetAndToggles(input: Record<string, unknown>, errors: string[]): void {
  validateRetrievalNumericLimit("maxResults", input.maxResults, errors);
  validateRetrievalNumericLimit("maxBodyChars", input.maxBodyChars, errors);
  if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") {
    errors.push("retrieval.includeArchived must be a boolean when set");
  }
  if (input.includeSuperseded !== undefined && typeof input.includeSuperseded !== "boolean") {
    errors.push("retrieval.includeSuperseded must be a boolean when set");
  }
}

export function validateMemoryRetrievalRequest(
  input: unknown,
): MemoryValidation<MemoryRetrievalRequest> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["retrieval must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  if (!isFiniteNonNegativeNumber(input.requestedAt)) {
    errors.push("retrieval.requestedAt must be a finite non-negative number");
  }
  validateRetrievalScopes(input.scopes, errors);
  validateRetrievalFilters(input, errors);
  validateRetrievalBudgetAndToggles(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryRetrievalRequest };
}

// A canonical coordinate string per scope. Distinct scope kinds always produce strings
// with distinct kind prefixes, so a `userId` equal to a `workspaceId` cannot collide.
// `global` carries a fixed coordinate so set membership remains a pure string compare.
function scopeCoordinateKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "global":
      return "global:";
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
  }
}

// A candidate scope is reachable when an authorized scope shares the same canonical
// coordinate. This is the type-level anchor for the no-cross-scope-visibility invariant.
export function isScopeReachable(
  candidate: MemoryScope,
  authorized: readonly MemoryScope[],
): boolean {
  const target = scopeCoordinateKey(candidate);
  for (const scope of authorized) {
    if (scopeCoordinateKey(scope) === target) {
      return true;
    }
  }
  return false;
}
