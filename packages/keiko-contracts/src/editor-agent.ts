import type { EditorDocumentVersion } from "./editor-session.js";
import type {
  LanguageDiagnostic,
  LanguageDiagnosticSeverity,
  LanguagePosition,
  LanguageRange,
} from "./language-service.js";
import { EDITOR_AGENT_TARGET_PATH_MAX_BYTES, isContainedAgentPath } from "./editor-agent-path.js";
import {
  parseEditorVerificationRunRequest,
  type EditorVerificationRunRequest,
} from "./editor-verification.js";

export { EDITOR_AGENT_TARGET_PATH_MAX_BYTES, isContainedAgentPath };

export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;
export const EDITOR_AGENT_CHANGESET_MAX_FILES = 50;
export const EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES = 65_536;
export const EDITOR_AGENT_PREPARED_CHANGESET_MAX_EDITS = 2_000;
export const EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS = 128;
export const EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS = 1_024;
export const EDITOR_AGENT_REFERENCE_ID_MAX_CHARS = 128;
export const EDITOR_AGENT_ACTION_ID_MAX_BYTES = 128;
export const EDITOR_AGENT_SESSION_ID_MAX_BYTES = 256;
export const EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES = 256;
export const EDITOR_AGENT_WINDOW_ID_MAX_BYTES = 256;
export const EDITOR_AGENT_PANE_ID_MAX_BYTES = 256;
export const EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES = 4_096;
export const EDITOR_AGENT_SNAPSHOT_MAX_PANES = 32;
export const EDITOR_AGENT_SNAPSHOT_MAX_OPEN_FILES_PER_PANE = 256;
export const EDITOR_AGENT_SNAPSHOT_MAX_DIRTY_FILES = 512;
export const EDITOR_AGENT_SNAPSHOT_PATH_METADATA_MAX_BYTES = 262_144;
export const EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES = 65_536;
export const EDITOR_AGENT_RESULT_MESSAGE_MAX_CHARS = 1_024;
export const EDITOR_AGENT_ACTION_DATA_MAX_BYTES = 256 * 1024;
export const EDITOR_AGENT_NAVIGATION_DOCUMENT_MAX_BYTES = 1_000_000;
export const EDITOR_AGENT_SEARCH_MAX_QUERY_CHARS = 200;
export const EDITOR_AGENT_SEARCH_MAX_RESULTS = 200;
export const EDITOR_AGENT_EVENT_ID_MAX_BYTES = 256;
export const EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_BYTES = 32;
export const EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS = 43;

export const EDITOR_AGENT_ACTION_ORIGINS = ["agent", "chat"] as const;
export type EditorAgentActionOrigin = (typeof EDITOR_AGENT_ACTION_ORIGINS)[number];
export const DEFAULT_EDITOR_AGENT_ACTION_ORIGIN: EditorAgentActionOrigin = "agent";

export type EditorAgentBridgeDecisionCapability = string;

const EDITOR_AGENT_TEXT_ENCODER = new TextEncoder();

export interface EditorAgentGovernedAuthorityReference {
  readonly runId: string;
  readonly envelopeDigest: string;
}

export interface EditorAgentOneUseApprovalReference {
  readonly approvalId: string;
  readonly actionId: string;
  readonly approvalProofDigest: string;
  readonly expiresAt: string;
}

export interface EditorAgentDiagnostic {
  readonly severity: LanguageDiagnosticSeverity;
  readonly range: LanguageRange;
  readonly message: string;
}

export interface EditorAgentDiagnosticsDetail {
  readonly items: readonly EditorAgentDiagnostic[];
  readonly truncated: boolean;
}

export type EditorAgentSnapshotTextMode = "none" | "selection" | "activeFile";

// Issue #1391 AC1 — snapshot text defaults to `none`. An agent that does not explicitly opt into a
// text mode never receives document content: the default is the content-free projection. The read
// request parser fills this in when `textMode` is omitted (a present-but-invalid value is still
// rejected), so the resolved request always carries a concrete, safe-by-default mode.
export const DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE: EditorAgentSnapshotTextMode = "none";

export interface EditorAgentPaneSnapshot {
  readonly paneId: string;
  readonly activeFile: string | null;
  readonly openFiles: readonly string[];
}

export interface EditorAgentSessionSnapshot {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly windowId: string;
  readonly workspaceRoot: string;
  readonly activePaneId: string | null;
  readonly panes: readonly EditorAgentPaneSnapshot[];
  readonly dirtyFiles: readonly string[];
  readonly activeFile: string | null;
  readonly cursor: { readonly line: number; readonly character: number } | null;
  readonly selection: LanguageRange | null;
  readonly diagnosticsSummary: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  } | null;
  readonly diagnosticsDetail?: EditorAgentDiagnosticsDetail | undefined;
  // Issue #1379 AC4 (ADR-0067 D6) — content-free language-provider availability for the active file.
  // Additive and optional: old snapshots (field absent) still validate. ids/booleans/short reason
  // strings only — never buffer text. `providerId` is null when no provider serves the language.
  readonly languageCapability?: {
    readonly languageId: string;
    readonly providerId: string | null;
    readonly available: boolean;
    readonly unavailableReason?: string | undefined;
  } | null;
  readonly documentVersion?: EditorDocumentVersion | undefined;
  readonly activeFileContentHash?: string | undefined;
  readonly textMode: EditorAgentSnapshotTextMode;
  readonly text?: string | undefined;
  readonly textTruncated?: boolean | undefined;
  readonly updatedAt: number;
}

export type EditorAgentNavigateSymbolOperation =
  "definition" | "references" | "renamePrepare" | "codeActions" | "signatureHelp";

export const EDITOR_AGENT_NAVIGATE_SYMBOL_OPERATIONS: readonly EditorAgentNavigateSymbolOperation[] =
  ["definition", "references", "renamePrepare", "codeActions", "signatureHelp"] as const;

export interface EditorAgentNavigateSymbolRequest {
  readonly operation: EditorAgentNavigateSymbolOperation;
  readonly document: {
    readonly path: string;
    readonly languageId: string;
    readonly text?: string | undefined;
  };
  readonly position: LanguagePosition;
  readonly range?: LanguageRange | undefined;
  readonly diagnostics?: readonly LanguageDiagnostic[] | undefined;
}

export type EditorAgentSearchWorkspaceMode = "text" | "symbol";

export interface EditorAgentSearchWorkspaceRequest {
  readonly mode: EditorAgentSearchWorkspaceMode;
  readonly query: string;
  readonly caseSensitive?: boolean | undefined;
  readonly includeGlobs?: readonly string[] | undefined;
  readonly excludeGlobs?: readonly string[] | undefined;
  readonly maxResults?: number | undefined;
  readonly scopePath?: string | undefined;
}

