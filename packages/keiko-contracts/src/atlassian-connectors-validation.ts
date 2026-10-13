// Hostile-input validators for the Atlassian connector contracts (Issue #2240, ADR-0128).
//
// Hand-written guards in the established `*-validation.ts` style (no zod): every object field set
// is a closed key allowlist (fail-closed — an unexpected field on a redacted, wire-facing contract
// is a validation error, never silently carried through), every enum is checked against its frozen
// array, and every cross-field integrity rule from ADR-0128 D5/D6 is enforced here so a corrupted
// or tampered record cannot smuggle bodies, secrets, or inconsistent counts across the wire.
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports, pure functions
// only.

import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS,
  ATLASSIAN_CONNECTOR_ACTIVITY_OUTCOMES,
  ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS,
  ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS,
  ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON,
  ATLASSIAN_CONNECTOR_REGISTRY_FAILURE_REASONS,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS,
  ATLASSIAN_SYNC_FAILURE_REASONS,
  ATLASSIAN_SYNC_SCOPE_MAX_KEYS,
  ATLASSIAN_SYNC_TERMINAL_STATUSES,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  hasBalancedJqlNesting,
  isAtlassianConnectorActionType,
  isAtlassianConnectorAuthRef,
  isAtlassianConnectorAuthScheme,
  isAtlassianConnectorProvider,
  isAtlassianConnectorWriteFailureReason,
  isAtlassianLiveSearchTemplateId,
  isAtlassianSyncFailureReason,
  isAtlassianSyncJobStatus,
  isJiraIssueCitationMetadata,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianContentPreview,
  isSafeAtlassianDisplayName,
  isSafeAtlassianIdentifier,
  isSafeConfluenceSpaceKey,
  isSafeJiraBrowseUrl,
  isSafeJiraLiveIssueSummary,
  isSafeJiraProjectKey,
  type AtlassianConnectorActionExecutionResult,
  type AtlassianConnectorActivityRecord,
  type AtlassianConnectorDescriptor,
  type AtlassianConnectorPendingApproval,
  type AtlassianConnectorPodSource,
  type AtlassianSyncBounds,
  type AtlassianSyncChangeCounts,
  type AtlassianSyncChangeSummary,
  type AtlassianSyncJobState,
  type AtlassianSyncJobStatus,
  type AtlassianSyncProgressCounts,
  type AtlassianSyncScope,
  type AtlassianSyncTerminalStatus,
  type JiraLiveIssue,
  type JiraLiveSearchRequest,
  type JiraLiveSearchResult,
} from "./atlassian-connectors.js";
import { CODING_WORKBENCH_POLICY_DENIAL_REASONS } from "./coding-workbench.js";

// ─── Validation result (per-lane alias of the shared ok/errors shape) ─────────
export interface AtlassianConnectorValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface AtlassianConnectorValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type AtlassianConnectorValidation<T> =
  AtlassianConnectorValidationOk<T> | AtlassianConnectorValidationFail;

// ─── Shared primitives ─────────────────────────────────────────────────────────
const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveIntWithin(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

// Rejects any object carrying a property outside `allowed`. Fail-closed: an unexpected field on a
// redacted contract must never ride through (mirrors `onlyKnownKeys` in html-manual-refresh.ts).
function onlyKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  errors: string[],
): boolean {
  let valid = true;
  const allowedSet = new Set(allowed);
  // No early return: these validators exist to catch EVERY credential- or body-like field a hostile
  // or buggy caller smuggled onto a payload, so stopping at the first understated the scope of what
  // was rejected. Matches `exactKeys` in coding-workbench-runtime-api-validation.ts and the
  // enumerate-every-reason convention the rest of the package follows.
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push(`${field} must not include ${key}`);
      valid = false;
    }
  }
  return valid;
}

function pushDigest(errors: string[], field: string, value: unknown): boolean {
  let valid = true;
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    errors.push(`${field} must be a 64-character lowercase hex digest`);
    valid = false;
  }
  return valid;
}

function pushTimestamp(errors: string[], field: string, value: unknown): boolean {
  let valid = true;
  if (!isFiniteNonNegativeNumber(value)) {
    errors.push(`${field} must be a finite non-negative number`);
    valid = false;
  }
  return valid;
}

function pushIdentifier(errors: string[], field: string, value: unknown): boolean {
  let valid = true;
  if (!isSafeAtlassianIdentifier(value)) {
    errors.push(`${field} must be a bounded identifier token`);
    valid = false;
  }
  return valid;
}

function pushSchemaVersion(errors: string[], field: string, value: unknown): boolean {
  let valid = true;
  if (value !== ATLASSIAN_CONNECTOR_SCHEMA_VERSION) {
    errors.push(`${field}.schemaVersion must be the literal "1"`);
    valid = false;
  }
  return valid;
}

// Validates a bounded set of unique provider keys (space or project keys).
function validateKeySet(
  value: unknown,
  field: string,
  isSafeKey: (candidate: unknown) => candidate is string,
  errors: string[],
): boolean {
  let valid = true;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    valid = false;
    return valid;
  }
  if (value.length === 0) {
    errors.push(`${field} must not be empty`);
    valid = false;
    return valid;
  }
  if (value.length > ATLASSIAN_SYNC_SCOPE_MAX_KEYS) {
    errors.push(`${field} must contain at most ${String(ATLASSIAN_SYNC_SCOPE_MAX_KEYS)} keys`);
    valid = false;
    return valid;
  }
  const seen = new Set<string>();
  const extent = value.length;
  if (!Number.isSafeInteger(extent) || extent < 1 || extent > ATLASSIAN_SYNC_SCOPE_MAX_KEYS) {
    errors.push(`${field} must contain at most ${String(ATLASSIAN_SYNC_SCOPE_MAX_KEYS)} keys`);
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = value[index];
    if (!isSafeKey(entry)) {
      errors.push(`${field} entries must be valid keys`);
      valid = false;
      return valid;
    }
    const key = entry;
    if (seen.has(key)) {
      errors.push(`${field} entries must be unique`);
      valid = false;
      return valid;
    }
    seen.add(key);
  }
  return valid;
}

