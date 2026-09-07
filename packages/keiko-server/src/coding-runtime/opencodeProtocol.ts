import { createHash } from "node:crypto";

import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";

import {
  parseCodingSidecarEventLine,
  type SidecarPermissionEvent,
} from "./codingSidecarEventParser.js";
import type {
  OpenCodeCompactionActivity,
  OpenCodeReconciliationEvent,
} from "./opencodeReconciler.js";
import {
  OPENCODE_GOVERNED_ACTION_PERMISSION,
  OPENCODE_TOOL_SOURCE_DEFINITIONS,
} from "./opencodeToolSchemas.js";

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
const PERMISSION_ID = /^per_[A-Za-z0-9_-]+$/u;
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
const FAILED_TERMINAL_FINISH_REASONS = new Set(["length", "content-filter", "error", "unknown"]);
const MESSAGE_ONLY_ASSISTANT_ERRORS = new Set(["MessageAbortedError", "ContentFilterError"]);
const ASSISTANT_MESSAGE_REQUIRED_FIELDS = [
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
] as const;
const ASSISTANT_MESSAGE_FIELDS = [
  ...ASSISTANT_MESSAGE_REQUIRED_FIELDS,
  "finish",
  "summary",
  "error",
  "structured",
  "variant",
] as const;
const APPROVED_PRODUCTIVE_TOOLS = new Set<string>(
  OPENCODE_TOOL_SOURCE_DEFINITIONS.map(({ name }) => name),
);

/**
 * True for a tool the Keiko facade dispatches and settles itself (`keiko_*`, per
 * `OPENCODE_TOOL_SOURCE_DEFINITIONS`). The single source of truth for "does something else
 * already own this tool's terminal state" (#3390) -- callers must not restate the productive-tool
 * list.
 */
export function isOpenCodeFacadeDispatchedTool(tool: string): boolean {
  return APPROVED_PRODUCTIVE_TOOLS.has(tool);
}