export type EditorAgentActionType =
  | "openFile"
  | "focusTab"
  | "moveTab"
  | "splitPane"
  | "setSelection"
  | "format"
  | "save"
  | "applyTextEdits"
  | "applyPatch"
  | "applyChangeset"
  // Issue #2210 (ADR-0126 D5): a governed, non-mutating request to run a verification through Issue
  // #2211's route. Added for policy classification; NOT dispatched to the browser bridge.
  | "requestVerification"
  | "navigateSymbol"
  | "searchWorkspace";

// Issue #2210 (ADR-0126 D5): an agent-originated verification request uses the same wire shape as the
// human editor route request (kinds/targetPath/requestId). Aliased to avoid duplicating the shape;
// the guard delegates to the canonical parser so validation stays in one place.
export type EditorAgentVerificationRequest = EditorVerificationRunRequest;

export function isEditorAgentVerificationRequest(
  value: unknown,
): value is EditorAgentVerificationRequest {
  return parseEditorVerificationRunRequest(value).ok;
}

export interface EditorAgentChangesetFile {
  readonly file: string;
  readonly expectedDocumentVersion?: EditorDocumentVersion | undefined;
  readonly expectedContentHash?: string | undefined;
}

export type EditorAgentPreparedChangeKind = "create" | "modify" | "delete";

export interface EditorAgentPreparedTextEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

export interface EditorAgentPreparedChangesetFile {
  readonly file: string;
  readonly kind: EditorAgentPreparedChangeKind;
  readonly textEdits: readonly EditorAgentPreparedTextEdit[];
}

export interface EditorAgentPreparedChangeset {
  readonly files: readonly EditorAgentPreparedChangesetFile[];
}

export interface EditorAgentChangeset {
  readonly patch: string;
  readonly files: readonly EditorAgentChangesetFile[];
  readonly selectedFiles?: readonly string[] | undefined;
  readonly prepared?: EditorAgentPreparedChangeset | undefined;
}

export interface EditorAgentAction {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly type: EditorAgentActionType;
  readonly origin?: EditorAgentActionOrigin | undefined;
  readonly authorityRef?: EditorAgentGovernedAuthorityReference | undefined;
  readonly approvalRef?: EditorAgentOneUseApprovalReference | undefined;
  /** Server-derived on emitted patch/changeset actions; omission preserves legacy review behavior. */
  readonly requiresReview?: boolean | undefined;
  readonly target?:
    | {
        readonly paneId?: string | undefined;
        readonly file?: string | undefined;
        readonly toPaneId?: string | undefined;
        readonly splitDirection?: "row" | "column" | undefined;
        readonly selection?: LanguageRange | undefined;
      }
    | undefined;
  readonly expectedDocumentVersion?: EditorDocumentVersion | undefined;
  readonly expectedContentHash?: string | undefined;
  readonly textEdits?:
    readonly { readonly range: LanguageRange; readonly newText: string }[] | undefined;
  readonly patch?: string | undefined;
  readonly changeset?: EditorAgentChangeset | undefined;
  readonly navigateSymbol?: EditorAgentNavigateSymbolRequest | undefined;
  readonly searchWorkspace?: EditorAgentSearchWorkspaceRequest | undefined;
}

export type EditorAgentActionStatus = "queued" | "succeeded" | "failed" | "conflict";

// Issue #1391 — the structured error-code taxonomy for agent action conflicts. Every conflict a
// write action can raise is one of these stable, machine-discriminable codes so agents, the BFF, and
// the conflict UI all reason over the same vocabulary rather than parsing free text (AC3).
//
//   - DIRTY                  the target buffer has unsaved changes (a non-`save` write was refused).
//   - VERSION_MISMATCH       the asserted `expectedDocumentVersion` no longer matches the document.
//   - CONTENT_HASH_MISMATCH  the asserted `expectedContentHash` no longer matches the document.
//   - NO_ACTIVE_SESSION      no browser bridge has registered a snapshot for the action's session.
//   - NO_ACTIVE_BRIDGE       a snapshot is registered but no live bridge is connected to execute the
//                            action (Issue #1392 — the session's SSE bridge has disconnected).
//   - INVALID_EDITS          the edits/patch are structurally invalid (overlap, inverted, malformed).
//   - OUT_OF_SCOPE           the target escapes the workspace root or the action is unsupported here.
//   - PRECONDITION_REQUIRED  a write action omitted the mandatory version/hash precondition (AC2).
//   - POLICY_DENIED          validated policy or authority denies the action.
//   - APPROVAL_REQUIRED      policy requires a review mechanism not available for this action.
export type EditorAgentConflictCode =
  | "DIRTY"
  | "VERSION_MISMATCH"
  | "CONTENT_HASH_MISMATCH"
  | "NO_ACTIVE_SESSION"
  | "NO_ACTIVE_BRIDGE"
  | "INVALID_EDITS"
  | "OUT_OF_SCOPE"
  | "PRECONDITION_REQUIRED"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED";

export const EDITOR_AGENT_CONFLICT_CODES: readonly EditorAgentConflictCode[] = [
  "DIRTY",
  "VERSION_MISMATCH",
  "CONTENT_HASH_MISMATCH",
  "NO_ACTIVE_SESSION",
  "NO_ACTIVE_BRIDGE",
  "INVALID_EDITS",
  "OUT_OF_SCOPE",
  "PRECONDITION_REQUIRED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
] as const;

// Issue #1392 — structured lifecycle failure codes (status: "failed") raised AFTER an action is
// admitted to the bounded queue, distinct from the preflight conflict taxonomy above:
//   - TIMED_OUT   the connected bridge never reported a result before the action deadline elapsed.
//   - QUEUE_FULL  the bounded per-session action queue was already saturated when the action arrived.
export type EditorAgentFailureCode = "TIMED_OUT" | "QUEUE_FULL";

export const EDITOR_AGENT_FAILURE_CODES: readonly EditorAgentFailureCode[] = [
  "TIMED_OUT",
  "QUEUE_FULL",
] as const;

export interface EditorAgentActionFailure {
  readonly code: EditorAgentFailureCode;
  readonly message: string;
}

export interface EditorAgentConflictDetail {
  readonly code: EditorAgentConflictCode;
  readonly message: string;
  readonly file?: string | undefined;
}

export type EditorAgentFileActionStatus = "succeeded" | "failed" | "conflict" | "not-selected";

export interface EditorAgentFileActionResult {
  readonly file: string;
  readonly status: EditorAgentFileActionStatus;
  readonly message?: string | undefined;
  readonly conflict?: EditorAgentConflictDetail | undefined;
}

