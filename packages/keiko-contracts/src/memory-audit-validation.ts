// Pure validators for the memory audit ledger envelope (Epic #204, Issue #205). Sibling
// of `memory-operations-validation.ts` and `memory-retrieval-validation.ts`.
//
// Audit invariant: a `MemoryAuditRecord.summary` MUST NOT carry credential-shaped content.
// This is defence in depth — the audit ledger persists summaries directly to evidence
// storage (#214), so a leaked secret would otherwise bypass body-only redaction sweeps.
// The shape check is `looksLikeSecretShape` from memory-validation.ts.

import type { MemoryAuditRecord, MemoryUpdateField } from "./memory-operations.js";
import { MEMORY_AUDIT_INITIATOR_SURFACES, MEMORY_UPDATE_FIELDS } from "./memory-operations.js";
import type { MemoryAuditActionKind, MemoryScope, MemoryEdgeKind } from "./memory-contracts.js";
import { MEMORY_AUDIT_ACTION_KINDS, MEMORY_EDGE_KINDS } from "./memory-contracts.js";
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

// Explicit non-brand admission shapes; no fields are omitted except phantom IDs.
type MemoryAuditActionFields =
  | { readonly kind: "proposed"; readonly proposalId: string; readonly scope: MemoryScope }
  | {
      readonly kind: "accepted";
      readonly proposalId: string;
      readonly memoryId: string;
      readonly scope: MemoryScope;
    }
  | { readonly kind: "rejected"; readonly proposalId: string; readonly reason: string }
  | {
      readonly kind: "updated";
      readonly memoryId: string;
      readonly fieldsChanged: readonly MemoryUpdateField[];
    }
  | {
      readonly kind: "superseded";
      readonly oldMemoryId: string;
      readonly newMemoryId: string;
      readonly edgeId: string;
      readonly edgeKind: MemoryEdgeKind;
    }
  | { readonly kind: "pinned" | "unpinned" | "archived"; readonly memoryId: string }
  | {
      readonly kind: "forgotten";
      readonly memoryId: string;
      readonly scope: MemoryScope;
      readonly reason: string;
    }
  | {
      readonly kind: "retrieved";
      readonly scopes: readonly MemoryScope[];
      readonly matchedMemoryIds: readonly string[];
    };
type MemoryAuditRecordFields = Omit<MemoryAuditRecord, "id" | "action" | "initiatorReviewerId"> & {
  readonly id: string;
  readonly action: MemoryAuditActionFields;
  readonly initiatorReviewerId?: string;
};

function validateAuditScopeArrayField(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("action.scopes must be a non-empty array");
    valid = false;
    return valid;
  }
  const extent = value.length;
  if (!Number.isSafeInteger(extent) || extent < 1) {
    errors.push("action.scopes must be a non-empty array");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value)) {
      pushNestedErrors("action", validateMemoryScope(undefined), errors);
      return false;
    }
    const scope: unknown = value[index];
    valid = pushNestedErrors("action", validateMemoryScope(scope), errors) && valid;
  }
  return valid;
}

function validateAuditMatchedIds(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(value)) {
    errors.push("action.matchedMemoryIds must be an array");
    valid = false;
    return valid;
  }
  const extent = value.length;
  if (!Number.isSafeInteger(extent) || extent < 0) {
    errors.push("action.matchedMemoryIds must be an array");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const id: unknown = value[index];
    if (!isNonEmptyTrimmedString(id)) {
      errors.push("action.matchedMemoryIds entry must be a non-empty string");
      valid = false;
      return valid;
    }
  }
  return valid;
}

function validateAuditFieldsChanged(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("action.fieldsChanged must be a non-empty array");
    valid = false;
    return valid;
  }
  const extent = value.length;
  if (!Number.isSafeInteger(extent) || extent < 1) {
    errors.push("action.fieldsChanged must be a non-empty array");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const field: unknown = value[index];
    if (!isMember(field, MEMORY_UPDATE_FIELDS)) {
      errors.push(`action.fieldsChanged entry must be one of ${MEMORY_UPDATE_FIELDS.join("|")}`);
      valid = false;
      return valid;
    }
  }
  return valid;
}

function validateAuditActionArrays(action: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if ("scope" in action) {
    valid = pushNestedErrors("action", validateMemoryScope(action.scope), errors) && valid;
  }
  if ("scopes" in action) {
    valid = validateAuditScopeArrayField(action.scopes, errors) && valid;
  }
  if ("matchedMemoryIds" in action) {
    valid = validateAuditMatchedIds(action.matchedMemoryIds, errors) && valid;
  }
  if ("fieldsChanged" in action) {
    valid = validateAuditFieldsChanged(action.fieldsChanged, errors) && valid;
  }
  return valid;
}

