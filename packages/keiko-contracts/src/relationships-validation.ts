// Pure deterministic validator for the relationship-engine contracts (Epic #532,
// Issue #538).
//
// This module is pure: no IO, no clock reads, no crypto, no randomness, no module-level
// side effects. The validator returns a discriminated `{ ok: true; value } | { ok: false;
// errors }` so downstream code can branch without throwing. Error messages are short,
// machine-readable, deterministic — one per failed invariant — and deliberately omit
// cross-workspace identifiers so the validator itself never leaks the foreign id
// (denial-reasons.md §"Cross-cutting invariants" body-free rule; audit-events.md §8.3
// FORBIDDEN field "cross-workspace identifiers on denied/cross-workspace").
//
// Scope: this validator covers the codes the contract layer can decide given the
// proposal record plus an optional pure context. The following codes are deliberately
// NOT enforced here because they require resources the contract package does not own:
//
//   - `denied/path-not-contained`         — enforced by @oscharko-dev/keiko-workspace at
//                                            the API edge (assertContainedRealPath).
//   - `denied/denied-by-deny-list`        — enforced by the project deny-list resolver.
//   - `denied/authority-insufficient`     — enforced by the BFF authority gate.
//   - `denied/endpoint-tombstoned|retired|unavailable` — emitted by the endpoint resolver
//                                            and folded into our validation result via
//                                            ctx.endpointResolver. (We surface these
//                                            from the resolver; we do not detect them.)
//   - `denied/kind-incompatible`          — fires for `agent → evidence-run` after agent
//                                            lands; while agent is forward-looking the
//                                            validator returns `object-kind-not-yet-
//                                            supported` per compatibility-matrix.md §3.
//
// The pure helper `assertRelationshipTypeAllowsKinds` is exported for the API layer to
// re-run the kind compatibility step in isolation (e.g. when scanning bulk proposals).

import type {
  ObjectReference,
  Relationship,
  RelationshipDenialCode,
  RelationshipEndpointStatus,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
  RelationshipTypeDefinition,
  RelationshipValidationContext,
  RelationshipValidationError,
} from "./relationships.js";
import {
  RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS,
  RELATIONSHIP_LIFECYCLE_STATES,
  RELATIONSHIP_OBJECT_KINDS,
  RELATIONSHIP_SCHEMA_VERSION,
  RELATIONSHIP_SUPPORTED_OBJECT_KINDS,
  RELATIONSHIP_TYPE_DEFINITIONS,
  RELATIONSHIP_TYPES,
} from "./relationships.js";

// ─── Result types ─────────────────────────────────────────────────────────────
export interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly RelationshipValidationError[];
}

export type RelationshipValidation = ValidationOk<Relationship> | ValidationFail;

// ─── Lifecycle transition table ───────────────────────────────────────────────
// Encoded directly from lifecycle.md §2 ("Transition table"). Read as: from-state →
// set of legal next-states. `(no-op)` self-transitions are admitted (lifecycle.md §2).
const LIFECYCLE_TRANSITIONS: Readonly<
  Record<RelationshipLifecycleState, readonly RelationshipLifecycleState[]>
> = {
  draft: ["draft", "active", "archived", "superseded", "revoked", "blocked", "stale"],
  active: ["active", "archived", "superseded", "revoked", "stale"],
  archived: ["archived", "superseded", "revoked", "stale"],
  superseded: ["superseded", "stale"],
  revoked: ["revoked"],
  blocked: ["blocked", "draft", "active", "archived", "revoked", "stale"],
  stale: ["stale", "active", "archived", "superseded", "revoked"],
} as const;

// ─── Shared primitive guards ──────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function makeError(
  code: RelationshipDenialCode,
  message: string,
  field?: string,
): RelationshipValidationError {
  return field === undefined ? { code, message } : { code, field, message };
}