const APPROVED_MODEL_VISIBLE_RUNTIME_TOOLS = new Set<string>([
  "question",
  // #2480: plan carrier only — its admitted parts feed the governed plan projection and it
  // never reaches the productive tool facade.
  "todowrite",
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

function parseOpenCodeSseWithLimit(
  input: string,
  maxFrameBytes: number,
): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> {
  const messages: OpenCodeSseMessage[] = [];
  for (const frame of input.replaceAll("\r\n", "\n").split("\n\n")) {
    if (frame.length === 0 || frame.startsWith(":")) continue;
    const parsed = parseSseFrame(frame, maxFrameBytes);
    if (!parsed.ok) return parsed;
    messages.push(parsed.value);
  }
  return { ok: true, value: messages };
}

function parseSseFrame(
  frame: string,
  maxFrameBytes: number,
): OpenCodeProtocolResult<OpenCodeSseMessage> {
  if (bytes(frame) > maxFrameBytes) return { ok: false, reason: "frame-oversized" };
  const fields = parseSseFields(frame);
  if (
    fields === undefined ||
    (fields.event !== undefined && fields.event !== "message") ||
    fields.data === undefined
  )
    return { ok: false, reason: "frame-invalid" };
  const data = normalizedGlobalEvent(parseRecord(fields.dataLines.join("\n")));
  if (data === undefined) return { ok: false, reason: "frame-invalid" };
  const failure = frameDataFailure(data);
  if (failure !== undefined) return { ok: false, reason: failure };
  return { ok: true, value: { event: "message", data } };
}

function parseSseFields(frame: string):
  | {
      readonly event: string | undefined;
      readonly data: string | undefined;
      readonly dataLines: readonly string[];
    }
  | undefined {
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
      return undefined;
    if (key === "data") dataLines.push(fieldValue);
    fields[key] = fieldValue;
  }
  return { event: fields.event, data: fields.data, dataLines };
}

function frameDataFailure(data: NormalizedSseData): OpenCodeProtocolFailure | undefined {
  if (
    (data.type === "session.status" || data.type === "session.idle") &&
    classifyOpenCodeLiveControl(data) === undefined
  )
    return "frame-invalid";
  if (
    data.type === "session.next.tool.called" &&
    (!nonEmpty(data.properties.tool) ||
      !APPROVED_MODEL_VISIBLE_RUNTIME_TOOLS.has(data.properties.tool))
  )
    return "event-unknown";
  return undefined;
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

const GOVERNED_EDIT_METADATA_KEYS = [
  "kind",
  "actionClass",
  "reasonCode",
  "expiresAt",
  "actionKind",
  "scopeLabel",
  "risk",
  "policyReason",
  "targetPath",
  "allowedRelativePaths",
  "fileCount",
  "addedLines",
  "deletedLines",
] as const;
const GOVERNED_VERIFICATION_METADATA_KEYS = [
  "kind",
  "actionClass",
  "reasonCode",
  "expiresAt",
  "actionKind",
  "scopeLabel",
  "risk",
  "policyReason",
  "commandLabel",
  "actionId",
  "idempotencyKey",
  "approvalId",
  "approvalDigest",
] as const;
const GOVERNED_TARGETED_VERIFICATION_METADATA_KEYS = [
  ...GOVERNED_VERIFICATION_METADATA_KEYS,
  "targetPathHash",
] as const;
const GOVERNED_VERIFIERS = new Set(["test", "targeted-test", "typecheck", "lint", "build"]);
// Colons are rejected wholesale: `C:/…` is drive-absolute under win32 resolution and
// `file.txt:stream` names an NTFS alternate data stream — neither is a workspace-relative path.
const GOVERNED_PATH = /^(?![\\/])(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)(?!.*:).+$/u;

/**
 * Converts only Keiko's exact custom-tool permission into the existing sidecar permission
 * contract. OpenCode routing/tool fields and arbitrary metadata are discarded at this boundary.
 */
export function projectOpenCodePermissionEvent(
  value: unknown,
  fixedSessionId: string,
): SidecarPermissionEvent | undefined {
  const properties = governedPermissionProperties(value, fixedSessionId);
  if (properties === undefined || !isRecord(properties.metadata)) return undefined;
  const projected = projectGovernedPermissionByKind(properties, properties.metadata);
  if (projected === undefined) return undefined;
  const parsed = parseCodingSidecarEventLine(JSON.stringify(projected));
  return parsed.status === "parsed" && parsed.event.type === "permission-request"
    ? parsed.event
    : undefined;
}

/**
 * Projects an upstream permission id into the content-free evidence vocabulary used by Keiko's
 * public runtime contract. The full SHA-256 value is rendered as decimal so no upstream identifier
 * bytes or unapproved evidence tokens cross the boundary. Callers reverse the alias only by
 * matching it against the bounded live permission list; collisions therefore fail closed.
 */
export function projectOpenCodePermissionRequestId(requestId: string): string | undefined {
  if (!PERMISSION_ID.test(requestId)) return undefined;
  const digest = createHash("sha256").update(requestId, "utf8").digest("hex");
  return `permission-${BigInt("0x" + digest).toString(10)}`;
}

/** A SHA-256 rendered as decimal never exceeds 78 digits. */
const PROJECTED_PERMISSION_REQUEST_ID = /^permission-\d{1,78}$/u;

/**
 * True only for ids `projectOpenCodePermissionRequestId` can have produced. Server-originated
 * asks (e.g. `research-approval-<n>`) never match: they have no child-side permission to settle.
 */
export function isProjectedOpenCodePermissionRequestId(requestId: string): boolean {
  return PROJECTED_PERMISSION_REQUEST_ID.test(requestId);
}

function governedPermissionProperties(
  value: unknown,
  fixedSessionId: string,
): Record<string, unknown> | undefined {
  if (!exactRecord(value, ["id", "type", "properties"])) return undefined;
  if (value.type !== "permission.asked" || !isRecord(value.properties)) return undefined;
  const properties = value.properties;
  return permissionAsked(properties) &&
    properties.sessionID === fixedSessionId &&
    properties.permission === OPENCODE_GOVERNED_ACTION_PERMISSION
    ? properties
    : undefined;
}

function projectGovernedPermissionByKind(
  properties: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (metadata.actionKind === "file-edit") {
    return projectGovernedEditPermission(properties, metadata);
  }
  if (
    metadata.actionKind === "verification-command" ||
    metadata.actionKind === "ci-observe" ||
    metadata.actionKind === "connector-read"
  ) {
    return projectGovernedCommandPermission(properties, metadata);
  }
  return undefined;
}

function projectGovernedEditPermission(
  properties: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    !exactRecord(metadata, GOVERNED_EDIT_METADATA_KEYS) ||
    !fixedPermissionMetadata(metadata, "workspace-write", "workspace-write", "file-edit", "medium")
  ) {
    return undefined;
  }
  const paths = governedPaths(metadata.allowedRelativePaths);
  if (
    paths === undefined ||
    !sameStrings(properties.patterns, paths) ||
    metadata.targetPath !== paths[0] ||
    metadata.fileCount !== paths.length ||
    !boundedCount(metadata.addedLines) ||
    !boundedCount(metadata.deletedLines)
  ) {
    return undefined;
  }
  const requestId = projectOpenCodePermissionRequestId(String(properties.id));
  if (requestId === undefined) return undefined;
  return {
    type: "permission-request",
    requestId,
    ...metadata,
    allowedRelativePaths: paths,
  };
}

function projectGovernedCommandPermission(
  properties: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const actionKind = metadata.actionKind;
  const metadataKeys =
    actionKind === "verification-command" && metadata.commandLabel === "targeted-test"
      ? GOVERNED_TARGETED_VERIFICATION_METADATA_KEYS
      : GOVERNED_VERIFICATION_METADATA_KEYS;
  if (
    !exactRecord(metadata, metadataKeys) ||
    typeof actionKind !== "string" ||
    !fixedPermissionMetadata(
      metadata,
      "command-execution",
      "command-execution",
      actionKind,
      "low",
    ) ||
    !validCommandApproval(properties, metadata)
  ) {
    return undefined;
  }
  const requestId = projectOpenCodePermissionRequestId(String(properties.id));
  return requestId === undefined
    ? undefined
    : { type: "permission-request", requestId, ...metadata };
}

function validCommandApproval(
  properties: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  const commandLabel = metadata.commandLabel;
  const approvalDigest = metadata.approvalDigest;
  const targetPathHash = metadata.targetPathHash;
  return (
    typeof commandLabel === "string" &&
    validGovernedCommandTarget(metadata.actionKind, commandLabel) &&
    validApprovalIdentities(metadata) &&
    typeof approvalDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(approvalDigest) &&
    (commandLabel === "targeted-test"
      ? typeof targetPathHash === "string" && /^[0-9a-f]{64}$/u.test(targetPathHash)
      : targetPathHash === undefined) &&
    sameStrings(properties.patterns, [commandLabel])
  );
}

function validGovernedCommandTarget(actionKind: unknown, commandLabel: string): boolean {
  if (actionKind === "verification-command") return GOVERNED_VERIFIERS.has(commandLabel);
  if (actionKind === "ci-observe") return commandLabel === "ci";
  return actionKind === "connector-read" && boundedApprovalIdentity(commandLabel);
}

function validApprovalIdentities(metadata: Record<string, unknown>): boolean {
  const actionId = metadata.actionId;
  const idempotencyKey = metadata.idempotencyKey;
  const approvalId = metadata.approvalId;
  return (
    boundedApprovalIdentity(actionId) &&
    boundedApprovalIdentity(idempotencyKey) &&
    boundedApprovalIdentity(approvalId) &&
    approvalId === actionId
  );
}

function boundedApprovalIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function fixedPermissionMetadata(
  metadata: Record<string, unknown>,
  kind: string,
  actionClass: string,
  actionKind: string,
  risk: string,
): boolean {
  return (
    metadata.kind === kind &&
    metadata.actionClass === actionClass &&
    metadata.reasonCode === "approval-required" &&
    metadata.actionKind === actionKind &&
    metadata.scopeLabel === "workspace-scope" &&
    metadata.risk === risk &&
    metadata.policyReason === "approval-required" &&
    typeof metadata.expiresAt === "string" &&
    metadata.expiresAt.length <= 64 &&
    Number.isFinite(Date.parse(metadata.expiresAt))
  );
}

function governedPaths(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths: readonly unknown[] = value;
  // One owner for the reviewable bound: the admission boundary and the operator review contract
  // share the same cap so a card can never be asked to render a wider list than admission accepts.
  if (
    paths.length < 1 ||
    paths.length > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS ||
    !paths.every(
      (path) =>
        typeof path === "string" &&
        path.length <= CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS &&
        GOVERNED_PATH.test(path),
    ) ||
    new Set(paths).size !== paths.length
  ) {
    return undefined;
  }
  return paths.filter((path): path is string => typeof path === "string");
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function boundedCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
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
    !Object.hasOwn(envelope, "payload") ||
    (Object.keys(envelope).length > 1 && !Object.hasOwn(envelope, "directory")) ||
    ![envelope.directory, envelope.project, envelope.workspace].every(
      (value) => value === undefined || nonEmpty(value),
    )
  )
    return undefined;
  const payload = envelope.payload;
  if (isRecord(payload) && payload.type === "sync") return normalizedSyncPayload(payload);
  const legacyPermission = normalizedLegacyPermissionPayload(payload);
  if (legacyPermission !== undefined) return legacyPermission;
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

/**
 * OpenCode 1.17.17's custom-tool `context.ask` emits the reviewed legacy permission event without
 * the newer outer event id. The permission request itself still carries the stable `per…` id.
 * Admit only that exact legacy shape and derive a content-free transport identity from it; every
 * other id-less live event remains rejected.
 */
function normalizedLegacyPermissionPayload(payload: unknown): NormalizedSseData | undefined {
  if (
    !exactRecord(payload, ["type", "properties"]) ||
    payload.type !== "permission.asked" ||
    !isRecord(payload.properties) ||
    !permissionAsked(payload.properties)
  ) {
    return undefined;
  }
  return {
    id: `evt_${String(payload.properties.id)}`,
    type: payload.type,
    properties: payload.properties,
  };
}

// eslint-disable-next-line complexity -- every reviewed sync bridge identity and schema gate is explicit.
function normalizedSyncPayload(payload: Record<string, unknown>): NormalizedSseData | undefined {
  if (
    !exactRecord(payload, ["type", "id", "syncEvent"]) ||
    payload.type !== "sync" ||
    typeof payload.id !== "string" ||
    !/^evt_[A-Za-z0-9_-]+$/u.test(payload.id) ||
    !exactRecord(payload.syncEvent, ["type", "id", "seq", "aggregateID", "data"]) ||
    payload.syncEvent.id !== payload.id ||
    !nonNegativeSafeInteger(payload.syncEvent.seq) ||
    !id(payload.syncEvent.aggregateID, "ses_") ||
    !isRecord(payload.syncEvent.data)
  )
    return undefined;
  // The fixed-session echo keeps its deep shape gate. Every other durable sync envelope is a
  // content-free pull trigger only: its data is never read here — row admission stays with the
  // pinned history parser behind POST /sync/history.
  if (payload.syncEvent.type === "session.created.1") {
    if (
      payload.syncEvent.seq !== 0 ||
      !sessionCreated(payload.syncEvent.data, payload.syncEvent.aggregateID)
    )
      return undefined;
    return { id: payload.id, type: "sync", properties: {} };
  }
  if (!nonEmpty(payload.syncEvent.type)) return undefined;
  return { id: payload.id, type: "sync", properties: {} };
}

/** Incremental bounded decoder for transport chunks that split an SSE frame. */
export function createOpenCodeSseDecoder(maxBufferedBytes = MAX_FRAME_BYTES): OpenCodeSseDecoder {
  let pending = "";
  const decode = (complete: boolean): OpenCodeProtocolResult<readonly OpenCodeSseMessage[]> => {
    const normalized = pending.replaceAll("\r\n", "\n");
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
      ...compactionProjection(type, data),
    });
  }
  return { ok: true, value: result };
}

