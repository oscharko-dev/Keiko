// Pure validators for the Governed Enterprise Memory Vault contracts (Epic #204, Issue
// #205). No filesystem, no clock, no crypto, no randomness — every helper inspects the
// structure of an `unknown` payload and reports which invariants failed. Producers and
// consumers wire these at trust-boundary edges (BFF, audit, capture, retrieval).
//
// Result envelopes follow the local-knowledge convention: a discriminated
// `{ ok: true; value } | { ok: false; errors }` so branches stay throw-free. Errors are
// short, machine-readable strings — one per failed invariant — for deterministic
// evaluation-harness diffs.
//
// Operation envelope validators (proposal/acceptance/rejection/update/etc.) live in the
// sibling module `memory-operations-validation.ts` to keep operation-specific checks separate.

import type {
  MemoryEdge,
  MemoryProvenance,
  MemoryRecord,
  MemoryStructuredPayload,
  MemoryValidityInterval,
} from "./memory-records.js";
import type { MemoryScope, MemoryStatus } from "./memory-contracts.js";
import {
  MEMORY_EDGE_KINDS,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
} from "./memory-contracts.js";
import { MEMORY_STRUCTURED_PAYLOAD_KINDS } from "./memory-records.js";
import {
  FORBIDDEN_CONTROL_RE,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_RATIONALE_MAX_CHARS,
  MEMORY_STRUCTURED_PAYLOAD_MAX_ENTRIES,
  MEMORY_TAG_MAX_CHARS,
  isFiniteNonNegativeNumber,
  isMember,
  isNonEmptyTrimmedString,
  isRecord,
  isSafeText,
  isUnitInterval,
  validateOptionalReference,
} from "./memory-internal.js";

// ─── Result types ─────────────────────────────────────────────────────────────
export interface MemoryValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
export interface MemoryValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type MemoryValidation<T> = MemoryValidationOk<T> | MemoryValidationFail;