// ─── Endpoint structural validation ───────────────────────────────────────────
function validateEndpointShape(
  endpoint: unknown,
  field: string,
  errors: RelationshipValidationError[],
): endpoint is EndpointShape {
  if (!isRecord(endpoint)) {
    errors.push(makeError("denied/invalid-structure", `${field} must be an object`, field));
    return false;
  }
  if (!isNonEmptyString(endpoint.kind)) {
    errors.push(
      makeError(
        "denied/invalid-structure",
        `${field}.kind must be a non-empty string`,
        `${field}.kind`,
      ),
    );
    return false;
  }
  if (!isNonEmptyString(endpoint.id)) {
    errors.push(
      makeError(
        "denied/invalid-structure",
        `${field}.id must be a non-empty string`,
        `${field}.id`,
      ),
    );
    return false;
  }
  if (!isNonEmptyString(endpoint.workspaceId)) {
    errors.push(
      makeError(
        "denied/invalid-structure",
        `${field}.workspaceId must be a non-empty string`,
        `${field}.workspaceId`,
      ),
    );
    return false;
  }
  return true;
}

// ─── Structural prelude ───────────────────────────────────────────────────────
// Returns null if the input is structurally usable (i.e. the kind/type/lifecycle slots
// parse as the right primitive shape AND the top-level fields are present). On structural
// failure returns an errors array and the caller short-circuits — any further check
// would be meaningless (denial-reasons.md §"Resolution order" preface).
type EndpointShape = Pick<ObjectReference, "id" | "workspaceId"> & { readonly kind: string };
type RequiredFields = Pick<Relationship, "id" | "workspaceId" | "createdAt" | "updatedAt" | "etag">;
type StructuralRecord = Record<string, unknown> &
  RequiredFields & {
    readonly source: EndpointShape;
    readonly target: EndpointShape;
  };
type KnownRecord = StructuralRecord & Omit<Relationship, "metadata">;
interface StructuralInput {
  readonly record: StructuralRecord;
  readonly source: EndpointShape;
  readonly target: EndpointShape;
}
interface KnownInput {
  readonly record: KnownRecord;
  readonly source: ObjectReference;
  readonly target: ObjectReference;
}

function checkRequiredEtag(
  input: Record<string, unknown>,
  errors: RelationshipValidationError[],
): boolean {
  // Preserve the original finite-first and second-read negative comparison.
  if (!isFiniteInteger(input.etag) || input.etag < 0) {
    errors.push(
      makeError("denied/invalid-structure", "etag must be a non-negative finite integer", "etag"),
    );
    return false;
  }
  return true;
}

// Per-field check for the top-level required fields (storage.md §3.1). Pushed into
// `errors` retains each failed check; the predicate owns its substantive field checks.
function checkRequiredStringField(
  input: Record<string, unknown>,
  field: "id" | "workspaceId" | "createdAt" | "updatedAt",
  errors: RelationshipValidationError[],
): boolean {
  if (!isNonEmptyString(input[field])) {
    errors.push(
      makeError("denied/invalid-structure", `${field} must be a non-empty string`, field),
    );
    return false;
  }
  return true;
}

function checkRequiredTopLevelFields(
  input: Record<string, unknown>,
  errors: RelationshipValidationError[],
): input is Record<string, unknown> & RequiredFields {
  const id = checkRequiredStringField(input, "id", errors);
  const workspaceId = checkRequiredStringField(input, "workspaceId", errors);
  const createdAt = checkRequiredStringField(input, "createdAt", errors);
  const updatedAt = checkRequiredStringField(input, "updatedAt", errors);
  const etag = checkRequiredEtag(input, errors);
  return id && workspaceId && createdAt && updatedAt && etag;
}

function checkStructuralFields(
  input: Record<string, unknown>,
  errors: RelationshipValidationError[],
): input is StructuralRecord {
  const required = checkRequiredTopLevelFields(input, errors);
  const source = validateEndpointShape(input.source, "source", errors);
  const target = validateEndpointShape(input.target, "target", errors);
  return required && source && target;
}

function structuralPrelude(input: unknown): {
  readonly errors: readonly RelationshipValidationError[];
  readonly value?: StructuralInput;
} {
  if (!isRecord(input)) {
    return {
      errors: [makeError("denied/invalid-structure", "relationship must be an object")],
    };
  }
  const errors: RelationshipValidationError[] = [];
  if (!checkStructuralFields(input, errors)) {
    return { errors };
  }

  return {
    errors: [],
    value: {
      record: input,
      source: input.source,
      target: input.target,
    },
  };
}