function compactionProjection(
  type: string,
  data: Record<string, unknown>,
): { readonly compaction: OpenCodeCompactionActivity } | Record<string, never> {
  if (type === "message.part.updated.1") return compactionPartProjection(data.part);
  return type === "message.updated.1" ? compactionSummaryProjection(data.info) : {};
}

function compactionPartProjection(
  value: unknown,
): { readonly compaction: OpenCodeCompactionActivity } | Record<string, never> {
  if (!isRecord(value) || value.type !== "compaction" || typeof value.messageID !== "string") {
    return {};
  }
  const common = {
    compactionIdSha256: structuralDigest(value.messageID),
    auto: value.auto === true,
    overflow: value.overflow === true,
  };
  return typeof value.tail_start_id === "string"
    ? {
        compaction: {
          event: "tail-retained",
          ...common,
          retainedTail: true,
          tailStartIdSha256: structuralDigest(value.tail_start_id),
        },
      }
    : { compaction: { event: "started", ...common, retainedTail: false } };
}

function compactionSummaryProjection(
  value: unknown,
): { readonly compaction: OpenCodeCompactionActivity } | Record<string, never> {
  if (!isRecord(value) || !settledCompactionSummary(value)) return {};
  const info = value;
  const compactionIdSha256 = structuralDigest(String(info.parentID));
  if (info.error === undefined && info.finish === "stop") {
    return { compaction: { event: "completed", compactionIdSha256 } };
  }
  const statedFinishReason = String(info.finish);
  const failedFinishReason = FAILED_TERMINAL_FINISH_REASONS.has(statedFinishReason);
  if (info.error === undefined && !failedFinishReason) return {};
  const errorKind =
    isRecord(info.error) && typeof info.error.name === "string"
      ? info.error.name
      : "OpenCodeCompactionFailure";
  return {
    compaction: {
      event: "failed",
      compactionIdSha256,
      errorKind,
      finishReason: failedFinishReason ? statedFinishReason : "error",
    },
  };
}

