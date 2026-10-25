// Pure validators for the Local Knowledge Connector contracts (Epic #189, Issue #191).
// No filesystem reads, no clock reads, no crypto, no randomness; these helpers only inspect
// the structure of an `unknown` payload and report which invariants failed. Producers and
// consumers wire these at trust-boundary edges (BFF, audit, indexer entry points).
//
// Each validator returns a discriminated `{ ok: true; value } | { ok: false; errors }` so
// downstream code can branch without throwing. Errors are short, machine-readable strings,
// one per failed invariant, to keep diagnostics deterministic for evaluation harnesses.

import {
  isCapturedExtent,
  isRecord,
  validateStableExtent,
  validateStableArrayMembers,
} from "./contract-validation-primitives.js";
import type {
  CapsuleContextualRetrievalSettings,
  CapsuleSet,
  ConnectorGraphState,
  ConnectorNode,
  EmbeddingModelIdentity,
  KnowledgeCapsule,
  KnowledgeSourceScope,
} from "./local-knowledge.js";
import { validateKnowledgePodModelUsePolicy } from "./local-knowledge-model-use-policy.js";
import type { CapsuleReindexRequest } from "./local-knowledge-records.js";
import {
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CAPSULE_CONTEXTUAL_RETRIEVAL_DOCUMENT_CONTEXT_MAX_CHARS_MAX,
  CAPSULE_CONTEXTUAL_RETRIEVAL_MAX_CONTEXT_CHARS_MAX,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_METADATA_KEY_MAX_CHARS,
  CAPSULE_METADATA_MAX_KEYS,
  CAPSULE_METADATA_VALUE_MAX_CHARS,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CONNECTOR_NODE_KINDS,
  EMBEDDING_VECTOR_NORMALIZATIONS,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
} from "./local-knowledge.js";
import { CAPSULE_REINDEX_MODES } from "./local-knowledge-records.js";
import { isSafeScopePath, isSafeStorageReference } from "./local-knowledge-paths.js";

// ─── Result types ─────────────────────────────────────────────────────────────
export interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type LocalKnowledgeValidation<T> = ValidationOk<T> | ValidationFail;

// ─── Shared primitive guards ──────────────────────────────────────────────────
type CapsuleStructure = Omit<KnowledgeCapsule, "id" | "sourceIds"> & {
  readonly id: string;
  readonly sourceIds: readonly string[];
};
type CapsuleSetStructure = Omit<CapsuleSet, "id" | "capsuleIds"> & {
  readonly id: string;
  readonly capsuleIds: readonly string[];
};
type ReindexStructure = Omit<CapsuleReindexRequest, "capsuleId"> & { readonly capsuleId: string };
type GraphNodeStructure =
  | Exclude<ConnectorNode, { readonly kind: "local-knowledge" }>
  | {
      readonly kind: "local-knowledge";
      readonly nodeId: string;
      readonly target:
        | { readonly kind: "capsule"; readonly capsuleId: string }
        | { readonly kind: "capsule-set"; readonly capsuleSetId: string };
    };
type GraphStructure = Omit<ConnectorGraphState, "nodes"> & {
  readonly nodes: readonly GraphNodeStructure[];
};

function combineAdmissions(previous: boolean, current: boolean): boolean {
  return previous && current;
}

// A refusal records the original diagnostic and actual failed field evidence.
function reject(errors: string[], ...reasons: string[]): false {
  errors.push(...reasons);
  return false;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const extent = value.length;
  if (!isCapturedExtent(extent)) return false;
  for (let index = 0; index < extent; index += 1) {
    if (typeof value[index] !== "string") return false;
  }
  return value.length === extent;
}

// Soft-cap chosen to keep browser surfaces safe (matches the upper bound a Conversation
// Center summary card will render without truncation). NUL and the ASCII control range
// are rejected because they corrupt terminal output and many UI text renderers; \n and \t
// are explicitly allowed since legitimate display strings carry line breaks.
const SAFE_DISPLAY_MAX_CHARS = 4096;

// Intentionally matches control characters; this is the entire purpose of the safety
// gate. The `no-control-regex` lint rule guards against accidental control matches, not
// deliberate ones.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export function isSafeDisplaySummary(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length > SAFE_DISPLAY_MAX_CHARS) {
    return false;
  }
  return !FORBIDDEN_CONTROL_RE.test(value);
}

function isSafeDisplayString(value: unknown): value is string {
  return isNonEmptyTrimmedString(value) && isSafeDisplaySummary(value);
}

