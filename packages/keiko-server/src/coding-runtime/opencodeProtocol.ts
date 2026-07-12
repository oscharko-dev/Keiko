import { createHash } from "node:crypto";

import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import { OPENCODE_TOOL_SOURCE_DEFINITIONS } from "./opencodeToolSchemas.js";

/** The only OpenCode HTTP surface admitted by the v1.17.17 adapter. */
export const OPENCODE_APPROVED_ENDPOINTS = Object.freeze([
  "GET /global/health",
  "GET /global/event",
  "GET /doc",
  "GET /session",
  "GET /session/status",
  "POST /session",
  "POST /session/{sessionID}/prompt_async",
  "POST /session/{sessionID}/abort",
  "GET /permission",
  "POST /permission/{requestID}/reply",
  "GET /question",
  "POST /question/{requestID}/reply",
  "POST /question/{requestID}/reject",
  "POST /sync/history",
] as const);

export type OpenCodeProtocolFailure =
  "schema-invalid" | "frame-invalid" | "frame-oversized" | "event-unknown";
export type OpenCodeProtocolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OpenCodeProtocolFailure };
export interface OpenCodeHealth {
  readonly healthy: boolean;
  readonly version: string;
}
export interface OpenCodeSseMessage {
  readonly event: "message";
  readonly data: Record<string, unknown>;
}
export interface OpenCodeSseDecoder {
  push(chunk: string): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]>;
  finish(): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]>;
}

export interface OpenCodeLiveControl {
  readonly sessionId: string;
  readonly state: "activity" | "terminal";
}

interface NormalizedSseData extends Record<string, unknown> {
  readonly id: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_HISTORY_INFO_BYTES = 64 * 1024;
const MAX_HISTORY_INFO_DEPTH = 8;
const MAX_JSON_DEPTH = 64;
const ID = /^(?:evt_|ses_|per|que)[A-Za-z0-9_-]+$/u;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]+$/u;
const PART_ID = /^prt_[A-Za-z0-9_-]+$/u;
const REVIEWED_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "unknown",
]);
const TERMINAL_FINISH_REASONS = new Set(["stop", "length", "content-filter", "error"]);
const APPROVED_PRODUCTIVE_TOOLS = new Set<string>(
  OPENCODE_TOOL_SOURCE_DEFINITIONS.map(({ name }) => name),
);
const APPROVED_MODEL_VISIBLE_RUNTIME_TOOLS = new Set<string>([
  "question",
  ...APPROVED_PRODUCTIVE_TOOLS,
]);

export function validateOpenCodeHealth(value: unknown): OpenCodeProtocolResult<OpenCodeHealth> {
  return exactRecord(value, ["healthy", "version"]) &&
    typeof value.healthy === "boolean" &&
    nonEmpty(value.version)
    ? { ok: true, value: { healthy: value.healthy, version: value.version } }
    : { ok: false, reason: "schema-invalid" };
}

/** Parses complete SSE frames; transport chunk assembly remains deliberately outside this pure codec. */
export function parseOpenCodeSse(
  input: string,
): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
  return parseOpenCodeSseWithLimit(input, MAX_FRAME_BYTES);
}

// eslint-disable-next-line complexity -- each independent frame violation fails closed.
function parseOpenCodeSseWithLimit(
  input: string,
  maxFrameBytes: number,
): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
  const messages: OpenCodeSseMessage[] = [];
  for (const frame of input.replace(/\r\n/gu, "\n").split("\n\n")) {
    if (frame.length === 0 || frame.startsWith(":")) continue;
    if (bytes(frame) > maxFrameBytes) return { ok: false, reason: "frame-oversized" };
    const fields: Record<string, string> = {};
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      const match = /^(event|data): ?(.*)$/u.exec(line);
      const key = match?.[1];
      const fieldValue = match?.[2];
      if (
        key === undefined ||
        fieldValue === undefined ||
        (key !== "data" && fields[key] !== undefined)
      )
        return { ok: false, reason: "frame-invalid" };
      if (key === "data") dataLines.push(fieldValue);
      fields[key] = fieldValue;
    }
    if ((fields.event !== undefined && fields.event !== "message") || fields.data === undefined)
      return { ok: false, reason: "frame-invalid" };
    const envelope = parseRecord(dataLines.join("\n"));
    const data = normalizedGlobalEvent(envelope);
    if (data === undefined) return { ok: false, reason: "frame-invalid" };
    if (
      (data.type === "session.status" || data.type === "session.idle") &&
      classifyOpenCodeLiveControl(data) === undefined
    )
      return { ok: false, reason: "frame-invalid" };
    if (
      data.type === "session.next.tool.called" &&
      (!nonEmpty(data.properties.tool) ||
        !APPROVED_MODEL_VISIBLE_RUNTIME_TOOLS.has(data.properties.tool))
    )
      return { ok: false, reason: "event-unknown" };
    messages.push({ event: "message", data });
  }
  return { ok: true, value: messages };
}