function settledCompactionSummary(info: Record<string, unknown>): boolean {
  if (
    info.role !== "assistant" ||
    info.summary !== true ||
    info.mode !== "compaction" ||
    info.agent !== "compaction" ||
    typeof info.parentID !== "string" ||
    !isRecord(info.time) ||
    !nonNegativeNumber(info.time.completed)
  )
    return false;
  return true;
}

function structuralDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The closed allowlist is a security control, not a dispatch extension point. */
function classifiedEvent(
  type: string,
  data: Record<string, unknown>,
  sequence: number,
  aggregateId: string,
): OpenCodeReconciliationEvent["kind"] | undefined {
  return (
    classifiedSessionEvent(type, data, sequence, aggregateId) ??
    classifiedMessageEvent(type, data, aggregateId) ??
    classifiedInteractionEvent(type, data) ??
    classifiedToolEvent(type, data)
  );
}

function classifiedSessionEvent(
  type: string,
  data: Record<string, unknown>,
  sequence: number,
  aggregateId: string,
): OpenCodeReconciliationEvent["kind"] | undefined {
  if (type === "session.created.1" && sequence === 0 && sessionCreated(data, aggregateId))
    return "observation";
  if (type === "session.updated.1" && sessionUpdated(data, aggregateId)) return "observation";
  if (type === "session.idle" && sessionIdleEvent(data)) return "terminal-control";
  if (type === "session.status" && sessionStatusEvent(data)) return "observation";
  return undefined;
}

