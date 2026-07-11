import { createHash } from "node:crypto";

import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";

/** The only OpenCode HTTP surface admitted by the v1.17.17 adapter. */
export const OPENCODE_APPROVED_ENDPOINTS = Object.freeze([
  "GET /global/health",
  "GET /global/event",
  "GET /session",
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
  readonly id?: string;
  readonly event?: string;
  readonly data: Record<string, unknown>;
}
export interface OpenCodeSseDecoder {
  push(chunk: string): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]>;
  finish(): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]>;
}

const MAX_FRAME_BYTES = 64 * 1024;
const ID = /^(?:evt_|ses_|per|que)[A-Za-z0-9_-]+$/u;

export function validateOpenCodeHealth(value: unknown): OpenCodeProtocolResult<OpenCodeHealth> {
  return exactRecord(value, ["healthy", "version"]) &&
    typeof value.healthy === "boolean" &&
    nonEmpty(value.version)
    ? { ok: true, value: { healthy: value.healthy, version: value.version } }
    : { ok: false, reason: "schema-invalid" };
}

/** Parses complete SSE frames; transport chunk assembly remains deliberately outside this pure codec. */
// eslint-disable-next-line complexity -- each independent frame violation fails closed.
export function parseOpenCodeSse(
  input: string,
): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
  if (bytes(input) > MAX_FRAME_BYTES) return { ok: false, reason: "frame-oversized" };
  const messages: OpenCodeSseMessage[] = [];
  for (const frame of input.replace(/\r\n/gu, "\n").split("\n\n")) {
    if (frame.length === 0 || frame.startsWith(":")) continue;
    const fields: Record<string, string> = {};
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      const match = /^(id|event|data): ?(.*)$/u.exec(line);
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
    if (fields.data === undefined) return { ok: false, reason: "frame-invalid" };
    const data = parseRecord(dataLines.join("\n"));
    if (data === undefined || (fields.id !== undefined && !ID.test(fields.id)))
      return { ok: false, reason: "frame-invalid" };
    messages.push({
      ...(fields.id === undefined ? {} : { id: fields.id }),
      ...(fields.event === undefined ? {} : { event: fields.event }),
      data,
    });
  }
  return { ok: true, value: messages };
}

/** Incremental bounded decoder for transport chunks that split an SSE frame. */
export function createOpenCodeSseDecoder(maxBufferedBytes = MAX_FRAME_BYTES): OpenCodeSseDecoder {
  let pending = "";
  const decode = (complete: boolean): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> => {
    const normalized = pending.replace(/\r\n/gu, "\n");
    const boundary = normalized.lastIndexOf("\n\n");
    if (boundary < 0)
      return complete && normalized.length > 0
        ? { ok: false, reason: "frame-invalid" }
        : { ok: true, value: [] };
    const ready = normalized.slice(0, boundary + 2);
    pending = normalized.slice(boundary + 2);
    return parseOpenCodeSse(ready);
  };
  return {
    push(chunk: string): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
      pending += chunk;
      return bytes(pending) > maxBufferedBytes
        ? { ok: false, reason: "frame-oversized" }
        : decode(false);
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
    const kind = classifiedEvent(type, data);
    if (kind === undefined) return { ok: false, reason: "event-unknown" };
    result.push({
      id,
      aggregateId,
      sequence,
      kind,
      digest: digest({ id, aggregate_id: aggregateId, seq: sequence, type, data }),
    });
  }
  return { ok: true, value: result };
}

// eslint-disable-next-line complexity -- the closed allowlist is a security control, not a dispatch extension point.
function classifiedEvent(
  type: string,
  data: Record<string, unknown>,
): OpenCodeReconciliationEvent["kind"] | undefined {
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
  if (toolEvent(type, data)) return "tool";
  return undefined;
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
    nonEmpty(data.provider)
  );
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
function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
