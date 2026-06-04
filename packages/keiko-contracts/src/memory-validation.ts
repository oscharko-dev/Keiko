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
// sibling module `memory-operations-validation.ts` to keep both files under the 400-LOC
// budget.

import type {
  MemoryEdge,
  MemoryProvenance,
  MemoryRecord,
  MemoryStructuredPayload,
  MemoryValidityInterval,
} from "./memory-records.js";
import type { MemoryScope, MemoryStatus } from "./memory.js";
import {
  MEMORY_EDGE_KINDS,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
} from "./memory.js";
import { MEMORY_STRUCTURED_PAYLOAD_KINDS } from "./memory-records.js";
import {
  FORBIDDEN_CONTROL_RE,
  MEMORY_RATIONALE_MAX_CHARS,
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
//             long contiguous digit runs (PAN/IBAN-shape).
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
  /\b\d{13,19}\b/,
];

export function looksLikeSecretShape(value: string): boolean {
  for (const re of SECRET_SHAPE_PATTERNS) {
    if (re.test(value)) {
      return true;
    }
  }
  return false;
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

// ─── Scope ────────────────────────────────────────────────────────────────────
// The validator checks that the coordinate field that MUST be present for the given kind
// is a non-empty string. Scope-CROSSING legality (i.e. "can a request at scope X read a
// record at scope Y") is an authorization decision belonging to downstream layers; this
// validator only proves the scope itself is well-formed.
function validateScopeCoordinate(input: Record<string, unknown>, errors: string[]): void {
  const kind = input.kind;
  if (kind === "global") {
    return;
  }
  if (kind === "user" && !isNonEmptyTrimmedString(input.userId)) {
    errors.push("scope.userId must be a non-empty string for kind=user");
  }
  if (kind === "workspace" && !isNonEmptyTrimmedString(input.workspaceId)) {
    errors.push("scope.workspaceId must be a non-empty string for kind=workspace");
  }
  if (kind === "project" && !isNonEmptyTrimmedString(input.projectId)) {
    errors.push("scope.projectId must be a non-empty string for kind=project");
  }
  if (kind === "workflow" && !isNonEmptyTrimmedString(input.workflowDefinitionId)) {
    errors.push("scope.workflowDefinitionId must be a non-empty string for kind=workflow");
  }
}

export function validateMemoryScope(input: unknown): MemoryValidation<MemoryScope> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["scope must be an object"] };
  }
  if (!isMember(input.kind, MEMORY_SCOPE_KINDS)) {
    return { ok: false, errors: [`scope.kind must be one of ${MEMORY_SCOPE_KINDS.join("|")}`] };
  }
  const errors: string[] = [];
  validateScopeCoordinate(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryScope };
}

// ─── Validity interval ────────────────────────────────────────────────────────
export function validateMemoryValidityInterval(
  input: unknown,
): MemoryValidation<MemoryValidityInterval> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["validity must be an object"] };
  }
  const errors: string[] = [];
  if (!isFiniteNonNegativeNumber(input.validFrom)) {
    errors.push("validity.validFrom must be a finite non-negative number");
  }
  if (input.validUntil !== undefined) {
    if (!isFiniteNonNegativeNumber(input.validUntil)) {
      errors.push("validity.validUntil must be a finite non-negative number when set");
    } else if (isFiniteNonNegativeNumber(input.validFrom) && input.validUntil < input.validFrom) {
      errors.push("validity.validUntil must be greater than or equal to validFrom");
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryValidityInterval };
}

// ─── Provenance ───────────────────────────────────────────────────────────────
function validateModelIdentity(input: Record<string, unknown>, errors: string[]): void {
  const identity = input.modelIdentity;
  if (identity === undefined) {
    return;
  }
  if (!isRecord(identity)) {
    errors.push("provenance.modelIdentity must be an object when set");
    return;
  }
  if (!isNonEmptyTrimmedString(identity.provider)) {
    errors.push("provenance.modelIdentity.provider must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(identity.modelId)) {
    errors.push("provenance.modelIdentity.modelId must be a non-empty string");
  }
  if (identity.modelRevision !== undefined && !isNonEmptyTrimmedString(identity.modelRevision)) {
    errors.push("provenance.modelIdentity.modelRevision must be a non-empty string when set");
  }
}

export function validateMemoryProvenance(input: unknown): MemoryValidation<MemoryProvenance> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["provenance must be an object"] };
  }
  const errors: string[] = [];
  if (!isMember(input.sourceKind, MEMORY_SOURCE_KINDS)) {
    errors.push(`provenance.sourceKind must be one of ${MEMORY_SOURCE_KINDS.join("|")}`);
  }
  validateOptionalReference("provenance.sourceConversationId", input.sourceConversationId, errors);
  validateOptionalReference("provenance.sourceWorkflowRunId", input.sourceWorkflowRunId, errors);
  validateOptionalReference(
    "provenance.sourceEvidenceManifestId",
    input.sourceEvidenceManifestId,
    errors,
  );
  if (!isFiniteNonNegativeNumber(input.capturedAt)) {
    errors.push("provenance.capturedAt must be a finite non-negative number");
  }
  validateModelIdentity(input, errors);
  if (!isUnitInterval(input.confidence)) {
    errors.push("provenance.confidence must be a finite number in [0, 1]");
  }
  if (!isMember(input.sensitivity, MEMORY_SENSITIVITIES)) {
    errors.push(`provenance.sensitivity must be one of ${MEMORY_SENSITIVITIES.join("|")}`);
  }
  if (
    input.captureRationale !== undefined &&
    !isSafeText(input.captureRationale, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("provenance.captureRationale must be a bounded control-free string when set");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryProvenance };
}