export interface EditorAgentActionResult {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly actionId: string;
  readonly sessionId: string;
  readonly status: EditorAgentActionStatus;
  readonly message?: string | undefined;
  readonly conflict?: EditorAgentConflictDetail | undefined;
  readonly failure?: EditorAgentActionFailure | undefined;
  readonly files?: readonly EditorAgentFileActionResult[] | undefined;
  /** Bounded server-resolved data for read-only actions; never included in global audit/SSE projections. */
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export type EditorAgentEvent =
  | {
      readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
      readonly eventId: string;
      readonly type: "session";
      readonly snapshot: EditorAgentSessionSnapshot;
    }
  | {
      readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
      readonly eventId: string;
      readonly type: "action";
      readonly action: EditorAgentAction;
    }
  | {
      readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
      readonly eventId: string;
      readonly type: "result";
      readonly result: EditorAgentActionResult;
    }
  | {
      readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
      readonly eventId: string;
      readonly type: "heartbeat";
      readonly updatedAt: number;
    };

export interface EditorAgentSnapshotRequest {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly sessionId?: string | undefined;
  readonly textMode: EditorAgentSnapshotTextMode;
  readonly maxBytes?: number | undefined;
}

export interface EditorAgentBridgeSnapshotRequest {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly kind: "snapshot";
  readonly snapshot: EditorAgentSessionSnapshot;
  readonly bridgeDecisionCapability?: EditorAgentBridgeDecisionCapability | undefined;
}

export interface EditorAgentActionResultRequest {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly kind: "result";
  readonly result: EditorAgentActionResult;
  readonly bridgeDecisionCapability?: EditorAgentBridgeDecisionCapability | undefined;
}

/**
 * A browser-originated action request. The capability authenticates the live bridge only and is
 * never copied onto the queued action or emitted over SSE.
 */
export interface EditorAgentBridgeActionRequest {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly kind: "action";
  readonly action: EditorAgentAction;
  readonly bridgeDecisionCapability: EditorAgentBridgeDecisionCapability;
}

export type EditorAgentActionsPostBody =
  EditorAgentAction | EditorAgentBridgeActionRequest | EditorAgentActionResultRequest;

export interface EditorAgentSessionsResponse {
  readonly sessions: readonly EditorAgentSessionSnapshot[];
}

export interface EditorAgentActionQueuedResponse {
  readonly result: EditorAgentActionResult;
}

export interface EditorAgentSnapshotResponse {
  readonly snapshot: EditorAgentSessionSnapshot | null;
  readonly bridgeDecisionCapability?: EditorAgentBridgeDecisionCapability | undefined;
}

export interface EditorAgentParseOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface EditorAgentParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type EditorAgentParse<T> = EditorAgentParseOk<T> | EditorAgentParseFail;

const EDITOR_AGENT_ACTION_TYPES: readonly EditorAgentActionType[] = [
  "openFile",
  "focusTab",
  "moveTab",
  "splitPane",
  "setSelection",
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
  "applyChangeset",
  "requestVerification",
  "navigateSymbol",
  "searchWorkspace",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedNonEmptyString(value: unknown, maxChars: number): value is string {
  return isNonEmptyString(value) && value.length <= maxChars;
}

function isBoundedUtf8String(value: unknown, maxBytes: number): value is string {
  return isNonEmptyString(value) && isUtf8StringWithin(value, maxBytes);
}

function isUtf8StringWithin(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && EDITOR_AGENT_TEXT_ENCODER.encode(value).length <= maxBytes;
}

function isBoundedTargetPath(value: unknown): value is string {
  return isBoundedUtf8String(value, EDITOR_AGENT_TARGET_PATH_MAX_BYTES);
}

function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length;
}

function isBoundedDiagnosticMessage(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    countUnicodeCodePoints(value) <= EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS
  );
}

function isBoundedResultMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    countUnicodeCodePoints(value) <= EDITOR_AGENT_RESULT_MESSAGE_MAX_CHARS
  );
}

function isTargetPathArray(value: unknown, maxItems: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every(isBoundedTargetPath);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNullOr(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === null || guard(value);
}

function isUndefinedOr(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function isDocumentVersion(value: unknown): value is EditorDocumentVersion {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sizeBytes) &&
    isNonNegativeFiniteNumber(value.modifiedAt) &&
    isSha256Hex(value.contentHash)
  );
}

function isPosition(
  value: unknown,
): value is { readonly line: number; readonly character: number } {
  return (
    isRecord(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.character)
  );
}

function isRange(value: unknown): value is LanguageRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isDiagnosticSeverity(value: unknown): value is LanguageDiagnosticSeverity {
  return value === "error" || value === "warning" || value === "info" || value === "hint";
}

export function isEditorAgentDiagnostic(value: unknown): value is EditorAgentDiagnostic {
  return (
    isRecord(value) &&
    isDiagnosticSeverity(value.severity) &&
    isRange(value.range) &&
    isBoundedDiagnosticMessage(value.message)
  );
}

export function isEditorAgentDiagnosticsDetail(
  value: unknown,
): value is EditorAgentDiagnosticsDetail {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.length <= EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS &&
    value.items.every(isEditorAgentDiagnostic) &&
    typeof value.truncated === "boolean"
  );
}

export function isEditorAgentGovernedAuthorityReference(
  value: unknown,
): value is EditorAgentGovernedAuthorityReference {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.runId, EDITOR_AGENT_REFERENCE_ID_MAX_CHARS) &&
    isSha256Hex(value.envelopeDigest)
  );
}

export function isEditorAgentOneUseApprovalReference(
  value: unknown,
): value is EditorAgentOneUseApprovalReference {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.approvalId, EDITOR_AGENT_REFERENCE_ID_MAX_CHARS) &&
    isBoundedNonEmptyString(value.actionId, EDITOR_AGENT_REFERENCE_ID_MAX_CHARS) &&
    isSha256Hex(value.approvalProofDigest) &&
    isBoundedNonEmptyString(value.expiresAt, 64)
  );
}

function changesetFileHasPrecondition(file: EditorAgentChangesetFile): boolean {
  return file.expectedDocumentVersion !== undefined || file.expectedContentHash !== undefined;
}

function normalizeAgentPath(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function normalizedPathsAreUnique(paths: readonly string[]): boolean {
  const normalized = paths.map(normalizeAgentPath);
  return new Set(normalized).size === normalized.length;
}

export function isEditorAgentChangesetFile(value: unknown): value is EditorAgentChangesetFile {
  if (!isRecord(value) || "idempotencyKey" in value) return false;
  return [
    isNonEmptyString(value.file) && isContainedAgentPath(value.file),
    isUndefinedOr(value.expectedDocumentVersion, isDocumentVersion),
    isUndefinedOr(value.expectedContentHash, isSha256Hex),
    value.expectedDocumentVersion !== undefined || value.expectedContentHash !== undefined,
  ].every(Boolean);
}

function isUniqueNonEmptyStringArray(value: unknown, maxItems: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maxItems &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function selectedFilesBelongToChangeset(
  selectedFiles: unknown,
  files: readonly EditorAgentChangesetFile[],
): boolean {
  if (selectedFiles === undefined) return true;
  if (!isUniqueNonEmptyStringArray(selectedFiles, files.length)) return false;
  if (!selectedFiles.every(isContainedAgentPath) || !normalizedPathsAreUnique(selectedFiles)) {
    return false;
  }
  const available = new Set(files.map((file) => normalizeAgentPath(file.file)));
  return selectedFiles.every((file) => available.has(normalizeAgentPath(file)));
}

function isPreparedChangeKind(value: unknown): value is EditorAgentPreparedChangeKind {
  return value === "create" || value === "modify" || value === "delete";
}

function isPreparedTextEditArray(value: unknown): value is readonly EditorAgentPreparedTextEdit[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isTextEdit) &&
    validateAgentTextEdits(value) === null
  );
}

