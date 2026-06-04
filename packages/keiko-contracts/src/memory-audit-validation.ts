// Pure validators for the memory audit ledger envelope (Epic #204, Issue #205). Sibling
// of `memory-operations-validation.ts` and `memory-retrieval-validation.ts`.
//
// Audit invariant: a `MemoryAuditRecord.summary` MUST NOT carry credential-shaped content.
// This is defence in depth — the audit ledger persists summaries directly to evidence
// storage (#214), so a leaked secret would otherwise bypass body-only redaction sweeps.
// The shape check is `looksLikeSecretShape` from memory-validation.ts.

import type { MemoryAuditRecord } from "./memory-operations.js";
import { MEMORY_AUDIT_INITIATOR_SURFACES, MEMORY_UPDATE_FIELDS } from "./memory-operations.js";
import type { MemoryAuditActionKind } from "./memory.js";
import { MEMORY_AUDIT_ACTION_KINDS, MEMORY_EDGE_KINDS } from "./memory.js";
import {
  looksLikeSecretShape,
  validateMemoryScope,
  type MemoryValidation,
} from "./memory-validation.js";
import {
  MEMORY_REASON_MAX_CHARS,
  MEMORY_SUMMARY_MAX_CHARS,
  isFiniteNonNegativeNumber,
  isMember,
  isNonEmptyTrimmedString,
  isRecord,
  isSafeText,
  pushNestedErrors,
  validateMemoryIdString,
  validateSchemaVersionLiteral,
} from "./memory-internal.js";

// Required field names per audit-action kind. Adding a new kind extends this map AND the
// `MemoryAuditAction` discriminated union; the validator complains when a present action
// is missing a required field for its kind.
const AUDIT_ACTION_KIND_FIELDS: ReadonlyMap<MemoryAuditActionKind, readonly string[]> = new Map([
  ["proposed", ["proposalId", "scope"]],
  ["accepted", ["proposalId", "memoryId", "scope"]],
  ["rejected", ["proposalId", "reason"]],
  ["updated", ["memoryId", "fieldsChanged"]],
  ["superseded", ["oldMemoryId", "newMemoryId", "edgeId", "edgeKind"]],
  ["pinned", ["memoryId"]],
  ["unpinned", ["memoryId"]],
  ["archived", ["memoryId"]],
  ["forgotten", ["memoryId", "scope", "reason"]],
  ["retrieved", ["scopes", "matchedMemoryIds"]],
]);

function validateAuditScopeArrayField(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("action.scopes must be a non-empty array");
    return;
  }
  for (const scope of value) {
    pushNestedErrors("action", validateMemoryScope(scope), errors);
  }
}

function validateAuditMatchedIds(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("action.matchedMemoryIds must be an array");
    return;
  }
  for (const id of value) {
    if (!isNonEmptyTrimmedString(id)) {
      errors.push("action.matchedMemoryIds entry must be a non-empty string");
      return;
    }
  }
}

function validateAuditFieldsChanged(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("action.fieldsChanged must be a non-empty array");
    return;
  }
  for (const field of value) {
    if (!isMember(field, MEMORY_UPDATE_FIELDS)) {
      errors.push(`action.fieldsChanged entry must be one of ${MEMORY_UPDATE_FIELDS.join("|")}`);
      return;
    }
  }
}

function validateAuditActionFieldShapes(action: Record<string, unknown>, errors: string[]): void {
  if ("scope" in action) {
    pushNestedErrors("action", validateMemoryScope(action.scope), errors);
  }
  if ("scopes" in action) {
    validateAuditScopeArrayField(action.scopes, errors);
  }
  if ("matchedMemoryIds" in action) {
    validateAuditMatchedIds(action.matchedMemoryIds, errors);
  }
  if ("fieldsChanged" in action) {
    validateAuditFieldsChanged(action.fieldsChanged, errors);
  }
  if ("edgeKind" in action && !isMember(action.edgeKind, MEMORY_EDGE_KINDS)) {
    errors.push(`action.edgeKind must be one of ${MEMORY_EDGE_KINDS.join("|")}`);
  }
  if ("reason" in action && !isSafeText(action.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("action.reason must be a bounded control-free non-empty string");
  }
}

function validateAuditActionKindShape(action: Record<string, unknown>, errors: string[]): void {
  if (!isMember(action.kind, MEMORY_AUDIT_ACTION_KINDS)) {
    errors.push(`action.kind must be one of ${MEMORY_AUDIT_ACTION_KINDS.join("|")}`);
    return;
  }
  const expected = AUDIT_ACTION_KIND_FIELDS.get(action.kind);
  if (expected === undefined) {
    errors.push(`action.kind ${action.kind} is missing field expectations`);
    return;
  }
  for (const field of expected) {
    if (!(field in action)) {
      errors.push(`action.${field} is required for kind=${action.kind}`);
    }
  }
  validateAuditActionFieldShapes(action, errors);
}

function validateAuditRecordCore(input: Record<string, unknown>, errors: string[]): void {
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("auditRecord.id", input.id, errors);
  if (!isMember(input.actionKind, MEMORY_AUDIT_ACTION_KINDS)) {
    errors.push(`auditRecord.actionKind must be one of ${MEMORY_AUDIT_ACTION_KINDS.join("|")}`);
  }
  if (!isMember(input.initiatorSurface, MEMORY_AUDIT_INITIATOR_SURFACES)) {
    errors.push(
      `auditRecord.initiatorSurface must be one of ${MEMORY_AUDIT_INITIATOR_SURFACES.join("|")}`,
    );
  }
  if (
    input.initiatorReviewerId !== undefined &&
    !isNonEmptyTrimmedString(input.initiatorReviewerId)
  ) {
    errors.push("auditRecord.initiatorReviewerId must be a non-empty string when set");
  }
  if (!isFiniteNonNegativeNumber(input.occurredAt)) {
    errors.push("auditRecord.occurredAt must be a finite non-negative number");
  }
  if (!isSafeText(input.summary, MEMORY_SUMMARY_MAX_CHARS)) {
    errors.push("auditRecord.summary must be a bounded control-free non-empty string");
  } else if (looksLikeSecretShape(input.summary)) {
    errors.push("auditRecord.summary must not carry credential-shaped content");
  }
}

export function validateMemoryAuditRecord(input: unknown): MemoryValidation<MemoryAuditRecord> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["auditRecord must be an object"] };
  }
  const errors: string[] = [];
  validateAuditRecordCore(input, errors);
  if (!isRecord(input.action)) {
    errors.push("auditRecord.action must be an object");
  } else {
    if (
      isMember(input.actionKind, MEMORY_AUDIT_ACTION_KINDS) &&
      input.action.kind !== input.actionKind
    ) {
      errors.push("auditRecord.action.kind must match auditRecord.actionKind");
    }
    validateAuditActionKindShape(input.action, errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryAuditRecord };
}