function validateSafeDisplayStringField(errors: string[], field: string, value: unknown): boolean {
  let valid = true;
  if (!isSafeDisplayString(value)) {
    valid = reject(errors, `${field} must be a browser-safe non-empty trimmed string`);
  }
  return valid;
}

function validateSafeDisplayStringArrayField(
  errors: string[],
  field: string,
  value: unknown,
): boolean {
  if (!Array.isArray(value)) {
    return reject(errors, `${field} must be a string array`);
  }
  return validateStableArrayMembers(
    value,
    field,
    errors,
    isSafeDisplayString,
    "entry must be a browser-safe non-empty trimmed string",
  );
}

function validateSafeMetadataMap(errors: string[], field: string, value: unknown): boolean {
  let valid = true;
  if (value === undefined) {
    return valid;
  }
  if (!isRecord(value)) {
    valid = reject(errors, `${field} must be an object when set`);
    return valid;
  }
  const entries = Object.entries(value);
  if (entries.length > CAPSULE_METADATA_MAX_KEYS) {
    valid = reject(
      errors,
      `${field} may contain at most ${String(CAPSULE_METADATA_MAX_KEYS)} entries`,
    );
    return valid;
  }
  for (const [key, entryValue] of entries) {
    if (!isSafeDisplayString(key) || key.length > CAPSULE_METADATA_KEY_MAX_CHARS) {
      valid = reject(
        errors,
        `${field} keys must be browser-safe non-empty strings no longer than ${String(CAPSULE_METADATA_KEY_MAX_CHARS)} characters`,
      );
      return valid;
    }
    if (
      typeof entryValue !== "string" ||
      !isSafeDisplaySummary(entryValue) ||
      entryValue.length > CAPSULE_METADATA_VALUE_MAX_CHARS
    ) {
      valid = reject(
        errors,
        `${field} values must be browser-safe strings no longer than ${String(CAPSULE_METADATA_VALUE_MAX_CHARS)} characters`,
      );
      return valid;
    }
  }
  return valid;
}

function validatePositiveIntegerMax(
  errors: string[],
  field: string,
  value: unknown,
  max: number,
): boolean {
  let valid = true;
  if (!isFinitePositiveInteger(value) || value > max) {
    valid = reject(errors, `${field} must be a positive integer no greater than ${String(max)}`);
  }
  return valid;
}

// Exported so the sibling Local Knowledge validators reuse this single allowlist-key check
// instead of maintaining their own copy (audit KEIKO-0530). `local-knowledge-pods.ts` and
// `local-knowledge-retrieval-activity.ts` import it directly (aliased to `onlyKeys` at the call
// site so their existing call shape is unchanged). `local-knowledge-model-use-policy.ts` keeps a
// private, algorithm-identical copy instead: this module already imports
// `validateKnowledgePodModelUsePolicy` (a value import) from that file, so an import in the other
// direction would form a circular module dependency between the two.
export function validateOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
  errors: string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(`${field} must not include ${key}`);
      return;
    }
  }
}

// ─── EmbeddingModelIdentity ───────────────────────────────────────────────────
function pushBadEnum(
  errors: string[],
  field: string,
  value: unknown,
  allowed: readonly string[],
): boolean {
  let valid = true;
  if (typeof value !== "string" || !allowed.includes(value)) {
    valid = reject(errors, `${field} must be one of ${allowed.join("|")}`);
  }
  return valid;
}