function isEditorAgentPreparedChangesetFile(
  value: unknown,
): value is EditorAgentPreparedChangesetFile {
  return (
    isRecord(value) &&
    isNonEmptyString(value.file) &&
    isContainedAgentPath(value.file) &&
    isPreparedChangeKind(value.kind) &&
    isPreparedTextEditArray(value.textEdits)
  );
}

function preparedTextBytes(files: readonly EditorAgentPreparedChangesetFile[]): number {
  return files.reduce(
    (total, file) =>
      total +
      file.textEdits.reduce(
        (fileTotal, edit) => fileTotal + EDITOR_AGENT_TEXT_ENCODER.encode(edit.newText).length,
        0,
      ),
    0,
  );
}

export function isEditorAgentPreparedChangeset(
  value: unknown,
): value is EditorAgentPreparedChangeset {
  if (!isRecord(value) || !Array.isArray(value.files)) return false;
  if (value.files.length === 0 || value.files.length > EDITOR_AGENT_CHANGESET_MAX_FILES)
    return false;
  if (!value.files.every(isEditorAgentPreparedChangesetFile)) return false;
  const files = value.files as readonly EditorAgentPreparedChangesetFile[];
  const editCount = files.reduce((total, file) => total + file.textEdits.length, 0);
  return (
    normalizedPathsAreUnique(files.map((file) => file.file)) &&
    editCount <= EDITOR_AGENT_PREPARED_CHANGESET_MAX_EDITS &&
    preparedTextBytes(files) <= EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES
  );
}

export function isEditorAgentChangeset(value: unknown): value is EditorAgentChangeset {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.files)) return false;
  if (value.files.length === 0 || value.files.length > EDITOR_AGENT_CHANGESET_MAX_FILES)
    return false;
  if (!value.files.every(isEditorAgentChangesetFile)) return false;
  const files = value.files as readonly EditorAgentChangesetFile[];
  if (!normalizedPathsAreUnique(files.map((file) => file.file))) return false;
  return (
    isNonEmptyString(value.patch) &&
    EDITOR_AGENT_TEXT_ENCODER.encode(value.patch).length <=
      EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES &&
    selectedFilesBelongToChangeset(value.selectedFiles, files) &&
    isUndefinedOr(value.prepared, isEditorAgentPreparedChangeset)
  );
}

function isDiagnosticsSummary(
  value: unknown,
): value is { readonly errors: number; readonly warnings: number; readonly infos: number } {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.errors) &&
    isNonNegativeInteger(value.warnings) &&
    isNonNegativeInteger(value.infos)
  );
}

// Issue #1379 AC4 — the content-free language-capability detail. languageId is a non-empty string,
// providerId is a string or null, available is a boolean, and unavailableReason (when present) is a
// string. Reuses the existing isRecord / string / isUndefinedOr helpers so the validator style
// matches the rest of this module.
function isLanguageCapability(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.languageId) &&
    (value.providerId === null || isString(value.providerId)) &&
    typeof value.available === "boolean" &&
    isUndefinedOr(value.unavailableReason, isString)
  );
}

function isPaneSnapshot(value: unknown): value is EditorAgentPaneSnapshot {
  return (
    isRecord(value) &&
    isBoundedUtf8String(value.paneId, EDITOR_AGENT_PANE_ID_MAX_BYTES) &&
    (value.activeFile === null || isBoundedTargetPath(value.activeFile)) &&
    isTargetPathArray(value.openFiles, EDITOR_AGENT_SNAPSHOT_MAX_OPEN_FILES_PER_PANE)
  );
}

function isSnapshotTextMode(value: unknown): value is EditorAgentSnapshotTextMode {
  return value === "none" || value === "selection" || value === "activeFile";
}

function isPaneSnapshotArray(value: unknown): value is readonly EditorAgentPaneSnapshot[] {
  return (
    Array.isArray(value) &&
    value.length <= EDITOR_AGENT_SNAPSHOT_MAX_PANES &&
    value.every(isPaneSnapshot)
  );
}

function snapshotPathMetadataWithinBound(value: Record<string, unknown>): boolean {
  if (!isPaneSnapshotArray(value.panes)) return false;
  if (!isTargetPathArray(value.dirtyFiles, EDITOR_AGENT_SNAPSHOT_MAX_DIRTY_FILES)) return false;
  const activeFile = value.activeFile;
  if (activeFile !== null && !isBoundedTargetPath(activeFile)) return false;
  const paths = value.panes.flatMap((pane) => [
    ...(pane.activeFile === null ? [] : [pane.activeFile]),
    ...pane.openFiles,
  ]);
  if (activeFile !== null) paths.push(activeFile);
  paths.push(...value.dirtyFiles);
  const bytes = paths.reduce(
    (total, path) => total + EDITOR_AGENT_TEXT_ENCODER.encode(path).length,
    0,
  );
  return bytes <= EDITOR_AGENT_SNAPSHOT_PATH_METADATA_MAX_BYTES;
}

export function isEditorAgentSessionSnapshot(value: unknown): value is EditorAgentSessionSnapshot {
  if (!isRecord(value)) return false;
  return [
    value.schemaVersion === EDITOR_AGENT_SCHEMA_VERSION,
    isBoundedUtf8String(value.sessionId, EDITOR_AGENT_SESSION_ID_MAX_BYTES),
    isBoundedUtf8String(value.windowId, EDITOR_AGENT_WINDOW_ID_MAX_BYTES),
    isBoundedUtf8String(value.workspaceRoot, EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES),
    isNullOr(value.activePaneId, (paneId) =>
      isBoundedUtf8String(paneId, EDITOR_AGENT_PANE_ID_MAX_BYTES),
    ),
    snapshotPathMetadataWithinBound(value),
    isNullOr(value.cursor, isPosition),
    isNullOr(value.selection, isRange),
    isNullOr(value.diagnosticsSummary, isDiagnosticsSummary),
    isUndefinedOr(value.diagnosticsDetail, isEditorAgentDiagnosticsDetail),
    isUndefinedOr(value.languageCapability, (c) => c === null || isLanguageCapability(c)),
    isUndefinedOr(value.documentVersion, isDocumentVersion),
    isUndefinedOr(value.activeFileContentHash, isSha256Hex),
    isSnapshotTextMode(value.textMode),
    isUndefinedOr(value.text, (text) =>
      isUtf8StringWithin(text, EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES),
    ),
    isUndefinedOr(
      value.textTruncated,
      (candidate): candidate is boolean => typeof candidate === "boolean",
    ),
    isNonNegativeInteger(value.updatedAt),
  ].every(Boolean);
}

