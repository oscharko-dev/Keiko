// Atlassian connector source, sync, and action contracts (Issue #2240, Epic #2238, ADR-0128).
//
// Shared leaf vocabulary for the governed Confluence/Jira connector lane: connector descriptors
// (never the secret — only the opaque `authRef` vault handle, ADR-0128 D2), bounded sync scopes
// (D5), the sync-job lifecycle union, the D4 action-class mapping table, and the pure per-mode
// decision helper that composes with the shared Workbench authority model exactly as
// `editor-agent-governance.ts` does for editor actions (stricter-wins, exactly one content-free
// reason).
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports, no Node APIs, no
// IO, no clock, no hashing, no randomness. Digests (`fingerprintSetDigest`, `jqlDigest`) are
// computed downstream with `keiko-security` hashing and only VERIFIED here. Every evidence-facing
// shape is content-free by construction: enums, counts, identifiers, hashes, and durations — no
// field can hold an issue/page body, comment text, raw JQL, token, or URL.

import {
  codingWorkbenchPolicyEffectFor,
  decideCodingWorkbenchActionForMode,
  strictestCodingWorkbenchPolicyEffect,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchApprovalRisk,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
  type CodingWorkbenchPolicyDenialReason,
  type CodingWorkbenchPolicyEffect,
  type CodingWorkbenchPolicyResourceScope,
  type CodingWorkbenchSupervisedActionKind,
} from "./coding-workbench.js";
import {
  containsAbsolutePath,
  containsPseudoRoleMarker,
  stripUnsafeFormatChars,
} from "./text-safety.js";

// ─── Schema version ───────────────────────────────────────────────────────────
// Pinned to "1". A breaking change introduces a NEW literal rather than mutating "1", the same
// evolution rule as `CODING_WORKBENCH_SCHEMA_VERSION` and the other audit surfaces.
export const ATLASSIAN_CONNECTOR_SCHEMA_VERSION = "1" as const;

// ─── Provider and auth scheme (ADR-0128 D2) ──────────────────────────────────
export type AtlassianConnectorProvider = "confluence" | "jira";

export const ATLASSIAN_CONNECTOR_PROVIDERS: readonly AtlassianConnectorProvider[] = Object.freeze([
  "confluence",
  "jira",
] as const satisfies readonly AtlassianConnectorProvider[]);

// `basic-api-token` is the only implemented v1 scheme (Atlassian Cloud). `bearer-pat` is declared
// now for the Data Center follow-up (ADR-0128 D7) so the credential shape never needs a breaking
// change; no runtime ships for it in v1.
export type AtlassianConnectorAuthScheme = "basic-api-token" | "bearer-pat";

export const ATLASSIAN_CONNECTOR_AUTH_SCHEMES: readonly AtlassianConnectorAuthScheme[] =
  Object.freeze([
    "basic-api-token",
    "bearer-pat",
  ] as const satisfies readonly AtlassianConnectorAuthScheme[]);

// The bounded connection-verification probe outcome (ADR-0128 D3). A wire type: the server verify
// route (keiko-connectors probe → keiko-server route) returns exactly one of these, and every UI
// surface renders exactly these actionable states — never a raw provider error. Defined in this
// leaf so both the server package and the UI share one source of truth (no re-declaration).
export type AtlassianConnectionVerificationStatus =
  "ok" | "auth-failed" | "forbidden" | "unreachable" | "timeout";

export const ATLASSIAN_CONNECTION_VERIFICATION_STATUSES: readonly AtlassianConnectionVerificationStatus[] =
  Object.freeze([
    "ok",
    "auth-failed",
    "forbidden",
    "unreachable",
    "timeout",
  ] as const satisfies readonly AtlassianConnectionVerificationStatus[]);

export function isAtlassianConnectionVerificationStatus(
  value: unknown,
): value is AtlassianConnectionVerificationStatus {
  return isOneOf(value, ATLASSIAN_CONNECTION_VERIFICATION_STATUSES);
}

// Opaque credential handle generated server-side at credential-write time (ADR-0128 D2):
// `atlassian-cred:<16 random bytes, base64url>`. 16 bytes encode to exactly 22 unpadded base64url
// characters. The descriptor carries only this reference; the secret lives in the dedicated vault.
export const ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX = "atlassian-cred:" as const;

const ATLASSIAN_CONNECTOR_AUTH_REF_PATTERN = /^atlassian-cred:[A-Za-z0-9_-]{22}$/u;

export function isAtlassianConnectorAuthRef(value: unknown): value is string {
  return typeof value === "string" && ATLASSIAN_CONNECTOR_AUTH_REF_PATTERN.test(value);
}

// ─── Bounded identifiers and display text ─────────────────────────────────────
export const ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS = 2048;
export const ATLASSIAN_CONNECTOR_DISPLAY_NAME_MAX_CHARS = 100;
export const ATLASSIAN_CONNECTOR_IDENTIFIER_MAX_CHARS = 128;

// Provider-assigned or Keiko-assigned identifier tokens: connector ids, job ids, activity ids,
// correlation ids, issue keys ("PROJ-123"), page ids, and scope labels. Allowlist, not denylist:
// no `/`, `:`, `@`, or whitespace can appear, so a URL, path, credential, or header can never ride
// an identifier field. `~` leads Confluence personal-space keys.
const ATLASSIAN_IDENTIFIER_PATTERN = /^[A-Za-z0-9~][A-Za-z0-9._~-]{0,127}$/u;

export function isSafeAtlassianIdentifier(value: unknown): value is string {
  return typeof value === "string" && ATLASSIAN_IDENTIFIER_PATTERN.test(value);
}

// URL/credential markers that must never appear in a display name (`@`, `?`, `#`, `://`). The
// base-URL guard below applies its own string-level variant of this rule before parsing.
function containsUrlOrCredentialMarker(value: string): boolean {
  return value.includes("@") || value.includes("?") || value.includes("#") || value.includes("://");
}