// ─── Schema-version check ─────────────────────────────────────────────────────
function checkSchemaVersion(
  record: StructuralRecord,
  errors: RelationshipValidationError[],
): record is StructuralRecord & Pick<Relationship, "schemaVersion"> {
  if (record.schemaVersion !== RELATIONSHIP_SCHEMA_VERSION) {
    errors.push(
      makeError(
        "denied/schema-version-unsupported",
        `schemaVersion must be the literal "${RELATIONSHIP_SCHEMA_VERSION}"`,
        "schemaVersion",
      ),
    );
    return false;
  }
  return true;
}

// ─── Unknown enum checks ──────────────────────────────────────────────────────
function checkKindIsKnown(
  endpoint: EndpointShape,
  field: string,
  errors: RelationshipValidationError[],
): endpoint is ObjectReference {
  const kind = endpoint.kind;
  const knownKinds: readonly string[] = RELATIONSHIP_OBJECT_KINDS;
  if (!knownKinds.includes(kind)) {
    errors.push(
      makeError(
        "denied/invalid-structure",
        `${field}.kind is not a known object kind`,
        `${field}.kind`,
      ),
    );
    return false;
  }
  return true;
}

function checkTypeIsKnown(
  record: StructuralRecord,
  errors: RelationshipValidationError[],
): record is StructuralRecord & Pick<Relationship, "type"> {
  const type = record.type;
  if (!isNonEmptyString(type)) {
    errors.push(makeError("denied/invalid-structure", "type must be a non-empty string", "type"));
    return false;
  }
  const knownTypes: readonly string[] = RELATIONSHIP_TYPES;
  if (!knownTypes.includes(type)) {
    errors.push(
      makeError("denied/invalid-structure", "type is not a known relationship type", "type"),
    );
    return false;
  }
  return true;
}

function checkLifecycleIsKnown(
  record: StructuralRecord,
  errors: RelationshipValidationError[],
): record is StructuralRecord & Pick<Relationship, "lifecycleState"> {
  const state = record.lifecycleState;
  if (!isNonEmptyString(state)) {
    errors.push(
      makeError(
        "denied/invalid-structure",
        "lifecycleState must be a non-empty string",
        "lifecycleState",
      ),
    );
    return false;
  }
  const knownStates: readonly string[] = RELATIONSHIP_LIFECYCLE_STATES;
  if (!knownStates.includes(state)) {
    errors.push(
      makeError(
        "denied/invalid-structure",
        "lifecycleState is not a known lifecycle state",
        "lifecycleState",
      ),
    );
    return false;
  }
  return true;
}

// ─── Endpoint-liveness folding (resolver-supplied) ────────────────────────────
function appendResolverError(
  side: "source" | "target",
  status: RelationshipEndpointStatus,
  errors: RelationshipValidationError[],
): void {
  if (status === "missing") {
    errors.push(
      makeError(
        side === "source" ? "denied/non-existent-source" : "denied/non-existent-target",
        `${side} endpoint does not exist`,
        side,
      ),
    );
    return;
  }
  if (status === "tombstoned") {
    errors.push(
      makeError("denied/endpoint-tombstoned", `${side} endpoint has been tombstoned`, side),
    );
    return;
  }
  if (status === "retired") {
    errors.push(makeError("denied/endpoint-retired", `${side} endpoint has been retired`, side));
    return;
  }
  if (status === "unavailable") {
    errors.push(makeError("denied/endpoint-unavailable", `${side} endpoint is unavailable`, side));
  }
  // "live" → nothing to append.
}

// ─── Forward-looking kind check ───────────────────────────────────────────────
function checkObjectKindSupported(
  endpoint: ObjectReference,
  field: string,
): RelationshipValidationError | null {
  const kind = endpoint.kind;
  const supportedKinds: readonly string[] = RELATIONSHIP_SUPPORTED_OBJECT_KINDS;
  if (!supportedKinds.includes(kind)) {
    return makeError(
      "denied/object-kind-not-yet-supported",
      `${field}.kind "${kind}" is reserved for a future release`,
      `${field}.kind`,
    );
  }
  return null;
}

