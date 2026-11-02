// Record-level schema validators and discriminator helpers for the Governed Enterprise
// Memory Vault (Epic #204, Issue #205). Mirrors the `local-knowledge-schema-validation.ts`
// pattern: takes an `unknown`, walks the structural shape, returns either a narrowed
// `MemoryRecord` or a list of failed invariants.
//
// Also exports `isMemoryRecord`, `isMemoryEdge`, and `assertNeverMemoryType` — the three
// helpers that prove the contract distinguishes durable memory from chat history,
// connected-context KnowledgeCapsules, and local-knowledge records. The discriminator
// surface is small and load-bearing: downstream packages call these at every trust
// boundary so the four "things that look like text with provenance" do not collapse into
// each other.

import type { MemoryEdge, MemoryRecord } from "./memory-records.js";
import { MEMORY_SCHEMA_VERSION, MEMORY_STATUSES, MEMORY_TYPES } from "./memory-contracts.js";
import {
  validateMemoryEdge,
  validateMemoryProvenance,
  validateMemoryScope,
  validateMemoryStructuredPayload,
  validateMemoryValidityInterval,
  type MemoryValidation,
} from "./memory-validation.js";
import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_REASON_MAX_CHARS,
  isFiniteNonNegativeNumber,
  isMember,
  isNonEmptyTrimmedString,
  isRecord,
  isSafeText,
  pushNestedErrors,
  validateRetentionHint,
  validateTags,
} from "./memory-internal.js";

interface MemoryObservationDiagnostics {
  errors: string[];
}

function validateRecordSchemaVersion(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    errors.push(`record.schemaVersion must be the literal "${MEMORY_SCHEMA_VERSION}"`);
    valid = false;
  }
  return valid;
}

function validateRecordEnums(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isMember(input.type, MEMORY_TYPES)) {
    errors.push(`record.type must be one of ${MEMORY_TYPES.join("|")}`);
    valid = false;
  }
  if (!isMember(input.status, MEMORY_STATUSES)) {
    errors.push(`record.status must be one of ${MEMORY_STATUSES.join("|")}`);
    valid = false;
  }
  return valid;
}

function validateRecordTimestamps(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isFiniteNonNegativeNumber(input.createdAt)) {
    errors.push("record.createdAt must be a finite non-negative number");
    valid = false;
  }
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    errors.push("record.updatedAt must be a finite non-negative number");
    valid = false;
  }
  if (
    isFiniteNonNegativeNumber(input.createdAt) &&
    isFiniteNonNegativeNumber(input.updatedAt) &&
    input.updatedAt < input.createdAt
  ) {
    errors.push("record.updatedAt must be greater than or equal to record.createdAt");
    valid = false;
  }
  return valid;
}

function validateRecordCoreShape(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isNonEmptyTrimmedString(input.id)) {
    errors.push("record.id must be a non-empty string");
    valid = false;
  }
  if (!isSafeText(input.body, MEMORY_BODY_MAX_CHARS)) {
    errors.push("record.body must be a bounded control-free non-empty string");
    valid = false;
  }
  if (typeof input.pinned !== "boolean") {
    errors.push("record.pinned must be a boolean");
    valid = false;
  }
  if (input.staleReason !== undefined && !isSafeText(input.staleReason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("record.staleReason must be a bounded control-free string when set");
    valid = false;
  }
  const enumsOk = validateRecordEnums(input, errors);
  const timestampsOk = validateRecordTimestamps(input, errors);
  return valid && enumsOk && timestampsOk;
}

function validateRecordRetentionHint(input: Record<string, unknown>, errors: string[]): boolean {
  const hint = input.retentionHint;
  if (hint === undefined) {
    return true;
  }
  return validateRetentionHint("record.retentionHint", hint, errors);
}

// ─── validateMemoryRecord ─────────────────────────────────────────────────────
function observeMemoryRecord(
  input: unknown,
  diagnostics: MemoryObservationDiagnostics,
): input is MemoryRecord {
  if (!isRecord(input)) {
    diagnostics.errors = ["record must be an object"];
    return false;
  }
  const errors = diagnostics.errors;
  const schemaOk = validateRecordSchemaVersion(input, errors);
  const scope = validateMemoryScope(input.scope);
  pushNestedErrors("record", scope, errors);
  const coreOk = validateRecordCoreShape(input, errors);
  let payloadOk = true;
  if (input.payload !== undefined) {
    const payload = validateMemoryStructuredPayload(input.payload);
    pushNestedErrors("record", payload, errors);
    payloadOk = payload.ok;
  }
  const provenance = validateMemoryProvenance(input.provenance);
  pushNestedErrors("record", provenance, errors);
  const validity = validateMemoryValidityInterval(input.validity);
  pushNestedErrors("record", validity, errors);
  const tagsOk = validateTags("record.tags", input.tags, errors);
  const retentionOk = validateRecordRetentionHint(input, errors);
  return (
    schemaOk &&
    scope.ok &&
    coreOk &&
    payloadOk &&
    provenance.ok &&
    validity.ok &&
    tagsOk &&
    retentionOk
  );
}

export function validateMemoryRecord(input: unknown): MemoryValidation<MemoryRecord> {
  const diagnostics: MemoryObservationDiagnostics = { errors: [] };
  if (!observeMemoryRecord(input, diagnostics)) {
    return { ok: false, errors: diagnostics.errors };
  }
  return { ok: true, value: input };
}

// ─── Predicates ───────────────────────────────────────────────────────────────
// `isMemoryRecord` returns true only for values that pass the full record validator. The
// distinction matters at the trust boundary: a chat message, a KnowledgeCapsule, or a
// local-knowledge ChunkRecord may share some structural fields with a MemoryRecord but
// none of them carries the (scope coordinate + provenance + status) triple together.
export function isMemoryRecord(value: unknown): value is MemoryRecord {
  return validateMemoryRecord(value).ok;
}

export function isMemoryEdge(value: unknown): value is MemoryEdge {
  return validateMemoryEdge(value).ok;
}

// `assertNeverMemoryType` proves the type union is exhausted at compile time. Call this
// in the default branch of a switch over `MemoryType`; a future contract version that
// adds a new type produces a compile error here, not a silent runtime fall-through.
export function assertNeverMemoryType(value: never): never {
  throw new Error(`unhandled MemoryType: ${String(value)}`);
}

// Re-export the narrow types the public surface uses; this keeps a single import target
// for the validator + record types so downstream packages do not have to chase two
// module paths.
export type { MemoryEdge, MemoryRecord };
export type {
  MemoryProvenance,
  MemoryStructuredPayload,
  MemoryValidityInterval,
} from "./memory-records.js";
export type { MemoryScope, MemoryType } from "./memory-contracts.js";