// Redaction-safe display name: bounded, no unsafe format characters, no filesystem path, no
// pseudo-role prompt marker, and none of the URL/credential markers. Mirrors the
// html-manual-source display-text backstop.
export function isSafeAtlassianDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) return false;
  if (value.length > ATLASSIAN_CONNECTOR_DISPLAY_NAME_MAX_CHARS) return false;
  if (stripUnsafeFormatChars(value) !== value) return false;
  if (containsAbsolutePath(value) || containsPseudoRoleMarker(value)) return false;
  return !containsUrlOrCredentialMarker(value);
}

// ─── Base URL validation (ADR-0128 D3) ────────────────────────────────────────
// The WHATWG parser guarantees a non-empty host for `https:` URLs (an empty host is a parse
// error), so no separate hostname check is needed after a successful parse.
function isSafeParsedBaseUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}

// HTTPS only; no embedded credentials; no query; no fragment. A path is allowed (Data Center
// context paths). The parsed-URL checks catch real userinfo/query/fragment components; the
// string-level scan afterwards is fail-closed defense in depth for the empty-marker forms
// (`https://:@host`, trailing `?` or `#`) that parse with empty userinfo/search/hash. The same
// validation runs again at request-construction time downstream (ADR-0128 D3).
export function isSafeAtlassianConnectorBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS) return false;
  if (/\s/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!isSafeParsedBaseUrl(url)) return false;
  return !value.includes("@") && !value.includes("?") && !value.includes("#");
}

// ─── Connector descriptor (ADR-0128 D2) ───────────────────────────────────────
// The non-secret projection every server route returns. It has NO field that could carry the
// credential: the secret is written once into the dedicated vault under `authRef` and resolved
// only by the outbound HTTP adapter in `keiko-server`.
export interface AtlassianConnectorDescriptor {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly id: string;
  readonly provider: AtlassianConnectorProvider;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authScheme: AtlassianConnectorAuthScheme;
  readonly authRef: string;
}

// ─── Sync scope (ADR-0128 D5) ─────────────────────────────────────────────────
// Confluence space keys are alphanumeric with an optional `~` personal-space prefix (the marker
// is not counted against the 255-character key bound). Jira project keys start with an uppercase
// letter (Jira's default cap is 10 characters; the bound tolerates admin-widened instances
// without becoming unbounded).
export const ATLASSIAN_SYNC_SCOPE_MAX_KEYS = 50;
export const ATLASSIAN_CONFLUENCE_SPACE_KEY_MAX_CHARS = 255;
export const ATLASSIAN_JIRA_PROJECT_KEY_MAX_CHARS = 32;
// JQL is opaque user input executed under the user's own token; the contract only bounds and
// transports it. No JQL parsing in v1, and it never appears in evidence (D6: hashed or omitted).
export const ATLASSIAN_JQL_MAX_CHARS = 2048;

const CONFLUENCE_SPACE_KEY_PATTERN = /^~?[A-Za-z0-9]{1,255}$/u;
const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/u;

export function isSafeConfluenceSpaceKey(value: unknown): value is string {
  return typeof value === "string" && CONFLUENCE_SPACE_KEY_PATTERN.test(value);
}

export function isSafeJiraProjectKey(value: unknown): value is string {
  return typeof value === "string" && JIRA_PROJECT_KEY_PATTERN.test(value);
}

// Shared, explicit run bounds. Defaults are the declared D5 ceilings: a later child may narrow
// but never widen them (mirroring `DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS`).
export interface AtlassianSyncBounds {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly maxConcurrency: number;
}

export const DEFAULT_ATLASSIAN_SYNC_BOUNDS: AtlassianSyncBounds = Object.freeze({
  maxItems: 2_000,
  maxBytes: 50_000_000,
  maxDurationMs: 900_000,
  maxConcurrency: 4,
} as const satisfies AtlassianSyncBounds);

// Live `search-issues-live` result ceiling (ADR-0128 D5, Issue #2248).
export const ATLASSIAN_LIVE_SEARCH_MAX_RESULTS = 100;

export interface ConfluenceSyncScope {
  readonly provider: "confluence";
  readonly spaceKeys: readonly string[];
  readonly bounds: AtlassianSyncBounds;
}

export interface JiraSyncScope {
  readonly provider: "jira";
  readonly projectKeys: readonly string[];
  readonly jql?: string | undefined;
  readonly bounds: AtlassianSyncBounds;
}

export type AtlassianSyncScope = ConfluenceSyncScope | JiraSyncScope;

// ─── Sync job lifecycle (ADR-0128 D5) ─────────────────────────────────────────
export type AtlassianSyncJobStatus =
  "pending" | "running" | "partial" | "succeeded" | "failed" | "cancelled";

