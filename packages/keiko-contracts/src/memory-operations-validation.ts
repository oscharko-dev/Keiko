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
import { MEMORY_FORGET_REASONS } from "./memory-operations.js";
import { MEMORY_SENSITIVITIES, MEMORY_TYPES } from "./memory-contracts.js";
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
  validateRetentionHint,
  validateSchemaVersionLiteral,
  validateTags,
} from "./memory-internal.js";

// ─── Proposal ─────────────────────────────────────────────────────────────────
// Explicit non-brand admission shapes; no fields are omitted except phantom IDs.
type MemoryProposalFields = Omit<MemoryProposal, "proposalId"> & { readonly proposalId: string };
type MemoryAcceptanceFields = Omit<
  MemoryAcceptance,
  "proposalId" | "mintedMemoryId" | "reviewerId"
> & { readonly proposalId: string; readonly mintedMemoryId: string; readonly reviewerId: string };
type MemoryRejectionFields = Omit<MemoryRejection, "proposalId" | "reviewerId"> & {
  readonly proposalId: string;
  readonly reviewerId: string;
};
type MemoryUpdateFields = Omit<MemoryUpdate, "memoryId" | "reviewerId"> & {
  readonly memoryId: string;
  readonly reviewerId: string;
};
type MemorySupersessionFields = Omit<
  MemorySupersession,
  "oldMemoryId" | "newMemoryId" | "reviewerId"
> & { readonly oldMemoryId: string; readonly newMemoryId: string; readonly reviewerId: string };
type MemoryPinFields = Omit<MemoryPin, "memoryId" | "reviewerId"> & {
  readonly memoryId: string;
  readonly reviewerId: string;
};
type MemoryUnpinFields = Omit<MemoryUnpin, "memoryId" | "reviewerId"> & {
  readonly memoryId: string;
  readonly reviewerId: string;
};
type MemoryPinOrMemoryUnpinFields = MemoryPinFields | MemoryUnpinFields;
type MemoryArchiveFields = Omit<MemoryArchive, "memoryId" | "reviewerId"> & {
  readonly memoryId: string;
  readonly reviewerId: string;
};
type MemoryForgetFields = Omit<MemoryForget, "memoryId" | "reviewerId"> & {
  readonly memoryId: string;
  readonly reviewerId: string;
};

function validateProposalRequiredNestedFields(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = validateTags("proposal.tags", input.tags, errors) && valid;
  valid = pushNestedErrors("proposal", validateMemoryProvenance(input.provenance), errors) && valid;
  valid =
    pushNestedErrors("proposal", validateMemoryValidityInterval(input.validity), errors) && valid;
  return valid;
}

function validateProposalOptionalFields(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.payload !== undefined) {
    valid =
      pushNestedErrors("proposal", validateMemoryStructuredPayload(input.payload), errors) && valid;
  }
  valid = validateProposalRequiredNestedFields(input, errors) && valid;
  if (input.retentionHint !== undefined) {
    valid = validateRetentionHint("proposal.retentionHint", input.retentionHint, errors) && valid;
  }
  if (
    input.captureReason !== undefined &&
    !isSafeText(input.captureReason, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("proposal.captureReason must be a bounded control-free string when set");
    valid = false;
  }
  return valid;
}

function admitMemoryProposal(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryProposalFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("proposal.proposalId", input.proposalId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.proposedAt)) {
    errors.push("proposal.proposedAt must be a finite non-negative number");
    valid = false;
  }
  valid = pushNestedErrors("proposal", validateMemoryScope(input.scope), errors) && valid;
  if (!isMember(input.type, MEMORY_TYPES)) {
    errors.push(`proposal.type must be one of ${MEMORY_TYPES.join("|")}`);
    valid = false;
  }
  if (!isSafeText(input.body, MEMORY_BODY_MAX_CHARS)) {
    errors.push("proposal.body must be a bounded control-free non-empty string");
    valid = false;
  }
  valid = validateProposalOptionalFields(input, errors) && valid;
  if (input.initialStatus !== "proposed") {
    errors.push('proposal.initialStatus must be the literal "proposed"');
    valid = false;
  }
  return valid;
}

export function validateMemoryProposal(input: unknown): MemoryValidation<MemoryProposal> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["proposal must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryProposal(input, errors)) return { ok: false, errors };
  const fields: MemoryProposalFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryProposal };
}

// ─── Acceptance ───────────────────────────────────────────────────────────────
function validateAcceptanceOverrides(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.bodyOverride !== undefined && !isSafeText(input.bodyOverride, MEMORY_BODY_MAX_CHARS)) {
    errors.push("acceptance.bodyOverride must be a bounded control-free string when set");
    valid = false;
  }
  if (
    input.sensitivityOverride !== undefined &&
    !isMember(input.sensitivityOverride, MEMORY_SENSITIVITIES)
  ) {
    errors.push(
      `acceptance.sensitivityOverride must be one of ${MEMORY_SENSITIVITIES.join("|")} when set`,
    );
    valid = false;
  }
  if (input.validityOverride !== undefined) {
    valid =
      pushNestedErrors(
        "acceptance",
        validateMemoryValidityInterval(input.validityOverride),
        errors,
      ) && valid;
  }
  if (
    input.reviewerNote !== undefined &&
    !isSafeText(input.reviewerNote, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("acceptance.reviewerNote must be a bounded control-free string when set");
    valid = false;
  }
  return valid;
}