// ─── Connector descriptor (ADR-0128 D2/D3) ────────────────────────────────────
const DESCRIPTOR_KEYS: readonly (keyof AtlassianConnectorDescriptor)[] = [
  "schemaVersion",
  "id",
  "provider",
  "displayName",
  "baseUrl",
  "authScheme",
  "authRef",
];

function admitAtlassianConnectorDescriptor(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianConnectorDescriptor {
  let valid = true;
  valid = onlyKnownKeys(input, DESCRIPTOR_KEYS, "descriptor", errors) && valid;
  valid = pushSchemaVersion(errors, "descriptor", input.schemaVersion) && valid;
  valid = pushIdentifier(errors, "descriptor.id", input.id) && valid;
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("descriptor.provider must be confluence or jira");
    valid = false;
  }
  if (!isSafeAtlassianDisplayName(input.displayName)) {
    errors.push("descriptor.displayName must be bounded redaction-safe display text");
    valid = false;
  }
  if (!isSafeAtlassianConnectorBaseUrl(input.baseUrl)) {
    errors.push("descriptor.baseUrl must be an https URL without credentials, query, or fragment");
    valid = false;
  }
  if (!isAtlassianConnectorAuthScheme(input.authScheme)) {
    errors.push("descriptor.authScheme must be basic-api-token or bearer-pat");
    valid = false;
  }
  if (!isAtlassianConnectorAuthRef(input.authRef)) {
    errors.push("descriptor.authRef must be an opaque atlassian-cred vault reference");
    valid = false;
  }
  return valid;
}