export const ATLASSIAN_SYNC_JOB_STATUSES: readonly AtlassianSyncJobStatus[] = Object.freeze([
  "pending",
  "running",
  "partial",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly AtlassianSyncJobStatus[]);

export type AtlassianSyncTerminalStatus = "partial" | "succeeded" | "failed" | "cancelled";

export const ATLASSIAN_SYNC_TERMINAL_STATUSES: readonly AtlassianSyncTerminalStatus[] =
  Object.freeze([
    "partial",
    "succeeded",
    "failed",
    "cancelled",
  ] as const satisfies readonly AtlassianSyncTerminalStatus[]);

// Content-free failure reasons. Item- and run-level failures are always one of these closed
// codes; a raw upstream error message, response body, or URL never enters the contract.
export type AtlassianSyncFailureReason =
  | "auth-failed"
  | "permission-denied"
  | "rate-limited"
  | "timeout"
  | "unavailable"
  | "scope-exceeded"
  | "bounds-exceeded"
  | "cancelled"
  | "malformed-payload";

export const ATLASSIAN_SYNC_FAILURE_REASONS: readonly AtlassianSyncFailureReason[] = Object.freeze([
  "auth-failed",
  "permission-denied",
  "rate-limited",
  "timeout",
  "unavailable",
  "scope-exceeded",
  "bounds-exceeded",
  "cancelled",
  "malformed-payload",
] as const satisfies readonly AtlassianSyncFailureReason[]);

// Per-run progress counters. Non-negative integers only; no item content.
export interface AtlassianSyncProgressCounts {
  readonly enumeratedItems: number;
  readonly fetchedItems: number;
  readonly indexedItems: number;
  readonly skippedItems: number;
  readonly failedItems: number;
}

// Fingerprint-diff change counts (ADR-0128 D5). The same closed shape as the Epic #1856
// `ManualRefreshChangeCounts` minus the moved-page category, which cannot occur for Atlassian
// items: issue keys and page ids are stable provider identifiers, not resolved paths.
export interface AtlassianSyncChangeCounts {
  readonly addedItems: number;
  readonly changedItems: number;
  readonly removedItems: number;
  readonly unchangedItems: number;
  readonly failedItems: number;
  readonly deniedItems: number;
}

// Redacted change summary of one terminal sync run: outcome enum, counts, the run's
// fingerprint-set digest (sha256 hex, computed downstream), and a completion timestamp. A run
// that did not apply (failed or cancelled) reports zero added/changed/removed items so it can
// never be misread as "nothing changed upstream" (D5).
export interface AtlassianSyncChangeSummary {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly outcome: AtlassianSyncTerminalStatus;
  readonly counts: AtlassianSyncChangeCounts;
  readonly fingerprintSetDigest: string;
  readonly completedAt: number;
}

interface AtlassianSyncJobCommon {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly jobId: string;
  readonly connectorId: string;
  readonly provider: AtlassianConnectorProvider;
  readonly queuedAt: number;
  readonly progress: AtlassianSyncProgressCounts;
}

export interface AtlassianSyncJobPending extends AtlassianSyncJobCommon {
  readonly status: "pending";
}

export interface AtlassianSyncJobRunning extends AtlassianSyncJobCommon {
  readonly status: "running";
  readonly startedAt: number;
}

export interface AtlassianSyncJobSucceeded extends AtlassianSyncJobCommon {
  readonly status: "succeeded";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly changeSummary: AtlassianSyncChangeSummary;
}

// Completed, but some items failed or were denied; the closed reason codes say why without
// carrying any item content.
export interface AtlassianSyncJobPartial extends AtlassianSyncJobCommon {
  readonly status: "partial";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly changeSummary: AtlassianSyncChangeSummary;
  readonly failureReasons: readonly AtlassianSyncFailureReason[];
}

// `startedAt` is optional on the failed/cancelled arms: a job can terminate straight from the
// queue (for example cancelled before its first request, or failed at authority validation).
export interface AtlassianSyncJobFailed extends AtlassianSyncJobCommon {
  readonly status: "failed";
  readonly startedAt?: number | undefined;
  readonly completedAt: number;
  readonly failureReason: AtlassianSyncFailureReason;
  readonly changeSummary: AtlassianSyncChangeSummary;
}

export interface AtlassianSyncJobCancelled extends AtlassianSyncJobCommon {
  readonly status: "cancelled";
  readonly startedAt?: number | undefined;
  readonly completedAt: number;
  readonly changeSummary: AtlassianSyncChangeSummary;
}

export type AtlassianSyncJobState =
  | AtlassianSyncJobPending
  | AtlassianSyncJobRunning
  | AtlassianSyncJobSucceeded
  | AtlassianSyncJobPartial
  | AtlassianSyncJobFailed
  | AtlassianSyncJobCancelled;

// ─── Governed action vocabulary and effect-class table (ADR-0128 D4) ──────────
export type AtlassianConnectorActionType =
  | "sync-space"
  | "sync-project"
  | "search-issues-live"
  | "create-issue"
  | "update-issue-fields"
  | "transition-issue"
  | "add-issue-comment"
  | "create-page"
  | "update-page"
  | "add-page-comment";

export const ATLASSIAN_CONNECTOR_ACTION_TYPES: readonly AtlassianConnectorActionType[] =
  Object.freeze([
    "sync-space",
    "sync-project",
    "search-issues-live",
    "create-issue",
    "update-issue-fields",
    "transition-issue",
    "add-issue-comment",
    "create-page",
    "update-page",
    "add-page-comment",
  ] as const satisfies readonly AtlassianConnectorActionType[]);

// The D4 "Action class" column, verbatim. `connector-access` is the shared
// `CodingWorkbenchActionClass` that admits connector operations into the Authority Envelope;
// `connector-write` is the shared `CodingWorkbenchSupervisedActionKind` that marks the write
// subset (there is deliberately no second Workbench action class for connector writes —
// ADR-0128 D4 scope-extension note).
export type AtlassianConnectorActionClass = "connector-access" | "connector-write";

export const ATLASSIAN_CONNECTOR_ACTION_CLASSES: readonly AtlassianConnectorActionClass[] =
  Object.freeze([
    "connector-access",
    "connector-write",
  ] as const satisfies readonly AtlassianConnectorActionClass[]);

export const ATLASSIAN_CONNECTOR_ACTION_CLASS: Readonly<
  Record<AtlassianConnectorActionType, AtlassianConnectorActionClass>
> = Object.freeze({
  "sync-space": "connector-access",
  "sync-project": "connector-access",
  "search-issues-live": "connector-access",
  "create-issue": "connector-write",
  "update-issue-fields": "connector-write",
  "transition-issue": "connector-write",
  "add-issue-comment": "connector-write",
  "create-page": "connector-write",
  "update-page": "connector-write",
  "add-page-comment": "connector-write",
} as const satisfies Readonly<Record<AtlassianConnectorActionType, AtlassianConnectorActionClass>>);

export const ATLASSIAN_CONNECTOR_ACTION_PROVIDER: Readonly<
  Record<AtlassianConnectorActionType, AtlassianConnectorProvider>
> = Object.freeze({
  "sync-space": "confluence",
  "sync-project": "jira",
  "search-issues-live": "jira",
  "create-issue": "jira",
  "update-issue-fields": "jira",
  "transition-issue": "jira",
  "add-issue-comment": "jira",
  "create-page": "confluence",
  "update-page": "confluence",
  "add-page-comment": "confluence",
} as const satisfies Readonly<Record<AtlassianConnectorActionType, AtlassianConnectorProvider>>);

export const ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE: Readonly<
  Record<AtlassianConnectorActionType, CodingWorkbenchConnectorScope>
> = Object.freeze({
  "sync-space": "knowledge-base.read",
  "sync-project": "issue-tracker.read",
  "search-issues-live": "issue-tracker.read",
  "create-issue": "issue-tracker.write",
  "update-issue-fields": "issue-tracker.write",
  "transition-issue": "issue-tracker.write",
  "add-issue-comment": "issue-tracker.write",
  "create-page": "knowledge-base.write",
  "update-page": "knowledge-base.write",
  "add-page-comment": "knowledge-base.write",
} as const satisfies Readonly<Record<AtlassianConnectorActionType, CodingWorkbenchConnectorScope>>);

// Risk tiers fixed by ADR-0128 D4: reads are `low`; additive comments are `low`; bounded field
// edits are `medium`; creating a durable external artifact or triggering workflow side effects
// (`create-issue`, `create-page`, `transition-issue`) is `high`. No v1 action is `critical`.
export const ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK: Readonly<
  Record<AtlassianConnectorActionType, CodingWorkbenchApprovalRisk>
> = Object.freeze({
  "sync-space": "low",
  "sync-project": "low",
  "search-issues-live": "low",
  "create-issue": "high",
  "update-issue-fields": "medium",
  "transition-issue": "high",
  "add-issue-comment": "low",
  "create-page": "high",
  "update-page": "medium",
  "add-page-comment": "low",
} as const satisfies Readonly<Record<AtlassianConnectorActionType, CodingWorkbenchApprovalRisk>>);

// Both connector action classes admit through the shared `connector-access` Workbench class; the
// write subset is additionally identified by the `connector-write` supervised action kind
// (mirroring `permissionKindForSupervisedCodingAction`). No new Workbench policy vocabulary.
export const ATLASSIAN_CONNECTOR_WORKBENCH_ACTION_CLASS: Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchActionClass>
> = Object.freeze({
  "connector-access": "connector-access",
  "connector-write": "connector-access",
} as const satisfies Readonly<Record<AtlassianConnectorActionClass, CodingWorkbenchActionClass>>);

export const ATLASSIAN_CONNECTOR_SUPERVISED_ACTION_KIND: Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchSupervisedActionKind | null>
> = Object.freeze({
  "connector-access": null,
  "connector-write": "connector-write",
} as const satisfies Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchSupervisedActionKind | null>
>);

// Every connector action reaches an external system over HTTPS, so both classes compose through
// the shared `internet` resource-scope row (ADR-0128 D4); `delivery` stays reserved for
// source-control/release actions.
export const ATLASSIAN_CONNECTOR_WORKBENCH_RESOURCE_SCOPE: Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchPolicyResourceScope>
> = Object.freeze({
  "connector-access": "internet",
  "connector-write": "internet",
} as const satisfies Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchPolicyResourceScope>
>);

// Missing-scope denial reason per action class (#2240 AC: a write action without the write scope
// is denied with `connector-write-denied` in every mode, including Full access).
export const ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON: Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchPolicyDenialReason>
> = Object.freeze({
  "connector-access": "connector-access-denied",
  "connector-write": "connector-write-denied",
} as const satisfies Readonly<
  Record<AtlassianConnectorActionClass, CodingWorkbenchPolicyDenialReason>
>);

// ─── Per-mode decision helper (ADR-0128 D4) ───────────────────────────────────
export type AtlassianConnectorActionDisposition = "allowed" | "review-required" | "denied";

export const ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS: readonly AtlassianConnectorActionDisposition[] =
  Object.freeze([
    "allowed",
    "review-required",
    "denied",
  ] as const satisfies readonly AtlassianConnectorActionDisposition[]);

export type AtlassianConnectorActionReviewReason =
  "mode-approval-required" | "deterministic-risk-approval-required";

export const ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS: readonly AtlassianConnectorActionReviewReason[] =
  Object.freeze([
    "mode-approval-required",
    "deterministic-risk-approval-required",
  ] as const satisfies readonly AtlassianConnectorActionReviewReason[]);

// A denied decision carries exactly one deny reason; a review-required decision carries exactly
// one review reason; an allowed decision carries neither (the editor-agent disposition rule).
export interface AtlassianConnectorActionDecision {
  readonly disposition: AtlassianConnectorActionDisposition;
  readonly actionType: AtlassianConnectorActionType;
  readonly actionClass: AtlassianConnectorActionClass;
  readonly requiredScope: CodingWorkbenchConnectorScope;
  readonly risk: CodingWorkbenchApprovalRisk;
  readonly denyReason?: CodingWorkbenchPolicyDenialReason | undefined;
  readonly reviewReason?: AtlassianConnectorActionReviewReason | undefined;
}

function atlassianDecisionBase(
  actionType: AtlassianConnectorActionType,
): Omit<AtlassianConnectorActionDecision, "disposition"> {
  const actionClass = ATLASSIAN_CONNECTOR_ACTION_CLASS[actionType];
  return {
    actionType,
    actionClass,
    requiredScope: ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[actionType],
    risk: ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[actionType],
  };
}

function atlassianReviewReasonFor(
  risk: CodingWorkbenchApprovalRisk,
): AtlassianConnectorActionReviewReason {
  return risk === "high" || risk === "critical"
    ? "deterministic-risk-approval-required"
    : "mode-approval-required";
}

// The envelope admission gate: the shared Workbench class for this action must be admitted by the
// mode policy (`decideCodingWorkbenchActionForMode`) AND, when the caller supplies the Authority
// Envelope's granted action classes, be a member of that grant — mirroring how
// `composeEditorAgentActionPolicyDecision` checks `authority.actionClasses`.
function atlassianClassAdmission(
  mode: CodingWorkbenchMode,
  workbenchClass: CodingWorkbenchActionClass,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  envelopeActionClasses: readonly CodingWorkbenchActionClass[] | undefined,
): {
  readonly effect: CodingWorkbenchPolicyEffect;
  readonly denyReason: CodingWorkbenchPolicyDenialReason;
} {
  const classDecision = decideCodingWorkbenchActionForMode(mode, workbenchClass, connectorScopes);
  if (!classDecision.allowed) {
    return { effect: "denied", denyReason: classDecision.reasonCode };
  }
  if (envelopeActionClasses !== undefined && !envelopeActionClasses.includes(workbenchClass)) {
    return { effect: "denied", denyReason: "connector-access-denied" };
  }
  return { effect: "allowed", denyReason: "connector-access-denied" };
}

// Deterministic, fail-closed decision for one governed connector action under one mode, one set
// of granted connector scopes, and (optionally) the Authority Envelope's granted action classes.
// Pure: no IO, no clock. Composition order is fixed:
//   1. Scope gate — a missing required scope is `denied` with the class-specific reason in EVERY
//      mode, including Full access (ADR-0128 D4 / #2240 AC).
//   2. Class admission via `decideCodingWorkbenchActionForMode` plus the envelope grant, composed
//      stricter-wins with the shared mode × `internet` resource-scope × risk matrix, exactly as
//      `editor-agent-governance.ts` composes `envelopeModeEffect`.
export function decideAtlassianConnectorAction(
  actionType: AtlassianConnectorActionType,
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
  envelopeActionClasses?: readonly CodingWorkbenchActionClass[],
): AtlassianConnectorActionDecision {
  const base = atlassianDecisionBase(actionType);
  if (!connectorScopes.includes(base.requiredScope)) {
    return {
      ...base,
      disposition: "denied",
      denyReason: ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON[base.actionClass],
    };
  }
  const workbenchClass = ATLASSIAN_CONNECTOR_WORKBENCH_ACTION_CLASS[base.actionClass];
  const resourceScope = ATLASSIAN_CONNECTOR_WORKBENCH_RESOURCE_SCOPE[base.actionClass];
  const admission = atlassianClassAdmission(
    mode,
    workbenchClass,
    connectorScopes,
    envelopeActionClasses,
  );
  const effect = strictestCodingWorkbenchPolicyEffect(
    admission.effect,
    codingWorkbenchPolicyEffectFor(mode, resourceScope, base.risk),
  );
  if (effect === "denied") {
    return { ...base, disposition: "denied", denyReason: admission.denyReason };
  }
  if (effect === "approval-required") {
    return {
      ...base,
      disposition: "review-required",
      reviewReason: atlassianReviewReasonFor(base.risk),
    };
  }
  return { ...base, disposition: "allowed" };
}

// ─── Write-action failure vocabulary (Issue #2244, ADR-0128 D4/D3) ───────────
// Closed, content-free failure reasons for the governed write executors. Literals shared with
// `AtlassianSyncFailureReason` keep one spelling per failure class across the lane; the four
// write-specific members (`conflict`, `invalid-transition`, `not-found`, `field-validation`)
// cover the provider outcomes the UI must render distinctly: an optimistic-version conflict
// (Confluence 409), a transition id absent from the issue's available transitions, a missing
// target, and a provider field-validation rejection. A raw provider error message never enters
// the contract.
export type AtlassianConnectorWriteFailureReason =
  | "auth-failed"
  | "permission-denied"
  | "not-found"
  | "rate-limited"
  | "timeout"
  | "unavailable"
  | "malformed-payload"
  | "bounds-exceeded"
  | "conflict"
  | "invalid-transition"
  | "field-validation";

export const ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS: readonly AtlassianConnectorWriteFailureReason[] =
  Object.freeze([
    "auth-failed",
    "permission-denied",
    "not-found",
    "rate-limited",
    "timeout",
    "unavailable",
    "malformed-payload",
    "bounds-exceeded",
    "conflict",
    "invalid-transition",
    "field-validation",
  ] as const satisfies readonly AtlassianConnectorWriteFailureReason[]);

// ─── Envelope-authority failure reasons (Issue #2244, ADR-0125) ───────────────
// The server-side Authority Envelope registry's closed failure vocabulary, spelled exactly as
// the editor lane's existing deny reasons (`EditorAgentActionDenyReason`) so the connector lane
// reuses the EXISTING envelope reason codes instead of coining new ones: the registry's
// `invalid | expired | budget-exceeded` map 1:1 onto these literals. An expired, digest-
// mismatched, or budget-exhausted envelope is `denied` with exactly one of these codes in every
// mode, including Full access.
export type AtlassianConnectorAuthorityFailureReason =
  "authority-invalid" | "authority-expired" | "authority-budget-exceeded";

export const ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS: readonly AtlassianConnectorAuthorityFailureReason[] =
  Object.freeze([
    "authority-invalid",
    "authority-expired",
    "authority-budget-exceeded",
  ] as const satisfies readonly AtlassianConnectorAuthorityFailureReason[]);

// ─── Human-initiation rationale (Issue #2244, ADR-0127/ADR-0128 D5) ───────────
// A direct human-triggered BFF operation (v1 sync is explicitly user-triggered, ADR-0128 D5) is
// human-approved by construction under the ADR-0127 human-control invariant: the per-action
// human trigger satisfies the D4 review requirement in every mode. Such an attempt records
// disposition `allowed` with this explicit rationale — never a bare, untraceable "allowed" —
// so the activity trail distinguishes a human-initiated action from an envelope-admitted one.
export type AtlassianConnectorHumanInitiationReason = "human-initiated";

export const ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON: AtlassianConnectorHumanInitiationReason =
  "human-initiated";

// ─── Redacted activity/evidence record (ADR-0128 D6) ──────────────────────────
// Every connector action attempt — allowed, review-required, denied, and failed — produces
// exactly one content-free record. Rejected content, by construction: issue/page bodies, comment
// text, ADF/storage-format payloads, field values, raw JQL, tokens, token-bearing URLs. The type
// has no field that could hold any of them, and the validator additionally rejects unknown keys.
export type AtlassianConnectorActivityOutcome =
  "succeeded" | "failed" | "denied" | "cancelled" | "pending-review";

export const ATLASSIAN_CONNECTOR_ACTIVITY_OUTCOMES: readonly AtlassianConnectorActivityOutcome[] =
  Object.freeze([
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "pending-review",
  ] as const satisfies readonly AtlassianConnectorActivityOutcome[]);

// Exactly-one-reason vocabulary for the activity record: the missing-scope/mode deny reasons, the
// review reasons, the closed sync and write failure reasons, the envelope-authority failure codes,
// and the human-initiation rationale. All content-free enums.
export type AtlassianConnectorActivityReasonCode =
  | CodingWorkbenchPolicyDenialReason
  | AtlassianConnectorActionReviewReason
  | AtlassianSyncFailureReason
  | AtlassianConnectorWriteFailureReason
  | AtlassianConnectorAuthorityFailureReason
  | AtlassianConnectorHumanInitiationReason;

export interface AtlassianConnectorActivityRecord {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly activityId: string;
  readonly occurredAt: number;
  readonly connectorId: string;
  readonly provider: AtlassianConnectorProvider;
  readonly actionType: AtlassianConnectorActionType;
  readonly actionClass: AtlassianConnectorActionClass;
  readonly disposition: AtlassianConnectorActionDisposition;
  readonly outcome: AtlassianConnectorActivityOutcome;
  readonly reasonCode?: AtlassianConnectorActivityReasonCode | undefined;
  // Issue key or page id — an identifier, never a body or URL (enforced by the identifier guard).
  readonly targetRef?: string | undefined;
  readonly correlationId: string;
  readonly durationMs: number;
  // Present only for sync actions: the D5 counts, outcome enum, and fingerprint-set digest.
  readonly syncSummary?: AtlassianSyncChangeSummary | undefined;
  // Present only for `search-issues-live`: sha256 hex of the JQL text, or omitted. Never the
  // query text itself (ADR-0128 D6).
  readonly jqlDigest?: string | undefined;
  // Present only for a succeeded `search-issues-live` execution (Issue #2248): how many issues
  // the live query returned, and their issue keys — counts and identifiers only (the D6 audit
  // vocabulary), never summaries, bodies, or the query text.
  readonly resultCount?: number | undefined;
  readonly resultIssueKeys?: readonly string[] | undefined;
}

// ─── Governed action wire results (Issue #2244; consumed by the #2245 approval UI) ─
// The bounded, content-free execution projection a write-action route answers: the created or
// affected target identifier (issue key, page id, or comment id) and — for Confluence page
// writes — the resulting version number on success; exactly one closed failure reason plus the
// upstream HTTP status on failure. No field can carry a body, field value, URL, or token.
export interface AtlassianConnectorActionExecutionSucceeded {
  readonly status: "succeeded";
  readonly targetRef?: string | undefined;
  readonly version?: number | undefined;
}

export interface AtlassianConnectorActionExecutionFailed {
  readonly status: "failed";
  readonly reason: AtlassianConnectorWriteFailureReason;
  readonly httpStatus?: number | undefined;
}

export type AtlassianConnectorActionExecutionResult =
  AtlassianConnectorActionExecutionSucceeded | AtlassianConnectorActionExecutionFailed;

// ─── Pending-approval projection (Issue #2244 → rendered by the #2245 UI) ─────
// The redacted pending-approval state a `review-required` disposition surfaces: identifiers, the
// D4 action row (class, required scope, risk), the single review reason, and the TTL window. The
// submitted action input (summaries, descriptions, comment text, page bodies) NEVER appears
// here — it is held only inside the server-side registry entry that the approve endpoint
// consumes, and credentials are never part of that entry either (ADR-0128 D2/D6).
export interface AtlassianConnectorPendingApproval {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly approvalId: string;
  readonly connectorId: string;
  readonly provider: AtlassianConnectorProvider;
  readonly actionType: AtlassianConnectorActionType;
  readonly actionClass: AtlassianConnectorActionClass;
  readonly requiredScope: CodingWorkbenchConnectorScope;
  readonly risk: CodingWorkbenchApprovalRisk;
  readonly reviewReason: AtlassianConnectorActionReviewReason;
  // Issue key, page id, or scope key the action targets — an identifier, never a body.
  readonly targetRef?: string | undefined;
  readonly correlationId: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

// ─── Jira issue citation metadata (#2243; #2248 presents the same field list) ─
// The structured, metadata-only projection of one synced Jira issue for citation display and
// future filtering: workflow state, classification, people display names, planning fields, and
// hierarchy/link KEYS (identifiers only — deliberately no graph modeling in v1). This is synced
// KNOWLEDGE content in the ADR-0128 D6 sense (like titles), not governance evidence: it may carry
// real field values but is still bounded and display-safe by construction — no bodies, comment
// text, URLs, or credentials can pass the validator. The serialized form is bounded so a hostile
// upstream cannot inflate fingerprint rows.
export const ATLASSIAN_CITATION_METADATA_MAX_CHARS = 4_096;
export const ATLASSIAN_CITATION_FIELD_MAX_CHARS = 100;
export const ATLASSIAN_CITATION_LIST_MAX_ENTRIES = 50;

export interface JiraIssueLinkRef {
  // Directional link description as Jira reports it (e.g. "blocks", "is blocked by").
  readonly linkType: string;
  readonly issueKey: string;
}

export interface JiraIssueCitationMetadata {
  readonly issueKey: string;
  readonly status?: string | undefined;
  readonly issueType?: string | undefined;
  readonly assignee?: string | undefined;
  readonly reporter?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly priority?: string | undefined;
  readonly resolution?: string | undefined;
  readonly originalEstimate?: string | undefined;
  readonly remainingEstimate?: string | undefined;
  readonly parentKey?: string | undefined;
  readonly subtaskKeys?: readonly string[] | undefined;
  readonly linkedIssues?: readonly JiraIssueLinkRef[] | undefined;
  // Provider timestamps, verbatim as Jira reports them (bounded display-safe text; compared in
  // UTC downstream — never reformatted here).
  readonly created?: string | undefined;
  readonly updated?: string | undefined;
}

const JIRA_CITATION_METADATA_KEYS: ReadonlySet<string> = new Set([
  "issueKey",
  "status",
  "issueType",
  "assignee",
  "reporter",
  "labels",
  "priority",
  "resolution",
  "originalEstimate",
  "remainingEstimate",
  "parentKey",
  "subtaskKeys",
  "linkedIssues",
  "created",
  "updated",
]);

// Bounded display value: shorter than a display name, same redaction posture (no URL/credential
// markers, no paths, no pseudo-role markers, no unsafe format characters). Exported so the
// producing adapter (#2243) and the live-search presenter (#2248) validate fields at the source
// instead of re-deriving the rule.
export function isSafeJiraCitationFieldText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ATLASSIAN_CITATION_FIELD_MAX_CHARS &&
    isSafeAtlassianDisplayName(value)
  );
}

