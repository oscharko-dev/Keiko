import type { EditorDocumentVersion } from "./editor-session.js";
import type { LanguageRange } from "./language-service.js";

export const EDITOR_AGENT_SCHEMA_VERSION = "1" as const;

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
    | readonly { readonly range: LanguageRange; readonly newText: string }[]
    | undefined;
  readonly patch?: string | undefined;
}

export type EditorAgentActionStatus = "queued" | "succeeded" | "failed" | "conflict";

// Issue #1391 — the structured error-code taxonomy for agent action conflicts. Every conflict a
// write action can raise is one of these stable, machine-discriminable codes so agents, the BFF, and
// the conflict UI all reason over the same vocabulary rather than parsing free text (AC3).
//
//   - DIRTY                  the target buffer has unsaved changes (a non-`save` write was refused).
//   - VERSION_MISMATCH       the asserted `expectedDocumentVersion` no longer matches the document.
//   - CONTENT_HASH_MISMATCH  the asserted `expectedContentHash` no longer matches the document.
//   - NO_ACTIVE_SESSION      no browser bridge is registered for the action's session.
//   - INVALID_EDITS          the edits/patch are structurally invalid (overlap, inverted, malformed).
//   - OUT_OF_SCOPE           the target escapes the workspace root or the action is unsupported here.
//   - PRECONDITION_REQUIRED  a write action omitted the mandatory version/hash precondition (AC2).
export type EditorAgentConflictCode =
  | "DIRTY"
  | "VERSION_MISMATCH"
  | "CONTENT_HASH_MISMATCH"
  | "NO_ACTIVE_SESSION"
  | "INVALID_EDITS"
  | "OUT_OF_SCOPE"
  | "PRECONDITION_REQUIRED";

export const EDITOR_AGENT_CONFLICT_CODES: readonly EditorAgentConflictCode[] = [
  "DIRTY",
  "VERSION_MISMATCH",
  "CONTENT_HASH_MISMATCH",
  "NO_ACTIVE_SESSION",
  "INVALID_EDITS",
  "OUT_OF_SCOPE",
  "PRECONDITION_REQUIRED",
] as const;

export interface EditorAgentActionResult {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly actionId: string;
  readonly sessionId: string;
  readonly status: EditorAgentActionStatus;
  readonly message?: string | undefined;
  readonly conflict?:
    | {
        readonly code: EditorAgentConflictCode;
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

function isSplitDirection(
  value: unknown,
): value is NonNullable<NonNullable<EditorAgentAction["target"]>["splitDirection"]> {
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
] as const;

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

export function isEditorAgentConflictCode(value: unknown): value is EditorAgentConflictCode {
  return (
    typeof value === "string" &&
    EDITOR_AGENT_CONFLICT_CODES.includes(value as EditorAgentConflictCode)
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
  if (!isNonEmptyString(value.eventId)) return false;
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

export function isContainedAgentPath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (candidate.startsWith("/")) return false;
  if (/^[A-Za-z]:/u.test(candidate)) return false;
  if (candidate.includes("\u0000")) return false;
  const segments = candidate.split(/[/\\]/u);
  return !segments.includes("..");
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
