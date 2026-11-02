// Pure validators for memory retrieval (Epic #204, Issue #205). Sibling of
// `memory-operations-validation.ts`. Split into its own module so each file stays under
// the 400-LOC budget, and so the retrieval surface — which downstream packages (#210)
// will iterate on more aggressively than the rest — has a stable, narrow import path.
//
// `isScopeReachable` lives here next to the retrieval-request validator because the same
// caller that constructs the request needs to verify, before issuing it, that each scope
// it intends to query is in the authorized set. Both helpers are pure and clock-free.

import type { MemoryRetrievalRequest } from "./memory-operations.js";
import type { MemoryScope } from "./memory-contracts.js";
import { MEMORY_STATUSES, MEMORY_TYPES } from "./memory-contracts.js";
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

function validateRetrievalScopes(input: unknown, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(input) || input.length === 0) {
    errors.push("retrieval.scopes must be a non-empty array");
    valid = false;
    return valid;
  }
  const extent = input.length;
  if (!Number.isSafeInteger(extent) || extent < 1) {
    errors.push("retrieval.scopes must be a non-empty array");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    if (!(index in input)) {
      pushNestedErrors("retrieval", validateMemoryScope(undefined), errors);
      return false;
    }
    const candidate: unknown = input[index];
    valid = pushNestedErrors("retrieval", validateMemoryScope(candidate), errors) && valid;
  }
  return valid;
}

function validateRetrievalEnumFilter(
  field: string,
  values: unknown,
  allowed: readonly string[],
  errors: string[],
): boolean {
  let valid = true;
  if (values === undefined) {
    return valid;
  }
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`retrieval.${field} must be a non-empty array when set`);
    valid = false;
    return valid;
  }
  const extent = values.length;
  if (!Number.isSafeInteger(extent) || extent < 1) {
    errors.push(`retrieval.${field} must be a non-empty array when set`);
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const value: unknown = values[index];
    if (!isMember(value, allowed)) {
      errors.push(`retrieval.${field} entry must be one of ${allowed.join("|")}`);
      valid = false;
      return valid;
    }
  }
  return valid;
}

// KEIKO-1027: enforce contract-level ceilings on the two retrieval budget hints so a hostile
// producer cannot ask the store for an unbounded scan (maxResults) or an unbounded body-byte
// projection (maxBodyChars). Values are hints, not guarantees; the store may still clamp
// tighter, but the contract now bounds the outer request shape at the naming boundary.
export const MEMORY_RETRIEVAL_MAX_RESULTS = 1024 as const;
export const MEMORY_RETRIEVAL_MAX_BODY_CHARS = MEMORY_BODY_MAX_CHARS;

function validateRetrievalNumericLimit(
  field: string,
  value: unknown,
  errors: string[],
  ceiling: number,
): boolean {
  let valid = true;
  if (value === undefined) {
    return valid;
  }
  if (!isFinitePositiveInteger(value)) {
    errors.push(`retrieval.${field} must be a positive integer when set`);
    valid = false;
    return valid;
  }
  if (value > ceiling) {
    errors.push(`retrieval.${field} must be <= ${String(ceiling)} when set`);
    valid = false;
  }
  return valid;
}

function validateRetrievalFilters(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid =
    validateRetrievalEnumFilter("typeFilter", input.typeFilter, MEMORY_TYPES, errors) && valid;
  valid =
    validateRetrievalEnumFilter("statusFilter", input.statusFilter, MEMORY_STATUSES, errors) &&
    valid;
  if (input.textQuery !== undefined && !isSafeText(input.textQuery, MEMORY_BODY_MAX_CHARS)) {
    errors.push("retrieval.textQuery must be a bounded control-free string when set");
    valid = false;
  }
  if (input.tagsFilter !== undefined) {
    valid = validateTags("retrieval.tagsFilter", input.tagsFilter, errors) && valid;
  }
  return valid;
}

function validateRetrievalBudgetAndToggles(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid =
    validateRetrievalNumericLimit(
      "maxResults",
      input.maxResults,
      errors,
      MEMORY_RETRIEVAL_MAX_RESULTS,
    ) && valid;
  valid =
    validateRetrievalNumericLimit(
      "maxBodyChars",
      input.maxBodyChars,
      errors,
      MEMORY_RETRIEVAL_MAX_BODY_CHARS,
    ) && valid;
  if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") {
    errors.push("retrieval.includeArchived must be a boolean when set");
    valid = false;
  }
  if (input.includeSuperseded !== undefined && typeof input.includeSuperseded !== "boolean") {
    errors.push("retrieval.includeSuperseded must be a boolean when set");
    valid = false;
  }
  return valid;
}

function admitMemoryRetrievalRequest(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryRetrievalRequest {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.requestedAt)) {
    errors.push("retrieval.requestedAt must be a finite non-negative number");
    valid = false;
  }
  valid = validateRetrievalScopes(input.scopes, errors) && valid;
  valid = validateRetrievalFilters(input, errors) && valid;
  valid = validateRetrievalBudgetAndToggles(input, errors) && valid;
  return valid;
}

export function validateMemoryRetrievalRequest(
  input: unknown,
): MemoryValidation<MemoryRetrievalRequest> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["retrieval must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryRetrievalRequest(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// A canonical coordinate string per scope. Distinct scope kinds always produce strings
// with distinct kind prefixes, so a `userId` equal to a `workspaceId` cannot collide.
// `global` carries a fixed coordinate so set membership remains a pure string compare.
// Exported as the single source of truth for the scope→partition-key projection used by
// keiko-memory-governance's conflict/forget scans and keiko-memory-consolidation's
// dedupe/conflict ordering (#2906 KEIKO-0546). The encoding "kind:coordinate" is
// load-bearing — two callers that partition with one function and compare with another
// would silently mismatch on global-scoped memories if the encoding diverged.
export function scopeCoordinateKey(scope: MemoryScope): string {
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