// eslint-disable-next-line complexity -- exact live-control variants fail closed independently.
export function classifyOpenCodeLiveControl(value: unknown): OpenCodeLiveControl | undefined {
  if (!exactRecord(value, ["id", "type", "properties"]) || !isRecord(value.properties))
    return undefined;
  if (
    value.type === "session.idle" &&
    exactRecord(value.properties, ["sessionID"]) &&
    id(value.properties.sessionID, "ses_")
  )
    return { sessionId: value.properties.sessionID, state: "terminal" };
  if (
    value.type !== "session.status" ||
    !exactRecord(value.properties, ["sessionID", "status"]) ||
    !id(value.properties.sessionID, "ses_")
  )
    return undefined;
  const status = value.properties.status;
  if (exactRecord(status, ["type"]) && status.type === "idle")
    return { sessionId: value.properties.sessionID, state: "terminal" };
  if (exactRecord(status, ["type"]) && status.type === "busy")
    return { sessionId: value.properties.sessionID, state: "activity" };
  if (validRetryStatus(status)) return { sessionId: value.properties.sessionID, state: "activity" };
  return undefined;
}

function validRetryStatus(value: unknown): boolean {
  return (
    (exactRecord(value, ["type", "attempt", "message", "next"]) ||
      exactRecord(value, ["type", "attempt", "message", "next", "action"])) &&
    value.type === "retry" &&
    nonNegativeSafeInteger(value.attempt) &&
    nonEmpty(value.message) &&
    nonNegativeSafeInteger(value.next) &&
    (value.action === undefined || validLiveStatusAction(value.action))
  );
}

function validLiveStatusAction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const exact =
    exactRecord(value, ["reason", "provider", "title", "message", "label"]) ||
    exactRecord(value, ["reason", "provider", "title", "message", "label", "link"]);
  return (
    exact &&
    [value.reason, value.provider, value.title, value.message, value.label, value.link].every(
      (item) => item === undefined || (typeof item === "string" && item.length <= 4096),
    )
  );
}

// eslint-disable-next-line complexity -- exact envelope and optional routing keys fail closed independently.
function normalizedGlobalEvent(
  envelope: Record<string, unknown> | undefined,
): NormalizedSseData | undefined {
  if (
    envelope === undefined ||
    !allowedRecord(envelope, ["directory", "project", "workspace", "payload"]) ||
    !Object.prototype.hasOwnProperty.call(envelope, "payload") ||
    (Object.keys(envelope).length > 1 &&
      !Object.prototype.hasOwnProperty.call(envelope, "directory")) ||
    ![envelope.directory, envelope.project, envelope.workspace].every(
      (value) => value === undefined || nonEmpty(value),
    )
  )
    return undefined;
  const payload = envelope.payload;
  if (isRecord(payload) && payload.type === "sync") return normalizedSyncPayload(payload);
  if (
    !exactRecord(payload, ["id", "type", "properties"]) ||
    typeof payload.id !== "string" ||
    !/^evt_[A-Za-z0-9_-]+$/u.test(payload.id) ||
    !nonEmpty(payload.type) ||
    !isRecord(payload.properties)
  )
    return undefined;
  return { id: payload.id, type: payload.type, properties: payload.properties };
}

// eslint-disable-next-line complexity -- every reviewed sync bridge identity and schema gate is explicit.
function normalizedSyncPayload(payload: Record<string, unknown>): NormalizedSseData | undefined {
  if (
    !exactRecord(payload, ["type", "id", "syncEvent"]) ||
    payload.type !== "sync" ||
    typeof payload.id !== "string" ||
    !/^evt_[A-Za-z0-9_-]+$/u.test(payload.id) ||
    !exactRecord(payload.syncEvent, ["type", "id", "seq", "aggregateID", "data"]) ||
    payload.syncEvent.type !== "session.created.1" ||
    payload.syncEvent.id !== payload.id ||
    !nonNegativeSafeInteger(payload.syncEvent.seq) ||
    payload.syncEvent.seq !== 0 ||
    !id(payload.syncEvent.aggregateID, "ses_") ||
    !isRecord(payload.syncEvent.data) ||
    !sessionCreated(payload.syncEvent.data, payload.syncEvent.aggregateID)
  )
    return undefined;
  return { id: payload.id, type: "sync", properties: {} };
}