// ─── Unsafe-content heuristics (secret-shape only, no allow/block list) ──────
// Audit-record defence-in-depth: rejects credential-shaped strings on the AUDIT SUMMARY
// path (validateMemoryAuditRecord). The PRIMARY secret-prevention gate is the capture
// layer (#207), which scans candidate memory body/payload before construction. This
// helper is intentionally NOT applied to record.body or proposal.body — body scanning is
// owned end-to-end by the capture layer so callers cannot route around the policy by
// constructing records directly. Shape-based: we test the SHAPE of the string, not a
// list of providers, so the heuristic stays useful across vendor changes.
//
// Pattern coverage — intentionally narrow (high precision over high recall):
//   COVERED:  sk- (OpenAI-style), AKIA (AWS), gh[pousr]_ (GitHub tokens),
//             xox[abporsu]- (Slack), three-part JWTs, PEM private keys,
//             long contiguous digit runs that resemble a payment-card PAN.
//   EXCLUDED: opaque "Bearer <token>" (catches only JWT-encoded bearers),
//             URL-embedded credentials (https://user:pass@host),
//             generic password=, secret=, key= form-encoded values.
//             These classes are intentionally deferred to the capture layer
//             (#207), where context-aware redaction can avoid false positives
//             on legitimate non-secret strings.
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abporsu]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const PAN_SHAPE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function passesLuhn(value: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// Exported so the capture layer's write-time scanner composes THIS detector instead of carrying a
// second, naive digit-run regex: two independent "parity" implementations drifted apart once
// already (GEN-DUP-DUPLICATION-004), and the primary boundary ended up weaker than the audit-time
// check it claimed to match.
export function hasPaymentCardPanShape(value: string): boolean {
  for (const match of value.matchAll(PAN_SHAPE_RE)) {
    const candidate = match[0].replaceAll(/[ -]/g, "");
    if (candidate.length >= 13 && candidate.length <= 19 && passesLuhn(candidate)) {
      return true;
    }
  }
  return false;
}

export function looksLikeSecretShape(value: string): boolean {
  for (const re of SECRET_SHAPE_PATTERNS) {
    if (re.test(value)) {
      return true;
    }
  }
  return hasPaymentCardPanShape(value);
}

// ─── Status transition legality ───────────────────────────────────────────────
// Pure: reads only the static `MEMORY_STATUS_TRANSITIONS` table. The error explains both
// the from-state and the attempted to-state so a UI surface can render a precise message.
export interface StatusTransitionCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

export function checkStatusTransition(from: MemoryStatus, to: MemoryStatus): StatusTransitionCheck {
  if (!isMember(from, MEMORY_STATUSES)) {
    return { ok: false, reason: `unknown from-status: ${String(from)}` };
  }
  if (!isMember(to, MEMORY_STATUSES)) {
    return { ok: false, reason: `unknown to-status: ${String(to)}` };
  }
  if (from === to) {
    return { ok: false, reason: `no-op transition: ${from} → ${to}` };
  }
  const allowed = MEMORY_STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal transition: ${from} → ${to}` };
  }
  return { ok: true };
}

interface MemoryObservationDiagnostics {
  errors: string[];
}

// ─── Scope ────────────────────────────────────────────────────────────────────
// The validator checks that the coordinate field that MUST be present for the given kind
// is a non-empty string. Scope-CROSSING legality (i.e. "can a request at scope X read a
// record at scope Y") is an authorization decision belonging to downstream layers; this
// validator only proves the scope itself is well-formed.
function validateScopeCoordinate(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  const kind = input.kind;
  if (kind === "global") {
    return true;
  }
  if (kind === "user" && !isNonEmptyTrimmedString(input.userId)) {
    errors.push("scope.userId must be a non-empty string for kind=user");
    valid = false;
  }
  if (kind === "workspace" && !isNonEmptyTrimmedString(input.workspaceId)) {
    errors.push("scope.workspaceId must be a non-empty string for kind=workspace");
    valid = false;
  }
  if (kind === "project" && !isNonEmptyTrimmedString(input.projectId)) {
    errors.push("scope.projectId must be a non-empty string for kind=project");
    valid = false;
  }
  if (kind === "workflow" && !isNonEmptyTrimmedString(input.workflowDefinitionId)) {
    errors.push("scope.workflowDefinitionId must be a non-empty string for kind=workflow");
    valid = false;
  }
  return valid;
}

function observeMemoryScope(
  input: unknown,
  diagnostics: MemoryObservationDiagnostics,
): input is MemoryScope {
  if (!isRecord(input)) {
    diagnostics.errors = ["scope must be an object"];
    return false;
  }
  if (!isMember(input.kind, MEMORY_SCOPE_KINDS)) {
    diagnostics.errors = [`scope.kind must be one of ${MEMORY_SCOPE_KINDS.join("|")}`];
    return false;
  }
  const errors = diagnostics.errors;
  return validateScopeCoordinate(input, errors);
}

export function validateMemoryScope(input: unknown): MemoryValidation<MemoryScope> {
  const diagnostics: MemoryObservationDiagnostics = { errors: [] };
  if (!observeMemoryScope(input, diagnostics)) {
    return { ok: false, errors: diagnostics.errors };
  }
  return { ok: true, value: input };
}

// ─── Validity interval ────────────────────────────────────────────────────────
function observeMemoryValidityInterval(
  input: unknown,
  diagnostics: MemoryObservationDiagnostics,
): input is MemoryValidityInterval {
  if (!isRecord(input)) {
    diagnostics.errors = ["validity must be an object"];
    return false;
  }
  const errors = diagnostics.errors;
  let valid = true;
  if (!isFiniteNonNegativeNumber(input.validFrom)) {
    errors.push("validity.validFrom must be a finite non-negative number");
    valid = false;
  }
  if (input.validUntil !== undefined) {
    if (!isFiniteNonNegativeNumber(input.validUntil)) {
      errors.push("validity.validUntil must be a finite non-negative number when set");
      valid = false;
    } else if (isFiniteNonNegativeNumber(input.validFrom) && input.validUntil < input.validFrom) {
      errors.push("validity.validUntil must be greater than or equal to validFrom");
      valid = false;
    }
  }
  return valid;
}

export function validateMemoryValidityInterval(
  input: unknown,
): MemoryValidation<MemoryValidityInterval> {
  const diagnostics: MemoryObservationDiagnostics = { errors: [] };
  if (!observeMemoryValidityInterval(input, diagnostics)) {
    return { ok: false, errors: diagnostics.errors };
  }
  return { ok: true, value: input };
}

// ─── Provenance ───────────────────────────────────────────────────────────────
function validateModelIdentity(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  const identity = input.modelIdentity;
  if (identity === undefined) {
    return true;
  }
  if (!isRecord(identity)) {
    errors.push("provenance.modelIdentity must be an object when set");
    return false;
  }
  if (!isNonEmptyTrimmedString(identity.provider)) {
    errors.push("provenance.modelIdentity.provider must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyTrimmedString(identity.modelId)) {
    errors.push("provenance.modelIdentity.modelId must be a non-empty string");
    valid = false;
  }
  if (identity.modelRevision !== undefined && !isNonEmptyTrimmedString(identity.modelRevision)) {
    errors.push("provenance.modelIdentity.modelRevision must be a non-empty string when set");
    valid = false;
  }
  return valid;
}

function validateProvenanceRationale(input: Record<string, unknown>, errors: string[]): boolean {
  if (
    input.captureRationale !== undefined &&
    !isSafeText(input.captureRationale, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("provenance.captureRationale must be a bounded control-free string when set");
    return false;
  }
  return true;
}

function validateProvenanceReferences(input: Record<string, unknown>, errors: string[]): boolean {
  const conversationOk = validateOptionalReference(
    "provenance.sourceConversationId",
    input.sourceConversationId,
    errors,
  );
  const workflowOk = validateOptionalReference(
    "provenance.sourceWorkflowRunId",
    input.sourceWorkflowRunId,
    errors,
  );
  const evidenceOk = validateOptionalReference(
    "provenance.sourceEvidenceManifestId",
    input.sourceEvidenceManifestId,
    errors,
  );
  return conversationOk && workflowOk && evidenceOk;
}

function observeMemoryProvenance(
  input: unknown,
  diagnostics: MemoryObservationDiagnostics,
): input is MemoryProvenance {
  if (!isRecord(input)) {
    diagnostics.errors = ["provenance must be an object"];
    return false;
  }
  const errors = diagnostics.errors;
  let valid = true;
  if (!isMember(input.sourceKind, MEMORY_SOURCE_KINDS)) {
    errors.push(`provenance.sourceKind must be one of ${MEMORY_SOURCE_KINDS.join("|")}`);
    valid = false;
  }
  const referencesOk = validateProvenanceReferences(input, errors);
  if (!isFiniteNonNegativeNumber(input.capturedAt)) {
    errors.push("provenance.capturedAt must be a finite non-negative number");
    valid = false;
  }
  const modelOk = validateModelIdentity(input, errors);
  if (!isUnitInterval(input.confidence)) {
    errors.push("provenance.confidence must be a finite number in [0, 1]");
    valid = false;
  }
  if (!isMember(input.sensitivity, MEMORY_SENSITIVITIES)) {
    errors.push(`provenance.sensitivity must be one of ${MEMORY_SENSITIVITIES.join("|")}`);
    valid = false;
  }
  const rationaleOk = validateProvenanceRationale(input, errors);
  return valid && referencesOk && modelOk && rationaleOk;
}

export function validateMemoryProvenance(input: unknown): MemoryValidation<MemoryProvenance> {
  const diagnostics: MemoryObservationDiagnostics = { errors: [] };
  if (!observeMemoryProvenance(input, diagnostics)) {
    return { ok: false, errors: diagnostics.errors };
  }
  return { ok: true, value: input };
}

// ─── Structured payload ───────────────────────────────────────────────────────
function validateStringListPayload(input: Record<string, unknown>, errors: string[]): boolean {
  if (!Array.isArray(input.items)) {
    errors.push("payload.items must be an array for kind=string-list");
    return false;
  }
  if (input.items.length > MEMORY_STRUCTURED_PAYLOAD_MAX_ENTRIES) {
    errors.push("payload.items exceeds the maximum entry count");
    return false;
  }
  for (const item of input.items) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > MEMORY_BODY_MAX_CHARS ||
      FORBIDDEN_CONTROL_RE.test(item)
    ) {
      errors.push("payload.items entry must be a non-empty bounded control-free string");
      return false;
    }
  }
  return true;
}

function isValidKeyValuePayloadEntry(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    isNonEmptyTrimmedString(entry.key) &&
    entry.key.length <= MEMORY_TAG_MAX_CHARS &&
    !FORBIDDEN_CONTROL_RE.test(entry.key) &&
    typeof entry.value === "string" &&
    entry.value.length <= MEMORY_BODY_MAX_CHARS &&
    !FORBIDDEN_CONTROL_RE.test(entry.value)
  );
}

function validateKeyValuePayload(input: Record<string, unknown>, errors: string[]): boolean {
  if (!Array.isArray(input.entries)) {
    errors.push("payload.entries must be an array for kind=key-value");
    return false;
  }
  if (input.entries.length > MEMORY_STRUCTURED_PAYLOAD_MAX_ENTRIES) {
    errors.push("payload.entries exceeds the maximum entry count");
    return false;
  }
  for (const entry of input.entries) {
    if (!isValidKeyValuePayloadEntry(entry)) {
      errors.push("payload.entries entry must have a bounded control-free key and string value");
      return false;
    }
  }
  return true;
}

function observeMemoryStructuredPayload(
  input: unknown,
  diagnostics: MemoryObservationDiagnostics,
): input is MemoryStructuredPayload {
  if (!isRecord(input)) {
    diagnostics.errors = ["payload must be an object"];
    return false;
  }
  if (!isMember(input.kind, MEMORY_STRUCTURED_PAYLOAD_KINDS)) {
    diagnostics.errors = [
      `payload.kind must be one of ${MEMORY_STRUCTURED_PAYLOAD_KINDS.join("|")}`,
    ];
    return false;
  }
  const errors = diagnostics.errors;
  if (input.kind === "string-list") {
    return validateStringListPayload(input, errors);
  }
  return validateKeyValuePayload(input, errors);
}

export function validateMemoryStructuredPayload(
  input: unknown,
): MemoryValidation<MemoryStructuredPayload> {
  const diagnostics: MemoryObservationDiagnostics = { errors: [] };
  if (!observeMemoryStructuredPayload(input, diagnostics)) {
    return { ok: false, errors: diagnostics.errors };
  }
  return { ok: true, value: input };
}

// ─── Edge ─────────────────────────────────────────────────────────────────────
function validateEdgeEndpoints(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isNonEmptyTrimmedString(input.fromMemoryId)) {
    errors.push("edge.fromMemoryId must be a non-empty string");
    valid = false;
  }
  if (!isNonEmptyTrimmedString(input.toMemoryId)) {
    errors.push("edge.toMemoryId must be a non-empty string");
    valid = false;
  }
  if (
    isNonEmptyTrimmedString(input.fromMemoryId) &&
    isNonEmptyTrimmedString(input.toMemoryId) &&
    input.fromMemoryId === input.toMemoryId
  ) {
    errors.push("edge.fromMemoryId and edge.toMemoryId must differ");
    valid = false;
  }
  return valid;
}

function validateEdgeOptionalFields(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.confidence !== undefined && !isUnitInterval(input.confidence)) {
    errors.push("edge.confidence must be a finite number in [0, 1] when set");
    valid = false;
  }
  if (
    input.provenanceSummary !== undefined &&
    !isSafeText(input.provenanceSummary, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("edge.provenanceSummary must be a bounded control-free string when set");
    valid = false;
  }
  return valid;
}

function observeMemoryEdge(
  input: unknown,
  diagnostics: MemoryObservationDiagnostics,
): input is MemoryEdge {
  if (!isRecord(input)) {
    diagnostics.errors = ["edge must be an object"];
    return false;
  }
  const errors = diagnostics.errors;
  let valid = true;
  if (input.schemaVersion !== "1") {
    errors.push('edge.schemaVersion must be the literal "1"');
    valid = false;
  }
  if (!isNonEmptyTrimmedString(input.id)) {
    errors.push("edge.id must be a non-empty string");
    valid = false;
  }
  const endpointsOk = validateEdgeEndpoints(input, errors);
  if (!isMember(input.kind, MEMORY_EDGE_KINDS)) {
    errors.push(`edge.kind must be one of ${MEMORY_EDGE_KINDS.join("|")}`);
    valid = false;
  }
  if (!isFiniteNonNegativeNumber(input.createdAt)) {
    errors.push("edge.createdAt must be a finite non-negative number");
    valid = false;
  }
  const optionalOk = validateEdgeOptionalFields(input, errors);
  return valid && endpointsOk && optionalOk;
}

export function validateMemoryEdge(input: unknown): MemoryValidation<MemoryEdge> {
  const diagnostics: MemoryObservationDiagnostics = { errors: [] };
  if (!observeMemoryEdge(input, diagnostics)) {
    return { ok: false, errors: diagnostics.errors };
  }
  return { ok: true, value: input };
}

// ─── Stale model metadata heuristic ───────────────────────────────────────────
// Returns true when a record's model identity differs from the currently-active model
// identity for the same provider. The retrieval layer (#210) consults this to
// deprioritize records whose authoring model has been replaced. Pure: no clock, no env.
export interface StaleModelMetadataInput {
  readonly record: Pick<MemoryRecord, "provenance">;
  readonly activeIdentitiesByProvider: ReadonlyMap<
    string,
    { readonly modelId: string; readonly modelRevision?: string }
  >;
}

export function hasStaleModelMetadata(input: StaleModelMetadataInput): boolean {
  const identity = input.record.provenance.modelIdentity;
  if (identity === undefined) {
    return false;
  }
  const active = input.activeIdentitiesByProvider.get(identity.provider);
  if (active === undefined) {
    return true;
  }
  if (active.modelId !== identity.modelId) {
    return true;
  }
  if (
    identity.modelRevision !== undefined &&
    active.modelRevision !== undefined &&
    identity.modelRevision !== active.modelRevision
  ) {
    return true;
  }
  return false;
}