// ─── Kind compatibility (validSourceKinds / validTargetKinds) ─────────────────
// Pure helper exported so the API layer can re-run the kind compatibility step in
// isolation when scanning bulk proposals. Returns the FIRST applicable denial code
// (per the resolution order: source check before target check) or `null` when both
// kinds are admissible for the relationship type.
export function assertRelationshipTypeAllowsKinds(
  type: RelationshipType,
  sourceKind: RelationshipObjectKind,
  targetKind: RelationshipObjectKind,
): RelationshipDenialCode | null {
  // `type: RelationshipType` is a closed key set of RELATIONSHIP_TYPE_DEFINITIONS, so
  // the indexed access is always defined — no need to widen / null-check.
  const def: RelationshipTypeDefinition = RELATIONSHIP_TYPE_DEFINITIONS[type];
  if (!def.validSourceKinds.includes(sourceKind)) {
    return "denied/source-kind-not-allowed";
  }
  if (!def.validTargetKinds.includes(targetKind)) {
    return "denied/target-kind-not-allowed";
  }
  return null;
}

// ─── Cardinality (context-gated) ──────────────────────────────────────────────
function checkCardinality(
  type: RelationshipType,
  ctx: RelationshipValidationContext | undefined,
): RelationshipValidationError | null {
  const counts = ctx?.cardinalityCounts;
  if (!counts) {
    return null;
  }
  if (type === "produces-evidence") {
    // 1:1 on the source side: at most one produces-evidence per source workflow-run.
    if (
      typeof counts.producesEvidenceForSource === "number" &&
      counts.producesEvidenceForSource >= 1
    ) {
      return makeError(
        "denied/cardinality-exceeded",
        "produces-evidence already exists for this source workflow-run",
      );
    }
  }
  if (type === "starts-workflow") {
    // 1:1 on the target side: each run has exactly one origin.
    if (typeof counts.startsWorkflowForTarget === "number" && counts.startsWorkflowForTarget >= 1) {
      return makeError(
        "denied/cardinality-exceeded",
        "starts-workflow already exists for this target workflow-run",
      );
    }
  }
  return null;
}

// ─── Cycle / self-edge ────────────────────────────────────────────────────────
// The validator detects the O(1) cases (self-loop). Transitive-closure cycle detection
// is deferred to issue #542's impact-analysis traversal (denial-reasons.md
// `denied/cycle-forbidden`).
function checkSelfEdge(
  source: ObjectReference,
  target: ObjectReference,
): RelationshipValidationError | null {
  if (source.kind === target.kind && source.id === target.id) {
    return makeError("denied/cycle-forbidden", "source and target refer to the same endpoint");
  }
  return null;
}

function checkDirectDependsOnReverseEdge(
  type: RelationshipType,
  ctx: RelationshipValidationContext | undefined,
): RelationshipValidationError | null {
  if (type === "depends-on" && ctx?.dependsOnReverseEdgeExists === true) {
    return makeError(
      "denied/cycle-forbidden",
      "depends-on reverse edge already exists for this endpoint pair",
    );
  }
  return null;
}

// ─── Cross-workspace ──────────────────────────────────────────────────────────
// The error message NEVER echoes the foreign workspace id: audit-events.md §8.3 lists
// `proposedSourceId` / `proposedTargetId` / cross-workspace identifiers as FORBIDDEN.
function checkCrossWorkspace(
  workspaceId: string,
  source: ObjectReference,
  target: ObjectReference,
): RelationshipValidationError | null {
  if (source.workspaceId !== workspaceId || target.workspaceId !== workspaceId) {
    return makeError(
      "denied/cross-workspace",
      "source and target must be in the relationship's workspace",
    );
  }
  return null;
}

// ─── Lifecycle transition (context-gated) ─────────────────────────────────────
function checkLifecycleTransition(
  lifecycleState: RelationshipLifecycleState,
  ctx: RelationshipValidationContext | undefined,
): RelationshipValidationError | null {
  const previous = ctx?.previousLifecycleState;
  if (previous === undefined) {
    return null;
  }
  const allowed = LIFECYCLE_TRANSITIONS[previous];
  if (!allowed.includes(lifecycleState)) {
    return makeError(
      "denied/lifecycle-illegal-transition",
      `transition from ${previous} to ${lifecycleState} is not permitted`,
      "lifecycleState",
    );
  }
  return null;
}