// eslint-disable-next-line max-lines-per-function, complexity
function admitsEmbeddingModelIdentity(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & EmbeddingModelIdentity {
  let valid = true;
  if (!isNonEmptyTrimmedString(input.provider)) {
    valid = reject(errors, "embeddingModelIdentity.provider must be a non-empty string");
  }
  if (!isNonEmptyTrimmedString(input.modelId)) {
    valid = reject(errors, "embeddingModelIdentity.modelId must be a non-empty string");
  }
  if (!isFinitePositiveInteger(input.vectorDimensions)) {
    valid = reject(errors, "embeddingModelIdentity.vectorDimensions must be a positive integer");
  }
  valid =
    pushBadEnum(
      errors,
      "embeddingModelIdentity.vectorMetric",
      input.vectorMetric,
      EMBEDDING_VECTOR_METRICS,
    ) && valid;
  if (input.modelRevision !== undefined && !isNonEmptyTrimmedString(input.modelRevision)) {
    valid = reject(
      errors,
      "embeddingModelIdentity.modelRevision must be a non-empty string when set",
    );
  }
  if (input.normalization !== undefined) {
    valid =
      pushBadEnum(
        errors,
        "embeddingModelIdentity.normalization",
        input.normalization,
        EMBEDDING_VECTOR_NORMALIZATIONS,
      ) && valid;
  }
  if (
    input.instructionVersion !== undefined &&
    !isNonEmptyTrimmedString(input.instructionVersion)
  ) {
    valid = reject(
      errors,
      "embeddingModelIdentity.instructionVersion must be a non-empty string when set",
    );
  }
  if (
    input.embeddingSpaceFingerprint !== undefined &&
    !isNonEmptyTrimmedString(input.embeddingSpaceFingerprint)
  ) {
    valid = reject(
      errors,
      "embeddingModelIdentity.embeddingSpaceFingerprint must be a non-empty string when set",
    );
  }
  if (input.dimensionsParam !== undefined && !isFinitePositiveInteger(input.dimensionsParam)) {
    valid = reject(
      errors,
      "embeddingModelIdentity.dimensionsParam must be a positive integer when set",
    );
  }

  return valid;
}

export function validateEmbeddingModelIdentity(
  input: unknown,
): LocalKnowledgeValidation<EmbeddingModelIdentity> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["embeddingModelIdentity must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsEmbeddingModelIdentity(input, errors) || errors.length > 0)
    return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── KnowledgeSourceScope ─────────────────────────────────────────────────────
function isSafeRelativeGlob(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length !== 0 &&
    !value.includes("\0") &&
    isSafeStorageReference(value)
  );
}

function validateGlobs(field: string, globs: unknown, errors: string[]): boolean {
  let valid = true;
  if (globs === undefined) {
    return valid;
  }
  if (!isStringArray(globs)) {
    valid = reject(errors, `${field} must be a string array when set`);
    return valid;
  }
  if (globs.length === 0) {
    valid = reject(errors, `${field} must be omitted instead of set to an empty array`);
    return valid;
  }
  const seen = new Set<string>();
  const members = globs;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, `${field} must have a valid array length`);
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const glob: unknown = members[index];
    if (!isSafeRelativeGlob(glob)) {
      valid = reject(errors, `${field} entry must be a safe relative NUL-free glob`);
      return valid;
    }
    if (seen.has(glob)) {
      valid = reject(errors, `${field} entries must be unique`);
      return valid;
    }
    seen.add(glob);
  }
  valid = combineAdmissions(valid, validateStableExtent(members, extent, field, errors));
  return valid;
}

function validateGlobOverlap(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isStringArray(input.includeGlobs) || !isStringArray(input.excludeGlobs)) {
    return valid;
  }
  const include = new Set<string>();
  const includeMembers = input.includeGlobs;
  const includeExtent = includeMembers.length;
  for (let index = 0; index < includeExtent; index += 1) {
    const entry = includeMembers[index];
    if (typeof entry !== "string")
      return reject(errors, "scope.includeGlobs must be a string array when set");
    include.add(entry);
  }
  const members = input.excludeGlobs;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "scope.excludeGlobs must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const exclude: unknown = members[index];
    if (typeof exclude !== "string")
      return reject(errors, "scope.excludeGlobs must be a string array when set");

    if (include.has(exclude)) {
      valid = reject(
        errors,
        "scope.excludeGlobs entries must not exactly cancel includeGlobs entries",
      );
      return valid;
    }
  }
  valid = combineAdmissions(
    valid,
    validateStableExtent(members, extent, "scope.excludeGlobs", errors),
  );
  return valid;
}

function validateFolderScope(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (typeof input.rootPath !== "string" || !isSafeScopePath(input.rootPath)) {
    valid = reject(errors, "scope.rootPath is unsafe or empty");
  }
  if (typeof input.recursive !== "boolean") {
    valid = reject(errors, "scope.recursive must be a boolean");
  }
  valid = combineAdmissions(valid, validateGlobs("scope.includeGlobs", input.includeGlobs, errors));
  valid = combineAdmissions(valid, validateGlobs("scope.excludeGlobs", input.excludeGlobs, errors));
  valid = combineAdmissions(valid, validateGlobOverlap(input, errors));
  return valid;
}

function validateRepositoryScope(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (typeof input.repositoryRoot !== "string" || !isSafeScopePath(input.repositoryRoot)) {
    valid = reject(errors, "scope.repositoryRoot is unsafe or empty");
  }
  valid = combineAdmissions(valid, validateGlobs("scope.includeGlobs", input.includeGlobs, errors));
  valid = combineAdmissions(valid, validateGlobs("scope.excludeGlobs", input.excludeGlobs, errors));
  valid = combineAdmissions(valid, validateGlobOverlap(input, errors));
  return valid;
}

