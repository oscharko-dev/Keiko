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
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS,
  ATLASSIAN_SYNC_FAILURE_REASONS,
  ATLASSIAN_SYNC_SCOPE_MAX_KEYS,
  ATLASSIAN_SYNC_TERMINAL_STATUSES,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
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
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push(`${field} must not include ${key}`);
      return;
    }
  }
}

function pushDigest(errors: string[], field: string, value: unknown): void {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    errors.push(`${field} must be a 64-character lowercase hex digest`);
  }
}

function pushTimestamp(errors: string[], field: string, value: unknown): void {
  if (!isFiniteNonNegativeNumber(value)) {
    errors.push(`${field} must be a finite non-negative number`);
  }
}

function pushIdentifier(errors: string[], field: string, value: unknown): void {
  if (!isSafeAtlassianIdentifier(value)) {
    errors.push(`${field} must be a bounded identifier token`);
  }
}

function pushSchemaVersion(errors: string[], field: string, value: unknown): void {
  if (value !== ATLASSIAN_CONNECTOR_SCHEMA_VERSION) {
    errors.push(`${field}.schemaVersion must be the literal "1"`);
  }
}

// Validates a bounded set of unique provider keys (space or project keys).
function validateKeySet(
  value: unknown,
  field: string,
  isSafeKey: (candidate: unknown) => boolean,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (value.length === 0) {
    errors.push(`${field} must not be empty`);
    return;
  }
  if (value.length > ATLASSIAN_SYNC_SCOPE_MAX_KEYS) {
    errors.push(`${field} must contain at most ${String(ATLASSIAN_SYNC_SCOPE_MAX_KEYS)} keys`);
    return;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isSafeKey(entry)) {
      errors.push(`${field} entries must be valid keys`);
      return;
    }
    const key = entry as string;
    if (seen.has(key)) {
      errors.push(`${field} entries must be unique`);
      return;
    }
    seen.add(key);
  }
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