function isActionType(value: unknown): value is EditorAgentActionType {
  return (
    typeof value === "string" && EDITOR_AGENT_ACTION_TYPES.includes(value as EditorAgentActionType)
  );
}

export function isEditorAgentActionOrigin(value: unknown): value is EditorAgentActionOrigin {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_ACTION_ORIGINS.includes(value as EditorAgentActionOrigin)
  );
}

export function resolveEditorAgentActionOrigin(
  value: EditorAgentActionOrigin | undefined,
): EditorAgentActionOrigin {
  return value ?? DEFAULT_EDITOR_AGENT_ACTION_ORIGIN;
}

function isSplitDirection(
  value: unknown,
): value is NonNullable<NonNullable<EditorAgentAction["target"]>["splitDirection"]> {
  return value === "row" || value === "column";
}

function isActionTarget(value: unknown): value is NonNullable<EditorAgentAction["target"]> {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return [
    isUndefinedOr(value.paneId, (paneId) =>
      isBoundedUtf8String(paneId, EDITOR_AGENT_PANE_ID_MAX_BYTES),
    ),
    isUndefinedOr(value.file, isBoundedTargetPath),
    isUndefinedOr(value.toPaneId, (paneId) =>
      isBoundedUtf8String(paneId, EDITOR_AGENT_PANE_ID_MAX_BYTES),
    ),
    isUndefinedOr(value.splitDirection, isSplitDirection),
    isUndefinedOr(value.selection, isRange),
  ].every(Boolean);
}

function isBoundedStringArray(value: unknown, maxItems: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => isNonEmptyString(entry) && entry.length <= 200)
  );
}

function isNavigateSymbolOperation(value: unknown): value is EditorAgentNavigateSymbolOperation {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_NAVIGATE_SYMBOL_OPERATIONS.includes(value as EditorAgentNavigateSymbolOperation)
  );
}

function isLanguageDiagnosticArray(value: unknown): value is readonly LanguageDiagnostic[] {
  return (
    Array.isArray(value) &&
    value.length <= EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS &&
    value.every(
      (item) => isEditorAgentDiagnostic(item) && isRecord(item) && isNonEmptyString(item.source),
    )
  );
}

function isNavigateSymbolDocument(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedTargetPath(value.path) &&
    isBoundedNonEmptyString(value.languageId, 128) &&
    isUndefinedOr(value.text, (text) =>
      isUtf8StringWithin(text, EDITOR_AGENT_NAVIGATION_DOCUMENT_MAX_BYTES),
    )
  );
}

function isNavigateSymbolRequest(value: unknown): value is EditorAgentNavigateSymbolRequest {
  if (!isRecord(value) || !isNavigateSymbolOperation(value.operation)) return false;
  if (!isNavigateSymbolDocument(value.document) || !isPosition(value.position)) return false;
  if (!isUndefinedOr(value.range, isRange)) return false;
  if (!isUndefinedOr(value.diagnostics, isLanguageDiagnosticArray)) return false;
  return value.operation === "codeActions"
    ? value.range !== undefined && value.diagnostics !== undefined
    : value.range === undefined && value.diagnostics === undefined;
}

function isSearchWorkspaceRequest(value: unknown): value is EditorAgentSearchWorkspaceRequest {
  return (
    isRecord(value) &&
    (value.mode === "text" || value.mode === "symbol") &&
    isBoundedNonEmptyString(value.query, EDITOR_AGENT_SEARCH_MAX_QUERY_CHARS) &&
    isUndefinedOr(value.caseSensitive, (candidate) => typeof candidate === "boolean") &&
    isUndefinedOr(value.includeGlobs, (candidate) => isBoundedStringArray(candidate, 32)) &&
    isUndefinedOr(value.excludeGlobs, (candidate) => isBoundedStringArray(candidate, 32)) &&
    isUndefinedOr(
      value.maxResults,
      (candidate) =>
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate > 0 &&
        candidate <= EDITOR_AGENT_SEARCH_MAX_RESULTS,
    ) &&
    isUndefinedOr(value.scopePath, isBoundedTargetPath)
  );
}

function isEditorAgentActionData(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).length <= EDITOR_AGENT_ACTION_DATA_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function isTextEdit(
  value: unknown,
): value is { readonly range: LanguageRange; readonly newText: string } {
  return isRecord(value) && isRange(value.range) && typeof value.newText === "string";
}

function isTextEditArray(
  value: unknown,
): value is readonly { readonly range: LanguageRange; readonly newText: string }[] {
  return Array.isArray(value) && value.every(isTextEdit);
}

export function isEditorAgentAction(value: unknown): value is EditorAgentAction {
  if (!isRecord(value)) return false;
  return [
    value.schemaVersion === EDITOR_AGENT_SCHEMA_VERSION,
    isBoundedUtf8String(value.actionId, EDITOR_AGENT_ACTION_ID_MAX_BYTES),
    isBoundedUtf8String(value.idempotencyKey, EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES),
    isBoundedUtf8String(value.sessionId, EDITOR_AGENT_SESSION_ID_MAX_BYTES),
    isActionType(value.type),
    isUndefinedOr(value.origin, isEditorAgentActionOrigin),
    isUndefinedOr(value.authorityRef, isEditorAgentGovernedAuthorityReference),
    isUndefinedOr(
      value.approvalRef,
      (reference) =>
        isEditorAgentOneUseApprovalReference(reference) && reference.actionId === value.actionId,
    ),
    isUndefinedOr(value.requiresReview, (candidate) => typeof candidate === "boolean"),
    isActionTarget(value.target),
    isUndefinedOr(value.expectedDocumentVersion, isDocumentVersion),
    isUndefinedOr(value.expectedContentHash, isSha256Hex),
    value.type === "applyTextEdits" || value.type === "applyPatch"
      ? isUndefinedOr(value.textEdits, isTextEditArray)
      : value.textEdits === undefined,
    value.type === "applyPatch" ? isUndefinedOr(value.patch, isString) : value.patch === undefined,
    value.type === "applyChangeset"
      ? isEditorAgentChangeset(value.changeset)
      : value.changeset === undefined,
    value.type === "navigateSymbol"
      ? isNavigateSymbolRequest(value.navigateSymbol)
      : value.navigateSymbol === undefined,
    value.type === "searchWorkspace"
      ? isSearchWorkspaceRequest(value.searchWorkspace)
      : value.searchWorkspace === undefined,
  ].every(Boolean);
}

// Issue #1391 AC2 — write actions. These four action types mutate buffer or file content and must
// therefore assert an optimistic-concurrency precondition before they run. The remaining action types
// (openFile, focusTab, moveTab, splitPane, setSelection) are navigation/inspection and carry no such
// requirement. The server reuses this frozen table so "what is a write action" has a single source of
// truth across the contract, the BFF preflight, and any future agent.
export const EDITOR_AGENT_WRITE_ACTION_TYPES: readonly EditorAgentActionType[] = [
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
  "applyChangeset",
] as const;