function sessionIdleEvent(data: Record<string, unknown>): boolean {
  return exactRecord(data, ["sessionID"]) && id(data.sessionID, "ses_");
}

function sessionStatusEvent(data: Record<string, unknown>): boolean {
  return (
    exactRecord(data, ["sessionID", "status"]) &&
    id(data.sessionID, "ses_") &&
    nonEmpty(data.status)
  );
}

function classifiedMessageEvent(
  type: string,
  data: Record<string, unknown>,
  aggregateId: string,
): OpenCodeReconciliationEvent["kind"] | undefined {
  if (type === "message.updated.1") return messageUpdated(data, aggregateId);
  if (type === "message.part.updated.1" && messagePartUpdated(data, aggregateId))
    return "observation";
  return undefined;
}

function classifiedInteractionEvent(
  type: string,
  data: Record<string, unknown>,
): "permission" | "question" | undefined {
  if (type === "permission.asked" && permissionAsked(data)) return "permission";
  if (type === "permission.replied" && permissionReplied(data)) return "permission";
  if (type === "question.asked" && questionAsked(data)) return "question";
  if ((type === "question.replied" || type === "question.rejected") && questionSettled(type, data))
    return "question";
  return undefined;
}

function permissionReplied(data: Record<string, unknown>): boolean {
  return (
    exactRecord(data, ["sessionID", "requestID", "reply"]) &&
    id(data.sessionID, "ses_") &&
    id(data.requestID, "per") &&
    ["once", "always", "reject"].includes(String(data.reply))
  );
}