function isOptionalCitationField(value: unknown): boolean {
  return value === undefined || isSafeJiraCitationFieldText(value);
}

function isBoundedArrayOf<T>(
  value: unknown,
  isEntry: (entry: unknown) => entry is T,
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length <= ATLASSIAN_CITATION_LIST_MAX_ENTRIES &&
    value.every((entry) => isEntry(entry))
  );
}

function isJiraIssueLinkRef(value: unknown): value is JiraIssueLinkRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "linkType" && key !== "issueKey")) return false;
  return isSafeJiraCitationFieldText(record.linkType) && isSafeAtlassianIdentifier(record.issueKey);
}

const JIRA_CITATION_SCALAR_FIELDS: readonly (keyof JiraIssueCitationMetadata)[] = [
  "status",
  "issueType",
  "assignee",
  "reporter",
  "priority",
  "resolution",
  "originalEstimate",
  "remainingEstimate",
  "created",
  "updated",
];

function jiraCitationScalarFieldsSafe(record: Record<string, unknown>): boolean {
  return (
    JIRA_CITATION_SCALAR_FIELDS.every((field) => isOptionalCitationField(record[field])) &&
    (record.parentKey === undefined || isSafeAtlassianIdentifier(record.parentKey))
  );
}

function jiraCitationListFieldsSafe(record: Record<string, unknown>): boolean {
  return (
    (record.labels === undefined || isBoundedArrayOf(record.labels, isSafeJiraCitationFieldText)) &&
    (record.subtaskKeys === undefined ||
      isBoundedArrayOf(record.subtaskKeys, isSafeAtlassianIdentifier)) &&
    (record.linkedIssues === undefined || isBoundedArrayOf(record.linkedIssues, isJiraIssueLinkRef))
  );
}