export const EDITOR_AGENT_ACTIVE_BUFFER_ACTION_TYPES: readonly EditorAgentActionType[] = [
  "setSelection",
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
] as const;

export function isEditorAgentActiveBufferActionType(
  value: unknown,
): value is EditorAgentActionType {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_ACTIVE_BUFFER_ACTION_TYPES.includes(value as EditorAgentActionType)
  );
}

export function isEditorAgentWriteActionType(value: unknown): value is EditorAgentActionType {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_WRITE_ACTION_TYPES.includes(value as EditorAgentActionType)
  );
}

// True when the action pins the document revision it expects to write against — by document version
// or by content hash. Either precondition is sufficient; both may be supplied. The mandatory
// `idempotencyKey` (validated by `isEditorAgentAction`) covers safe retry; this covers safe write.
export function editorAgentActionHasWritePrecondition(action: EditorAgentAction): boolean {
  if (action.type === "applyChangeset") {
    return action.changeset?.files.every(changesetFileHasPrecondition) === true;
  }
  return action.expectedDocumentVersion !== undefined || action.expectedContentHash !== undefined;
}

// Issue #1391 AC2 — a write action must assert a version/hash precondition in addition to its
// mandatory idempotency key, so an agent can never blind-write over a buffer whose revision it has
// not pinned (lost-update prevention). Returns a stable, content-free error string when a write
// action is missing the precondition, or null when the action satisfies it or is not a write action.
// Pure and throw-free, consistent with the other editor-agent validators; consumers (the BFF
// preflight, tests, future agents) reuse it rather than re-deriving the rule.
export function editorAgentWritePreconditionError(action: EditorAgentAction): string | null {
  if (!isEditorAgentWriteActionType(action.type)) return null;
  if (editorAgentActionHasWritePrecondition(action)) return null;
  return "Write actions require an expected document version or content hash precondition.";
}

function isActionStatus(value: unknown): value is EditorAgentActionStatus {
  return value === "queued" || value === "succeeded" || value === "failed" || value === "conflict";
}

export function isEditorAgentConflictDetail(value: unknown): value is EditorAgentConflictDetail {
  return (
    isRecord(value) &&
    isEditorAgentConflictCode(value.code) &&
    isBoundedResultMessage(value.message) &&
    isUndefinedOr(value.file, (file) => isNonEmptyString(file) && isContainedAgentPath(file))
  );
}

function isOptionalEditorAgentConflictDetail(value: unknown): boolean {
  return value === undefined || isEditorAgentConflictDetail(value);
}

function isEditorAgentFileActionStatus(value: unknown): value is EditorAgentFileActionStatus {
  return (
    value === "succeeded" || value === "failed" || value === "conflict" || value === "not-selected"
  );
}

export function isEditorAgentFileActionResult(
  value: unknown,
): value is EditorAgentFileActionResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value.file) &&
    isContainedAgentPath(value.file) &&
    isEditorAgentFileActionStatus(value.status) &&
    isUndefinedOr(value.message, isBoundedResultMessage) &&
    isOptionalEditorAgentConflictDetail(value.conflict)
  );
}

function isEditorAgentFileActionResultArray(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > EDITOR_AGENT_CHANGESET_MAX_FILES) return false;
  if (!value.every(isEditorAgentFileActionResult)) return false;
  return new Set(value.map((result) => result.file)).size === value.length;
}

// Issue #1392 — a failure detail, when present, mirrors the conflict-detail guard against the
// lifecycle-failure taxonomy, so a "failed" result cannot smuggle an out-of-taxonomy code past it.
function isEditorAgentFailureDetail(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) && isEditorAgentFailureCode(value.code) && isBoundedResultMessage(value.message)
  );
}

export function isEditorAgentActionResult(value: unknown): value is EditorAgentActionResult {
  return (
    isRecord(value) &&
    value.schemaVersion === EDITOR_AGENT_SCHEMA_VERSION &&
    isBoundedUtf8String(value.actionId, EDITOR_AGENT_ACTION_ID_MAX_BYTES) &&
    isBoundedUtf8String(value.sessionId, EDITOR_AGENT_SESSION_ID_MAX_BYTES) &&
    isActionStatus(value.status) &&
    isUndefinedOr(value.message, isBoundedResultMessage) &&
    isOptionalEditorAgentConflictDetail(value.conflict) &&
    isEditorAgentFailureDetail(value.failure) &&
    isEditorAgentFileActionResultArray(value.files) &&
    isUndefinedOr(value.data, isEditorAgentActionData)
  );
}

export function isEditorAgentConflictCode(value: unknown): value is EditorAgentConflictCode {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_CONFLICT_CODES.includes(value as EditorAgentConflictCode)
  );
}

export function isEditorAgentFailureCode(value: unknown): value is EditorAgentFailureCode {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_FAILURE_CODES.includes(value as EditorAgentFailureCode)
  );
}

// Issue #1391 — structural guard over the full editor-agent event union. Validates the shared
// envelope fields (schemaVersion, eventId) and the payload of every event kind (session, action,
// result, heartbeat). Consumers that read events off the SSE stream (the browser bridge today, any
// future agent transport) use it to reject malformed frames at the trust boundary instead of casting
// untyped JSON. Pure and throw-free.
export function isEditorAgentEvent(value: unknown): value is EditorAgentEvent {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION) return false;
  if (!isBoundedUtf8String(value.eventId, EDITOR_AGENT_EVENT_ID_MAX_BYTES)) return false;
  switch (value.type) {
    case "session":
      return isEditorAgentSessionSnapshot(value.snapshot);
    case "action":
      return isEditorAgentAction(value.action);
    case "result":
      return isEditorAgentActionResult(value.result);
    case "heartbeat":
      return isNonNegativeInteger(value.updatedAt);
    default:
      return false;
  }
}

function validateAgentTextEdit(
  edit: { readonly range: LanguageRange; readonly newText: string },
  index: number,
): string | null {
  const { start, end } = edit.range;
  const label = String(index);
  if (start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) {
    return `Edit ${label} has a negative line or character coordinate.`;
  }
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    return `Edit ${label} has an inverted range (end before start).`;
  }
  return null;
}

function positionLessThan(
  a: { readonly line: number; readonly character: number },
  b: { readonly line: number; readonly character: number },
): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

// Half-open ranges [start, end) overlap iff the later edit starts strictly before the earlier
// edit ends. Adjacency (next.start === current.end) does not overlap and is allowed.
function rangesOverlap(current: LanguageRange, next: LanguageRange): boolean {
  return positionLessThan(next.start, current.end);
}

