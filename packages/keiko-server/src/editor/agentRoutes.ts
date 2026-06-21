import type { ServerResponse } from "node:http";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentAction,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
  type EditorAgentSnapshotTextMode,
} from "@oscharko-dev/keiko-contracts";
import { errorBody, STREAMING, type HandlerOutcome, type RouteContext, type RouteResult } from "../routes.js";
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

function utf8Prefix(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
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
  if (action.expectedDocumentVersion === undefined || snapshot.documentVersion === undefined) return null;
  return action.expectedDocumentVersion.contentHash === snapshot.documentVersion.contentHash
    ? null
    : conflict(action, "VERSION_MISMATCH", "The active document version no longer matches.");
}

function contentHashConflict(
  action: EditorAgentAction,
  snapshot: EditorAgentSessionSnapshot,
): EditorAgentActionResult | null {
  if (action.expectedContentHash === undefined || snapshot.activeFileContentHash === undefined) return null;
  return action.expectedContentHash === snapshot.activeFileContentHash
    ? null
    : conflict(action, "CONTENT_HASH_MISMATCH", "The active document content hash no longer matches.");
}

function targetFile(action: EditorAgentAction, snapshot: EditorAgentSessionSnapshot): string | null {
  return action.target?.file ?? snapshot.activeFile;
}

function writeAction(action: EditorAgentAction): boolean {
  return (
    action.type === "format" ||
    action.type === "save" ||
    action.type === "applyTextEdits" ||
    action.type === "applyPatch"
  );
}

function conflict(
  action: EditorAgentAction,
  code: NonNullable<EditorAgentActionResult["conflict"]>["code"],
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
  if (!writeAction(action)) return null;
  return (
    dirtyBufferConflict(action, snapshot) ??
    documentVersionConflict(action, snapshot) ??
    contentHashConflict(action, snapshot)
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
        body: errorBody("IDEMPOTENCY_CONFLICT", "Idempotency-Key was reused with a different action."),
      };
    }
    return { status: 200, body: { result: replay.result } };
  }
  const failed = preflight(action);
  if (failed !== null) {
    idempotency.set(action.idempotencyKey, { requestBody, result: failed });
    return { status: 409, body: { result: failed } };
  }
  const result: EditorAgentActionResult = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "queued",
  };
  idempotency.set(action.idempotencyKey, { requestBody, result });
  emit({ type: "action", action });
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