// Strict, fail-closed guard for the citation-metadata projection: unknown keys are rejected, the
// issue key is mandatory, every field is bounded display-safe text or a validated identifier.
export function isJiraIssueCitationMetadata(value: unknown): value is JiraIssueCitationMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !JIRA_CITATION_METADATA_KEYS.has(key))) return false;
  if (!isSafeAtlassianIdentifier(record.issueKey)) return false;
  return jiraCitationScalarFieldsSafe(record) && jiraCitationListFieldsSafe(record);
}

// ─── Live JQL search wire shapes (Issue #2248; extends the #2240 action vocabulary) ─
// RECORDED CONTRACT CHANGE, cross-referenced with #2240: #2240 declared the `search-issues-live`
// D4 action row, the D5 result ceiling (`ATLASSIAN_LIVE_SEARCH_MAX_RESULTS`), the JQL bound, and
// the `jqlDigest` evidence field; #2248 adds the live query's request and result wire shapes.
// A live result is EPHEMERAL provider data (Issue #2248 Scope 3): returned to the caller, never
// persisted or indexed — the `source: "live"` marker plus `queriedAt` let every surface
// distinguish it from synced pod citations. Users sync the pod when they want persistence.

// Well-known query templates. Each template is composed downstream (keiko-connectors) from fixed,
// validated parts — never from user input — and the exact JQL is documented beside the composer.
// A closed union with room for more templates; free-form JQL stays opaque and length-bounded.
export type AtlassianLiveSearchTemplateId = "assigned-to-me-open";