function validateFilesScope(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (typeof input.rootPath !== "string" || !isSafeScopePath(input.rootPath)) {
    valid = reject(errors, "scope.rootPath is unsafe or empty");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    valid = reject(errors, "scope.files must be a non-empty array");
    return valid;
  }
  const members = input.files;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "scope.files must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = members[index];

    if (typeof entry !== "string" || !isSafeStorageReference(entry)) {
      valid = reject(errors, "scope.files entry is unsafe or empty");
      return valid;
    }
  }
  valid = combineAdmissions(valid, validateStableExtent(members, extent, "scope.files", errors));
  return valid;
}

function admitsKnowledgeSourceScope(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & KnowledgeSourceScope {
  let valid = true;
  const kind = input.kind;
  if (!KNOWLEDGE_SOURCE_SCOPE_KINDS_ADMISSION.includes(kind)) {
    return reject(errors, `scope.kind must be one of ${KNOWLEDGE_SOURCE_SCOPE_KINDS.join("|")}`);
  }
  if (kind === "folder") {
    valid = combineAdmissions(valid, validateFolderScope(input, errors));
  } else if (kind === "repository") {
    valid = combineAdmissions(valid, validateRepositoryScope(input, errors));
  } else {
    valid = combineAdmissions(valid, validateFilesScope(input, errors));
  }

  return valid;
}

export function validateKnowledgeSourceScope(
  input: unknown,
): LocalKnowledgeValidation<KnowledgeSourceScope> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["scope must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsKnowledgeSourceScope(input, errors) || errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── KnowledgeCapsule ─────────────────────────────────────────────────────────
const CONTEXTUAL_RETRIEVAL_KEYS = [
  "enabled",
  "modelId",
  "promptVersion",
  "strict",
  "maxContextChars",
  "documentContextMaxChars",
] as const;

function validateContextualRetrievalStrings(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (input.modelId !== undefined && !isSafeDisplayString(input.modelId)) {
    valid = reject(
      errors,
      "contextualRetrieval.modelId must be a browser-safe non-empty string when set",
    );
  }
  if (input.promptVersion !== undefined && !isSafeDisplayString(input.promptVersion)) {
    valid = reject(
      errors,
      "contextualRetrieval.promptVersion must be a browser-safe non-empty string when set",
    );
  }
  return valid;
}

function validateContextualRetrievalLimits(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (input.maxContextChars !== undefined) {
    valid = combineAdmissions(
      valid,
      validatePositiveIntegerMax(
        errors,
        "contextualRetrieval.maxContextChars",
        input.maxContextChars,
        CAPSULE_CONTEXTUAL_RETRIEVAL_MAX_CONTEXT_CHARS_MAX,
      ),
    );
  }
  if (input.documentContextMaxChars !== undefined) {
    valid = combineAdmissions(
      valid,
      validatePositiveIntegerMax(
        errors,
        "contextualRetrieval.documentContextMaxChars",
        input.documentContextMaxChars,
        CAPSULE_CONTEXTUAL_RETRIEVAL_DOCUMENT_CONTEXT_MAX_CHARS_MAX,
      ),
    );
  }
  return valid;
}

function admitsCapsuleContextualRetrievalSettings(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & CapsuleContextualRetrievalSettings {
  let valid = true;
  validateOnlyKeys(input, CONTEXTUAL_RETRIEVAL_KEYS, "contextualRetrieval", errors);
  if (typeof input.enabled !== "boolean") {
    valid = reject(errors, "contextualRetrieval.enabled must be a boolean");
  }
  valid = combineAdmissions(valid, validateContextualRetrievalStrings(input, errors));
  if (input.strict !== undefined && typeof input.strict !== "boolean") {
    valid = reject(errors, "contextualRetrieval.strict must be a boolean when set");
  }
  valid = combineAdmissions(valid, validateContextualRetrievalLimits(input, errors));

  return valid;
}

export function validateCapsuleContextualRetrievalSettings(
  input: unknown,
): LocalKnowledgeValidation<CapsuleContextualRetrievalSettings> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["contextualRetrieval must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsCapsuleContextualRetrievalSettings(input, errors) || errors.length > 0)
    return { ok: false, errors };
  return { ok: true, value: input };
}

function validateCapsuleEnums(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid =
    pushBadEnum(
      errors,
      "capsule.retrievalEffort",
      input.retrievalEffort,
      CAPSULE_RETRIEVAL_EFFORTS,
    ) && valid;
  valid =
    pushBadEnum(errors, "capsule.outputMode", input.outputMode, CAPSULE_OUTPUT_MODES) && valid;
  valid =
    pushBadEnum(
      errors,
      "capsule.answerGroundingPolicy",
      input.answerGroundingPolicy,
      CAPSULE_ANSWER_GROUNDING_POLICIES,
    ) && valid;
  valid =
    pushBadEnum(errors, "capsule.lifecycleState", input.lifecycleState, CAPSULE_LIFECYCLE_STATES) &&
    valid;
  return valid;
}

function validateCapsuleTimestamps(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isFiniteNonNegativeNumber(input.createdAt)) {
    valid = reject(errors, "capsule.createdAt must be a finite non-negative number");
  }
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    valid = reject(errors, "capsule.updatedAt must be a finite non-negative number");
  }
  return valid;
}

function validateCapsuleSourceLineage(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0) {
    valid = reject(errors, "capsule.sourceIds must be a non-empty array");
    return valid;
  }
  const members = input.sourceIds;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "capsule.sourceIds must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const id: unknown = members[index];

    if (!isNonEmptyTrimmedString(id)) {
      valid = reject(errors, "capsule.sourceIds entry must be a non-empty string");
      return valid;
    }
  }
  valid = combineAdmissions(
    valid,
    validateStableExtent(members, extent, "capsule.sourceIds", errors),
  );
  return valid;
}

