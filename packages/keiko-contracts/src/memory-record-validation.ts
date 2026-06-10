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

import type {
  MemoryEdge,
  MemoryRecord,
  MemoryStructuredPayload,
  MemoryValidityInterval,
} from "./memory-records.js";
import type { MemoryProvenance } from "./memory-records.js";
import type { MemoryScope, MemoryType } from "./memory.js";
import { MEMORY_SCHEMA_VERSION, MEMORY_STATUSES, MEMORY_TYPES } from "./memory.js";
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

function validateRecordSchemaVersion(input: Record<string, unknown>, errors: string[]): void {
  if (input.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    errors.push(`record.schemaVersion must be the literal "${MEMORY_SCHEMA_VERSION}"`);
  }
}

function validateRecordEnums(input: Record<string, unknown>, errors: string[]): void {
  if (!isMember(input.type, MEMORY_TYPES)) {
    errors.push(`record.type must be one of ${MEMORY_TYPES.join("|")}`);
  }
  if (!isMember(input.status, MEMORY_STATUSES)) {
    errors.push(`record.status must be one of ${MEMORY_STATUSES.join("|")}`);
  }
}

function validateRecordTimestamps(input: Record<string, unknown>, errors: string[]): void {
  if (!isFiniteNonNegativeNumber(input.createdAt)) {
    errors.push("record.createdAt must be a finite non-negative number");
  }
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    errors.push("record.updatedAt must be a finite non-negative number");
  }
  if (
    isFiniteNonNegativeNumber(input.createdAt) &&
    isFiniteNonNegativeNumber(input.updatedAt) &&
    input.updatedAt < input.createdAt
  ) {
    errors.push("record.updatedAt must be greater than or equal to record.createdAt");
  }
}

function validateRecordCoreShape(input: Record<string, unknown>, errors: string[]): void {
  if (!isNonEmptyTrimmedString(input.id)) {
    errors.push("record.id must be a non-empty string");
  }
  if (!isSafeText(input.body, MEMORY_BODY_MAX_CHARS)) {
    errors.push("record.body must be a bounded control-free non-empty string");
  }
  if (typeof input.pinned !== "boolean") {
    errors.push("record.pinned must be a boolean");
  }
  if (input.staleReason !== undefined && !isSafeText(input.staleReason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("record.staleReason must be a bounded control-free string when set");
  }
  validateRecordEnums(input, errors);
  validateRecordTimestamps(input, errors);
}

function validateRecordRetentionHint(input: Record<string, unknown>, errors: string[]): void {
  const hint = input.retentionHint;
  if (hint === undefined) {
    return;
  }
  validateRetentionHint("record.retentionHint", hint, errors);
}

// ─── validateMemoryRecord ─────────────────────────────────────────────────────
export function validateMemoryRecord(input: unknown): MemoryValidation<MemoryRecord> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["record must be an object"] };
  }
  const errors: string[] = [];
  validateRecordSchemaVersion(input, errors);
  pushNestedErrors("record", validateMemoryScope(input.scope), errors);
  validateRecordCoreShape(input, errors);
  if (input.payload !== undefined) {
    pushNestedErrors("record", validateMemoryStructuredPayload(input.payload), errors);
  }
  pushNestedErrors("record", validateMemoryProvenance(input.provenance), errors);
  pushNestedErrors("record", validateMemoryValidityInterval(input.validity), errors);
  validateTags("record.tags", input.tags, errors);
  validateRecordRetentionHint(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryRecord };
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
export type {
  MemoryEdge,
  MemoryProvenance,
  MemoryRecord,
  MemoryScope,
  MemoryStructuredPayload,
  MemoryType,
  MemoryValidityInterval,
};