export const ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS: readonly AtlassianLiveSearchTemplateId[] =
  Object.freeze([
    "assigned-to-me-open",
  ] as const satisfies readonly AtlassianLiveSearchTemplateId[]);

export function isAtlassianLiveSearchTemplateId(
  value: unknown,
): value is AtlassianLiveSearchTemplateId {
  return isOneOf(value, ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS);
}

// Exactly one of `jql` (opaque free text, bounded by ATLASSIAN_JQL_MAX_CHARS, transported only —
// never parsed, never in evidence) or `templateId` selects the query; `maxResults` optionally
// narrows the D5 ceiling (1..ATLASSIAN_LIVE_SEARCH_MAX_RESULTS applies when absent). The XOR and
// bounds are enforced by `validateJiraLiveSearchRequest`.
export interface JiraLiveSearchRequest {
  readonly jql?: string | undefined;
  readonly templateId?: AtlassianLiveSearchTemplateId | undefined;
  readonly maxResults?: number | undefined;
}

// Bound for a live hit's summary — the same ceiling the synced citation title obeys (#2243), so a
// live row can never out-size a synced one.
export const ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS = 500;

// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const LIVE_SUMMARY_CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

// A live summary is provider CONTENT in the ADR-0128 D6 sense (like a synced title), not
// governance evidence: real text, but bounded and single-line (Jira summaries are single-line
// upstream; the producing executor flattens hostile control characters before this guard).
// Empty is valid — an issue may carry no summary.
export function isSafeJiraLiveIssueSummary(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS &&
    !LIVE_SUMMARY_CONTROL_CHARS_PATTERN.test(value)
  );
}