/** Incremental bounded decoder for transport chunks that split an SSE frame. */
export function createOpenCodeSseDecoder(maxBufferedBytes = MAX_FRAME_BYTES): OpenCodeSseDecoder {
  let pending = "";
  const decode = (complete: boolean): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> => {
    const normalized = pending.replace(/\r\n/gu, "\n");
    const boundary = normalized.lastIndexOf("\n\n");
    if (boundary < 0) {
      if (bytes(normalized) > maxBufferedBytes) return { ok: false, reason: "frame-oversized" };
      return complete && normalized.length > 0
        ? { ok: false, reason: "frame-invalid" }
        : { ok: true, value: [] };
    }
    const ready = normalized.slice(0, boundary + 2);
    pending = normalized.slice(boundary + 2);
    if (bytes(pending) > maxBufferedBytes) return { ok: false, reason: "frame-oversized" };
    return parseOpenCodeSseWithLimit(ready, maxBufferedBytes);
  };
  return {
    push(chunk: string): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
      pending += chunk;
      return decode(false);
    },
    finish(): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
      return decode(true);
    },
  };
}

/**
 * Narrows the permissive upstream Sync History record to Keiko's content-free, security-relevant
 * subset. Unknown events are intentionally not forward compatible: a new upstream event requires review.
 */
export function parseOpenCodeHistory(
  value: unknown,
): OpenCodeProtocolResult<readonly OpenCodeReconciliationEvent[]> {
  if (!Array.isArray(value)) return { ok: false, reason: "schema-invalid" };
  const result: OpenCodeReconciliationEvent[] = [];
  for (const row of value) {
    if (!exactRecord(row, ["id", "aggregate_id", "seq", "type", "data"]))
      return { ok: false, reason: "schema-invalid" };
    const { id, aggregate_id: aggregateId, seq: sequence, type, data } = row;
    if (
      !nonEmpty(id) ||
      !nonEmpty(aggregateId) ||
      !nonNegativeSafeInteger(sequence) ||
      !nonEmpty(type) ||
      !isRecord(data)
    )
      return { ok: false, reason: "schema-invalid" };
    const kind = classifiedEvent(type, data, sequence, aggregateId);
    if (kind === undefined) return { ok: false, reason: "event-unknown" };
    result.push({
      id,
      aggregateId,
      sequence,
      kind,
      digest: historyDigest(id, aggregateId, sequence, type, data),
    });
  }
  return { ok: true, value: result };
}

// eslint-disable-next-line complexity -- the closed allowlist is a security control, not a dispatch extension point.
function classifiedEvent(
  type: string,
  data: Record<string, unknown>,
  sequence: number,
  aggregateId: string,
): OpenCodeReconciliationEvent["kind"] | undefined {
  if (type === "session.created.1" && sequence === 0 && sessionCreated(data, aggregateId))
    return "observation";
  if (type === "session.updated.1" && sessionUpdated(data, aggregateId)) return "observation";
  if (type === "message.updated.1") return messageUpdated(data, aggregateId);
  if (type === "message.part.updated.1" && messagePartUpdated(data, aggregateId))
    return "observation";
  if (type === "session.idle" && exactRecord(data, ["sessionID"]) && id(data.sessionID, "ses_"))
    return "terminal";
  if (
    type === "session.status" &&
    exactRecord(data, ["sessionID", "status"]) &&
    id(data.sessionID, "ses_") &&
    nonEmpty(data.status)
  )
    return "observation";
  if (type === "permission.asked" && permissionAsked(data)) return "permission";
  if (
    type === "permission.replied" &&
    exactRecord(data, ["sessionID", "requestID", "reply"]) &&
    id(data.sessionID, "ses_") &&
    id(data.requestID, "per") &&
    ["once", "always", "reject"].includes(String(data.reply))
  )
    return "permission";
  if (type === "question.asked" && questionAsked(data)) return "question";
  if (
    (type === "question.replied" || type === "question.rejected") &&
    exactRecord(
      data,
      type === "question.replied"
        ? ["sessionID", "requestID", "answers"]
        : ["sessionID", "requestID"],
    ) &&
    id(data.sessionID, "ses_") &&
    id(data.requestID, "que")
  )
    return "question";
  const toolKind = classifiedToolEvent(type, data);
  if (toolKind !== undefined) return toolKind;
  return undefined;
}

