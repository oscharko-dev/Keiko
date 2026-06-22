import type { EditorDocumentVersion } from "./editor-session.js";
import type { LanguageRange } from "./language-service.js";

export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;

export type EditorAgentSnapshotTextMode = "none" | "selection" | "activeFile";

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
  readonly diagnosticsSummary:
    | { readonly errors: number; readonly warnings: number; readonly infos: number }
    | null;
  readonly documentVersion?: EditorDocumentVersion | undefined;
  readonly activeFileContentHash?: string | undefined;
  readonly textMode: EditorAgentSnapshotTextMode;
  readonly text?: string | undefined;
  readonly textTruncated?: boolean | undefined;
  readonly updatedAt: number;
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
  | "applyPatch";

export interface EditorAgentAction {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly type: EditorAgentActionType;
  readonly target?: {
    readonly paneId?: string | undefined;
    readonly file?: string | undefined;
    readonly toPaneId?: string | undefined;
    readonly splitDirection?: "row" | "column" | undefined;
    readonly selection?: LanguageRange | undefined;
  } | undefined;
  readonly expectedDocumentVersion?: EditorDocumentVersion | undefined;
  readonly expectedContentHash?: string | undefined;
  readonly textEdits?: readonly { readonly range: LanguageRange; readonly newText: string }[] | undefined;
  readonly patch?: string | undefined;
}

export type EditorAgentActionStatus = "queued" | "succeeded" | "failed" | "conflict";

export interface EditorAgentActionResult {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly actionId: string;
  readonly sessionId: string;
  readonly status: EditorAgentActionStatus;
  readonly message?: string | undefined;
  readonly conflict?:
    | {
        readonly code: "DIRTY" | "VERSION_MISMATCH" | "CONTENT_HASH_MISMATCH" | "NO_ACTIVE_SESSION";
        readonly message: string;
      }
    | undefined;
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
}

export interface EditorAgentActionResultRequest {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly kind: "result";
  readonly result: EditorAgentActionResult;
}

export type EditorAgentActionsPostBody = EditorAgentAction | EditorAgentActionResultRequest;

export interface EditorAgentSessionsResponse {
  readonly sessions: readonly EditorAgentSessionSnapshot[];
}

export interface EditorAgentActionQueuedResponse {
  readonly result: EditorAgentActionResult;
}

export interface EditorAgentSnapshotResponse {
  readonly snapshot: EditorAgentSessionSnapshot | null;
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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    isNonNegativeInteger(value.modifiedAt) &&
    isSha256Hex(value.contentHash)
  );
}

function isPosition(value: unknown): value is { readonly line: number; readonly character: number } {
  return isRecord(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.character);
}

function isRange(value: unknown): value is LanguageRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
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

function isPaneSnapshot(value: unknown): value is EditorAgentPaneSnapshot {
  return (
    isRecord(value) &&
    isNonEmptyString(value.paneId) &&
    (value.activeFile === null || typeof value.activeFile === "string") &&
    isStringArray(value.openFiles)
  );
}

function isSnapshotTextMode(value: unknown): value is EditorAgentSnapshotTextMode {
  return value === "none" || value === "selection" || value === "activeFile";
}

function isPaneSnapshotArray(value: unknown): value is readonly EditorAgentPaneSnapshot[] {
  return Array.isArray(value) && value.every(isPaneSnapshot);
}

export function isEditorAgentSessionSnapshot(value: unknown): value is EditorAgentSessionSnapshot {
  if (!isRecord(value)) return false;
  return [
    value.schemaVersion === EDITOR_AGENT_SCHEMA_VERSION,
    isNonEmptyString(value.sessionId),
    isNonEmptyString(value.windowId),
    isNonEmptyString(value.workspaceRoot),
    isNullOr(value.activePaneId, isString),
    isPaneSnapshotArray(value.panes),
    isStringArray(value.dirtyFiles),
    isNullOr(value.activeFile, isString),
    isNullOr(value.cursor, isPosition),
    isNullOr(value.selection, isRange),
    isNullOr(value.diagnosticsSummary, isDiagnosticsSummary),
    isUndefinedOr(value.documentVersion, isDocumentVersion),
    isUndefinedOr(value.activeFileContentHash, isSha256Hex),
    isSnapshotTextMode(value.textMode),
    isUndefinedOr(value.text, isString),
    isUndefinedOr(value.textTruncated, (candidate): candidate is boolean => typeof candidate === "boolean"),
    isNonNegativeInteger(value.updatedAt),
  ].every(Boolean);
}

