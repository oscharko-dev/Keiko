// Pure validators for memory operation envelopes (Epic #204, Issue #205). Sibling of
// `memory-validation.ts`. Retrieval and audit validators live in
// `memory-retrieval-validation.ts` and `memory-audit-validation.ts` so each file stays
// under the 400-LOC budget. No IO, no clock, no randomness.

import type {
  MemoryAcceptance,
  MemoryArchive,
  MemoryForget,
  MemoryPin,
  MemoryProposal,
  MemoryRejection,
  MemorySupersession,
  MemoryUnpin,
  MemoryUpdate,
} from "./memory-operations.js";
import { MEMORY_SENSITIVITIES, MEMORY_TYPES } from "./memory.js";
import {
  validateMemoryProvenance,
  validateMemoryScope,
  validateMemoryStructuredPayload,
  validateMemoryValidityInterval,
  type MemoryValidation,
} from "./memory-validation.js";
import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_RATIONALE_MAX_CHARS,
  MEMORY_REASON_MAX_CHARS,
  isFiniteNonNegativeNumber,
  isMember,
  isNonEmptyTrimmedString,
  isRecord,
  isSafeText,
  pushNestedErrors,
  validateMemoryIdString,
  validateSchemaVersionLiteral,
  validateTags,
} from "./memory-internal.js";

// ─── Proposal ─────────────────────────────────────────────────────────────────
export function validateMemoryProposal(input: unknown): MemoryValidation<MemoryProposal> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["proposal must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("proposal.proposalId", input.proposalId, errors);
  if (!isFiniteNonNegativeNumber(input.proposedAt)) {
    errors.push("proposal.proposedAt must be a finite non-negative number");
  }
  pushNestedErrors("proposal", validateMemoryScope(input.scope), errors);
  if (!isMember(input.type, MEMORY_TYPES)) {
    errors.push(`proposal.type must be one of ${MEMORY_TYPES.join("|")}`);
  }
  if (!isSafeText(input.body, MEMORY_BODY_MAX_CHARS)) {
    errors.push("proposal.body must be a bounded control-free non-empty string");
  }
  if (input.payload !== undefined) {
    pushNestedErrors("proposal", validateMemoryStructuredPayload(input.payload), errors);
  }
  validateTags(input.tags, errors);
  pushNestedErrors("proposal", validateMemoryProvenance(input.provenance), errors);
  pushNestedErrors("proposal", validateMemoryValidityInterval(input.validity), errors);
  if (input.initialStatus !== "proposed") {
    errors.push('proposal.initialStatus must be the literal "proposed"');
  }
  if (
    input.captureReason !== undefined &&
    !isSafeText(input.captureReason, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("proposal.captureReason must be a bounded control-free string when set");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryProposal };
}

// ─── Acceptance ───────────────────────────────────────────────────────────────
function validateAcceptanceOverrides(input: Record<string, unknown>, errors: string[]): void {
  if (input.bodyOverride !== undefined && !isSafeText(input.bodyOverride, MEMORY_BODY_MAX_CHARS)) {
    errors.push("acceptance.bodyOverride must be a bounded control-free string when set");
  }
  if (
    input.sensitivityOverride !== undefined &&
    !isMember(input.sensitivityOverride, MEMORY_SENSITIVITIES)
  ) {
    errors.push(
      `acceptance.sensitivityOverride must be one of ${MEMORY_SENSITIVITIES.join("|")} when set`,
    );
  }
  if (input.validityOverride !== undefined) {
    pushNestedErrors("acceptance", validateMemoryValidityInterval(input.validityOverride), errors);
  }
  if (
    input.reviewerNote !== undefined &&
    !isSafeText(input.reviewerNote, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("acceptance.reviewerNote must be a bounded control-free string when set");
  }
}

export function validateMemoryAcceptance(input: unknown): MemoryValidation<MemoryAcceptance> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["acceptance must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("acceptance.proposalId", input.proposalId, errors);
  validateMemoryIdString("acceptance.mintedMemoryId", input.mintedMemoryId, errors);
  validateMemoryIdString("acceptance.reviewerId", input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input.acceptedAt)) {
    errors.push("acceptance.acceptedAt must be a finite non-negative number");
  }
  validateAcceptanceOverrides(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryAcceptance };
}

// ─── Rejection ────────────────────────────────────────────────────────────────
export function validateMemoryRejection(input: unknown): MemoryValidation<MemoryRejection> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["rejection must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("rejection.proposalId", input.proposalId, errors);
  validateMemoryIdString("rejection.reviewerId", input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input.rejectedAt)) {
    errors.push("rejection.rejectedAt must be a finite non-negative number");
  }
  if (!isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("rejection.reason must be a bounded control-free non-empty string");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryRejection };
}

// ─── Update ───────────────────────────────────────────────────────────────────
const UPDATE_OPTIONAL_FIELDS = [
  "bodyPatch",
  "payloadPatch",
  "tagsPatch",
  "validityPatch",
  "sensitivityPatch",
  "retentionHintPatch",
] as const;

function countUpdatePatches(input: Record<string, unknown>): number {
  let count = 0;
  for (const field of UPDATE_OPTIONAL_FIELDS) {
    if (input[field] !== undefined) {
      count += 1;
    }
  }
  return count;
}