function sessionCreated(data: Record<string, unknown>, aggregateId: string): boolean {
  if (
    !exactRecord(data, ["sessionID", "info"]) ||
    !id(data.sessionID, "ses_") ||
    data.sessionID !== aggregateId ||
    !isRecord(data.info) ||
    !id(data.info.id, "ses_") ||
    data.info.id !== data.sessionID
  )
    return false;
  return boundedJson(data.info, 0) && bytes(JSON.stringify(data.info)) <= MAX_HISTORY_INFO_BYTES;
}

// eslint-disable-next-line complexity -- the pinned session projection is an exact-key trust boundary.
function sessionUpdated(data: Record<string, unknown>, aggregateId: string): boolean {
  if (
    !exactRecord(data, ["sessionID", "info"]) ||
    data.sessionID !== aggregateId ||
    !isRecord(data.info)
  )
    return false;
  const info = data.info;
  return (
    allowedRecord(info, [
      "id",
      "slug",
      "projectID",
      "directory",
      "path",
      "summary",
      "cost",
      "tokens",
      "title",
      "agent",
      "model",
      "version",
      "time",
    ]) &&
    info.id === aggregateId &&
    id(info.id, "ses_") &&
    [info.slug, info.projectID, info.directory, info.path, info.title, info.version].every(
      nonEmpty,
    ) &&
    finite(info.cost) &&
    tokenCounts(info.tokens) &&
    (info.agent === undefined || nonEmpty(info.agent)) &&
    (info.model === undefined || modelIdentity(info.model)) &&
    (info.summary === undefined || sessionSummary(info.summary)) &&
    lifecycleTime(info.time) &&
    boundedLifecycle(info)
  );
}

// eslint-disable-next-line complexity -- user, assistant, and terminal variants fail closed independently.
function messageUpdated(
  data: Record<string, unknown>,
  aggregateId: string,
): OpenCodeReconciliationEvent["kind"] | undefined {
  if (
    !exactRecord(data, ["sessionID", "info"]) ||
    data.sessionID !== aggregateId ||
    !isRecord(data.info) ||
    data.info.sessionID !== aggregateId
  )
    return undefined;
  if (data.info.role === "user") return userMessage(data.info) ? "observation" : undefined;
  if (!assistantMessage(data.info)) return undefined;
  const completed = isRecord(data.info.time) && nonNegativeNumber(data.info.time.completed);
  return completed && TERMINAL_FINISH_REASONS.has(String(data.info.finish))
    ? "terminal"
    : "observation";
}

function userMessage(info: Record<string, unknown>): boolean {
  return (
    exactRecord(info, ["id", "sessionID", "role", "time", "agent", "model"]) &&
    MESSAGE_ID.test(String(info.id)) &&
    info.role === "user" &&
    exactCreatedTime(info.time) &&
    nonEmpty(info.agent) &&
    userModelIdentity(info.model) &&
    boundedLifecycle(info)
  );
}

// eslint-disable-next-line complexity -- every required assistant completion field is checked explicitly.
function assistantMessage(info: Record<string, unknown>): boolean {
  if (
    !allowedRecord(info, [
      "id",
      "sessionID",
      "role",
      "time",
      "parentID",
      "modelID",
      "providerID",
      "mode",
      "agent",
      "path",
      "cost",
      "tokens",
      "finish",
    ]) ||
    ![
      "id",
      "sessionID",
      "role",
      "time",
      "parentID",
      "modelID",
      "providerID",
      "mode",
      "agent",
      "path",
      "cost",
      "tokens",
    ].every((key) => Object.prototype.hasOwnProperty.call(info, key))
  )
    return false;
  return (
    MESSAGE_ID.test(String(info.id)) &&
    info.role === "assistant" &&
    assistantTime(info.time) &&
    MESSAGE_ID.test(String(info.parentID)) &&
    [info.modelID, info.providerID, info.mode, info.agent].every(nonEmpty) &&
    exactStringRecord(info.path, ["cwd", "root"]) &&
    finite(info.cost) &&
    tokenCounts(info.tokens) &&
    (info.finish === undefined ||
      (nonEmpty(info.finish) && REVIEWED_FINISH_REASONS.has(info.finish))) &&
    boundedLifecycle(info)
  );
}