function questionSettled(
  type: "question.replied" | "question.rejected",
  data: Record<string, unknown>,
): boolean {
  return (
    exactRecord(
      data,
      type === "question.replied"
        ? ["sessionID", "requestID", "answers"]
        : ["sessionID", "requestID"],
    ) &&
    id(data.sessionID, "ses_") &&
    id(data.requestID, "que")
  );
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
    [info.slug, info.projectID, info.directory, info.title, info.version].every(nonEmpty) &&
    // The pinned 1.17.17 child reports `path: ""` when the session's working directory is the
    // project root — every git-worktree task workspace. Present-but-empty is the real contract;
    // absence stays rejected (#2475).
    boundedString(info.path) &&
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
  if (isRecord(data.info.error) && data.info.error.name === "MessageAbortedError")
    return "terminal";
  if (data.info.error !== undefined) return "terminal-failure";
  const completed = isRecord(data.info.time) && nonNegativeNumber(data.info.time.completed);
  if (!completed) return "observation";
  if (data.info.finish === "stop") return "terminal";
  return FAILED_TERMINAL_FINISH_REASONS.has(String(data.info.finish))
    ? "terminal-failure"
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
    !allowedRecord(info, ASSISTANT_MESSAGE_FIELDS) ||
    !ASSISTANT_MESSAGE_REQUIRED_FIELDS.every((key) => Object.hasOwn(info, key))
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
    (info.summary === undefined || typeof info.summary === "boolean") &&
    (info.error === undefined || assistantError(info.error)) &&
    (info.structured === undefined || boundedLifecycle(info.structured)) &&
    (info.variant === undefined || boundedString(info.variant)) &&
    boundedLifecycle(info)
  );
}

function assistantError(value: unknown): boolean {
  if (!exactRecord(value, ["name", "data"]) || !nonEmpty(value.name) || !isRecord(value.data))
    return false;
  const validator = assistantErrorDataValidator(value.name);
  return validator?.(value.data) ?? false;
}

type AssistantErrorDataValidator = (data: Record<string, unknown>) => boolean;

function assistantErrorDataValidator(name: string): AssistantErrorDataValidator | undefined {
  if (MESSAGE_ONLY_ASSISTANT_ERRORS.has(name)) return messageOnlyErrorData;
  return ASSISTANT_ERROR_DATA_VALIDATORS.get(name);
}

function messageOnlyErrorData(data: Record<string, unknown>): boolean {
  return exactRecord(data, ["message"]) && boundedString(data.message);
}

