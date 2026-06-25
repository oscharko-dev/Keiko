import type { ServerResponse } from "node:http";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  validateAgentTextEdits,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentConflictCode,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
  type EditorAgentSnapshotTextMode,
  type LanguageRange,
} from "@oscharko-dev/keiko-contracts";
import {
  computeFileContent,
  validatePatch,
  type PatchFileChange,
  type PatchValidation,
} from "@oscharko-dev/keiko-tools";
import { resolveWithinWorkspace, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "../routes.js";
import { SSE_HEADERS, readyMessage } from "../sse.js";
import { readJsonObject } from "../files.js";

const MAX_AGENT_BODY_BYTES = 1_048_576;
const DEFAULT_SNAPSHOT_TEXT_BUDGET_BYTES = 64 * 1024;

interface QueuedRecord {
  readonly requestBody: string;
  readonly result: EditorAgentActionResult;
}

const sessions = new Map<string, EditorAgentSessionSnapshot>();
const idempotency = new Map<string, QueuedRecord>();
const subscribers = new Set<(event: EditorAgentEvent) => void>();
let eventSeq = 0;

type EditorAgentEventPayload =
  | { readonly type: "session"; readonly snapshot: EditorAgentSessionSnapshot }
  | { readonly type: "action"; readonly action: EditorAgentAction }
  | { readonly type: "result"; readonly result: EditorAgentActionResult }
  | { readonly type: "heartbeat"; readonly updatedAt: number };

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function nextEventId(): string {
  eventSeq += 1;
  return `editor-agent-${String(eventSeq)}`;
}

function emit(event: EditorAgentEventPayload): void {
  const envelope: EditorAgentEvent = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    eventId: nextEventId(),
    ...event,
  };
  for (const subscriber of subscribers) subscriber(envelope);
}

function utf8Prefix(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (bytes + nextBytes > maxBytes) return { text: text.slice(0, end), truncated: true };
    bytes += nextBytes;
    end += char.length;
  }
  return { text, truncated: false };
}

function shapeSnapshot(
  snapshot: EditorAgentSessionSnapshot,
  textMode: EditorAgentSnapshotTextMode,
  maxBytes: number,
): EditorAgentSessionSnapshot {
  if (textMode === "none" || snapshot.text === undefined) {
    const { text, textTruncated, ...rest } = snapshot;
    void text;
    void textTruncated;
    return { ...rest, textMode };
  }
  const bounded = utf8Prefix(snapshot.text, maxBytes);
  return {
    ...snapshot,
    textMode,
    text: bounded.text,
    textTruncated: snapshot.textTruncated === true || bounded.truncated,
  };
}

function dirtyBufferConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  const file = targetFile(action, snapshot);
  if (file !== null && snapshot.dirtyFiles.includes(file) && action.type !== "save") {
    return conflict(action, "DIRTY", "The target buffer has unsaved changes.");
  }
  return null;
}

function documentVersionConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.expectedDocumentVersion === undefined || snapshot.documentVersion === undefined)
    return null;
  return action.expectedDocumentVersion.contentHash === snapshot.documentVersion.contentHash
    ? null
    : conflict(action, "VERSION_MISMATCH", "The active document version no longer matches.");
}

function contentHashConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.expectedContentHash === undefined || snapshot.activeFileContentHash === undefined)
    return null;
  return action.expectedContentHash === snapshot.activeFileContentHash
    ? null
    : conflict(
        action,
        "CONTENT_HASH_MISMATCH",
        "The active document content hash no longer matches.",
      );
}

function containmentConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  const file = targetFile(action, snapshot);
  if (file === null) return null;
  return isContainedAgentPath(file)
    ? null
    : conflict(action, "OUT_OF_SCOPE", "The target file escapes the workspace root.");
}

function textEditsConflict(action: EditorAgentAction): EditorAgentActionResult | null {
  if (action.type !== "applyTextEdits") return null;
  const error = validateAgentTextEdits(action.textEdits ?? []);
  return error === null ? null : conflict(action, "INVALID_EDITS", error);
}