function validateUpdatePatchFields(input: Record<string, unknown>, errors: string[]): void {
  if (input.bodyPatch !== undefined && !isSafeText(input.bodyPatch, MEMORY_BODY_MAX_CHARS)) {
    errors.push("update.bodyPatch must be a bounded control-free string when set");
  }
  if (input.payloadPatch !== undefined) {
    pushNestedErrors("update", validateMemoryStructuredPayload(input.payloadPatch), errors);
  }
  if (input.tagsPatch !== undefined) {
    validateTags(input.tagsPatch, errors);
  }
  if (input.validityPatch !== undefined) {
    pushNestedErrors("update", validateMemoryValidityInterval(input.validityPatch), errors);
  }
  if (
    input.sensitivityPatch !== undefined &&
    !isMember(input.sensitivityPatch, MEMORY_SENSITIVITIES)
  ) {
    errors.push(
      `update.sensitivityPatch must be one of ${MEMORY_SENSITIVITIES.join("|")} when set`,
    );
  }
  if (input.retentionHintPatch !== undefined && !isRecord(input.retentionHintPatch)) {
    errors.push("update.retentionHintPatch must be an object when set");
  }
}

export function validateMemoryUpdate(input: unknown): MemoryValidation<MemoryUpdate> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["update must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("update.memoryId", input.memoryId, errors);
  validateMemoryIdString("update.reviewerId", input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    errors.push("update.updatedAt must be a finite non-negative number");
  }
  validateUpdatePatchFields(input, errors);
  if (countUpdatePatches(input) === 0) {
    errors.push("update must change at least one field");
  }
  if (
    input.reviewerNote !== undefined &&
    !isSafeText(input.reviewerNote, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("update.reviewerNote must be a bounded control-free string when set");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryUpdate };
}

// ─── Supersession ─────────────────────────────────────────────────────────────
export function validateMemorySupersession(input: unknown): MemoryValidation<MemorySupersession> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["supersession must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("supersession.oldMemoryId", input.oldMemoryId, errors);
  validateMemoryIdString("supersession.newMemoryId", input.newMemoryId, errors);
  if (
    isNonEmptyTrimmedString(input.oldMemoryId) &&
    isNonEmptyTrimmedString(input.newMemoryId) &&
    input.oldMemoryId === input.newMemoryId
  ) {
    errors.push("supersession.oldMemoryId and supersession.newMemoryId must differ");
  }
  validateMemoryIdString("supersession.reviewerId", input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input.supersededAt)) {
    errors.push("supersession.supersededAt must be a finite non-negative number");
  }
  if (!isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("supersession.reason must be a bounded control-free non-empty string");
  }
  if (input.edgeKind !== "supersedes") {
    errors.push('supersession.edgeKind must be the literal "supersedes"');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemorySupersession };
}

// ─── Pin / unpin / archive ────────────────────────────────────────────────────
function validatePinOrUnpinShape(
  noun: "pin" | "unpin",
  timestampField: "pinnedAt" | "unpinnedAt",
  input: unknown,
): MemoryValidation<MemoryPin | MemoryUnpin> {
  if (!isRecord(input)) {
    return { ok: false, errors: [`${noun} must be an object`] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString(`${noun}.memoryId`, input.memoryId, errors);
  validateMemoryIdString(`${noun}.reviewerId`, input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input[timestampField])) {
    errors.push(`${noun}.${timestampField} must be a finite non-negative number`);
  }
  if (input.reason !== undefined && !isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push(`${noun}.reason must be a bounded control-free string when set`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryPin | MemoryUnpin };
}

export function validateMemoryPin(input: unknown): MemoryValidation<MemoryPin> {
  return validatePinOrUnpinShape("pin", "pinnedAt", input) as MemoryValidation<MemoryPin>;
}

export function validateMemoryUnpin(input: unknown): MemoryValidation<MemoryUnpin> {
  return validatePinOrUnpinShape("unpin", "unpinnedAt", input) as MemoryValidation<MemoryUnpin>;
}

export function validateMemoryArchive(input: unknown): MemoryValidation<MemoryArchive> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["archive must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("archive.memoryId", input.memoryId, errors);
  validateMemoryIdString("archive.reviewerId", input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input.archivedAt)) {
    errors.push("archive.archivedAt must be a finite non-negative number");
  }
  if (input.reason !== undefined && !isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("archive.reason must be a bounded control-free string when set");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryArchive };
}

// ─── Forget ───────────────────────────────────────────────────────────────────
// The destructive-acknowledgement flag is pinned to the literal `true` at the type level,
// so structural success is also semantic acknowledgement: a caller cannot ship a forget
// envelope without explicit acknowledgement.
export function validateMemoryForget(input: unknown): MemoryValidation<MemoryForget> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["forget must be an object"] };
  }
  const errors: string[] = [];
  validateSchemaVersionLiteral(input, errors);
  validateMemoryIdString("forget.memoryId", input.memoryId, errors);
  validateMemoryIdString("forget.reviewerId", input.reviewerId, errors);
  if (!isFiniteNonNegativeNumber(input.forgottenAt)) {
    errors.push("forget.forgottenAt must be a finite non-negative number");
  }
  if (!isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("forget.reason must be a bounded control-free non-empty string");
  }
  if (input.userAcknowledgedDestructive !== true) {
    errors.push("forget.userAcknowledgedDestructive must be the literal true");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryForget };
}