function providerAuthErrorData(data: Record<string, unknown>): boolean {
  return (
    exactRecord(data, ["providerID", "message"]) &&
    boundedString(data.providerID) &&
    boundedString(data.message)
  );
}

function unknownErrorData(data: Record<string, unknown>): boolean {
  return (
    allowedRecord(data, ["message", "ref"]) &&
    Object.hasOwn(data, "message") &&
    boundedString(data.message) &&
    (data.ref === undefined || boundedString(data.ref))
  );
}

function structuredOutputErrorData(data: Record<string, unknown>): boolean {
  return (
    exactRecord(data, ["message", "retries"]) &&
    boundedString(data.message) &&
    nonNegativeSafeInteger(data.retries)
  );
}

function contextOverflowErrorData(data: Record<string, unknown>): boolean {
  return (
    allowedRecord(data, ["message", "responseBody"]) &&
    Object.hasOwn(data, "message") &&
    boundedString(data.message) &&
    (data.responseBody === undefined || boundedString(data.responseBody))
  );
}

function apiErrorData(data: Record<string, unknown>): boolean {
  if (!apiErrorShape(data)) return false;
  if (!boundedString(data.message) || typeof data.isRetryable !== "boolean") return false;
  if (!optionalValue(data.statusCode, nonNegativeSafeInteger)) return false;
  if (!optionalValue(data.responseHeaders, stringRecord)) return false;
  if (!optionalValue(data.responseBody, boundedString)) return false;
  return optionalValue(data.metadata, stringRecord);
}

function stringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(boundedString);
}

function optionalValue(value: unknown, validate: (candidate: unknown) => boolean): boolean {
  return value === undefined || validate(value);
}

function apiErrorShape(data: Record<string, unknown>): boolean {
  return (
    allowedRecord(data, [
      "message",
      "statusCode",
      "isRetryable",
      "responseHeaders",
      "responseBody",
      "metadata",
    ]) &&
    Object.hasOwn(data, "message") &&
    Object.hasOwn(data, "isRetryable")
  );
}

const ASSISTANT_ERROR_DATA_VALIDATORS: ReadonlyMap<string, AssistantErrorDataValidator> = new Map([
  ["ProviderAuthError", providerAuthErrorData],
  ["UnknownError", unknownErrorData],
  ["MessageOutputLengthError", (data): boolean => exactRecord(data, [])],
  ["StructuredOutputError", structuredOutputErrorData],
  ["ContextOverflowError", contextOverflowErrorData],
  ["APIError", apiErrorData],
]);

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
    !boundedPartLifecycle(data.part)
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
  if (part.type === "compaction") {
    return (
      allowedRecord(part, [
        "id",
        "sessionID",
        "messageID",
        "type",
        "auto",
        "overflow",
        "tail_start_id",
      ]) &&
      typeof part.auto === "boolean" &&
      typeof part.overflow === "boolean" &&
      (part.tail_start_id === undefined ||
        (typeof part.tail_start_id === "string" && MESSAGE_ID.test(part.tail_start_id)))
    );
  }
  return part.type === "tool" && toolPart(part);
}

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
  return toolState(part.state);
}