function overlapError(
  edits: readonly { readonly range: LanguageRange; readonly newText: string }[],
): string | null {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => (positionLessThan(a.edit.range.start, b.edit.range.start) ? -1 : 1));
  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i - 1];
    const next = ordered[i];
    if (current === undefined || next === undefined) continue;
    if (rangesOverlap(current.edit.range, next.edit.range)) {
      const [lo, hi] = [current.index, next.index].sort((x, y) => x - y);
      return `Edits ${String(lo)} and ${String(hi)} overlap.`;
    }
  }
  return null;
}

export function validateAgentTextEdits(
  edits: readonly { readonly range: LanguageRange; readonly newText: string }[],
): string | null {
  let index = 0;
  for (const edit of edits) {
    const error = validateAgentTextEdit(edit, index);
    if (error !== null) return error;
    index += 1;
  }
  return overlapError(edits);
}

function parseBridgeSnapshotRequest(
  value: Record<string, unknown>,
): EditorAgentParse<EditorAgentBridgeSnapshotRequest> {
  if (
    value.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION ||
    value.kind !== "snapshot" ||
    !Object.keys(value).every((key) => EDITOR_AGENT_BRIDGE_SNAPSHOT_REQUEST_KEYS.has(key)) ||
    !isEditorAgentSessionSnapshot(value.snapshot)
  ) {
    return { ok: false, errors: ["snapshot must be a valid editor agent session snapshot"] };
  }
  if (
    value.bridgeDecisionCapability !== undefined &&
    !isEditorAgentBridgeDecisionCapability(value.bridgeDecisionCapability)
  ) {
    return { ok: false, errors: ["bridgeDecisionCapability must be a bounded capability"] };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "snapshot",
      snapshot: value.snapshot,
      ...(value.bridgeDecisionCapability === undefined
        ? {}
        : { bridgeDecisionCapability: value.bridgeDecisionCapability }),
    },
  };
}

const EDITOR_AGENT_BRIDGE_SNAPSHOT_REQUEST_KEYS = new Set([
  "schemaVersion",
  "kind",
  "snapshot",
  "bridgeDecisionCapability",
]);

function parseReadSnapshotRequest(
  value: Record<string, unknown>,
): EditorAgentParse<EditorAgentSnapshotRequest> {
  if (value.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION) {
    return { ok: false, errors: ["schemaVersion must be 1"] };
  }
  // AC1 (#1391): snapshot text defaults to `none`. An omitted `textMode` resolves to the content-free
  // default so an agent never receives document content it did not explicitly request; a value that is
  // present but not one of the three modes is still a hard error.
  const textMode =
    value.textMode === undefined ? DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE : value.textMode;
  if (!isSnapshotTextMode(textMode)) {
    return { ok: false, errors: ["textMode must be none, selection, or activeFile"] };
  }
  if (
    value.sessionId !== undefined &&
    !isBoundedUtf8String(value.sessionId, EDITOR_AGENT_SESSION_ID_MAX_BYTES)
  ) {
    return { ok: false, errors: ["sessionId must be a bounded string when present"] };
  }
  if (value.maxBytes !== undefined && !isNonNegativeInteger(value.maxBytes)) {
    return { ok: false, errors: ["maxBytes must be a non-negative integer when present"] };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      textMode,
      ...(value.maxBytes === undefined ? {} : { maxBytes: value.maxBytes }),
    },
  };
}

export function parseEditorAgentSnapshotRequest(
  value: unknown,
): EditorAgentParse<EditorAgentSnapshotRequest | EditorAgentBridgeSnapshotRequest> {
  if (!isRecord(value)) return { ok: false, errors: ["request must be an object"] };
  return value.kind === "snapshot"
    ? parseBridgeSnapshotRequest(value)
    : parseReadSnapshotRequest(value);
}

function canonicalRange(range: LanguageRange): LanguageRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function canonicalDocumentVersion(version: EditorDocumentVersion): EditorDocumentVersion {
  return {
    sizeBytes: version.sizeBytes,
    modifiedAt: version.modifiedAt,
    contentHash: version.contentHash,
  };
}

function canonicalActionTarget(
  target: NonNullable<EditorAgentAction["target"]>,
): NonNullable<EditorAgentAction["target"]> {
  return {
    ...(target.paneId === undefined ? {} : { paneId: target.paneId }),
    ...(target.file === undefined ? {} : { file: target.file }),
    ...(target.toPaneId === undefined ? {} : { toPaneId: target.toPaneId }),
    ...(target.splitDirection === undefined ? {} : { splitDirection: target.splitDirection }),
    ...(target.selection === undefined ? {} : { selection: canonicalRange(target.selection) }),
  };
}

function canonicalChangesetFile(file: EditorAgentChangesetFile): EditorAgentChangesetFile {
  return {
    file: file.file,
    ...(file.expectedDocumentVersion === undefined
      ? {}
      : { expectedDocumentVersion: canonicalDocumentVersion(file.expectedDocumentVersion) }),
    ...(file.expectedContentHash === undefined
      ? {}
      : { expectedContentHash: file.expectedContentHash }),
  };
}

function canonicalPreparedTextEdit(edit: EditorAgentPreparedTextEdit): EditorAgentPreparedTextEdit {
  return { range: canonicalRange(edit.range), newText: edit.newText };
}

function canonicalPreparedChangesetFile(
  file: EditorAgentPreparedChangesetFile,
): EditorAgentPreparedChangesetFile {
  return {
    file: file.file,
    kind: file.kind,
    textEdits: file.textEdits.map(canonicalPreparedTextEdit),
  };
}

function canonicalChangeset(changeset: EditorAgentChangeset): EditorAgentChangeset {
  return {
    patch: changeset.patch,
    files: changeset.files.map(canonicalChangesetFile),
    ...(changeset.selectedFiles === undefined
      ? {}
      : { selectedFiles: [...changeset.selectedFiles] }),
    ...(changeset.prepared === undefined
      ? {}
      : {
          prepared: { files: changeset.prepared.files.map(canonicalPreparedChangesetFile) },
        }),
  };
}

function canonicalNavigateSymbolRequest(
  request: NonNullable<EditorAgentAction["navigateSymbol"]>,
): NonNullable<EditorAgentAction["navigateSymbol"]> {
  return {
    operation: request.operation,
    document: {
      path: request.document.path,
      languageId: request.document.languageId,
      ...(request.document.text === undefined ? {} : { text: request.document.text }),
    },
    position: canonicalPosition(request.position),
    ...(request.range === undefined ? {} : { range: canonicalRange(request.range) }),
    ...(request.diagnostics === undefined
      ? {}
      : { diagnostics: request.diagnostics.map(canonicalDiagnostic) }),
  };
}