function admitMemoryAcceptance(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryAcceptanceFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("acceptance.proposalId", input.proposalId, errors) && valid;
  valid =
    validateMemoryIdString("acceptance.mintedMemoryId", input.mintedMemoryId, errors) && valid;
  valid = validateMemoryIdString("acceptance.reviewerId", input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.acceptedAt)) {
    errors.push("acceptance.acceptedAt must be a finite non-negative number");
    valid = false;
  }
  valid = validateAcceptanceOverrides(input, errors) && valid;
  return valid;
}

export function validateMemoryAcceptance(input: unknown): MemoryValidation<MemoryAcceptance> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["acceptance must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryAcceptance(input, errors)) return { ok: false, errors };
  const fields: MemoryAcceptanceFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryAcceptance };
}

// ─── Rejection ────────────────────────────────────────────────────────────────
function admitMemoryRejection(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryRejectionFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("rejection.proposalId", input.proposalId, errors) && valid;
  valid = validateMemoryIdString("rejection.reviewerId", input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.rejectedAt)) {
    errors.push("rejection.rejectedAt must be a finite non-negative number");
    valid = false;
  }
  if (!isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("rejection.reason must be a bounded control-free non-empty string");
    valid = false;
  }
  return valid;
}

export function validateMemoryRejection(input: unknown): MemoryValidation<MemoryRejection> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["rejection must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryRejection(input, errors)) return { ok: false, errors };
  const fields: MemoryRejectionFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryRejection };
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

function validateUpdateMetadataPatchFields(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (input.validityPatch !== undefined) {
    valid =
      pushNestedErrors("update", validateMemoryValidityInterval(input.validityPatch), errors) &&
      valid;
  }
  if (
    input.sensitivityPatch !== undefined &&
    !isMember(input.sensitivityPatch, MEMORY_SENSITIVITIES)
  ) {
    errors.push(
      `update.sensitivityPatch must be one of ${MEMORY_SENSITIVITIES.join("|")} when set`,
    );
    valid = false;
  }
  if (input.retentionHintPatch !== undefined) {
    valid =
      validateRetentionHint("update.retentionHintPatch", input.retentionHintPatch, errors) && valid;
  }
  return valid;
}

function validateUpdatePatchFields(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.bodyPatch !== undefined && !isSafeText(input.bodyPatch, MEMORY_BODY_MAX_CHARS)) {
    errors.push("update.bodyPatch must be a bounded control-free string when set");
    valid = false;
  }
  if (input.payloadPatch !== undefined) {
    valid =
      pushNestedErrors("update", validateMemoryStructuredPayload(input.payloadPatch), errors) &&
      valid;
  }
  if (input.tagsPatch !== undefined) {
    valid = validateTags("update.tagsPatch", input.tagsPatch, errors) && valid;
  }
  valid = validateUpdateMetadataPatchFields(input, errors) && valid;
  return valid;
}

function admitMemoryUpdate(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryUpdateFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("update.memoryId", input.memoryId, errors) && valid;
  valid = validateMemoryIdString("update.reviewerId", input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    errors.push("update.updatedAt must be a finite non-negative number");
    valid = false;
  }
  valid = validateUpdatePatchFields(input, errors) && valid;
  if (countUpdatePatches(input) === 0) {
    errors.push("update must change at least one field");
    valid = false;
  }
  if (
    input.reviewerNote !== undefined &&
    !isSafeText(input.reviewerNote, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("update.reviewerNote must be a bounded control-free string when set");
    valid = false;
  }
  return valid;
}

export function validateMemoryUpdate(input: unknown): MemoryValidation<MemoryUpdate> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["update must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryUpdate(input, errors)) return { ok: false, errors };
  const fields: MemoryUpdateFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryUpdate };
}

// ─── Supersession ─────────────────────────────────────────────────────────────
function admitMemorySupersession(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemorySupersessionFields {
  let valid = [
    validateSchemaVersionLiteral(input, errors),
    validateMemoryIdString("supersession.oldMemoryId", input.oldMemoryId, errors),
    validateMemoryIdString("supersession.newMemoryId", input.newMemoryId, errors),
  ].every(Boolean);
  if (
    isNonEmptyTrimmedString(input.oldMemoryId) &&
    isNonEmptyTrimmedString(input.newMemoryId) &&
    input.oldMemoryId === input.newMemoryId
  ) {
    errors.push("supersession.oldMemoryId and supersession.newMemoryId must differ");
    valid = false;
  }
  valid = validateMemoryIdString("supersession.reviewerId", input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.supersededAt)) {
    errors.push("supersession.supersededAt must be a finite non-negative number");
    valid = false;
  }
  if (!isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("supersession.reason must be a bounded control-free non-empty string");
    valid = false;
  }
  if (input.edgeKind !== "supersedes") {
    errors.push('supersession.edgeKind must be the literal "supersedes"');
    valid = false;
  }
  return valid;
}