// eslint-disable-next-line complexity -- each pinned tool-state shape fails closed independently.
function toolState(state: Record<string, unknown>): boolean {
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
  if (state.status === "error") {
    return (
      allowedRecord(state, ["status", "input", "error", "metadata", "time"]) &&
      isRecord(state.input) &&
      nonEmpty(state.error) &&
      (state.metadata === undefined || isRecord(state.metadata)) &&
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

/**
 * A message text part or completed governed-tool output may legitimately carry file/model content
 * beyond the uniform 4096-character metadata bound. That body stays capped by the 64 KiB part byte
 * budget (the DoS guard), every other field keeps the tight per-string bound, and the reconciliation
 * projection never carries the admitted body. Non-body fields and all other variants stay bounded
 * exactly as before.
 *
 * A part this size only ever arrives through the `POST /sync/history` HTTP body (which shares this
 * 64 KiB row budget), never as a single live SSE frame: the live path yields content-free pull
 * triggers only, so the independent `MAX_FRAME_BYTES` SSE limit is not a cross-budget constraint.
 */
function boundedPartLifecycle(part: Record<string, unknown>): boolean {
  if (part.type === "text") return boundedPartBody(part, "text", "", part.text);
  const state = isRecord(part.state) ? part.state : undefined;
  if (part.type !== "tool" || state?.status !== "completed") return boundedLifecycle(part);
  return boundedPartBody(part, "state", { ...state, output: "" }, state.output);
}

function boundedPartBody(
  part: Record<string, unknown>,
  key: "text" | "state",
  boundedValue: unknown,
  body: unknown = boundedValue,
): boolean {
  return (
    typeof body === "string" &&
    boundedLifecycle({ ...part, [key]: boundedValue }) &&
    bytes(JSON.stringify(part)) <= MAX_HISTORY_INFO_BYTES
  );
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function tokenCounts(value: unknown): boolean {
  if (
    !exactRecord(value, ["cache", "input", "output", "reasoning", "total"]) &&
    !exactRecord(value, ["cache", "input", "output", "reasoning"])
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

/** Only reviewed identity fields survive content-free projection. */
function contentFreeHistoryData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = projectedStringFields(data, [
    "sessionID",
    "id",
    "requestID",
    "assistantMessageID",
    "callID",
    "reply",
  ]);
  if (isRecord(data.info)) {
    result.info = projectedStringFields(data.info, ["id", "sessionID", "role", "finish"]);
  }
  if (isRecord(data.part)) result.part = contentFreePart(data.part);
  return result;
}

function projectedStringFields(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") projected[key] = value;
  }
  return projected;
}

function contentFreePart(part: Record<string, unknown>): Record<string, string> {
  const projected = projectedStringFields(part, [
    "id",
    "sessionID",
    "messageID",
    "type",
    "reason",
    "tool",
  ]);
  if (isRecord(part.state) && typeof part.state.status === "string") {
    projected.status = part.state.status;
  }
  return projected;
}

function permissionAsked(data: Record<string, unknown>): boolean {
  return (
    (exactRecord(data, ["id", "sessionID", "permission", "patterns", "metadata", "always"]) ||
      exactRecord(data, [
        "id",
        "sessionID",
        "permission",
        "patterns",
        "metadata",
        "always",
        "tool",
      ])) &&
    id(data.id, "per") &&
    id(data.sessionID, "ses_") &&
    nonEmpty(data.permission) &&
    stringArray(data.patterns) &&
    isRecord(data.metadata) &&
    stringArray(data.always) &&
    (data.tool === undefined || validPermissionTool(data.tool))
  );
}

function validPermissionTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["messageID", "callID"]) &&
    typeof value.messageID === "string" &&
    MESSAGE_ID.test(value.messageID) &&
    nonEmpty(value.callID)
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
/** The pinned event variants and productive-tool gate stay explicit. */
function toolEvent(type: string, data: Record<string, unknown>): boolean {
  const allowed = toolEventAllowedKeys(type);
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

function toolEventAllowedKeys(type: string): readonly string[] | undefined {
  if (type === "session.next.tool.called") {
    return ["timestamp", "sessionID", "assistantMessageID", "callID", "tool", "input", "provider"];
  }
  if (type === "session.next.tool.success") {
    return [
      "timestamp",
      "sessionID",
      "assistantMessageID",
      "callID",
      "structured",
      "content",
      "provider",
      "outputPaths",
      "result",
    ];
  }
  if (type === "session.next.tool.failed") {
    return [
      "timestamp",
      "sessionID",
      "assistantMessageID",
      "callID",
      "error",
      "provider",
      "result",
    ];
  }
  return undefined;
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
    keys.every((key) => Object.hasOwn(value, key))
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
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
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
function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096;
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