// Canonical https target for a browse URL: no whitespace, none of the string-level
// userinfo/query/fragment markers (defense in depth, mirroring the base-URL guard), parseable,
// byte-identical to its canonical WHATWG serialization (so dot-segment traversal or
// re-encodable forms are rejected, never normalized through), and structurally safe
// (https only; no userinfo, query, or fragment components).
function canonicalHttpsBrowseTarget(value: string): URL | undefined {
  if (/\s/u.test(value) || value.includes("@") || value.includes("?") || value.includes("#")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.toString() !== value || !isSafeParsedBaseUrl(url)) return undefined;
  return url;
}

// Absolute https click-through URL for one live issue (`{base}/browse/{KEY}`), mirroring the
// synced `webuiPath` convention resolved against the connector's validated base URL. Fail-closed
// exactly like the base-URL guard, plus the path must terminate in `/browse/<safe issue key>`.
export function isSafeJiraBrowseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS) return false;
  const url = canonicalHttpsBrowseTarget(value);
  if (url === undefined) return false;
  const match = /\/browse\/([^/]+)$/u.exec(url.pathname);
  return match !== null && isSafeAtlassianIdentifier(match[1]);
}

// One live search hit: the issue key, its bounded summary, the browse click-through URL, and the
// FULL #2243 citation-metadata projection — a live hit and a synced citation present the same
// field list by construction (the #2248 parity acceptance criterion; `metadata.issueKey` must
// equal `key`, enforced by the validator).
export interface JiraLiveIssue {
  readonly key: string;
  readonly summary: string;
  readonly browseUrl: string;
  readonly metadata: JiraIssueCitationMetadata;
}