function validateKnowledgeCapsuleDisplayMetadata(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = combineAdmissions(
    valid,
    validateSafeDisplayStringField(errors, "capsule.displayName", input.displayName),
  );
  if (input.description !== undefined) {
    valid = combineAdmissions(
      valid,
      validateSafeDisplayStringField(errors, "capsule.description", input.description),
    );
  }
  if (input.sourceRoutingInstructions !== undefined) {
    valid = combineAdmissions(
      valid,
      validateSafeDisplayStringField(
        errors,
        "capsule.sourceRoutingInstructions",
        input.sourceRoutingInstructions,
      ),
    );
  }
  valid = combineAdmissions(
    valid,
    validateSafeDisplayStringArrayField(errors, "capsule.tags", input.tags),
  );
  valid = combineAdmissions(
    valid,
    validateSafeMetadataMap(errors, "capsule.metadata", input.metadata),
  );
  return valid;
}

function validateKnowledgeCapsuleOptionalSettings(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (input.contextualRetrieval !== undefined) {
    const contextualResult = validateCapsuleContextualRetrievalSettings(input.contextualRetrieval);
    if (!contextualResult.ok) {
      valid = reject(errors, ...contextualResult.errors.map((error) => `capsule.${error}`));
    }
  }
  if (input.modelUsePolicy !== undefined) {
    const policyResult = validateKnowledgePodModelUsePolicy(input.modelUsePolicy);
    if (!policyResult.ok) {
      valid = reject(errors, ...policyResult.errors.map((error) => `capsule.${error}`));
    }
  }
  return valid;
}

function validateKnowledgeCapsuleStorageReference(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    typeof input.storageReference !== "string" ||
    !isSafeStorageReference(input.storageReference)
  ) {
    valid = reject(errors, "capsule.storageReference must be a safe relative path");
  }
  return valid;
}