// ─── Structured payload ───────────────────────────────────────────────────────
function validateStringListPayload(input: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(input.items)) {
    errors.push("payload.items must be an array for kind=string-list");
    return;
  }
  for (const item of input.items) {
    if (typeof item !== "string" || item.length === 0 || FORBIDDEN_CONTROL_RE.test(item)) {
      errors.push("payload.items entry must be a non-empty control-free string");
      return;
    }
  }
}

function validateKeyValuePayload(input: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(input.entries)) {
    errors.push("payload.entries must be an array for kind=key-value");
    return;
  }
  for (const entry of input.entries) {
    if (
      !isRecord(entry) ||
      !isNonEmptyTrimmedString(entry.key) ||
      typeof entry.value !== "string" ||
      FORBIDDEN_CONTROL_RE.test(entry.value)
    ) {
      errors.push(
        "payload.entries entry must have a non-empty key and a control-free string value",
      );
      return;
    }
  }
}

export function validateMemoryStructuredPayload(
  input: unknown,
): MemoryValidation<MemoryStructuredPayload> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  if (!isMember(input.kind, MEMORY_STRUCTURED_PAYLOAD_KINDS)) {
    return {
      ok: false,
      errors: [`payload.kind must be one of ${MEMORY_STRUCTURED_PAYLOAD_KINDS.join("|")}`],
    };
  }
  const errors: string[] = [];
  if (input.kind === "string-list") {
    validateStringListPayload(input, errors);
  } else {
    validateKeyValuePayload(input, errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryStructuredPayload };
}

// ─── Edge ─────────────────────────────────────────────────────────────────────
function validateEdgeEndpoints(input: Record<string, unknown>, errors: string[]): void {
  if (!isNonEmptyTrimmedString(input.fromMemoryId)) {
    errors.push("edge.fromMemoryId must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(input.toMemoryId)) {
    errors.push("edge.toMemoryId must be a non-empty string");
  }
  if (
    isNonEmptyTrimmedString(input.fromMemoryId) &&
    isNonEmptyTrimmedString(input.toMemoryId) &&
    input.fromMemoryId === input.toMemoryId
  ) {
    errors.push("edge.fromMemoryId and edge.toMemoryId must differ");
  }
}

function validateEdgeOptionalFields(input: Record<string, unknown>, errors: string[]): void {
  if (input.confidence !== undefined && !isUnitInterval(input.confidence)) {
    errors.push("edge.confidence must be a finite number in [0, 1] when set");
  }
  if (
    input.provenanceSummary !== undefined &&
    !isSafeText(input.provenanceSummary, MEMORY_RATIONALE_MAX_CHARS)
  ) {
    errors.push("edge.provenanceSummary must be a bounded control-free string when set");
  }
}

export function validateMemoryEdge(input: unknown): MemoryValidation<MemoryEdge> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["edge must be an object"] };
  }
  const errors: string[] = [];
  if (input.schemaVersion !== "1") {
    errors.push('edge.schemaVersion must be the literal "1"');
  }
  if (!isNonEmptyTrimmedString(input.id)) {
    errors.push("edge.id must be a non-empty string");
  }
  validateEdgeEndpoints(input, errors);
  if (!isMember(input.kind, MEMORY_EDGE_KINDS)) {
    errors.push(`edge.kind must be one of ${MEMORY_EDGE_KINDS.join("|")}`);
  }
  if (!isFiniteNonNegativeNumber(input.createdAt)) {
    errors.push("edge.createdAt must be a finite non-negative number");
  }
  validateEdgeOptionalFields(input, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as MemoryEdge };
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