function workspaceInfoFromRoot(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const OUT_OF_SCOPE_REJECTION_CODES = new Set(["path-unsafe", "path-denied", "binary"]);

function mapPatchValidation(
  action: EditorAgentAction,
  validation: PatchValidation,
): EditorAgentActionResult | null {
  if (validation.files.length > 1) {
    return conflict(
      action,
      "OUT_OF_SCOPE",
      "Multi-file patches are not supported on the agent action path.",
    );
  }
  const scopeRejection = validation.reasons.find((reason) =>
    OUT_OF_SCOPE_REJECTION_CODES.has(reason.code),
  );
  if (scopeRejection !== undefined) {
    return conflict(action, "OUT_OF_SCOPE", scopeRejection.message);
  }
  const firstReason = validation.reasons.at(0);
  if (firstReason !== undefined) {
    return conflict(action, "INVALID_EDITS", firstReason.message);
  }
  const firstConflict = validation.conflicts.at(0);
  if (firstConflict !== undefined) {
    return conflict(action, "INVALID_EDITS", firstConflict.reason);
  }
  if (validation.ok && validation.files.length === 0) {
    return conflict(action, "INVALID_EDITS", "Patch contains no applicable file change.");
  }
  return null;
}

function patchValidationConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.type !== "applyPatch") return null;
  const validation = validatePatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.patch ?? "",
    {
      fs: nodeWorkspaceFs,
    },
  );
  return mapPatchValidation(action, validation);
}

interface AgentTextEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

function wholeDocumentReplaceEdit(currentContent: string, postImage: string): AgentTextEdit {
  const currentLineCount = currentContent.split("\n").length;
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: currentLineCount + 1, character: 0 },
    },
    newText: postImage,
  };
}

function deriveSingleFilePostImage(
  file: PatchFileChange,
  snapshot: EditorAgentSessionSnapshot,
): AgentTextEdit | null {
  const absolute = resolveWithinWorkspace(snapshot.workspaceRoot, file.path);
  const exists = nodeWorkspaceFs.exists(absolute);
  const currentContent = exists ? nodeWorkspaceFs.readFileUtf8(absolute) : "";
  const outcome = computeFileContent(file, exists ? currentContent : undefined);
  if (outcome.content === null || outcome.conflicts.length > 0) return null;
  return wholeDocumentReplaceEdit(currentContent, outcome.content);
}

// Translates a queued, preflight-validated single-file applyPatch into the contract textEdits the
// browser reviews and applies. Computing the post-image with keiko-tools' tested single-file apply
// logic against the current on-disk content guarantees the cross-cutting invariant
// applyTextEditsToText(currentContent, edits) === patchedSingleFileContent. Returns null when the
// patch is not the expected single-file shape or its post-image cannot be derived (including any
// filesystem/path error), so the caller fails the action rather than emitting an un-appliable one.
// keiko-tools strips a/ b/ git prefixes; both the patch path and snapshot.activeFile are
// workspace-relative POSIX paths. Normalize a leading ./ and backslashes so a legitimately
// matching same-file patch is not rejected on a cosmetic difference.
function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function deriveAgentPatchTextEdits(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): readonly AgentTextEdit[] | null {
  // Intentional re-validation: preflight already validated this patch, but validatePatch is
  // deterministic and pure over (workspace, patch, fs), so deriving here keeps this function
  // self-contained without threading mutable validation state through the queue path.
  const validation = validatePatch(
    workspaceInfoFromRoot(snapshot.workspaceRoot),
    action.patch ?? "",
    { fs: nodeWorkspaceFs },
  );
  const file = validation.files.at(0);
  if (!validation.ok || validation.files.length !== 1 || file === undefined) return null;
  // The post-image is derived from the patch's file content but the browser applies it to the
  // open buffer. Refuse to apply a patch that targets a different file than the open buffer.
  if (
    snapshot.activeFile === null ||
    normalizeWorkspaceRelativePath(file.path) !==
      normalizeWorkspaceRelativePath(snapshot.activeFile)
  ) {
    return null;
  }
  try {
    const edit = deriveSingleFilePostImage(file, snapshot);
    return edit === null ? null : [edit];
  } catch {
    return null;
  }
}

function emitAgentAction(action: EditorAgentAction, snapshot: EditorAgentSessionSnapshot): boolean {
  if (action.type !== "applyPatch") {
    emit({ type: "action", action });
    return true;
  }
  const textEdits = deriveAgentPatchTextEdits(action, snapshot);
  if (textEdits === null) return false;
  emit({ type: "action", action: { ...action, textEdits } });
  return true;
}

function targetFile(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): string | null {
  return action.target?.file ?? snapshot.activeFile;
}