function admitsKnowledgeCapsule(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & CapsuleStructure {
  let valid = true;
  if (!isNonEmptyTrimmedString(input.id)) {
    valid = reject(errors, "capsule.id must be a non-empty string");
  }
  valid = combineAdmissions(valid, validateKnowledgeCapsuleDisplayMetadata(input, errors));
  valid = combineAdmissions(valid, validateKnowledgeCapsuleOptionalSettings(input, errors));
  if (input.alwaysQuery !== undefined && typeof input.alwaysQuery !== "boolean") {
    valid = reject(errors, "capsule.alwaysQuery must be a boolean when set");
  }
  valid = combineAdmissions(valid, validateCapsuleSourceLineage(input, errors));
  valid = combineAdmissions(valid, validateCapsuleEnums(input, errors));
  const identityResult = validateEmbeddingModelIdentity(input.embeddingModelIdentity);
  if (!identityResult.ok) {
    for (const reason of identityResult.errors) {
      valid = reject(errors, `capsule.${reason}`);
    }
  }
  valid = combineAdmissions(valid, validateKnowledgeCapsuleStorageReference(input, errors));
  valid = combineAdmissions(valid, validateCapsuleTimestamps(input, errors));

  return valid;
}

export function validateKnowledgeCapsule(
  input: unknown,
): LocalKnowledgeValidation<KnowledgeCapsule> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["capsule must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsKnowledgeCapsule(input, errors) || errors.length > 0) return { ok: false, errors };
  // All non-brand fields are admitted above; this attaches only erased ID brands.
  const admitted: CapsuleStructure = input;
  // SAFETY: The checked structure retains every concrete field; only ID brands differ.
  return { ok: true, value: admitted as KnowledgeCapsule };
}

// ─── CapsuleSet ───────────────────────────────────────────────────────────────
function validateCapsuleSetCapsuleIds(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(input.capsuleIds) || input.capsuleIds.length === 0) {
    valid = reject(errors, "capsuleSet.capsuleIds must be a non-empty array");
    return valid;
  }
  const members = input.capsuleIds;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "capsuleSet.capsuleIds must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const id: unknown = members[index];

    if (!isNonEmptyTrimmedString(id)) {
      valid = reject(errors, "capsuleSet.capsuleIds entry must be a non-empty string");
      return valid;
    }
  }
  valid = combineAdmissions(
    valid,
    validateStableExtent(members, extent, "capsuleSet.capsuleIds", errors),
  );
  return valid;
}

function admitsCapsuleSet(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & CapsuleSetStructure {
  let valid = true;
  if (!isNonEmptyTrimmedString(input.id)) {
    valid = reject(errors, "capsuleSet.id must be a non-empty string");
  }
  if (!isSafeDisplayString(input.displayName)) {
    valid = reject(
      errors,
      "capsuleSet.displayName must be a browser-safe non-empty trimmed string",
    );
  }
  if (input.description !== undefined && !isSafeDisplayString(input.description)) {
    valid = reject(
      errors,
      "capsuleSet.description must be a browser-safe non-empty trimmed string",
    );
  }
  valid = combineAdmissions(
    valid,
    validateSafeDisplayStringArrayField(errors, "capsuleSet.tags", input.tags),
  );
  valid = combineAdmissions(valid, validateCapsuleSetCapsuleIds(input, errors));
  if (!isFiniteNonNegativeNumber(input.composedAt)) {
    valid = reject(errors, "capsuleSet.composedAt must be a finite non-negative number");
  }

  return valid;
}

export function validateCapsuleSet(input: unknown): LocalKnowledgeValidation<CapsuleSet> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["capsuleSet must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsCapsuleSet(input, errors) || errors.length > 0) return { ok: false, errors };
  // All non-brand fields are admitted above; this attaches only erased ID brands.
  const admitted: CapsuleSetStructure = input;
  // SAFETY: The checked structure retains every concrete field; only ID brands differ.
  return { ok: true, value: admitted as CapsuleSet };
}

function admitsCapsuleReindexRequest(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & ReindexStructure {
  let valid = true;
  if (!isNonEmptyTrimmedString(input.capsuleId)) {
    valid = reject(errors, "reindexRequest.capsuleId must be a non-empty string");
  }
  if (input.mode !== undefined && !CAPSULE_REINDEX_MODES_ADMISSION.includes(input.mode)) {
    valid = reject(errors, `reindexRequest.mode must be one of ${CAPSULE_REINDEX_MODES.join("|")}`);
  }
  if (input.force !== undefined && typeof input.force !== "boolean") {
    valid = reject(errors, "reindexRequest.force must be a boolean when provided");
  }
  valid = combineAdmissions(valid, validateResumeJobId(input, errors));

  return valid;
}

export function validateCapsuleReindexRequest(
  input: unknown,
): LocalKnowledgeValidation<CapsuleReindexRequest> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["reindexRequest must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsCapsuleReindexRequest(input, errors) || errors.length > 0)
    return { ok: false, errors };
  // All non-brand fields are admitted above; this attaches only erased ID brands.
  const admitted: ReindexStructure = input;
  // SAFETY: The checked structure retains every concrete field; only ID brands differ.
  return { ok: true, value: admitted as CapsuleReindexRequest };
}

function validateResumeJobId(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.resumeJobId === undefined) return valid;
  if (!isNonEmptyTrimmedString(input.resumeJobId) || input.mode !== "resume") {
    valid = reject(
      errors,
      "reindexRequest.resumeJobId requires mode resume and a non-empty job id",
    );
  }
  return valid;
}

// ─── ConnectorGraphState ──────────────────────────────────────────────────────
function validateFilesWindowNode(node: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  validateOnlyKeys(node, ["kind", "nodeId", "scope"], "graph.nodes entry.files-window", errors);
  const scopeResult = validateKnowledgeSourceScope(node.scope);
  if (!scopeResult.ok) {
    for (const reason of scopeResult.errors) {
      valid = reject(errors, `graph.nodes entry.files-window.${reason}`);
    }
  }
  return valid;
}

function validateLocalKnowledgeNodeTarget(target: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(target)) {
    valid = reject(errors, "graph.nodes entry.local-knowledge.target must be an object");
    return valid;
  }
  if (target.kind === "capsule") {
    validateOnlyKeys(
      target,
      ["kind", "capsuleId"],
      "graph.nodes entry.local-knowledge.target.capsule",
      errors,
    );
    if (!isNonEmptyTrimmedString(target.capsuleId)) {
      valid = reject(
        errors,
        "graph.nodes entry.local-knowledge.target.capsuleId must be a non-empty string",
      );
    }
    return valid;
  }
  if (target.kind === "capsule-set") {
    validateOnlyKeys(
      target,
      ["kind", "capsuleSetId"],
      "graph.nodes entry.local-knowledge.target.capsule-set",
      errors,
    );
    if (!isNonEmptyTrimmedString(target.capsuleSetId)) {
      valid = reject(
        errors,
        "graph.nodes entry.local-knowledge.target.capsuleSetId must be a non-empty string",
      );
    }
    return valid;
  }
  valid = reject(
    errors,
    'graph.nodes entry.local-knowledge.target.kind must be "capsule" or "capsule-set"',
  );
  return valid;
}