function canonicalSearchWorkspaceRequest(
  request: NonNullable<EditorAgentAction["searchWorkspace"]>,
): NonNullable<EditorAgentAction["searchWorkspace"]> {
  return {
    mode: request.mode,
    query: request.query,
    ...(request.caseSensitive === undefined ? {} : { caseSensitive: request.caseSensitive }),
    ...(request.includeGlobs === undefined ? {} : { includeGlobs: [...request.includeGlobs] }),
    ...(request.excludeGlobs === undefined ? {} : { excludeGlobs: [...request.excludeGlobs] }),
    ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
    ...(request.scopePath === undefined ? {} : { scopePath: request.scopePath }),
  };
}

function canonicalTextEditsPayload(action: EditorAgentAction): Partial<EditorAgentAction> {
  return action.textEdits === undefined
    ? {}
    : { textEdits: action.textEdits.map(canonicalPreparedTextEdit) };
}

function canonicalPatchPayload(action: EditorAgentAction): Partial<EditorAgentAction> {
  return {
    ...canonicalTextEditsPayload(action),
    ...(action.patch === undefined ? {} : { patch: action.patch }),
  };
}

function canonicalEditorAgentActionPayload(action: EditorAgentAction): Partial<EditorAgentAction> {
  switch (action.type) {
    case "applyTextEdits":
      return canonicalTextEditsPayload(action);
    case "applyPatch":
      return canonicalPatchPayload(action);
    case "applyChangeset":
      return action.changeset === undefined
        ? {}
        : { changeset: canonicalChangeset(action.changeset) };
    case "navigateSymbol":
      return action.navigateSymbol === undefined
        ? {}
        : { navigateSymbol: canonicalNavigateSymbolRequest(action.navigateSymbol) };
    case "searchWorkspace":
      return action.searchWorkspace === undefined
        ? {}
        : { searchWorkspace: canonicalSearchWorkspaceRequest(action.searchWorkspace) };
    default:
      return {};
  }
}

function canonicalPosition(position: LanguagePosition): LanguagePosition {
  return { line: position.line, character: position.character };
}

function canonicalDiagnostic(diagnostic: LanguageDiagnostic): LanguageDiagnostic {
  return {
    range: canonicalRange(diagnostic.range),
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  };
}

function canonicalEditorAgentAction(action: EditorAgentAction): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    sessionId: action.sessionId,
    type: action.type,
    origin: resolveEditorAgentActionOrigin(action.origin),
    ...(action.authorityRef === undefined
      ? {}
      : {
          authorityRef: {
            runId: action.authorityRef.runId,
            envelopeDigest: action.authorityRef.envelopeDigest,
          },
        }),
    ...(action.approvalRef === undefined
      ? {}
      : {
          approvalRef: {
            approvalId: action.approvalRef.approvalId,
            actionId: action.approvalRef.actionId,
            approvalProofDigest: action.approvalRef.approvalProofDigest,
            expiresAt: action.approvalRef.expiresAt,
          },
        }),
    ...(action.requiresReview === undefined ? {} : { requiresReview: action.requiresReview }),
    ...(action.target === undefined ? {} : { target: canonicalActionTarget(action.target) }),
    ...(action.expectedDocumentVersion === undefined
      ? {}
      : { expectedDocumentVersion: canonicalDocumentVersion(action.expectedDocumentVersion) }),
    ...(action.expectedContentHash === undefined
      ? {}
      : { expectedContentHash: action.expectedContentHash }),
    ...canonicalEditorAgentActionPayload(action),
  };
}

function canonicalConflict(conflict: EditorAgentConflictDetail): EditorAgentConflictDetail {
  return {
    code: conflict.code,
    message: conflict.message,
    ...(conflict.file === undefined ? {} : { file: conflict.file }),
  };
}

function canonicalFileActionResult(
  result: EditorAgentFileActionResult,
): EditorAgentFileActionResult {
  return {
    file: result.file,
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.conflict === undefined ? {} : { conflict: canonicalConflict(result.conflict) }),
  };
}

function canonicalActionResult(result: EditorAgentActionResult): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: result.actionId,
    sessionId: result.sessionId,
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.conflict === undefined ? {} : { conflict: canonicalConflict(result.conflict) }),
    ...(result.failure === undefined
      ? {}
      : { failure: { code: result.failure.code, message: result.failure.message } }),
    ...(result.files === undefined ? {} : { files: result.files.map(canonicalFileActionResult) }),
    ...(result.data === undefined ? {} : { data: result.data }),
  };
}

const EDITOR_AGENT_BRIDGE_ACTION_REQUEST_KEYS = new Set([
  "schemaVersion",
  "kind",
  "action",
  "bridgeDecisionCapability",
]);

const EDITOR_AGENT_ACTION_RESULT_REQUEST_KEYS = new Set([
  "schemaVersion",
  "kind",
  "result",
  "bridgeDecisionCapability",
]);

function parseBridgeActionRequest(
  value: Record<string, unknown>,
): EditorAgentParse<EditorAgentBridgeActionRequest> {
  if (
    value.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION ||
    !Object.keys(value).every((key) => EDITOR_AGENT_BRIDGE_ACTION_REQUEST_KEYS.has(key)) ||
    !isEditorAgentAction(value.action) ||
    !isEditorAgentBridgeDecisionCapability(value.bridgeDecisionCapability)
  ) {
    return { ok: false, errors: ["browser action request is invalid"] };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "action",
      action: canonicalEditorAgentAction(value.action),
      bridgeDecisionCapability: value.bridgeDecisionCapability,
    },
  };
}

function parseActionResultRequest(
  value: Record<string, unknown>,
): EditorAgentParse<EditorAgentActionResultRequest> {
  if (
    value.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION ||
    value.kind !== "result" ||
    !Object.keys(value).every((key) => EDITOR_AGENT_ACTION_RESULT_REQUEST_KEYS.has(key)) ||
    !isEditorAgentActionResult(value.result)
  ) {
    return { ok: false, errors: ["action result request is invalid"] };
  }
  const capability = value.bridgeDecisionCapability;
  if (capability !== undefined && !isEditorAgentBridgeDecisionCapability(capability)) {
    return { ok: false, errors: ["bridgeDecisionCapability must be a bounded capability"] };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "result",
      result: canonicalActionResult(value.result),
      ...(capability === undefined ? {} : { bridgeDecisionCapability: capability }),
    },
  };
}

function invalidActionsPostBody(): EditorAgentParseFail {
  return {
    ok: false,
    errors: ["body must be an editor agent action, browser action request, or action result"],
  };
}

export function parseEditorAgentActionsPostBody(
  value: unknown,
): EditorAgentParse<EditorAgentActionsPostBody> {
  if (isEditorAgentAction(value)) {
    return { ok: true, value: canonicalEditorAgentAction(value) };
  }
  if (!isRecord(value)) return invalidActionsPostBody();
  if (value.kind === "action") return parseBridgeActionRequest(value);
  return value.kind === "result" ? parseActionResultRequest(value) : invalidActionsPostBody();
}

export function isEditorAgentBridgeDecisionCapability(
  value: unknown,
): value is EditorAgentBridgeDecisionCapability {
  return (
    typeof value === "string" &&
    value.length === EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}