// Issue #1391 AC2 — reject a write action that does not pin the document revision it expects to write
// against. The contract owns both "what is a write action" and "what counts as a precondition"; the
// server only maps the missing-precondition rule onto the structured PRECONDITION_REQUIRED conflict.
function preconditionConflict(action: EditorAgentAction): EditorAgentActionResult | null {
  const error = editorAgentWritePreconditionError(action);
  return error === null ? null : conflict(action, "PRECONDITION_REQUIRED", error);
}

function conflict(
  action: EditorAgentAction,
  code: EditorAgentConflictCode,
  message: string,
): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "conflict",
    message,
    conflict: { code, message },
  };
}

function preflight(action: EditorAgentAction): EditorAgentActionResult | null {
  const snapshot = sessions.get(action.sessionId);
  if (snapshot === undefined) {
    return conflict(action, "NO_ACTIVE_SESSION", "No active browser bridge is registered.");
  }
  if (!isEditorAgentWriteActionType(action.type)) return null;
  // The structural gates run first so a doubly-invalid write reports its most specific failure; the
  // precondition gate runs last and rejects any otherwise-valid write that did not pin a revision
  // (#1391 AC2 — no blind writes).
  return (
    dirtyBufferConflict(action, snapshot) ??
    documentVersionConflict(action, snapshot) ??
    contentHashConflict(action, snapshot) ??
    containmentConflict(action, snapshot) ??
    textEditsConflict(action) ??
    patchValidationConflict(action, snapshot) ??
    preconditionConflict(action)
  );
}

export function handleEditorAgentSessions(): RouteResult {
  return { status: 200, body: { sessions: [...sessions.values()] } };
}

export async function handleEditorAgentSnapshot(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentSnapshotRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if ("kind" in parsed.value) {
    sessions.set(parsed.value.snapshot.sessionId, parsed.value.snapshot);
    emit({ type: "session", snapshot: parsed.value.snapshot });
    return { status: 200, body: { snapshot: parsed.value.snapshot } };
  }
  const selected =
    parsed.value.sessionId === undefined
      ? [...sessions.values()][0]
      : sessions.get(parsed.value.sessionId);
  if (selected === undefined) return { status: 200, body: { snapshot: null } };
  const maxBytes = parsed.value.maxBytes ?? DEFAULT_SNAPSHOT_TEXT_BUDGET_BYTES;
  return {
    status: 200,
    body: { snapshot: shapeSnapshot(selected, parsed.value.textMode, maxBytes) },
  };
}

export async function handleEditorAgentActions(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_AGENT_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentActionsPostBody(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  if (!isEditorAgentAction(parsed.value)) {
    const result = parsed.value.result;
    emit({ type: "result", result });
    return { status: 200, body: { result } };
  }
  const action = parsed.value;
  const requestBody = JSON.stringify(action);
  const replay = idempotency.get(action.idempotencyKey);
  if (replay !== undefined) {
    if (replay.requestBody !== requestBody) {
      return {
        status: 409,
        body: errorBody(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was reused with a different action.",
        ),
      };
    }
    return { status: 200, body: { result: replay.result } };
  }
  const failed = preflight(action);
  if (failed !== null) {
    idempotency.set(action.idempotencyKey, { requestBody, result: failed });
    emit({ type: "result", result: failed });
    return { status: 409, body: { result: failed } };
  }
  return queueAndEmitAction(action, requestBody);
}

function failedResult(action: EditorAgentAction, message: string): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "failed",
    message,
  };
}

function queueAndEmitAction(action: EditorAgentAction, requestBody: string): RouteResult {
  const snapshot = sessions.get(action.sessionId);
  if (snapshot === undefined || !emitAgentAction(action, snapshot)) {
    const result = failedResult(action, "Patch could not be prepared for review.");
    idempotency.set(action.idempotencyKey, { requestBody, result });
    return { status: 409, body: { result } };
  }
  const result: EditorAgentActionResult = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "queued",
  };
  idempotency.set(action.idempotencyKey, { requestBody, result });
  return { status: 202, body: { result } };
}

export function handleEditorAgentEvents(ctx: RouteContext): HandlerOutcome {
  openAgentSseStream(ctx.res);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openAgentSseStream(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  const subscriber = (event: EditorAgentEvent): void => {
    const frame = `id: ${event.eventId}\nevent: editor-agent:${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if (!res.write(frame)) res.destroy();
  };
  subscribers.add(subscriber);
  res.write(readyMessage());
  res.on("close", () => {
    subscribers.delete(subscriber);
  });
}

export function _resetEditorAgentStateForTests(): void {
  sessions.clear();
  idempotency.clear();
  subscribers.clear();
  eventSeq = 0;
}