function validateLocalKnowledgeNode(node: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  validateOnlyKeys(node, ["kind", "nodeId", "target"], "graph.nodes entry.local-knowledge", errors);
  valid = combineAdmissions(valid, validateLocalKnowledgeNodeTarget(node.target, errors));
  return valid;
}

function validateConversationCenterNode(node: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  validateOnlyKeys(
    node,
    ["kind", "nodeId", "conversationId", "route"],
    "graph.nodes entry.conversation-center",
    errors,
  );
  if (!isNonEmptyTrimmedString(node.conversationId)) {
    valid = reject(
      errors,
      "graph.nodes entry.conversation-center.conversationId must be a non-empty string",
    );
  }
  if (!isNonEmptyTrimmedString(node.route)) {
    valid = reject(
      errors,
      "graph.nodes entry.conversation-center.route must be a non-empty string",
    );
  }
  return valid;
}

interface GraphNodeKindObservations {
  readonly nodeKinds: ReadonlyMap<string, unknown>;
  readonly valid: boolean;
}

function collectNodeKinds(nodes: readonly unknown[], errors: string[]): GraphNodeKindObservations {
  let valid = true;
  const nodeKinds = new Map<string, unknown>();
  const members = nodes;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "graph.nodes must have a valid array length");
    return { nodeKinds, valid: false };
  }
  for (let index = 0; index < extent; index += 1) {
    const node: unknown = members[index];

    if (!isRecord(node)) {
      valid = reject(errors, "graph.nodes entry must be an object");
      continue;
    }
    if (!isNonEmptyTrimmedString(node.nodeId)) {
      valid = reject(errors, "graph.nodes entry must have a non-empty nodeId");
      continue;
    }
    if (nodeKinds.has(node.nodeId)) {
      valid = reject(errors, `graph.nodes contains a duplicate nodeId: ${node.nodeId}`);
      continue;
    }
    if (typeof node.kind !== "string" || !CONNECTOR_NODE_KINDS_ADMISSION.includes(node.kind)) {
      valid = reject(errors, "graph.nodes entry has an unknown kind");
      continue;
    }
    nodeKinds.set(node.nodeId, node.kind);
    if (node.kind === "files-window") {
      valid = combineAdmissions(valid, validateFilesWindowNode(node, errors));
    } else if (node.kind === "local-knowledge") {
      valid = combineAdmissions(valid, validateLocalKnowledgeNode(node, errors));
    } else {
      valid = combineAdmissions(valid, validateConversationCenterNode(node, errors));
    }
  }
  valid = combineAdmissions(valid, validateStableExtent(members, extent, "graph.nodes", errors));
  return { nodeKinds, valid };
}