// ─── Forbidden metadata keys ──────────────────────────────────────────────────
function checkForbiddenMetadata(
  record: KnownRecord,
  errors: RelationshipValidationError[],
): record is KnownRecord & Pick<Relationship, "metadata"> {
  if (record.metadata === undefined || record.metadata === null) {
    return true;
  }
  if (!isRecord(record.metadata)) {
    errors.push(
      makeError(
        "denied/payload-content-not-permitted",
        "metadata must be an object when set",
        "metadata",
      ),
    );
    return false;
  }
  for (const key of Object.keys(record.metadata)) {
    // Lowercase + strip non-alphanumerics so "API_KEY", "api-key", "apiKey", and
    // "api.key" all collapse to "apikey" — catching the common variants of forbidden
    // payload-key names with one substring check per banned token.
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const banned of RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS) {
      if (normalized.includes(banned)) {
        errors.push(
          makeError(
            "denied/payload-content-not-permitted",
            "metadata may not carry endpoint content",
            `metadata.${key}`,
          ),
        );
        break;
      }
    }
  }
  return true;
}

// ─── Driver ───────────────────────────────────────────────────────────────────
// Pure: same input → same output. Each check is implemented as a small helper above so
// the resolution order is visible at the call site below; reordering the calls REORDERS
// the resolution order, which is the explicit normative contract.
// Short-circuit checks that must pass before the accumulating phase runs. Returns either
// false with the first blocking errors, or a substantive typed success when the record is
// structurally usable for the kind compatibility / cardinality / lifecycle / metadata
// checks. The order pins resolution-order steps 1–4 (schema, type, kind-known,
// lifecycle-known) so subsequent helpers can safely index by `type` / `kind` /
// `lifecycleState`.
function runShortCircuitChecks(
  input: StructuralInput,
  errors: RelationshipValidationError[],
): input is KnownInput {
  const { record, source, target } = input;
  if (!checkSchemaVersion(record, errors)) return false;
  if (!checkTypeIsKnown(record, errors)) return false;
  const sourceKnown = checkKindIsKnown(source, "source", errors);
  const targetKnown = checkKindIsKnown(target, "target", errors);
  if (!sourceKnown || !targetKnown) return false;
  return checkLifecycleIsKnown(record, errors);
}

// Accumulates kind-compatibility errors for the resolution-order 4 + 5 slots, AFTER
// the forward-looking kind check (resolution-order 3). If a forward-looking error was
// already reported on either side, the kind-compatibility step is skipped — the
// validity sets index by RELATIONSHIP_TYPE_DEFINITIONS which only covers supported
// kinds; reporting both noise and signal would be misleading.
function appendKindCompatibilityErrors(
  type: RelationshipType,
  sourceRef: ObjectReference,
  targetRef: ObjectReference,
  errors: RelationshipValidationError[],
): void {
  const kindCode = assertRelationshipTypeAllowsKinds(type, sourceRef.kind, targetRef.kind);
  if (kindCode === "denied/source-kind-not-allowed") {
    errors.push(
      makeError(
        "denied/source-kind-not-allowed",
        `source.kind "${sourceRef.kind}" is not permitted for type "${type}"`,
        "source.kind",
      ),
    );
  } else if (kindCode === "denied/target-kind-not-allowed") {
    errors.push(
      makeError(
        "denied/target-kind-not-allowed",
        `target.kind "${targetRef.kind}" is not permitted for type "${type}"`,
        "target.kind",
      ),
    );
  }
}

function appendCycleErrors(
  type: RelationshipType,
  sourceRef: ObjectReference,
  targetRef: ObjectReference,
  ctx: RelationshipValidationContext | undefined,
  errors: RelationshipValidationError[],
): void {
  const selfEdge = checkSelfEdge(sourceRef, targetRef);
  if (selfEdge) errors.push(selfEdge);
  const reverseEdge = checkDirectDependsOnReverseEdge(type, ctx);
  if (reverseEdge) errors.push(reverseEdge);
}