export function validateMemorySupersession(input: unknown): MemoryValidation<MemorySupersession> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["supersession must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemorySupersession(input, errors)) return { ok: false, errors };
  const fields: MemorySupersessionFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemorySupersession };
}

// ─── Pin / unpin / archive ────────────────────────────────────────────────────
function admitMemoryPinOrMemoryUnpin(
  input: Record<string, unknown>,
  noun: "pin" | "unpin",
  timestampField: "pinnedAt" | "unpinnedAt",
  errors: string[],
): input is Record<string, unknown> & MemoryPinOrMemoryUnpinFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString(`${noun}.memoryId`, input.memoryId, errors) && valid;
  valid = validateMemoryIdString(`${noun}.reviewerId`, input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input[timestampField])) {
    errors.push(`${noun}.${timestampField} must be a finite non-negative number`);
    valid = false;
  }
  if (input.reason !== undefined && !isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push(`${noun}.reason must be a bounded control-free string when set`);
    valid = false;
  }
  return valid;
}

function validatePinOrUnpinShape(
  noun: "pin",
  timestampField: "pinnedAt",
  input: unknown,
): MemoryValidation<MemoryPin>;
function validatePinOrUnpinShape(
  noun: "unpin",
  timestampField: "unpinnedAt",
  input: unknown,
): MemoryValidation<MemoryUnpin>;
function validatePinOrUnpinShape(
  noun: "pin" | "unpin",
  timestampField: "pinnedAt" | "unpinnedAt",
  input: unknown,
): MemoryValidation<MemoryPin | MemoryUnpin> {
  if (!isRecord(input)) {
    return { ok: false, errors: [`${noun} must be an object`] };
  }
  const errors: string[] = [];
  if (!admitMemoryPinOrMemoryUnpin(input, noun, timestampField, errors))
    return { ok: false, errors };
  const fields: MemoryPinOrMemoryUnpinFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryPin | MemoryUnpin };
}

export function validateMemoryPin(input: unknown): MemoryValidation<MemoryPin> {
  return validatePinOrUnpinShape("pin", "pinnedAt", input);
}

export function validateMemoryUnpin(input: unknown): MemoryValidation<MemoryUnpin> {
  return validatePinOrUnpinShape("unpin", "unpinnedAt", input);
}

function admitMemoryArchive(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryArchiveFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("archive.memoryId", input.memoryId, errors) && valid;
  valid = validateMemoryIdString("archive.reviewerId", input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.archivedAt)) {
    errors.push("archive.archivedAt must be a finite non-negative number");
    valid = false;
  }
  if (input.reason !== undefined && !isSafeText(input.reason, MEMORY_REASON_MAX_CHARS)) {
    errors.push("archive.reason must be a bounded control-free string when set");
    valid = false;
  }
  return valid;
}

export function validateMemoryArchive(input: unknown): MemoryValidation<MemoryArchive> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["archive must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryArchive(input, errors)) return { ok: false, errors };
  const fields: MemoryArchiveFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryArchive };
}

// ─── Forget ───────────────────────────────────────────────────────────────────
// The destructive-acknowledgement flag is pinned to the literal `true` at the type level,
// so structural success is also semantic acknowledgement: a caller cannot ship a forget
// envelope without explicit acknowledgement.
function admitMemoryForget(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & MemoryForgetFields {
  let valid = true;
  valid = validateSchemaVersionLiteral(input, errors) && valid;
  valid = validateMemoryIdString("forget.memoryId", input.memoryId, errors) && valid;
  valid = validateMemoryIdString("forget.reviewerId", input.reviewerId, errors) && valid;
  if (!isFiniteNonNegativeNumber(input.forgottenAt)) {
    errors.push("forget.forgottenAt must be a finite non-negative number");
    valid = false;
  }
  if (
    !isSafeText(input.reason, MEMORY_REASON_MAX_CHARS) ||
    !isMember(input.reason, MEMORY_FORGET_REASONS)
  ) {
    errors.push("forget.reason must be a supported content-free reason code");
    valid = false;
  }
  if (input.userAcknowledgedDestructive !== true) {
    errors.push("forget.userAcknowledgedDestructive must be the literal true");
    valid = false;
  }
  return valid;
}

export function validateMemoryForget(input: unknown): MemoryValidation<MemoryForget> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["forget must be an object"] };
  }
  const errors: string[] = [];
  if (!admitMemoryForget(input, errors)) return { ok: false, errors };
  const fields: MemoryForgetFields = input;
  // Only phantom ID brands remain; every non-brand field was concretely admitted above.
  return { ok: true, value: fields as MemoryForget };
}