function validateAuditActionIds(
  action: Record<string, unknown>,
  required: ReadonlySet<string>,
  errors: string[],
): boolean {
  let valid = true;
  valid =
    validateOptionalAuditIdField(
      "action.proposalId",
      action.proposalId,
      required.has("proposalId"),
      errors,
    ) && valid;
  valid =
    validateOptionalAuditIdField(
      "action.memoryId",
      action.memoryId,
      required.has("memoryId"),
      errors,
    ) && valid;
  valid =
    validateOptionalAuditIdField("action.edgeId", action.edgeId, required.has("edgeId"), errors) &&
    valid;
  valid =
    validateOptionalAuditIdField(
      "action.oldMemoryId",
      action.oldMemoryId,
      required.has("oldMemoryId"),
      errors,
    ) && valid;
  valid =
    validateOptionalAuditIdField(
      "action.newMemoryId",
      action.newMemoryId,
      required.has("newMemoryId"),
      errors,
    ) && valid;
  return valid;
}

function validateAuditActionVocabulary(action: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if ("edgeKind" in action && !isMember(action.edgeKind, MEMORY_EDGE_KINDS)) {
    errors.push(`action.edgeKind must be one of ${MEMORY_EDGE_KINDS.join("|")}`);
    valid = false;
  }
  if ("reason" in action && !isSafeText(action.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("action.reason must be a bounded control-free non-empty string");
    valid = false;
  }
  return valid;
}

function validateAuditActionFieldShapes(
  action: Record<string, unknown>,
  required: ReadonlySet<string>,
  errors: string[],
): boolean {
  let valid = true;
  valid = validateAuditActionArrays(action, errors) && valid;
  valid = validateAuditActionIds(action, required, errors) && valid;
  valid = validateAuditActionVocabulary(action, errors) && valid;
  return valid;
}

function validateOptionalAuditIdField(
  field: string,
  value: unknown,
  required: boolean,
  errors: string[],
): boolean {
  let valid = true;
  if (value === undefined && !required) {
    return valid;
  }
  valid = validateMemoryIdString(field, value, errors) && valid;
  return valid;
}

function validateAuditActionKindShape(action: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isMember(action.kind, MEMORY_AUDIT_ACTION_KINDS)) {
    errors.push(`action.kind must be one of ${MEMORY_AUDIT_ACTION_KINDS.join("|")}`);
    valid = false;
    return valid;
  }
  const expected = AUDIT_ACTION_KIND_FIELDS.get(action.kind);
  if (expected === undefined) {
    errors.push(`action.kind ${action.kind} is missing field expectations`);
    valid = false;
    return valid;
  }
  const presentRequired = new Set<string>();
  for (const field of expected) {
    if (!(field in action)) {
      errors.push(`action.${field} is required for kind=${action.kind}`);
      valid = false;
    } else {
      presentRequired.add(field);
    }
  }
  valid = validateAuditActionFieldShapes(action, presentRequired, errors) && valid;
  return valid;
}

function validateAuditRecordTextAndTime(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isFiniteNonNegativeNumber(input.occurredAt)) {
    errors.push("auditRecord.occurredAt must be a finite non-negative number");
    valid = false;
  }
  if (!isSafeText(input.summary, MEMORY_SUMMARY_MAX_CHARS)) {
    errors.push("auditRecord.summary must be a bounded control-free non-empty string");
    valid = false;
  } else if (looksLikeSecretShape(input.summary)) {
    errors.push("auditRecord.summary must not carry credential-shaped content");
    valid = false;
  }
  return valid;
}

function validateAuditRecordCore(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("auditRecord.id", input.id, errors) && valid;
  if (!isMember(input.actionKind, MEMORY_AUDIT_ACTION_KINDS)) {
    errors.push(`auditRecord.actionKind must be one of ${MEMORY_AUDIT_ACTION_KINDS.join("|")}`);
    valid = false;
  }
  if (!isMember(input.initiatorSurface, MEMORY_AUDIT_INITIATOR_SURFACES)) {
    errors.push(
      `auditRecord.initiatorSurface must be one of ${MEMORY_AUDIT_INITIATOR_SURFACES.join("|")}`,
    );
    valid = false;
  }
  if (
    input.initiatorReviewerId !== undefined &&
    !isNonEmptyTrimmedString(input.initiatorReviewerId)
  ) {
    errors.push("auditRecord.initiatorReviewerId must be a non-empty string when set");
    valid = false;
  }
  valid = validateAuditRecordTextAndTime(input, errors) && valid;
  return valid;
}

function admitMemoryAuditRecord(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryAuditRecordFields {
  let valid = true;
  valid = validateAuditRecordCore(input, errors) && valid;
  if (!isRecord(input.action)) {
    errors.push("auditRecord.action must be an object");
    valid = false;
  } else {
    if (
      isMember(input.actionKind, MEMORY_AUDIT_ACTION_KINDS) &&
      input.action.kind !== input.actionKind
    ) {
      errors.push("auditRecord.action.kind must match auditRecord.actionKind");
      valid = false;
    }
    valid = validateAuditActionKindShape(input.action, errors) && valid;
  }
  return valid;
}

export function validateMemoryAuditRecord(input: unknown): MemoryValidation<MemoryAuditRecord> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["auditRecord must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryAuditRecord(input, errors)) return { ok: false, errors };
  const fields: MemoryAuditRecordFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  // SAFETY: The owning guard checks all concrete fields; only erased ID brands remain.
  return { ok: true, value: fields as MemoryAuditRecord };
}