function validateEdgeNodeId(
  field: "from" | "to",
  nodeId: unknown,
  nodeKinds: ReadonlyMap<string, unknown>,
  errors: string[],
): string | undefined {
  if (typeof nodeId !== "string" || !nodeKinds.has(nodeId)) {
    errors.push(`graph.edges references unknown ${field}.nodeId`);
    return undefined;
  }
  return nodeId;
}

function validateEdgeNodeKind(
  field: "from" | "to",
  kind: unknown,
  nodeId: string | undefined,
  nodeKinds: ReadonlyMap<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (typeof kind !== "string" || !CONNECTOR_NODE_KINDS_ADMISSION.includes(kind)) {
    valid = reject(errors, `graph.edges ${field}.kind must be a known node kind`);
    return valid;
  }
  if (nodeId !== undefined && nodeKinds.get(nodeId) !== kind) {
    valid = reject(errors, `graph.edges ${field}.kind must match the referenced node kind`);
  }
  return valid;
}

function validateEdgeRecord(
  edge: Record<string, unknown>,
  nodeKinds: ReadonlyMap<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  const from = edge.from;
  const to = edge.to;
  if (!isRecord(from) || !isRecord(to)) {
    return reject(errors, "graph.edges entry must have from/to objects");
  }
  const fromId = validateEdgeNodeId("from", from.nodeId, nodeKinds, errors);
  const toId = validateEdgeNodeId("to", to.nodeId, nodeKinds, errors);
  valid = fromId !== undefined && toId !== undefined && valid;
  valid = combineAdmissions(
    valid,
    validateEdgeNodeKind("from", from.kind, fromId, nodeKinds, errors),
  );
  valid = combineAdmissions(valid, validateEdgeNodeKind("to", to.kind, toId, nodeKinds, errors));
  if (!isFiniteNonNegativeNumber(edge.createdAt)) {
    valid = reject(errors, "graph.edges entry must have a finite non-negative createdAt");
  }
  return valid;
}

function validateEdges(
  edges: readonly unknown[],
  nodeKinds: ReadonlyMap<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  const members = edges;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "graph.edges must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const edge: unknown = members[index];

    if (!isRecord(edge) || !isRecord(edge.from) || !isRecord(edge.to)) {
      valid = reject(errors, "graph.edges entry must have from/to objects");
      continue;
    }
    valid = combineAdmissions(valid, validateEdgeRecord(edge, nodeKinds, errors));
  }
  valid = combineAdmissions(valid, validateStableExtent(members, extent, "graph.edges", errors));
  return valid;
}

function admitsConnectorGraphState(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & GraphStructure {
  let valid = true;
  if (input.schemaVersion !== "1") {
    valid = reject(errors, 'graph.schemaVersion must be the literal "1"');
  }
  if (!Array.isArray(input.nodes)) {
    reject(errors, "graph.nodes must be an array");
    return false;
  }
  if (!Array.isArray(input.edges)) {
    reject(errors, "graph.edges must be an array");
    return false;
  }
  const collected = collectNodeKinds(input.nodes, errors);
  valid = combineAdmissions(valid, collected.valid);
  const nodeKinds = collected.nodeKinds;
  valid = combineAdmissions(valid, validateEdges(input.edges, nodeKinds, errors));
  if (!isFiniteNonNegativeNumber(input.updatedAt)) {
    valid = reject(errors, "graph.updatedAt must be a finite non-negative number");
  }

  return valid;
}

export function validateConnectorGraphState(
  input: unknown,
): LocalKnowledgeValidation<ConnectorGraphState> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["graph must be an object"] };
  }
  const errors: string[] = [];
  if (!admitsConnectorGraphState(input, errors) || errors.length > 0) return { ok: false, errors };
  // All non-brand fields are admitted above; this attaches only erased ID brands.
  // SAFETY: The checked structure retains every concrete field; only ID brands differ.
  return { ok: true, value: input as ConnectorGraphState };
}

// Re-export the connector node alias so consumers of this validator module can narrow
// without dipping back into the types file when they already imported the validator.
export type { ConnectorNode };

const CAPSULE_REINDEX_MODES_ADMISSION: readonly unknown[] = CAPSULE_REINDEX_MODES;
const CONNECTOR_NODE_KINDS_ADMISSION: readonly unknown[] = CONNECTOR_NODE_KINDS;

const KNOWLEDGE_SOURCE_SCOPE_KINDS_ADMISSION: readonly unknown[] = KNOWLEDGE_SOURCE_SCOPE_KINDS;