export function validateAtlassianConnectorDescriptor(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorDescriptor> {
  if (!isRecord(input)) return { ok: false, errors: ["descriptor must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianConnectorDescriptor(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Sync bounds (ADR-0128 D5 — narrow-only against the declared defaults) ────
const SYNC_BOUNDS_KEYS: readonly (keyof AtlassianSyncBounds)[] = [
  "maxItems",
  "maxBytes",
  "maxDurationMs",
  "maxConcurrency",
];

function admitAtlassianSyncBounds(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianSyncBounds {
  let valid = true;
  valid = onlyKnownKeys(input, SYNC_BOUNDS_KEYS, "bounds", errors) && valid;
  for (const key of SYNC_BOUNDS_KEYS) {
    if (!isPositiveIntWithin(input[key], DEFAULT_ATLASSIAN_SYNC_BOUNDS[key])) {
      errors.push(`bounds.${key} must be a positive integer that does not widen the D5 default`);
      valid = false;
    }
  }
  return valid;
}

export function validateAtlassianSyncBounds(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncBounds> {
  if (!isRecord(input)) return { ok: false, errors: ["bounds must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianSyncBounds(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Sync scope ─────────────────────────────────────────────────────────────────
const CONFLUENCE_SCOPE_KEYS: readonly string[] = ["provider", "spaceKeys", "bounds"];
const JIRA_SCOPE_KEYS: readonly string[] = ["provider", "projectKeys", "jql", "bounds"];

// JQL is opaque user input executed under the user's own token: bounded and transported, never
// parsed and never surfaced in evidence (ADR-0128 D6 hashes or omits it).
function validateOpaqueJql(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > ATLASSIAN_JQL_MAX_CHARS ||
    value.trim().length === 0
  ) {
    errors.push(
      `scope.jql must be a non-empty string of at most ${String(ATLASSIAN_JQL_MAX_CHARS)} characters`,
    );
    valid = false;
    return valid;
  }
  // Structural (not semantic) precondition of the `project IN (...) AND (<jql>)` composition the
  // adapter builds: a clause that closes the injected group widens egress past the approved
  // projects. Rejected here so a scope can never be persisted in that shape (ADR-0128 D5).
  if (!hasBalancedJqlNesting(value)) {
    errors.push("scope.jql must have balanced parentheses and terminated string literals");
    valid = false;
  }
  return valid;
}

function validateScopeBounds(value: unknown, errors: string[]): boolean {
  let valid = true;
  const bounds = validateAtlassianSyncBounds(value);
  if (!bounds.ok) {
    errors.push(...bounds.errors.map((error) => `scope.${error}`));
    valid = false;
  }
  return valid;
}

function admitAtlassianSyncScope(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianSyncScope {
  let valid = true;
  if (input.provider === "confluence") {
    valid = onlyKnownKeys(input, CONFLUENCE_SCOPE_KEYS, "scope", errors) && valid;
    valid =
      validateKeySet(input.spaceKeys, "scope.spaceKeys", isSafeConfluenceSpaceKey, errors) && valid;
  } else if (input.provider === "jira") {
    valid = onlyKnownKeys(input, JIRA_SCOPE_KEYS, "scope", errors) && valid;
    valid =
      validateKeySet(input.projectKeys, "scope.projectKeys", isSafeJiraProjectKey, errors) && valid;
    valid = validateOpaqueJql(input.jql, errors) && valid;
  } else {
    errors.push("scope.provider must be confluence or jira");
    return false;
  }
  valid = validateScopeBounds(input.bounds, errors) && valid;
  return valid;
}

export function validateAtlassianSyncScope(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncScope> {
  if (!isRecord(input)) return { ok: false, errors: ["scope must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianSyncScope(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Progress and change counts ─────────────────────────────────────────────────
const PROGRESS_COUNT_KEYS: readonly (keyof AtlassianSyncProgressCounts)[] = [
  "enumeratedItems",
  "fetchedItems",
  "indexedItems",
  "skippedItems",
  "failedItems",
];

const CHANGE_COUNT_KEYS: readonly (keyof AtlassianSyncChangeCounts)[] = [
  "addedItems",
  "changedItems",
  "removedItems",
  "unchangedItems",
  "failedItems",
  "deniedItems",
];

function validateCountRecord(
  input: unknown,
  keys: readonly string[],
  field: string,
  errors: string[],
): boolean {
  let valid = true;
  if (!isRecord(input)) {
    errors.push(`${field} must be an object`);
    valid = false;
    return valid;
  }
  valid = onlyKnownKeys(input, keys, field, errors) && valid;
  for (const key of keys) {
    if (!isNonNegativeSafeInteger(input[key])) {
      errors.push(`${field}.${key} must be a non-negative integer`);
      valid = false;
      return valid;
    }
  }
  return valid;
}

// ─── Change summary (ADR-0128 D5/D6) ──────────────────────────────────────────
const CHANGE_SUMMARY_KEYS: readonly (keyof AtlassianSyncChangeSummary)[] = [
  "schemaVersion",
  "outcome",
  "counts",
  "fingerprintSetDigest",
  "completedAt",
];

// A run that did not apply (failed or cancelled) commits nothing, so it must report zero
// added/changed/removed items — a partial or aborted run can never be misread as "nothing
// changed upstream" (ADR-0128 D5).
function validateNotAppliedZeroCounts(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.outcome !== "failed" && input.outcome !== "cancelled") return valid;
  const counts = input.counts;
  if (!isRecord(counts)) return valid;
  for (const key of ["addedItems", "changedItems", "removedItems"] as const) {
    if (counts[key] !== 0) {
      errors.push(`changeSummary.counts.${key} must be 0 for a ${input.outcome} run`);
      valid = false;
      return valid;
    }
  }
  return valid;
}

function admitAtlassianSyncChangeSummary(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianSyncChangeSummary {
  let valid = true;
  valid = onlyKnownKeys(input, CHANGE_SUMMARY_KEYS, "changeSummary", errors) && valid;
  valid = pushSchemaVersion(errors, "changeSummary", input.schemaVersion) && valid;
  if (
    typeof input.outcome !== "string" ||
    !isOneOfStrings(input.outcome, ATLASSIAN_SYNC_TERMINAL_STATUSES)
  ) {
    errors.push(
      `changeSummary.outcome must be one of ${ATLASSIAN_SYNC_TERMINAL_STATUSES.join("|")}`,
    );
    valid = false;
  }
  valid =
    validateCountRecord(input.counts, CHANGE_COUNT_KEYS, "changeSummary.counts", errors) && valid;
  valid =
    pushDigest(errors, "changeSummary.fingerprintSetDigest", input.fingerprintSetDigest) && valid;
  valid = pushTimestamp(errors, "changeSummary.completedAt", input.completedAt) && valid;
  valid = validateNotAppliedZeroCounts(input, errors) && valid;
  return valid;
}

export function validateAtlassianSyncChangeSummary(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncChangeSummary> {
  if (!isRecord(input)) return { ok: false, errors: ["changeSummary must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianSyncChangeSummary(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Sync job state (discriminated union, ADR-0128 D5) ────────────────────────
const JOB_COMMON_KEYS: readonly string[] = [
  "schemaVersion",
  "status",
  "jobId",
  "connectorId",
  "provider",
  "queuedAt",
  "progress",
];

const JOB_EXTRA_KEYS_BY_STATUS: Readonly<Record<AtlassianSyncJobStatus, readonly string[]>> =
  Object.freeze({
    pending: [],
    running: ["startedAt"],
    succeeded: ["startedAt", "completedAt", "changeSummary"],
    partial: ["startedAt", "completedAt", "changeSummary", "failureReasons"],
    failed: ["startedAt", "completedAt", "changeSummary", "failureReason"],
    cancelled: ["startedAt", "completedAt", "changeSummary"],
  } as const satisfies Readonly<Record<AtlassianSyncJobStatus, readonly string[]>>);

// `startedAt` is required once a job has run (`running`, `succeeded`, `partial`) and optional on
// the arms that may terminate straight from the queue (`failed`, `cancelled`).
const JOB_STARTED_AT_REQUIRED: ReadonlySet<AtlassianSyncJobStatus> =
  new Set<AtlassianSyncJobStatus>(["running", "succeeded", "partial"]);

function validateJobCommon(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = pushSchemaVersion(errors, "syncJob", input.schemaVersion) && valid;
  valid = pushIdentifier(errors, "syncJob.jobId", input.jobId) && valid;
  valid = pushIdentifier(errors, "syncJob.connectorId", input.connectorId) && valid;
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("syncJob.provider must be confluence or jira");
    valid = false;
  }
  valid = pushTimestamp(errors, "syncJob.queuedAt", input.queuedAt) && valid;
  valid =
    validateCountRecord(input.progress, PROGRESS_COUNT_KEYS, "syncJob.progress", errors) && valid;
  return valid;
}

function validateJobTimestamps(
  input: Record<string, unknown>,
  status: AtlassianSyncJobStatus,
  errors: string[],
): boolean {
  let valid = true;
  if (JOB_STARTED_AT_REQUIRED.has(status) || input.startedAt !== undefined) {
    valid = pushTimestamp(errors, "syncJob.startedAt", input.startedAt) && valid;
  }
  if (status !== "pending" && status !== "running") {
    valid = pushTimestamp(errors, "syncJob.completedAt", input.completedAt) && valid;
  }
  return valid;
}

function validateJobFailureReasons(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(input.failureReasons) || input.failureReasons.length === 0) {
    errors.push("syncJob.failureReasons must be a non-empty array for a partial run");
    valid = false;
    return valid;
  }
  const seen = new Set<string>();
  const reasons = input.failureReasons;
  if (!Array.isArray(reasons)) {
    errors.push("syncJob.failureReasons must be a non-empty array for a partial run");
    return false;
  }
  const extent = reasons.length;
  if (!Number.isSafeInteger(extent) || extent < 1) {
    errors.push("syncJob.failureReasons must be a non-empty array for a partial run");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const reason: unknown = reasons[index];
    if (!isAtlassianSyncFailureReason(reason)) {
      errors.push(
        `syncJob.failureReasons entries must be one of ${ATLASSIAN_SYNC_FAILURE_REASONS.join("|")}`,
      );
      valid = false;
      return valid;
    }
    if (seen.has(reason)) {
      errors.push("syncJob.failureReasons entries must be unique");
      valid = false;
      return valid;
    }
    seen.add(reason);
  }
  return valid;
}

// The terminal change summary must agree with the job status: a `failed` job carries a `failed`
// summary, never a stale `succeeded` one.
function validateJobTerminalFields(
  input: Record<string, unknown>,
  status: AtlassianSyncTerminalStatus,
  errors: string[],
): boolean {
  let valid = true;
  const summary = validateAtlassianSyncChangeSummary(input.changeSummary);
  if (!summary.ok) {
    errors.push(...summary.errors.map((error) => `syncJob.${error}`));
    valid = false;
  } else if (summary.value.outcome !== status) {
    errors.push(`syncJob.changeSummary.outcome must equal the job status ${status}`);
    valid = false;
  }
  if (status === "failed" && !isAtlassianSyncFailureReason(input.failureReason)) {
    errors.push(`syncJob.failureReason must be one of ${ATLASSIAN_SYNC_FAILURE_REASONS.join("|")}`);
    valid = false;
  }
  if (status === "partial") {
    valid = validateJobFailureReasons(input, errors) && valid;
  }
  return valid;
}

function admitAtlassianSyncJobState(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianSyncJobState {
  const status = input.status;
  if (!isAtlassianSyncJobStatus(status)) {
    errors.push("syncJob.status is invalid");
    return false;
  }
  let valid = true;
  valid =
    onlyKnownKeys(
      input,
      [...JOB_COMMON_KEYS, ...JOB_EXTRA_KEYS_BY_STATUS[status]],
      "syncJob",
      errors,
    ) && valid;
  valid = validateJobCommon(input, errors) && valid;
  valid = validateJobTimestamps(input, status, errors) && valid;
  if (status !== "pending" && status !== "running") {
    valid = validateJobTerminalFields(input, status, errors) && valid;
  }
  return valid;
}

export function validateAtlassianSyncJobState(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncJobState> {
  if (!isRecord(input)) return { ok: false, errors: ["syncJob must be an object"] };
  if (!isAtlassianSyncJobStatus(input.status)) {
    return { ok: false, errors: ["syncJob.status is invalid"] };
  }
  const errors: string[] = [];
  if (!admitAtlassianSyncJobState(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Redacted activity record (ADR-0128 D6) ───────────────────────────────────
const ACTIVITY_RECORD_KEYS: readonly (keyof AtlassianConnectorActivityRecord)[] = [
  "schemaVersion",
  "activityId",
  "occurredAt",
  "connectorId",
  "provider",
  "actionType",
  "actionClass",
  "disposition",
  "outcome",
  "reasonCode",
  "targetRef",
  "correlationId",
  "durationMs",
  "syncSummary",
  "jqlDigest",
  "resultCount",
  "resultIssueKeys",
];

const SYNC_ACTION_TYPES: readonly string[] = ["sync-space", "sync-project"];

function validateActivityIdentity(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = pushSchemaVersion(errors, "activity", input.schemaVersion) && valid;
  valid = pushIdentifier(errors, "activity.activityId", input.activityId) && valid;
  valid = pushTimestamp(errors, "activity.occurredAt", input.occurredAt) && valid;
  valid = pushIdentifier(errors, "activity.connectorId", input.connectorId) && valid;
  valid = pushIdentifier(errors, "activity.correlationId", input.correlationId) && valid;
  if (!isNonNegativeSafeInteger(input.durationMs)) {
    errors.push("activity.durationMs must be a non-negative integer");
    valid = false;
  }
  if (input.targetRef !== undefined && !isSafeAtlassianIdentifier(input.targetRef)) {
    errors.push("activity.targetRef must be a bounded identifier token when set");
    valid = false;
  }
  return valid;
}

// The action rows are pinned by the D4 table: the recorded class and provider must match the
// action type, so a tampered record cannot re-label a write as a read.
function validateActivityActionConsistency(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  if (!isAtlassianConnectorActionType(input.actionType)) {
    errors.push("activity.actionType is invalid");
    return false;
  }
  let valid = true;
  const actionClass: unknown = input.actionClass;
  const classAction: unknown = input.actionType;
  if (
    !isAtlassianConnectorActionType(classAction) ||
    actionClass !== ATLASSIAN_CONNECTOR_ACTION_CLASS[classAction]
  ) {
    errors.push("activity.actionClass must match the D4 table for the action type");
    valid = false;
  }
  const provider: unknown = input.provider;
  const providerAction: unknown = input.actionType;
  if (
    !isAtlassianConnectorActionType(providerAction) ||
    provider !== ATLASSIAN_CONNECTOR_ACTION_PROVIDER[providerAction]
  ) {
    errors.push("activity.provider must match the D4 table for the action type");
    valid = false;
  }
  return valid;
}

function isOneOfStrings(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

// A closed EXECUTION failure reason: the sync vocabulary or the write vocabulary (Issue #2244).
function isExecutionFailureReason(value: unknown): boolean {
  return isAtlassianSyncFailureReason(value) || isAtlassianConnectorWriteFailureReason(value);
}

// An allowed attempt carries no reason unless its execution failed (one closed sync/write failure
// reason) or it was directly human-initiated (`human-initiated` rationale, ADR-0128 D5 explicit
// user-triggered sync); its outcome can never be `denied`.
function validateAllowedAttemptReason(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.outcome === "denied") {
    errors.push("activity.outcome must not be denied for an allowed attempt");
    valid = false;
  }
  if (
    input.reasonCode !== undefined &&
    !isExecutionFailureReason(input.reasonCode) &&
    input.reasonCode !== ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON
  ) {
    errors.push(
      "activity.reasonCode must be an execution failure reason or human-initiated for an allowed attempt",
    );
    valid = false;
  }
  if (input.outcome === "failed" && !isExecutionFailureReason(input.reasonCode)) {
    errors.push("activity.reasonCode must be an execution failure reason for a failed attempt");
    valid = false;
  }
  return valid;
}

// A review-required attempt carries its one review reason while pending, approved-and-succeeded,
// or rejected (`cancelled`); an approved execution that then failed carries the closed execution
// failure reason instead, so the provider outcome is never lost from the trail.
function validateReviewRequiredAttemptReason(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (input.outcome === "failed") {
    if (!isExecutionFailureReason(input.reasonCode)) {
      errors.push(
        "activity.reasonCode must be an execution failure reason for a failed review-required attempt",
      );
      valid = false;
    }
    return valid;
  }
  if (!isOneOfStrings(input.reasonCode, ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS)) {
    errors.push("activity.reasonCode must be a review reason for a review-required attempt");
    valid = false;
  }
  return valid;
}

// Exactly-one-reason pairing (ADR-0125 disposition rule applied to connector activity):
// denied → one central denial reason or one envelope-authority failure code; review-required →
// one review reason (or the execution failure reason after an approved run failed); allowed →
// see above.
function validateActivityReasonPairing(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.disposition === "denied") {
    if (
      !isOneOfStrings(input.reasonCode, CODING_WORKBENCH_POLICY_DENIAL_REASONS) &&
      !isOneOfStrings(input.reasonCode, ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS) &&
      !isOneOfStrings(input.reasonCode, ATLASSIAN_CONNECTOR_REGISTRY_FAILURE_REASONS)
    ) {
      errors.push(
        "activity.reasonCode must be a policy denial, authority failure, or registry failure reason for a denied attempt",
      );
      valid = false;
    }
    if (input.outcome !== "denied") {
      errors.push("activity.outcome must be denied for a denied attempt");
      valid = false;
    }
    return valid;
  }
  if (input.disposition === "review-required") {
    valid = validateReviewRequiredAttemptReason(input, errors) && valid;
    return valid;
  }
  valid = validateAllowedAttemptReason(input, errors) && valid;
  return valid;
}

// `syncSummary` may only accompany sync actions; `jqlDigest` (sha256 of the JQL, never the text)
// may only accompany `search-issues-live` (ADR-0128 D6).
function validateActivityActionPayloads(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.syncSummary !== undefined) {
    if (!isOneOfStrings(input.actionType, SYNC_ACTION_TYPES)) {
      errors.push("activity.syncSummary is only allowed for sync actions");
      valid = false;
    } else {
      const summary = validateAtlassianSyncChangeSummary(input.syncSummary);
      if (!summary.ok) {
        errors.push(...summary.errors.map((error) => `activity.${error}`));
        valid = false;
      }
    }
  }
  if (input.jqlDigest !== undefined) {
    if (input.actionType !== "search-issues-live") {
      errors.push("activity.jqlDigest is only allowed for search-issues-live");
      valid = false;
    } else {
      valid = pushDigest(errors, "activity.jqlDigest", input.jqlDigest) && valid;
    }
  }
  valid = validateActivityLiveResultFields(input, errors) && valid;
  return valid;
}

// `resultCount`/`resultIssueKeys` (Issue #2248) may only accompany `search-issues-live`: a
// bounded count and bounded identifier list — the D6 "counts and issue keys" audit vocabulary.
// When both are present they must agree, so a tampered record cannot claim one count and list
// another.
function validateActivityLiveResultCount(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (input.resultCount === undefined) return valid;
  if (input.actionType !== "search-issues-live") {
    errors.push("activity.resultCount is only allowed for search-issues-live");
    valid = false;
    return valid;
  }
  if (
    !isNonNegativeSafeInteger(input.resultCount) ||
    input.resultCount > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS
  ) {
    errors.push(
      `activity.resultCount must be a non-negative integer of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)}`,
    );
    valid = false;
  }
  return valid;
}

function hasPhysicalLiveIssueKeys(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const extent = value.length;
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)
    return false;
  for (let index = 0; index < extent; index += 1) {
    if (!isSafeAtlassianIdentifier(value[index])) return false;
  }
  return true;
}

function validateActivityLiveResultKeys(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.resultIssueKeys === undefined) return valid;
  if (input.actionType !== "search-issues-live") {
    errors.push("activity.resultIssueKeys is only allowed for search-issues-live");
    valid = false;
    return valid;
  }
  if (
    !Array.isArray(input.resultIssueKeys) ||
    input.resultIssueKeys.length > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS ||
    !hasPhysicalLiveIssueKeys(input.resultIssueKeys)
  ) {
    errors.push("activity.resultIssueKeys must be a bounded array of identifier tokens");
    valid = false;
    return valid;
  }
  if (input.resultCount !== undefined && input.resultIssueKeys.length !== input.resultCount) {
    errors.push("activity.resultIssueKeys length must equal activity.resultCount");
    valid = false;
  }
  return valid;
}

function validateActivityLiveResultFields(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  valid = validateActivityLiveResultCount(input, errors) && valid;
  valid = validateActivityLiveResultKeys(input, errors) && valid;
  return valid;
}

function admitAtlassianConnectorActivityRecord(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianConnectorActivityRecord {
  let valid = true;
  valid = onlyKnownKeys(input, ACTIVITY_RECORD_KEYS, "activity", errors) && valid;
  valid = validateActivityIdentity(input, errors) && valid;
  valid = validateActivityActionConsistency(input, errors) && valid;
  if (!isOneOfStrings(input.disposition, ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS)) {
    errors.push("activity.disposition is invalid");
    valid = false;
  }
  if (!isOneOfStrings(input.outcome, ATLASSIAN_CONNECTOR_ACTIVITY_OUTCOMES)) {
    errors.push("activity.outcome is invalid");
    valid = false;
  }
  valid = validateActivityReasonPairing(input, errors) && valid;
  valid = validateActivityActionPayloads(input, errors) && valid;
  return valid;
}

export function validateAtlassianConnectorActivityRecord(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorActivityRecord> {
  if (!isRecord(input)) return { ok: false, errors: ["activity must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianConnectorActivityRecord(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Connector-pod source metadata (#2240 Scope 6) ────────────────────────────
const POD_SOURCE_KEYS: readonly (keyof AtlassianConnectorPodSource)[] = [
  "provider",
  "connectorId",
  "scopeLabels",
  "lastSyncAt",
  "lastChangeSummary",
];

function admitAtlassianConnectorPodSource(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianConnectorPodSource {
  let valid = true;
  valid = onlyKnownKeys(input, POD_SOURCE_KEYS, "connectorSource", errors) && valid;
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("connectorSource.provider must be confluence or jira");
    valid = false;
  }
  valid = pushIdentifier(errors, "connectorSource.connectorId", input.connectorId) && valid;
  valid =
    validateKeySet(
      input.scopeLabels,
      "connectorSource.scopeLabels",
      isSafeAtlassianIdentifier,
      errors,
    ) && valid;
  if (input.lastSyncAt !== undefined) {
    valid = pushTimestamp(errors, "connectorSource.lastSyncAt", input.lastSyncAt) && valid;
  }
  if (input.lastChangeSummary !== undefined) {
    const summary = validateAtlassianSyncChangeSummary(input.lastChangeSummary);
    if (!summary.ok) {
      errors.push(...summary.errors.map((error) => `connectorSource.${error}`));
      valid = false;
    }
  }
  return valid;
}

export function validateAtlassianConnectorPodSource(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorPodSource> {
  if (!isRecord(input)) return { ok: false, errors: ["connectorSource must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianConnectorPodSource(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Pending-approval projection (Issue #2244 → #2245 UI) ─────────────────────
const PENDING_APPROVAL_KEYS: readonly (keyof AtlassianConnectorPendingApproval)[] = [
  "schemaVersion",
  "approvalId",
  "connectorId",
  "provider",
  "actionType",
  "actionClass",
  "requiredScope",
  "risk",
  "reviewReason",
  "targetRef",
  "correlationId",
  "requestedAt",
  "expiresAt",
  "contentPreview",
  "contentPreviewUnavailable",
];

// The action row is pinned by the D4 table exactly as the activity validator pins it: a tampered
// approval cannot re-label a high-risk create as a low-risk comment or swap its required scope.
function validateApprovalActionRow(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isAtlassianConnectorActionType(input.actionType)) {
    errors.push("approval.actionType is invalid");
    valid = false;
    return valid;
  }
  const actionType: unknown = input.actionType;
  let expectedClass: unknown;
  let expectedProvider: unknown;
  let expectedScope: unknown;
  let expectedRisk: unknown;
  if (isAtlassianConnectorActionType(actionType)) {
    expectedClass = ATLASSIAN_CONNECTOR_ACTION_CLASS[actionType];
    expectedProvider = ATLASSIAN_CONNECTOR_ACTION_PROVIDER[actionType];
    expectedScope = ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[actionType];
    expectedRisk = ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[actionType];
  } else {
    errors.push("approval.actionType is invalid");
    valid = false;
  }
  if (input.actionClass !== expectedClass) {
    errors.push("approval.actionClass must match the D4 table for the action type");
    valid = false;
  }
  if (input.provider !== expectedProvider) {
    errors.push("approval.provider must match the D4 table for the action type");
    valid = false;
  }
  if (input.requiredScope !== expectedScope) {
    errors.push("approval.requiredScope must match the D4 table for the action type");
    valid = false;
  }
  if (input.risk !== expectedRisk) {
    errors.push("approval.risk must match the D4 table for the action type");
    valid = false;
  }
  return valid;
}

// The independently-optional fields: an identifier token (targetRef) and the mutually-exclusive
// content-preview pair (contentPreview / contentPreviewUnavailable, KEIKO-0186 — exactly one of
// them, or neither, is ever set: never both). Split out so the caller's own complexity stays
// under the repository's cyclomatic-complexity ceiling.
function validateApprovalOptionalFields(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.targetRef !== undefined && !isSafeAtlassianIdentifier(input.targetRef)) {
    errors.push("approval.targetRef must be a bounded identifier token when set");
    valid = false;
  }
  if (input.contentPreview !== undefined && !isSafeAtlassianContentPreview(input.contentPreview)) {
    errors.push(
      "approval.contentPreview must be a bounded, control-character-free preview when set",
    );
    valid = false;
  }
  if (input.contentPreviewUnavailable !== undefined && input.contentPreviewUnavailable !== true) {
    errors.push("approval.contentPreviewUnavailable must be true when set");
    valid = false;
  }
  if (input.contentPreview !== undefined && input.contentPreviewUnavailable !== undefined) {
    errors.push("approval.contentPreview and approval.contentPreviewUnavailable are exclusive");
    valid = false;
  }
  return valid;
}

function validateApprovalIdentity(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = onlyKnownKeys(input, PENDING_APPROVAL_KEYS, "approval", errors) && valid;
  valid = pushSchemaVersion(errors, "approval", input.schemaVersion) && valid;
  valid = pushIdentifier(errors, "approval.approvalId", input.approvalId) && valid;
  valid = pushIdentifier(errors, "approval.connectorId", input.connectorId) && valid;
  valid = pushIdentifier(errors, "approval.correlationId", input.correlationId) && valid;
  return valid;
}

function admitAtlassianConnectorPendingApproval(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianConnectorPendingApproval {
  let valid = true;
  valid = validateApprovalIdentity(input, errors) && valid;
  valid = validateApprovalActionRow(input, errors) && valid;
  if (!isOneOfStrings(input.reviewReason, ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS)) {
    errors.push("approval.reviewReason must be a review reason");
    valid = false;
  }
  valid = validateApprovalOptionalFields(input, errors) && valid;
  valid = pushTimestamp(errors, "approval.requestedAt", input.requestedAt) && valid;
  valid = pushTimestamp(errors, "approval.expiresAt", input.expiresAt) && valid;
  if (
    isFiniteNonNegativeNumber(input.requestedAt) &&
    isFiniteNonNegativeNumber(input.expiresAt) &&
    input.expiresAt < input.requestedAt
  ) {
    errors.push("approval.expiresAt must not precede approval.requestedAt");
    valid = false;
  }
  return valid;
}

export function validateAtlassianConnectorPendingApproval(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorPendingApproval> {
  if (!isRecord(input)) return { ok: false, errors: ["approval must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianConnectorPendingApproval(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Governed action execution result (Issue #2244) ───────────────────────────
const EXECUTION_SUCCEEDED_KEYS: readonly string[] = ["status", "targetRef", "version"];
const EXECUTION_FAILED_KEYS: readonly string[] = ["status", "reason", "httpStatus"];

function validateExecutionSucceeded(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = onlyKnownKeys(input, EXECUTION_SUCCEEDED_KEYS, "executionResult", errors) && valid;
  if (input.targetRef !== undefined && !isSafeAtlassianIdentifier(input.targetRef)) {
    errors.push("executionResult.targetRef must be a bounded identifier token when set");
    valid = false;
  }
  if (input.version !== undefined && !isPositiveIntWithin(input.version, Number.MAX_SAFE_INTEGER)) {
    errors.push("executionResult.version must be a positive integer when set");
    valid = false;
  }
  return valid;
}

function validateExecutionFailed(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = onlyKnownKeys(input, EXECUTION_FAILED_KEYS, "executionResult", errors) && valid;
  if (!isAtlassianConnectorWriteFailureReason(input.reason)) {
    errors.push(
      `executionResult.reason must be one of ${ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS.join("|")}`,
    );
    valid = false;
  }
  if (
    input.httpStatus !== undefined &&
    !(typeof input.httpStatus === "number" && Number.isInteger(input.httpStatus))
  ) {
    errors.push("executionResult.httpStatus must be an integer status code when set");
    valid = false;
  }
  return valid;
}

function admitAtlassianConnectorActionExecutionResult(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & AtlassianConnectorActionExecutionResult {
  let valid = true;
  if (input.status === "succeeded") {
    valid = validateExecutionSucceeded(input, errors) && valid;
  } else if (input.status === "failed") {
    valid = validateExecutionFailed(input, errors) && valid;
  } else {
    errors.push("executionResult.status must be succeeded or failed");
    return false;
  }
  return valid;
}

export function validateAtlassianConnectorActionExecutionResult(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorActionExecutionResult> {
  if (!isRecord(input)) return { ok: false, errors: ["executionResult must be an object"] };
  const errors: string[] = [];
  if (!admitAtlassianConnectorActionExecutionResult(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Live JQL search request (Issue #2248) ────────────────────────────────────
const LIVE_SEARCH_REQUEST_KEYS: readonly (keyof JiraLiveSearchRequest)[] = [
  "jql",
  "templateId",
  "maxResults",
];

// The query selector: exactly one of the opaque bounded JQL or a well-known template id. The
// JQL is validated for bounds ONLY — it stays opaque (never parsed) and never enters evidence
// (hashed or omitted, ADR-0128 D6).
function pushLiveSearchQueryErrors(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if ((input.jql === undefined) === (input.templateId === undefined)) {
    errors.push("liveSearchRequest must carry exactly one of jql or templateId");
    valid = false;
  }
  if (
    input.jql !== undefined &&
    (typeof input.jql !== "string" ||
      input.jql.length === 0 ||
      input.jql.length > ATLASSIAN_JQL_MAX_CHARS)
  ) {
    errors.push(
      `liveSearchRequest.jql must be a non-empty string of at most ${String(ATLASSIAN_JQL_MAX_CHARS)} characters`,
    );
    valid = false;
  }
  if (input.templateId !== undefined && !isAtlassianLiveSearchTemplateId(input.templateId)) {
    errors.push(
      `liveSearchRequest.templateId must be one of ${ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS.join("|")}`,
    );
    valid = false;
  }
  return valid;
}

// Fail-closed request guard: the query XOR rule plus an optional result narrowing that can never
// widen the D5 ceiling.
function admitJiraLiveSearchRequest(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & JiraLiveSearchRequest {
  let valid = true;
  valid = onlyKnownKeys(input, LIVE_SEARCH_REQUEST_KEYS, "liveSearchRequest", errors) && valid;
  valid = pushLiveSearchQueryErrors(input, errors) && valid;
  if (
    input.maxResults !== undefined &&
    !isPositiveIntWithin(input.maxResults, ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)
  ) {
    errors.push(
      `liveSearchRequest.maxResults must be a positive integer of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)}`,
    );
    valid = false;
  }
  return valid;
}

export function validateJiraLiveSearchRequest(
  input: unknown,
): AtlassianConnectorValidation<JiraLiveSearchRequest> {
  if (!isRecord(input)) return { ok: false, errors: ["liveSearchRequest must be an object"] };
  const errors: string[] = [];
  if (!admitJiraLiveSearchRequest(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Live JQL search result (Issue #2248) ─────────────────────────────────────
const LIVE_ISSUE_KEYS: readonly (keyof JiraLiveIssue)[] = [
  "key",
  "summary",
  "browseUrl",
  "metadata",
];
const LIVE_RESULT_KEYS: readonly (keyof JiraLiveSearchResult)[] = [
  "schemaVersion",
  "source",
  "queriedAt",
  "jqlDigest",
  "totalMatched",
  "truncated",
  "issues",
];

// One live hit: closed keys, a safe issue key, bounded display-safe summary, an https browse URL
// whose trailing key MUST match, and the #2243 citation-metadata projection keyed by the same
// issue key — the cross-field pinning that keeps a live hit and a synced citation structurally
// interchangeable.
function validateJiraLiveIssueEntry(entry: unknown, field: string, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(entry)) {
    errors.push(`${field} must be an object`);
    valid = false;
    return valid;
  }
  valid = onlyKnownKeys(entry, LIVE_ISSUE_KEYS, field, errors) && valid;
  if (!isSafeAtlassianIdentifier(entry.key)) {
    errors.push(`${field}.key must be a bounded identifier token`);
    valid = false;
    return valid;
  }
  if (!isSafeJiraLiveIssueSummary(entry.summary)) {
    errors.push(`${field}.summary must be bounded single-line text`);
    valid = false;
  }
  if (!isSafeJiraBrowseUrl(entry.browseUrl) || !entry.browseUrl.endsWith(`/browse/${entry.key}`)) {
    errors.push(`${field}.browseUrl must be an https browse URL ending in the issue key`);
    valid = false;
  }
  if (!isJiraIssueCitationMetadata(entry.metadata)) {
    errors.push(`${field}.metadata must be a valid citation-metadata projection`);
    valid = false;
  } else if (entry.metadata.issueKey !== entry.key) {
    errors.push(`${field}.metadata.issueKey must equal ${field}.key`);
    valid = false;
  }
  return valid;
}

function validateLiveResultIssues(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(input.issues) || input.issues.length > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS) {
    errors.push(
      `liveResult.issues must be an array of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)} issues`,
    );
    valid = false;
    return valid;
  }
  const issues = input.issues;
  if (!Array.isArray(issues)) {
    errors.push(
      `liveResult.issues must be an array of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)} issues`,
    );
    return false;
  }
  const extent = issues.length;
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS) {
    errors.push(
      `liveResult.issues must be an array of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)} issues`,
    );
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    if (!(index in issues)) {
      errors.push(`liveResult.issues[${String(index)}] must be an object`);
      return false;
    }
    valid =
      validateJiraLiveIssueEntry(issues[index], `liveResult.issues[${String(index)}]`, errors) &&
      valid;
  }
  return valid;
}

// `totalMatched` integrity (v1 semantics): the token-paginated search endpoint reports no total
// for a capped walk, so the field may only accompany a complete (`truncated: false`) result and
// must then equal the returned issue count.
function validateLiveResultTotals(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.totalMatched === undefined) return valid;
  if (!isNonNegativeSafeInteger(input.totalMatched)) {
    errors.push("liveResult.totalMatched must be a non-negative integer");
    valid = false;
    return valid;
  }
  if (input.truncated !== false) {
    errors.push("liveResult.totalMatched is only allowed for a complete (not truncated) result");
    valid = false;
    return valid;
  }
  if (Array.isArray(input.issues) && input.totalMatched !== input.issues.length) {
    errors.push("liveResult.totalMatched must equal the returned issue count");
    valid = false;
  }
  return valid;
}

function admitJiraLiveSearchResult(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & JiraLiveSearchResult {
  let valid = true;
  valid = onlyKnownKeys(input, LIVE_RESULT_KEYS, "liveResult", errors) && valid;
  valid = pushSchemaVersion(errors, "liveResult", input.schemaVersion) && valid;
  if (input.source !== "live") {
    errors.push('liveResult.source must be the literal "live"');
    valid = false;
  }
  valid = pushTimestamp(errors, "liveResult.queriedAt", input.queriedAt) && valid;
  valid = pushDigest(errors, "liveResult.jqlDigest", input.jqlDigest) && valid;
  if (typeof input.truncated !== "boolean") {
    errors.push("liveResult.truncated must be a boolean");
    valid = false;
  }
  valid = validateLiveResultIssues(input, errors) && valid;
  valid = validateLiveResultTotals(input, errors) && valid;
  return valid;
}

export function validateJiraLiveSearchResult(
  input: unknown,
): AtlassianConnectorValidation<JiraLiveSearchResult> {
  if (!isRecord(input)) return { ok: false, errors: ["liveResult must be an object"] };
  const errors: string[] = [];
  if (!admitJiraLiveSearchResult(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}