// Runs every accumulating check in the resolution-order documented by
// denial-reasons.md. The helper is the seam between the short-circuit phase (above) and
// the per-step pure helpers (cardinality / cycle / cross-workspace / lifecycle /
// metadata).
function runAccumulatingChecks(
  record: KnownRecord,
  source: ObjectReference,
  target: ObjectReference,
  ctx: RelationshipValidationContext | undefined,
  errors: RelationshipValidationError[],
): record is KnownRecord & Pick<Relationship, "metadata"> {
  const type = record.type;
  const lifecycleState = record.lifecycleState;
  const sourceRef = source;
  const targetRef = target;

  // Resolution-order 3 — forward-looking kinds. Accumulates both sides.
  const sourceSupported = checkObjectKindSupported(source, "source");
  if (sourceSupported) errors.push(sourceSupported);
  const targetSupported = checkObjectKindSupported(target, "target");
  if (targetSupported) errors.push(targetSupported);

  // Resolution-order 4 + 5 — kind compatibility, skipped if a forward-looking error
  // fired on either side (see helper docstring).
  if (sourceSupported === null && targetSupported === null) {
    appendKindCompatibilityErrors(type, sourceRef, targetRef, errors);
  }

  // Resolution-order 7 — cardinality (context-gated).
  const cardinality = checkCardinality(type, ctx);
  if (cardinality) errors.push(cardinality);

  // Resolution-order 8 — O(1) self-loop.
  appendCycleErrors(type, sourceRef, targetRef, ctx, errors);

  // Resolution-order 9 — body-free cross-workspace.
  const cross = checkCrossWorkspace(record.workspaceId, sourceRef, targetRef);
  if (cross) errors.push(cross);

  // Resolution-order 12 — lifecycle transition (context-gated).
  const transition = checkLifecycleTransition(lifecycleState, ctx);
  if (transition) errors.push(transition);

  // Resolution-order 13-15 — deferred endpoint liveness from the resolver port. Missing
  // endpoints short-circuit earlier in `runResolverMissingCheck`.
  appendDeferredResolverErrors(ctx, errors);

  // Resolution-order 16 — forbidden metadata keys.
  return checkForbiddenMetadata(record, errors);
}

// Resolver-supplied identity codes (resolution-order 1 + 2). Returns the errors when
// the resolver reports any missing endpoint (caller short-circuits); empty array when
// ctx supplied an endpointResolver but both endpoints still exist; null when ctx omitted
// endpoint resolution entirely.
function runResolverMissingCheck(
  ctx: RelationshipValidationContext | undefined,
): readonly RelationshipValidationError[] | null {
  if (!ctx?.endpointResolver) return null;
  const errors: RelationshipValidationError[] = [];
  if (ctx.endpointResolver.source === "missing") {
    appendResolverError("source", ctx.endpointResolver.source, errors);
  }
  if (ctx.endpointResolver.target === "missing") {
    appendResolverError("target", ctx.endpointResolver.target, errors);
  }
  return errors;
}

function appendDeferredResolverErrors(
  ctx: RelationshipValidationContext | undefined,
  errors: RelationshipValidationError[],
): void {
  if (!ctx?.endpointResolver) return;
  if (ctx.endpointResolver.source !== "missing") {
    appendResolverError("source", ctx.endpointResolver.source, errors);
  }
  if (ctx.endpointResolver.target !== "missing") {
    appendResolverError("target", ctx.endpointResolver.target, errors);
  }
}

export function validateRelationship(
  input: unknown,
  ctx?: RelationshipValidationContext,
): RelationshipValidation {
  const prelude = structuralPrelude(input);
  if (!prelude.value) {
    return { ok: false, errors: prelude.errors };
  }
  const checked = prelude.value;
  const shortCircuit: RelationshipValidationError[] = [];
  if (!runShortCircuitChecks(checked, shortCircuit)) {
    return { ok: false, errors: shortCircuit };
  }
  const { record, source, target } = checked;

  // Resolver identity is the most-structural failure (denial-reasons.md "Resolution
  // order" 1 + 2). When the resolver reports any failure, short-circuit.
  const resolverErrors = runResolverMissingCheck(ctx);
  if (resolverErrors !== null && resolverErrors.length > 0) {
    return { ok: false, errors: resolverErrors };
  }

  const errors: RelationshipValidationError[] = [];
  const metadata = runAccumulatingChecks(record, source, target, ctx, errors);
  if (!metadata || errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: record };
}