// eslint-disable-next-line complexity, max-lines-per-function -- reviewed part variants remain a closed allowlist.
function messagePartUpdated(data: Record<string, unknown>, aggregateId: string): boolean {
  if (
    !exactRecord(data, ["sessionID", "part", "time"]) ||
    data.sessionID !== aggregateId ||
    !isRecord(data.part) ||
    !nonNegativeNumber(data.time) ||
    data.part.sessionID !== aggregateId ||
    !PART_ID.test(String(data.part.id)) ||
    !MESSAGE_ID.test(String(data.part.messageID)) ||
    !boundedLifecycle(data.part)
  )
    return false;
  const part = data.part;
  if (part.type === "text") {
    return (
      allowedRecord(part, [
        "id",
        "sessionID",
        "messageID",
        "type",
        "text",
        "synthetic",
        "ignored",
        "time",
        "metadata",
      ]) &&
      typeof part.text === "string" &&
      (part.synthetic === undefined || typeof part.synthetic === "boolean") &&
      (part.ignored === undefined || typeof part.ignored === "boolean")
    );
  }
  if (part.type === "step-start") {
    return allowedRecord(part, ["id", "sessionID", "messageID", "type", "snapshot"]);
  }
  if (part.type === "step-finish") {
    return (
      allowedRecord(part, [
        "id",
        "sessionID",
        "messageID",
        "type",
        "reason",
        "snapshot",
        "cost",
        "tokens",
      ]) &&
      nonEmpty(part.reason) &&
      REVIEWED_FINISH_REASONS.has(part.reason) &&
      finite(part.cost) &&
      tokenCounts(part.tokens)
    );
  }
  return part.type === "tool" && toolPart(part);
}

// eslint-disable-next-line complexity -- each pinned tool-state shape fails closed independently.
function toolPart(part: Record<string, unknown>): boolean {
  if (
    !allowedRecord(part, [
      "id",
      "sessionID",
      "messageID",
      "type",
      "callID",
      "tool",
      "state",
      "metadata",
    ]) ||
    !nonEmpty(part.callID) ||
    !nonEmpty(part.tool) ||
    !APPROVED_MODEL_VISIBLE_RUNTIME_TOOLS.has(part.tool) ||
    (part.metadata !== undefined && !isRecord(part.metadata)) ||
    !isRecord(part.state)
  )
    return false;
  const state = part.state;
  if (state.status === "pending") {
    return (
      exactRecord(state, ["status", "input", "raw"]) &&
      isRecord(state.input) &&
      typeof state.raw === "string"
    );
  }
  if (state.status === "running") {
    return (
      allowedRecord(state, ["status", "input", "title", "metadata", "time"]) &&
      isRecord(state.input) &&
      (state.title === undefined ||
        (typeof state.title === "string" && state.title.length <= 4096)) &&
      (state.metadata === undefined || isRecord(state.metadata)) &&
      exactStartTime(state.time)
    );
  }
  if (state.status === "completed") {
    return (
      allowedRecord(state, ["status", "input", "output", "title", "metadata", "time"]) &&
      isRecord(state.input) &&
      typeof state.output === "string" &&
      nonEmpty(state.title) &&
      isRecord(state.metadata) &&
      exactStartEndTime(state.time)
    );
  }
  return false;
}

function boundedJson(value: unknown, depth: number): boolean {
  if (depth > MAX_HISTORY_INFO_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 4096;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 256 && value.every((item) => boundedJson(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(
    ([key, item]) => nonEmpty(key) && boundedJson(item, depth + 1),
  );
}

function boundedLifecycle(value: unknown): boolean {
  return boundedJson(value, 0) && bytes(JSON.stringify(value)) <= MAX_HISTORY_INFO_BYTES;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function tokenCounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(["cache", "input", "output", "reasoning", "total"].sort()) &&
    JSON.stringify(keys) !== JSON.stringify(["cache", "input", "output", "reasoning"].sort())
  )
    return false;
  return (
    [value.total, value.input, value.output, value.reasoning].every(
      (item) => item === undefined || nonNegativeNumber(item),
    ) &&
    isRecord(value.cache) &&
    exactRecord(value.cache, ["read", "write"]) &&
    nonNegativeNumber(value.cache.read) &&
    nonNegativeNumber(value.cache.write)
  );
}

function lifecycleTime(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["created", "updated"]) &&
    nonNegativeNumber(value.created) &&
    nonNegativeNumber(value.updated)
  );
}