export function validateAtlassianConnectorDescriptor(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorDescriptor> {
  if (!isRecord(input)) return { ok: false, errors: ["descriptor must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, DESCRIPTOR_KEYS, "descriptor", errors);
  pushSchemaVersion(errors, "descriptor", input.schemaVersion);
  pushIdentifier(errors, "descriptor.id", input.id);
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("descriptor.provider must be confluence or jira");
  }
  if (!isSafeAtlassianDisplayName(input.displayName)) {
    errors.push("descriptor.displayName must be bounded redaction-safe display text");
  }
  if (!isSafeAtlassianConnectorBaseUrl(input.baseUrl)) {
    errors.push("descriptor.baseUrl must be an https URL without credentials, query, or fragment");
  }
  if (!isAtlassianConnectorAuthScheme(input.authScheme)) {
    errors.push("descriptor.authScheme must be basic-api-token or bearer-pat");
  }
  if (!isAtlassianConnectorAuthRef(input.authRef)) {
    errors.push("descriptor.authRef must be an opaque atlassian-cred vault reference");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianConnectorDescriptor };
}

// ─── Sync bounds (ADR-0128 D5 — narrow-only against the declared defaults) ────
const SYNC_BOUNDS_KEYS: readonly (keyof AtlassianSyncBounds)[] = [
  "maxItems",
  "maxBytes",
  "maxDurationMs",
  "maxConcurrency",
];

export function validateAtlassianSyncBounds(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncBounds> {
  if (!isRecord(input)) return { ok: false, errors: ["bounds must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, SYNC_BOUNDS_KEYS, "bounds", errors);
  for (const key of SYNC_BOUNDS_KEYS) {
    if (!isPositiveIntWithin(input[key], DEFAULT_ATLASSIAN_SYNC_BOUNDS[key])) {
      errors.push(`bounds.${key} must be a positive integer that does not widen the D5 default`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianSyncBounds };
}

// ─── Sync scope ─────────────────────────────────────────────────────────────────
const CONFLUENCE_SCOPE_KEYS: readonly string[] = ["provider", "spaceKeys", "bounds"];
const JIRA_SCOPE_KEYS: readonly string[] = ["provider", "projectKeys", "jql", "bounds"];

// JQL is opaque user input executed under the user's own token: bounded and transported, never
// parsed and never surfaced in evidence (ADR-0128 D6 hashes or omits it).
function validateOpaqueJql(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0 || value.length > ATLASSIAN_JQL_MAX_CHARS) {
    errors.push(
      `scope.jql must be a non-empty string of at most ${String(ATLASSIAN_JQL_MAX_CHARS)} characters`,
    );
  }
}

function validateScopeBounds(value: unknown, errors: string[]): void {
  const bounds = validateAtlassianSyncBounds(value);
  if (!bounds.ok) {
    errors.push(...bounds.errors.map((error) => `scope.${error}`));
  }
}

export function validateAtlassianSyncScope(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncScope> {
  if (!isRecord(input)) return { ok: false, errors: ["scope must be an object"] };
  const errors: string[] = [];
  if (input.provider === "confluence") {
    onlyKnownKeys(input, CONFLUENCE_SCOPE_KEYS, "scope", errors);
    validateKeySet(input.spaceKeys, "scope.spaceKeys", isSafeConfluenceSpaceKey, errors);
  } else if (input.provider === "jira") {
    onlyKnownKeys(input, JIRA_SCOPE_KEYS, "scope", errors);
    validateKeySet(input.projectKeys, "scope.projectKeys", isSafeJiraProjectKey, errors);
    validateOpaqueJql(input.jql, errors);
  } else {
    return { ok: false, errors: ["scope.provider must be confluence or jira"] };
  }
  validateScopeBounds(input.bounds, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianSyncScope };
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
): void {
  if (!isRecord(input)) {
    errors.push(`${field} must be an object`);
    return;
  }
  onlyKnownKeys(input, keys, field, errors);
  for (const key of keys) {
    if (!isNonNegativeSafeInteger(input[key])) {
      errors.push(`${field}.${key} must be a non-negative integer`);
      return;
    }
  }
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
function validateNotAppliedZeroCounts(input: Record<string, unknown>, errors: string[]): void {
  if (input.outcome !== "failed" && input.outcome !== "cancelled") return;
  const counts = input.counts;
  if (!isRecord(counts)) return;
  for (const key of ["addedItems", "changedItems", "removedItems"] as const) {
    if (counts[key] !== 0) {
      errors.push(`changeSummary.counts.${key} must be 0 for a ${input.outcome} run`);
      return;
    }
  }
}

export function validateAtlassianSyncChangeSummary(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncChangeSummary> {
  if (!isRecord(input)) return { ok: false, errors: ["changeSummary must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, CHANGE_SUMMARY_KEYS, "changeSummary", errors);
  pushSchemaVersion(errors, "changeSummary", input.schemaVersion);
  if (
    typeof input.outcome !== "string" ||
    !(ATLASSIAN_SYNC_TERMINAL_STATUSES as readonly string[]).includes(input.outcome)
  ) {
    errors.push(
      `changeSummary.outcome must be one of ${ATLASSIAN_SYNC_TERMINAL_STATUSES.join("|")}`,
    );
  }
  validateCountRecord(input.counts, CHANGE_COUNT_KEYS, "changeSummary.counts", errors);
  pushDigest(errors, "changeSummary.fingerprintSetDigest", input.fingerprintSetDigest);
  pushTimestamp(errors, "changeSummary.completedAt", input.completedAt);
  validateNotAppliedZeroCounts(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianSyncChangeSummary };
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

function validateJobCommon(input: Record<string, unknown>, errors: string[]): void {
  pushSchemaVersion(errors, "syncJob", input.schemaVersion);
  pushIdentifier(errors, "syncJob.jobId", input.jobId);
  pushIdentifier(errors, "syncJob.connectorId", input.connectorId);
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("syncJob.provider must be confluence or jira");
  }
  pushTimestamp(errors, "syncJob.queuedAt", input.queuedAt);
  validateCountRecord(input.progress, PROGRESS_COUNT_KEYS, "syncJob.progress", errors);
}

function validateJobTimestamps(
  input: Record<string, unknown>,
  status: AtlassianSyncJobStatus,
  errors: string[],
): void {
  if (JOB_STARTED_AT_REQUIRED.has(status) || input.startedAt !== undefined) {
    pushTimestamp(errors, "syncJob.startedAt", input.startedAt);
  }
  if (status !== "pending" && status !== "running") {
    pushTimestamp(errors, "syncJob.completedAt", input.completedAt);
  }
}

function validateJobFailureReasons(input: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(input.failureReasons) || input.failureReasons.length === 0) {
    errors.push("syncJob.failureReasons must be a non-empty array for a partial run");
    return;
  }
  const seen = new Set<string>();
  for (const reason of input.failureReasons) {
    if (!isAtlassianSyncFailureReason(reason)) {
      errors.push(
        `syncJob.failureReasons entries must be one of ${ATLASSIAN_SYNC_FAILURE_REASONS.join("|")}`,
      );
      return;
    }
    if (seen.has(reason)) {
      errors.push("syncJob.failureReasons entries must be unique");
      return;
    }
    seen.add(reason);
  }
}

// The terminal change summary must agree with the job status: a `failed` job carries a `failed`
// summary, never a stale `succeeded` one.
function validateJobTerminalFields(
  input: Record<string, unknown>,
  status: AtlassianSyncTerminalStatus,
  errors: string[],
): void {
  const summary = validateAtlassianSyncChangeSummary(input.changeSummary);
  if (!summary.ok) {
    errors.push(...summary.errors.map((error) => `syncJob.${error}`));
  } else if (summary.value.outcome !== status) {
    errors.push(`syncJob.changeSummary.outcome must equal the job status ${status}`);
  }
  if (status === "failed" && !isAtlassianSyncFailureReason(input.failureReason)) {
    errors.push(`syncJob.failureReason must be one of ${ATLASSIAN_SYNC_FAILURE_REASONS.join("|")}`);
  }
  if (status === "partial") {
    validateJobFailureReasons(input, errors);
  }
}

export function validateAtlassianSyncJobState(
  input: unknown,
): AtlassianConnectorValidation<AtlassianSyncJobState> {
  if (!isRecord(input)) return { ok: false, errors: ["syncJob must be an object"] };
  if (!isAtlassianSyncJobStatus(input.status)) {
    return { ok: false, errors: ["syncJob.status is invalid"] };
  }
  const status = input.status;
  const errors: string[] = [];
  onlyKnownKeys(
    input,
    [...JOB_COMMON_KEYS, ...JOB_EXTRA_KEYS_BY_STATUS[status]],
    "syncJob",
    errors,
  );
  validateJobCommon(input, errors);
  validateJobTimestamps(input, status, errors);
  if (status !== "pending" && status !== "running") {
    validateJobTerminalFields(input, status, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianSyncJobState };
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

function validateActivityIdentity(input: Record<string, unknown>, errors: string[]): void {
  pushSchemaVersion(errors, "activity", input.schemaVersion);
  pushIdentifier(errors, "activity.activityId", input.activityId);
  pushTimestamp(errors, "activity.occurredAt", input.occurredAt);
  pushIdentifier(errors, "activity.connectorId", input.connectorId);
  pushIdentifier(errors, "activity.correlationId", input.correlationId);
  if (!isNonNegativeSafeInteger(input.durationMs)) {
    errors.push("activity.durationMs must be a non-negative integer");
  }
  if (input.targetRef !== undefined && !isSafeAtlassianIdentifier(input.targetRef)) {
    errors.push("activity.targetRef must be a bounded identifier token when set");
  }
}

// The action rows are pinned by the D4 table: the recorded class and provider must match the
// action type, so a tampered record cannot re-label a write as a read.
function validateActivityActionConsistency(input: Record<string, unknown>, errors: string[]): void {
  if (!isAtlassianConnectorActionType(input.actionType)) {
    errors.push("activity.actionType is invalid");
    return;
  }
  if (input.actionClass !== ATLASSIAN_CONNECTOR_ACTION_CLASS[input.actionType]) {
    errors.push("activity.actionClass must match the D4 table for the action type");
  }
  if (input.provider !== ATLASSIAN_CONNECTOR_ACTION_PROVIDER[input.actionType]) {
    errors.push("activity.provider must match the D4 table for the action type");
  }
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
function validateAllowedAttemptReason(input: Record<string, unknown>, errors: string[]): void {
  if (input.outcome === "denied") {
    errors.push("activity.outcome must not be denied for an allowed attempt");
  }
  if (
    input.reasonCode !== undefined &&
    !isExecutionFailureReason(input.reasonCode) &&
    input.reasonCode !== ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON
  ) {
    errors.push(
      "activity.reasonCode must be an execution failure reason or human-initiated for an allowed attempt",
    );
  }
  if (input.outcome === "failed" && !isExecutionFailureReason(input.reasonCode)) {
    errors.push("activity.reasonCode must be an execution failure reason for a failed attempt");
  }
}

// A review-required attempt carries its one review reason while pending, approved-and-succeeded,
// or rejected (`cancelled`); an approved execution that then failed carries the closed execution
// failure reason instead, so the provider outcome is never lost from the trail.
function validateReviewRequiredAttemptReason(
  input: Record<string, unknown>,
  errors: string[],
): void {
  if (input.outcome === "failed") {
    if (!isExecutionFailureReason(input.reasonCode)) {
      errors.push(
        "activity.reasonCode must be an execution failure reason for a failed review-required attempt",
      );
    }
    return;
  }
  if (!isOneOfStrings(input.reasonCode, ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS)) {
    errors.push("activity.reasonCode must be a review reason for a review-required attempt");
  }
}

// Exactly-one-reason pairing (ADR-0125 disposition rule applied to connector activity):
// denied → one central denial reason or one envelope-authority failure code; review-required →
// one review reason (or the execution failure reason after an approved run failed); allowed →
// see above.
function validateActivityReasonPairing(input: Record<string, unknown>, errors: string[]): void {
  if (input.disposition === "denied") {
    if (
      !isOneOfStrings(input.reasonCode, CODING_WORKBENCH_POLICY_DENIAL_REASONS) &&
      !isOneOfStrings(input.reasonCode, ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS)
    ) {
      errors.push(
        "activity.reasonCode must be a policy denial or authority failure reason for a denied attempt",
      );
    }
    if (input.outcome !== "denied") {
      errors.push("activity.outcome must be denied for a denied attempt");
    }
    return;
  }
  if (input.disposition === "review-required") {
    validateReviewRequiredAttemptReason(input, errors);
    return;
  }
  validateAllowedAttemptReason(input, errors);
}

// `syncSummary` may only accompany sync actions; `jqlDigest` (sha256 of the JQL, never the text)
// may only accompany `search-issues-live` (ADR-0128 D6).
function validateActivityActionPayloads(input: Record<string, unknown>, errors: string[]): void {
  if (input.syncSummary !== undefined) {
    if (!isOneOfStrings(input.actionType, SYNC_ACTION_TYPES)) {
      errors.push("activity.syncSummary is only allowed for sync actions");
    } else {
      const summary = validateAtlassianSyncChangeSummary(input.syncSummary);
      if (!summary.ok) {
        errors.push(...summary.errors.map((error) => `activity.${error}`));
      }
    }
  }
  if (input.jqlDigest !== undefined) {
    if (input.actionType !== "search-issues-live") {
      errors.push("activity.jqlDigest is only allowed for search-issues-live");
    } else {
      pushDigest(errors, "activity.jqlDigest", input.jqlDigest);
    }
  }
  validateActivityLiveResultFields(input, errors);
}

// `resultCount`/`resultIssueKeys` (Issue #2248) may only accompany `search-issues-live`: a
// bounded count and bounded identifier list — the D6 "counts and issue keys" audit vocabulary.
// When both are present they must agree, so a tampered record cannot claim one count and list
// another.
function validateActivityLiveResultCount(input: Record<string, unknown>, errors: string[]): void {
  if (input.resultCount === undefined) return;
  if (input.actionType !== "search-issues-live") {
    errors.push("activity.resultCount is only allowed for search-issues-live");
    return;
  }
  if (
    !isNonNegativeSafeInteger(input.resultCount) ||
    input.resultCount > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS
  ) {
    errors.push(
      `activity.resultCount must be a non-negative integer of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)}`,
    );
  }
}

function validateActivityLiveResultKeys(input: Record<string, unknown>, errors: string[]): void {
  if (input.resultIssueKeys === undefined) return;
  if (input.actionType !== "search-issues-live") {
    errors.push("activity.resultIssueKeys is only allowed for search-issues-live");
    return;
  }
  if (
    !Array.isArray(input.resultIssueKeys) ||
    input.resultIssueKeys.length > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS ||
    !input.resultIssueKeys.every((key) => isSafeAtlassianIdentifier(key))
  ) {
    errors.push("activity.resultIssueKeys must be a bounded array of identifier tokens");
    return;
  }
  if (input.resultCount !== undefined && input.resultIssueKeys.length !== input.resultCount) {
    errors.push("activity.resultIssueKeys length must equal activity.resultCount");
  }
}

function validateActivityLiveResultFields(input: Record<string, unknown>, errors: string[]): void {
  validateActivityLiveResultCount(input, errors);
  validateActivityLiveResultKeys(input, errors);
}

export function validateAtlassianConnectorActivityRecord(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorActivityRecord> {
  if (!isRecord(input)) return { ok: false, errors: ["activity must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, ACTIVITY_RECORD_KEYS, "activity", errors);
  validateActivityIdentity(input, errors);
  validateActivityActionConsistency(input, errors);
  if (!isOneOfStrings(input.disposition, ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS)) {
    errors.push("activity.disposition is invalid");
  }
  if (!isOneOfStrings(input.outcome, ATLASSIAN_CONNECTOR_ACTIVITY_OUTCOMES)) {
    errors.push("activity.outcome is invalid");
  }
  validateActivityReasonPairing(input, errors);
  validateActivityActionPayloads(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianConnectorActivityRecord };
}

// ─── Connector-pod source metadata (#2240 Scope 6) ────────────────────────────
const POD_SOURCE_KEYS: readonly (keyof AtlassianConnectorPodSource)[] = [
  "provider",
  "connectorId",
  "scopeLabels",
  "lastSyncAt",
  "lastChangeSummary",
];

export function validateAtlassianConnectorPodSource(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorPodSource> {
  if (!isRecord(input)) return { ok: false, errors: ["connectorSource must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, POD_SOURCE_KEYS, "connectorSource", errors);
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("connectorSource.provider must be confluence or jira");
  }
  pushIdentifier(errors, "connectorSource.connectorId", input.connectorId);
  validateKeySet(
    input.scopeLabels,
    "connectorSource.scopeLabels",
    isSafeAtlassianIdentifier,
    errors,
  );
  if (input.lastSyncAt !== undefined) {
    pushTimestamp(errors, "connectorSource.lastSyncAt", input.lastSyncAt);
  }
  if (input.lastChangeSummary !== undefined) {
    const summary = validateAtlassianSyncChangeSummary(input.lastChangeSummary);
    if (!summary.ok) {
      errors.push(...summary.errors.map((error) => `connectorSource.${error}`));
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianConnectorPodSource };
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
];

// The action row is pinned by the D4 table exactly as the activity validator pins it: a tampered
// approval cannot re-label a high-risk create as a low-risk comment or swap its required scope.
function validateApprovalActionRow(input: Record<string, unknown>, errors: string[]): void {
  if (!isAtlassianConnectorActionType(input.actionType)) {
    errors.push("approval.actionType is invalid");
    return;
  }
  const actionType = input.actionType;
  if (input.actionClass !== ATLASSIAN_CONNECTOR_ACTION_CLASS[actionType]) {
    errors.push("approval.actionClass must match the D4 table for the action type");
  }
  if (input.provider !== ATLASSIAN_CONNECTOR_ACTION_PROVIDER[actionType]) {
    errors.push("approval.provider must match the D4 table for the action type");
  }
  if (input.requiredScope !== ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[actionType]) {
    errors.push("approval.requiredScope must match the D4 table for the action type");
  }
  if (input.risk !== ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[actionType]) {
    errors.push("approval.risk must match the D4 table for the action type");
  }
}

export function validateAtlassianConnectorPendingApproval(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorPendingApproval> {
  if (!isRecord(input)) return { ok: false, errors: ["approval must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, PENDING_APPROVAL_KEYS, "approval", errors);
  pushSchemaVersion(errors, "approval", input.schemaVersion);
  pushIdentifier(errors, "approval.approvalId", input.approvalId);
  pushIdentifier(errors, "approval.connectorId", input.connectorId);
  pushIdentifier(errors, "approval.correlationId", input.correlationId);
  validateApprovalActionRow(input, errors);
  if (!isOneOfStrings(input.reviewReason, ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS)) {
    errors.push("approval.reviewReason must be a review reason");
  }
  if (input.targetRef !== undefined && !isSafeAtlassianIdentifier(input.targetRef)) {
    errors.push("approval.targetRef must be a bounded identifier token when set");
  }
  pushTimestamp(errors, "approval.requestedAt", input.requestedAt);
  pushTimestamp(errors, "approval.expiresAt", input.expiresAt);
  if (
    isFiniteNonNegativeNumber(input.requestedAt) &&
    isFiniteNonNegativeNumber(input.expiresAt) &&
    input.expiresAt < input.requestedAt
  ) {
    errors.push("approval.expiresAt must not precede approval.requestedAt");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianConnectorPendingApproval };
}

// ─── Governed action execution result (Issue #2244) ───────────────────────────
const EXECUTION_SUCCEEDED_KEYS: readonly string[] = ["status", "targetRef", "version"];
const EXECUTION_FAILED_KEYS: readonly string[] = ["status", "reason", "httpStatus"];

function validateExecutionSucceeded(input: Record<string, unknown>, errors: string[]): void {
  onlyKnownKeys(input, EXECUTION_SUCCEEDED_KEYS, "executionResult", errors);
  if (input.targetRef !== undefined && !isSafeAtlassianIdentifier(input.targetRef)) {
    errors.push("executionResult.targetRef must be a bounded identifier token when set");
  }
  if (input.version !== undefined && !isPositiveIntWithin(input.version, Number.MAX_SAFE_INTEGER)) {
    errors.push("executionResult.version must be a positive integer when set");
  }
}

function validateExecutionFailed(input: Record<string, unknown>, errors: string[]): void {
  onlyKnownKeys(input, EXECUTION_FAILED_KEYS, "executionResult", errors);
  if (!isAtlassianConnectorWriteFailureReason(input.reason)) {
    errors.push(
      `executionResult.reason must be one of ${ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS.join("|")}`,
    );
  }
  if (
    input.httpStatus !== undefined &&
    !(typeof input.httpStatus === "number" && Number.isInteger(input.httpStatus))
  ) {
    errors.push("executionResult.httpStatus must be an integer status code when set");
  }
}

export function validateAtlassianConnectorActionExecutionResult(
  input: unknown,
): AtlassianConnectorValidation<AtlassianConnectorActionExecutionResult> {
  if (!isRecord(input)) return { ok: false, errors: ["executionResult must be an object"] };
  const errors: string[] = [];
  if (input.status === "succeeded") {
    validateExecutionSucceeded(input, errors);
  } else if (input.status === "failed") {
    validateExecutionFailed(input, errors);
  } else {
    return { ok: false, errors: ["executionResult.status must be succeeded or failed"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as AtlassianConnectorActionExecutionResult };
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
function pushLiveSearchQueryErrors(input: Record<string, unknown>, errors: string[]): void {
  if ((input.jql === undefined) === (input.templateId === undefined)) {
    errors.push("liveSearchRequest must carry exactly one of jql or templateId");
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
  }
  if (input.templateId !== undefined && !isAtlassianLiveSearchTemplateId(input.templateId)) {
    errors.push(
      `liveSearchRequest.templateId must be one of ${ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS.join("|")}`,
    );
  }
}

// Fail-closed request guard: the query XOR rule plus an optional result narrowing that can never
// widen the D5 ceiling.
export function validateJiraLiveSearchRequest(
  input: unknown,
): AtlassianConnectorValidation<JiraLiveSearchRequest> {
  if (!isRecord(input)) return { ok: false, errors: ["liveSearchRequest must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, LIVE_SEARCH_REQUEST_KEYS, "liveSearchRequest", errors);
  pushLiveSearchQueryErrors(input, errors);
  if (
    input.maxResults !== undefined &&
    !isPositiveIntWithin(input.maxResults, ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)
  ) {
    errors.push(
      `liveSearchRequest.maxResults must be a positive integer of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)}`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as JiraLiveSearchRequest };
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
function validateJiraLiveIssueEntry(entry: unknown, field: string, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push(`${field} must be an object`);
    return;
  }
  onlyKnownKeys(entry, LIVE_ISSUE_KEYS, field, errors);
  if (!isSafeAtlassianIdentifier(entry.key)) {
    errors.push(`${field}.key must be a bounded identifier token`);
    return;
  }
  if (!isSafeJiraLiveIssueSummary(entry.summary)) {
    errors.push(`${field}.summary must be bounded single-line text`);
  }
  if (!isSafeJiraBrowseUrl(entry.browseUrl) || !entry.browseUrl.endsWith(`/browse/${entry.key}`)) {
    errors.push(`${field}.browseUrl must be an https browse URL ending in the issue key`);
  }
  if (!isJiraIssueCitationMetadata(entry.metadata)) {
    errors.push(`${field}.metadata must be a valid citation-metadata projection`);
  } else if (entry.metadata.issueKey !== entry.key) {
    errors.push(`${field}.metadata.issueKey must equal ${field}.key`);
  }
}

function validateLiveResultIssues(input: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(input.issues) || input.issues.length > ATLASSIAN_LIVE_SEARCH_MAX_RESULTS) {
    errors.push(
      `liveResult.issues must be an array of at most ${String(ATLASSIAN_LIVE_SEARCH_MAX_RESULTS)} issues`,
    );
    return;
  }
  input.issues.forEach((entry, index) => {
    validateJiraLiveIssueEntry(entry, `liveResult.issues[${String(index)}]`, errors);
  });
}

// `totalMatched` integrity (v1 semantics): the token-paginated search endpoint reports no total
// for a capped walk, so the field may only accompany a complete (`truncated: false`) result and
// must then equal the returned issue count.
function validateLiveResultTotals(input: Record<string, unknown>, errors: string[]): void {
  if (input.totalMatched === undefined) return;
  if (!isNonNegativeSafeInteger(input.totalMatched)) {
    errors.push("liveResult.totalMatched must be a non-negative integer");
    return;
  }
  if (input.truncated !== false) {
    errors.push("liveResult.totalMatched is only allowed for a complete (not truncated) result");
    return;
  }
  if (Array.isArray(input.issues) && input.totalMatched !== input.issues.length) {
    errors.push("liveResult.totalMatched must equal the returned issue count");
  }
}

export function validateJiraLiveSearchResult(
  input: unknown,
): AtlassianConnectorValidation<JiraLiveSearchResult> {
  if (!isRecord(input)) return { ok: false, errors: ["liveResult must be an object"] };
  const errors: string[] = [];
  onlyKnownKeys(input, LIVE_RESULT_KEYS, "liveResult", errors);
  pushSchemaVersion(errors, "liveResult", input.schemaVersion);
  if (input.source !== "live") {
    errors.push('liveResult.source must be the literal "live"');
  }
  pushTimestamp(errors, "liveResult.queriedAt", input.queriedAt);
  pushDigest(errors, "liveResult.jqlDigest", input.jqlDigest);
  if (typeof input.truncated !== "boolean") {
    errors.push("liveResult.truncated must be a boolean");
  }
  validateLiveResultIssues(input, errors);
  validateLiveResultTotals(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as JiraLiveSearchResult };
}