// The ephemeral live result envelope. `jqlDigest` is sha256 hex of the EXECUTED JQL (computed
// downstream with keiko-security hashing, ADR-0128 D6 — the query text itself never appears in
// any evidence surface). `totalMatched` is present exactly when the full match set was enumerated
// (`truncated === false`) and then equals `issues.length`; the token-paginated search endpoint
// reports no total for a capped walk, so a truncated result omits it.
export interface JiraLiveSearchResult {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly source: "live";
  readonly queriedAt: number;
  readonly jqlDigest: string;
  readonly totalMatched?: number | undefined;
  readonly truncated: boolean;
  readonly issues: readonly JiraLiveIssue[];
}

// ─── Connector-pod source metadata (#2240 Scope 6) ────────────────────────────
// The redacted source metadata a connector-backed Knowledge Pod projects into
// `KnowledgePodSummary.connectorSource` (extending the existing pod contract the same way the
// HTML-manual `manualRefresh` summary does — not forking it). Scope labels are validated
// identifier tokens (space/project keys), never paths, URLs, or bodies.
export interface AtlassianConnectorPodSource {
  readonly provider: AtlassianConnectorProvider;
  readonly connectorId: string;
  readonly scopeLabels: readonly string[];
  readonly lastSyncAt?: number | undefined;
  readonly lastChangeSummary?: AtlassianSyncChangeSummary | undefined;
}

// ─── Enum guards ───────────────────────────────────────────────────────────────
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function isAtlassianConnectorProvider(value: unknown): value is AtlassianConnectorProvider {
  return isOneOf(value, ATLASSIAN_CONNECTOR_PROVIDERS);
}

export function isAtlassianConnectorAuthScheme(
  value: unknown,
): value is AtlassianConnectorAuthScheme {
  return isOneOf(value, ATLASSIAN_CONNECTOR_AUTH_SCHEMES);
}

export function isAtlassianConnectorActionType(
  value: unknown,
): value is AtlassianConnectorActionType {
  return isOneOf(value, ATLASSIAN_CONNECTOR_ACTION_TYPES);
}

export function isAtlassianSyncJobStatus(value: unknown): value is AtlassianSyncJobStatus {
  return isOneOf(value, ATLASSIAN_SYNC_JOB_STATUSES);
}

export function isAtlassianSyncTerminalStatus(
  value: unknown,
): value is AtlassianSyncTerminalStatus {
  return isOneOf(value, ATLASSIAN_SYNC_TERMINAL_STATUSES);
}

export function isAtlassianSyncFailureReason(value: unknown): value is AtlassianSyncFailureReason {
  return isOneOf(value, ATLASSIAN_SYNC_FAILURE_REASONS);
}

export function isAtlassianConnectorActionReviewReason(
  value: unknown,
): value is AtlassianConnectorActionReviewReason {
  return isOneOf(value, ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS);
}

export function isAtlassianConnectorWriteFailureReason(
  value: unknown,
): value is AtlassianConnectorWriteFailureReason {
  return isOneOf(value, ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS);
}

export function isAtlassianConnectorAuthorityFailureReason(
  value: unknown,
): value is AtlassianConnectorAuthorityFailureReason {
  return isOneOf(value, ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS);
}