function exactCreatedTime(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ["created"]) && nonNegativeNumber(value.created);
}

function assistantTime(value: unknown): boolean {
  return (
    isRecord(value) &&
    (exactRecord(value, ["created"]) || exactRecord(value, ["created", "completed"])) &&
    nonNegativeNumber(value.created) &&
    (value.completed === undefined || nonNegativeNumber(value.completed))
  );
}

function exactStartTime(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ["start"]) && nonNegativeNumber(value.start);
}

function exactStartEndTime(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["start", "end"]) &&
    nonNegativeNumber(value.start) &&
    nonNegativeNumber(value.end)
  );
}

function modelIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    allowedRecord(value, ["id", "providerID", "variant"]) &&
    nonEmpty(value.id) &&
    nonEmpty(value.providerID) &&
    (value.variant === undefined || nonEmpty(value.variant))
  );
}

function userModelIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["providerID", "modelID"]) &&
    nonEmpty(value.providerID) &&
    nonEmpty(value.modelID)
  );
}

function sessionSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["additions", "deletions", "files"]) &&
    [value.additions, value.deletions, value.files].every(nonNegativeNumber)
  );
}

function exactStringRecord(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && exactRecord(value, keys) && keys.every((key) => nonEmpty(value[key]));
}

function historyDigest(
  eventId: string,
  aggregateId: string,
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): string {
  const digestData = contentFreeHistoryData(data);
  return digest({ id: eventId, aggregate_id: aggregateId, seq: sequence, type, data: digestData });
}

// eslint-disable-next-line complexity -- only reviewed identity fields survive content-free projection.
function contentFreeHistoryData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["sessionID", "id", "requestID", "assistantMessageID", "callID", "reply"]) {
    const value = data[key];
    if (typeof value === "string") result[key] = value;
  }
  if (isRecord(data.info)) {
    const info: Record<string, string> = {};
    for (const key of ["id", "sessionID", "role", "finish"]) {
      const value = data.info[key];
      if (typeof value === "string") info[key] = value;
    }
    result.info = info;
  }
  if (isRecord(data.part)) {
    const part: Record<string, string> = {};
    for (const key of ["id", "sessionID", "messageID", "type", "reason", "tool"]) {
      const value = data.part[key];
      if (typeof value === "string") part[key] = value;
    }
    result.part = part;
    if (isRecord(data.part.state) && typeof data.part.state.status === "string") {
      part.status = data.part.state.status;
    }
  }
  return result;
}

function permissionAsked(data: Record<string, unknown>): boolean {
  return (
    exactRecord(data, ["id", "sessionID", "permission", "patterns", "metadata", "always"]) &&
    id(data.id, "per") &&
    id(data.sessionID, "ses_") &&
    nonEmpty(data.permission) &&
    stringArray(data.patterns) &&
    isRecord(data.metadata) &&
    stringArray(data.always)
  );
}
function questionAsked(data: Record<string, unknown>): boolean {
  return (
    exactRecord(data, ["id", "sessionID", "questions"]) &&
    id(data.id, "que") &&
    id(data.sessionID, "ses_") &&
    Array.isArray(data.questions)
  );
}
// eslint-disable-next-line complexity -- the pinned event variants and productive-tool gate stay explicit.
function toolEvent(type: string, data: Record<string, unknown>): boolean {
  const allowed =
    type === "session.next.tool.called"
      ? ["timestamp", "sessionID", "assistantMessageID", "callID", "tool", "input", "provider"]
      : type === "session.next.tool.success"
        ? [
            "timestamp",
            "sessionID",
            "assistantMessageID",
            "callID",
            "structured",
            "content",
            "provider",
            "outputPaths",
            "result",
          ]
        : type === "session.next.tool.failed"
          ? [
              "timestamp",
              "sessionID",
              "assistantMessageID",
              "callID",
              "error",
              "provider",
              "result",
            ]
          : undefined;
  return (
    allowed !== undefined &&
    allowedRecord(data, allowed) &&
    nonEmpty(data.timestamp) &&
    id(data.sessionID, "ses_") &&
    nonEmpty(data.assistantMessageID) &&
    nonEmpty(data.callID) &&
    nonEmpty(data.provider) &&
    (type !== "session.next.tool.called" ||
      (nonEmpty(data.tool) && APPROVED_MODEL_VISIBLE_RUNTIME_TOOLS.has(data.tool)))
  );
}