function isActionType(value: unknown): value is EditorAgentActionType {
  return typeof value === "string" && EDITOR_AGENT_ACTION_TYPES.includes(value as EditorAgentActionType);
}

function isSplitDirection(value: unknown): value is NonNullable<NonNullable<EditorAgentAction["target"]>["splitDirection"]> {
  return value === "row" || value === "column";
}

function isActionTarget(value: unknown): value is NonNullable<EditorAgentAction["target"]> {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return [
    isUndefinedOr(value.paneId, isString),
    isUndefinedOr(value.file, isString),
    isUndefinedOr(value.toPaneId, isString),
    isUndefinedOr(value.splitDirection, isSplitDirection),
    isUndefinedOr(value.selection, isRange),
  ].every(Boolean);
}

function isTextEdit(value: unknown): value is { readonly range: LanguageRange; readonly newText: string } {
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
    isNonEmptyString(value.actionId),
    isNonEmptyString(value.idempotencyKey),
    isNonEmptyString(value.sessionId),
    isActionType(value.type),
    isActionTarget(value.target),
    isUndefinedOr(value.expectedDocumentVersion, isDocumentVersion),
    isUndefinedOr(value.expectedContentHash, isSha256Hex),
    isUndefinedOr(value.textEdits, isTextEditArray),
    isUndefinedOr(value.patch, isString),
  ].every(Boolean);
}

function isActionStatus(value: unknown): value is EditorAgentActionStatus {
  return value === "queued" || value === "succeeded" || value === "failed" || value === "conflict";
}

export function isEditorAgentActionResult(value: unknown): value is EditorAgentActionResult {
  return (
    isRecord(value) &&
    value.schemaVersion === EDITOR_AGENT_SCHEMA_VERSION &&
    isNonEmptyString(value.actionId) &&
    isNonEmptyString(value.sessionId) &&
    isActionStatus(value.status) &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function parseBridgeSnapshotRequest(
  value: Record<string, unknown>,
): EditorAgentParse<EditorAgentBridgeSnapshotRequest> {
  if (!isEditorAgentSessionSnapshot(value.snapshot)) {
    return { ok: false, errors: ["snapshot must be a valid editor agent session snapshot"] };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "snapshot",
      snapshot: value.snapshot,
    },
  };
}

function parseReadSnapshotRequest(value: Record<string, unknown>): EditorAgentParse<EditorAgentSnapshotRequest> {
  if (value.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION) {
    return { ok: false, errors: ["schemaVersion must be 1"] };
  }
  if (!isSnapshotTextMode(value.textMode)) {
    return { ok: false, errors: ["textMode must be none, selection, or activeFile"] };
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") {
    return { ok: false, errors: ["sessionId must be a string when present"] };
  }
  if (value.maxBytes !== undefined && !isNonNegativeInteger(value.maxBytes)) {
    return { ok: false, errors: ["maxBytes must be a non-negative integer when present"] };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      textMode: value.textMode,
      ...(value.maxBytes === undefined ? {} : { maxBytes: value.maxBytes }),
    },
  };
}

export function parseEditorAgentSnapshotRequest(
  value: unknown,
): EditorAgentParse<EditorAgentSnapshotRequest | EditorAgentBridgeSnapshotRequest> {
  if (!isRecord(value)) return { ok: false, errors: ["request must be an object"] };
  return value.kind === "snapshot" ? parseBridgeSnapshotRequest(value) : parseReadSnapshotRequest(value);
}

export function parseEditorAgentActionsPostBody(
  value: unknown,
): EditorAgentParse<EditorAgentActionsPostBody> {
  if (isEditorAgentAction(value)) return { ok: true, value };
  if (isRecord(value) && value.kind === "result" && isEditorAgentActionResult(value.result)) {
    return {
      ok: true,
      value: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "result",
        result: value.result,
      },
    };
  }
  return { ok: false, errors: ["body must be an editor agent action or action result"] };
}