function classifiedToolEvent(
  type: string,
  data: Record<string, unknown>,
): "question" | "tool" | undefined {
  if (!toolEvent(type, data)) return undefined;
  if (type === "session.next.tool.called" && data.tool === "question") return "question";
  if (
    type === "session.next.tool.called" &&
    (!nonEmpty(data.tool) || !APPROVED_PRODUCTIVE_TOOLS.has(data.tool))
  )
    return undefined;
  return "tool";
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function allowedRecord(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type OpenCodeJsonResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** Parses bounded OpenCode JSON while rejecting duplicate decoded object keys recursively. */
export function parseOpenCodeJson(value: string): OpenCodeJsonResult {
  const state = { index: 0 };
  try {
    if (!scanJsonValue(value, state, 0)) return { ok: false };
    skipJsonWhitespace(value, state);
    if (state.index !== value.length) return { ok: false };
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function scanJsonValue(value: string, state: { index: number }, depth: number): boolean {
  skipJsonWhitespace(value, state);
  const token = value[state.index];
  if (token === "{") return depth < MAX_JSON_DEPTH && scanJsonObject(value, state, depth + 1);
  if (token === "[") return depth < MAX_JSON_DEPTH && scanJsonArray(value, state, depth + 1);
  if (token === '"') return scanJsonString(value, state) !== undefined;
  for (const literal of ["true", "false", "null"]) {
    if (value.startsWith(literal, state.index)) {
      state.index += literal.length;
      return true;
    }
  }
  const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
    value.slice(state.index),
  )?.[0];
  if (number === undefined) return false;
  state.index += number.length;
  return true;
}

function scanJsonObject(value: string, state: { index: number }, depth: number): boolean {
  state.index += 1;
  skipJsonWhitespace(value, state);
  if (value[state.index] === "}") {
    state.index += 1;
    return true;
  }
  const keys = new Set<string>();
  for (;;) {
    skipJsonWhitespace(value, state);
    const key = scanJsonString(value, state);
    if (key === undefined || keys.has(key)) return false;
    keys.add(key);
    skipJsonWhitespace(value, state);
    if (value[state.index] !== ":") return false;
    state.index += 1;
    if (!scanJsonValue(value, state, depth)) return false;
    skipJsonWhitespace(value, state);
    const separator = value[state.index];
    state.index += 1;
    if (separator === "}") return true;
    if (separator !== ",") return false;
  }
}

function scanJsonArray(value: string, state: { index: number }, depth: number): boolean {
  state.index += 1;
  skipJsonWhitespace(value, state);
  if (value[state.index] === "]") {
    state.index += 1;
    return true;
  }
  for (;;) {
    if (!scanJsonValue(value, state, depth)) return false;
    skipJsonWhitespace(value, state);
    const separator = value[state.index];
    state.index += 1;
    if (separator === "]") return true;
    if (separator !== ",") return false;
  }
}

function scanJsonString(value: string, state: { index: number }): string | undefined {
  if (value[state.index] !== '"') return undefined;
  const start = state.index;
  state.index += 1;
  while (state.index < value.length) {
    const token = value[state.index];
    state.index += 1;
    if (token === "\\") {
      state.index += 1;
      continue;
    }
    if (token === '"') {
      const parsed: unknown = JSON.parse(value.slice(start, state.index));
      return typeof parsed === "string" ? parsed : undefined;
    }
  }
  return undefined;
}

function skipJsonWhitespace(value: string, state: { index: number }): void {
  while (/\s/u.test(value[state.index] ?? "")) state.index += 1;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  const parsed = parseOpenCodeJson(value);
  return parsed.ok && isRecord(parsed.value) ? parsed.value : undefined;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function id(value: unknown, prefix: string): value is string {
  return nonEmpty(value) && value.startsWith(prefix) && ID.test(value);
}
function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 256 && value.every(nonEmpty);
}
function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
