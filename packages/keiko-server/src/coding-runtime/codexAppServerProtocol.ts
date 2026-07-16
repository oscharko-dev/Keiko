import { parseOpenCodeJson } from "./opencodeProtocol.js";

/** Exact reviewed app-server schema bundle. Any drift requires a new adapter review. */
export const CODEX_APP_SERVER_SCHEMA = Object.freeze({
  version: "0.144.1",
  digest: "05463d8615d2a277cf3be6ee15a84398c5e2ce2307b93415602499dc3e07880a",
  algorithm: "keiko-codex-schema-bundle-v1",
} as const);

export const CODEX_APP_SERVER_CLIENT_METHODS = Object.freeze([
  "initialize",
  "initialized",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "thread/start",
  "turn/start",
  "turn/interrupt",
] as const);

export type CodexAppServerMethod = (typeof CODEX_APP_SERVER_CLIENT_METHODS)[number];
export type CodexAppServerFailure =
  "frame-invalid" | "frame-oversized" | "method-denied" | "message-denied";
export type CodexAppServerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CodexAppServerFailure };
export type CodexAppServerId = string | number;
export type CodexAppServerMessage = Readonly<Record<string, unknown>>;
export interface CodexAppServerJsonlDecoder {
  push(chunk: string): CodexAppServerResult<readonly CodexAppServerMessage[]>;
  finish(): CodexAppServerResult<readonly CodexAppServerMessage[]>;
}
export type CodexAppServerProjection =
  | {
      readonly kind: "delta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "lifecycle";
      readonly event: string;
      readonly threadId: string;
      readonly turnId?: string;
      readonly itemId?: string;
      readonly terminalStatus?: "completed" | "failed" | "interrupted";
    }
  | {
      readonly kind: "auth-lifecycle";
      readonly event: "account/login/completed" | "account/updated";
      readonly authenticated: boolean;
    }
  | {
      readonly kind: "tool-call";
      readonly id: CodexAppServerId;
      readonly threadId: string;
      readonly turnId: string;
      readonly callId: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };
export type CodexAppServerToolCallOutcome =
  | {
      readonly success: true;
      readonly contentItems: readonly { readonly type: "inputText"; readonly text: string }[];
    }
  | { readonly success: false };

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_JSONL_CHUNK_BYTES = 1024 * 1024;
const MAX_JSONL_PENDING_BYTES = 1024 * 1024;
const MAX_JSONL_BATCH_MESSAGES = 256;
const MAX_JSON_DEPTH = 64;
const MAX_TEXT_BYTES = 64 * 1024;
const CLIENT_METHODS = new Set<string>(CODEX_APP_SERVER_CLIENT_METHODS);
const FORBIDDEN_KEYS =
  /(?:api[_-]?key|auth[_-]?tokens?|refresh[_-]?tokens?|access[_-]?tokens?|token|password|secret|credential)/iu;
const BUILT_IN_TOOL =
  /^(?:exec|shell|bash|apply[_-]?patch|file|fs|config|plugin|mcp|approval)(?:$|[/:._-])/iu;
const PLAN_TYPES = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

// eslint-disable-next-line complexity -- every reviewed request variant is intentionally closed independently.
export function validateCodexAppServerClientRequest(
  method: string,
  params: unknown,
): CodexAppServerResult<undefined> {
  if (!CLIENT_METHODS.has(method) || hasForbiddenData(params)) return denied("method-denied");
  let valid = false;
  switch (method) {
    case "initialize":
      valid =
        exactRecord(params, ["clientInfo", "capabilities"]) &&
        exactRecord(params.clientInfo, ["name", "version"]) &&
        params.clientInfo.name === "keiko" &&
        nonEmpty(params.clientInfo.version) &&
        validInitializeCapabilities(params.capabilities);
      break;
    case "initialized":
      valid = params === undefined;
      break;
    case "account/read":
      valid = exactRecord(params, []);
      break;
    case "account/login/cancel":
      valid = exactStringRecord(params, ["loginId"]);
      break;
    case "account/logout":
      valid = params === null || params === undefined;
      break;
    case "account/login/start":
      valid =
        exactRecord(params, ["type"]) &&
        (params.type === "chatgpt" || params.type === "chatgptDeviceCode");
      break;
    case "thread/start":
      valid = exactRecord(params, []);
      break;
    case "turn/start":
      valid =
        exactRecord(params, ["threadId", "input"]) &&
        nonEmpty(params.threadId) &&
        validTurnInput(params.input);
      break;
    case "turn/interrupt":
      valid =
        exactRecord(params, ["threadId", "turnId"]) &&
        nonEmpty(params.threadId) &&
        nonEmpty(params.turnId);
      break;
  }
  return valid ? { ok: true, value: undefined } : denied("method-denied");
}

// eslint-disable-next-line complexity, max-lines-per-function -- every response variant has an independent exact projection.
export function projectCodexAppServerResponse(
  method: string,
  result: unknown,
): CodexAppServerResult<unknown> {
  switch (method) {
    case "initialize":
      if (exactStringRecord(result, ["codexHome", "platformFamily", "platformOs", "userAgent"]))
        return {
          ok: true,
          value: {
            codexHome: result.codexHome,
            platformFamily: result.platformFamily,
            platformOs: result.platformOs,
            userAgent: result.userAgent,
          },
        };
      break;
    case "account/read":
      if (validAccountResponse(result))
        return {
          ok: true,
          value: {
            authenticated: isRecord(result.account),
            authMode: isRecord(result.account) ? "chatgpt" : null,
            requiresOpenaiAuth: result.requiresOpenaiAuth,
          },
        };
      break;
    case "account/login/start":
      if (validBrowserLoginResponse(result)) return { ok: true, value: result };
      if (validDeviceLoginResponse(result)) return { ok: true, value: result };
      break;
    case "account/login/cancel":
      if (
        exactRecord(result, ["status"]) &&
        (result.status === "canceled" || result.status === "notFound")
      )
        return { ok: true, value: { status: result.status } };
      break;
    case "account/logout":
    case "turn/interrupt":
      if (exactRecord(result, [])) return { ok: true, value: { completed: true } };
      break;
    case "thread/start":
      if (validThreadStartResponse(result))
        return { ok: true, value: { threadId: result.thread.id } };
      break;
    case "turn/start":
      if (exactRecord(result, ["turn"]) && validTurn(result.turn))
        return { ok: true, value: { turnId: result.turn.id } };
      break;
  }
  return denied("message-denied");
}

export function projectCodexAppServerToolCallOutcome(
  outcome: CodexAppServerToolCallOutcome,
): CodexAppServerResult<{ readonly success: boolean; readonly contentItems: readonly unknown[] }> {
  if (!outcome.success) return { ok: true, value: { success: false, contentItems: [] } };
  if (
    outcome.contentItems.length > 64 ||
    !outcome.contentItems.every((item: unknown) => validToolContentItem(item))
  )
    return denied("message-denied");
  return { ok: true, value: { success: true, contentItems: outcome.contentItems } };
}

/** Incremental strict JSONL decoder. A failure poisons this decoder instance. */
export function createCodexAppServerJsonlDecoder(): CodexAppServerJsonlDecoder {
  let pending = "";
  let failed: CodexAppServerFailure | undefined;
  const drain = (complete: boolean): CodexAppServerResult<readonly CodexAppServerMessage[]> => {
    if (failed !== undefined) return { ok: false, reason: failed };
    const messages: CodexAppServerMessage[] = [];
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) break;
      if (messages.length >= MAX_JSONL_BATCH_MESSAGES) {
        failed = "frame-invalid";
        return { ok: false, reason: failed };
      }
      const frame = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const parsed = parseFrame(frame);
      if (!parsed.ok) {
        failed = parsed.reason;
        return parsed;
      }
      messages.push(parsed.value);
    }
    if (bytes(pending) + 1 > MAX_FRAME_BYTES || (complete && pending.length > 0)) {
      failed = bytes(pending) + 1 > MAX_FRAME_BYTES ? "frame-oversized" : "frame-invalid";
      return { ok: false, reason: failed };
    }
    return { ok: true, value: messages };
  };
  return {
    push(chunk: string): CodexAppServerResult<readonly CodexAppServerMessage[]> {
      const chunkBytes = bytes(chunk);
      if (
        failed !== undefined ||
        chunkBytes > MAX_JSONL_CHUNK_BYTES ||
        bytes(pending) + chunkBytes > MAX_JSONL_PENDING_BYTES
      ) {
        failed ??= "frame-oversized";
        return { ok: false, reason: failed };
      }
      pending = (pending + chunk).replace(/\r\n/gu, "\n");
      return drain(false);
    },
    finish(): CodexAppServerResult<readonly CodexAppServerMessage[]> {
      return drain(true);
    },
  };
}

export function parseCodexAppServerJsonl(
  input: string,
): CodexAppServerResult<readonly CodexAppServerMessage[]> {
  const decoder = createCodexAppServerJsonlDecoder();
  const first = decoder.push(input);
  if (!first.ok) return first;
  const last = decoder.finish();
  return last.ok ? { ok: true, value: [...first.value, ...last.value] } : last;
}

// eslint-disable-next-line complexity, max-lines-per-function -- notification/request variants fail closed independently.
export function projectCodexAppServerMessage(
  message: CodexAppServerMessage,
): CodexAppServerResult<CodexAppServerProjection | undefined> {
  if (
    typeof message.method !== "string" ||
    !allowedRecord(message, ["id", "method", "params"]) ||
    Object.prototype.hasOwnProperty.call(message, "result") ||
    Object.prototype.hasOwnProperty.call(message, "error")
  )
    return denied("message-denied");
  const params = message.params;
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (message.method === "item/agentMessage/delta") {
    if (
      hasId ||
      !exactRecord(params, ["threadId", "turnId", "itemId", "delta"]) ||
      !nonEmpty(params.threadId) ||
      !nonEmpty(params.turnId) ||
      !nonEmpty(params.itemId) ||
      typeof params.delta !== "string" ||
      bytes(params.delta) > MAX_TEXT_BYTES
    )
      return denied("message-denied");
    return {
      ok: true,
      value: {
        kind: "delta",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        delta: params.delta,
      },
    };
  }
  if (message.method === "remoteControl/status/changed") {
    if (
      hasId ||
      !allowedRecord(params, ["installationId", "serverName", "status", "environmentId"]) ||
      !["installationId", "serverName", "status"].every((key) =>
        Object.prototype.hasOwnProperty.call(params, key),
      ) ||
      !nonEmpty(params.installationId) ||
      !nonEmpty(params.serverName) ||
      (params.environmentId !== undefined &&
        params.environmentId !== null &&
        !nonEmpty(params.environmentId)) ||
      (params.status !== "disabled" &&
        params.status !== "connecting" &&
        params.status !== "connected" &&
        params.status !== "errored")
    )
      return denied("message-denied");
    return { ok: true, value: undefined };
  }
  const lifecycle = projectLifecycle(message.method, params);
  if (lifecycle !== undefined)
    return hasId ? denied("message-denied") : { ok: true, value: lifecycle };
  if (message.method === "account/login/completed") {
    if (
      hasId ||
      !allowedRecord(params, ["loginId", "success", "error"]) ||
      !Object.prototype.hasOwnProperty.call(params, "success") ||
      (params.loginId !== undefined && params.loginId !== null && !nonEmpty(params.loginId)) ||
      (params.error !== undefined && params.error !== null && typeof params.error !== "string") ||
      typeof params.success !== "boolean"
    )
      return denied("message-denied");
    return {
      ok: true,
      value: { kind: "auth-lifecycle", event: message.method, authenticated: params.success },
    };
  }
  if (message.method === "account/updated") {
    if (
      hasId ||
      !allowedRecord(params, ["authMode", "planType"]) ||
      (params.authMode !== undefined &&
        params.authMode !== null &&
        params.authMode !== "chatgpt") ||
      (params.planType !== undefined &&
        params.planType !== null &&
        (typeof params.planType !== "string" || !PLAN_TYPES.has(params.planType)))
    )
      return denied("message-denied");
    return {
      ok: true,
      value: {
        kind: "auth-lifecycle",
        event: message.method,
        authenticated: params.authMode === "chatgpt",
      },
    };
  }
  if (message.method === "item/tool/call") {
    if (
      !validId(message.id) ||
      !allowedRecord(params, ["threadId", "turnId", "callId", "tool", "arguments", "namespace"]) ||
      !nonEmpty(params.threadId) ||
      !nonEmpty(params.turnId) ||
      !nonEmpty(params.callId) ||
      !nonEmpty(params.tool) ||
      BUILT_IN_TOOL.test(params.tool) ||
      (params.namespace !== undefined &&
        params.namespace !== null &&
        !nonEmpty(params.namespace)) ||
      !isRecord(params.arguments) ||
      !validJsonValue(params.arguments, 0) ||
      hasForbiddenData(params.arguments)
    )
      return denied("message-denied");
    return {
      ok: true,
      value: {
        kind: "tool-call",
        id: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: params.tool,
        arguments: params.arguments,
      },
    };
  }
  return denied("message-denied");
}

// eslint-disable-next-line complexity, max-lines-per-function -- each generated notification wire shape is closed independently.
function projectLifecycle(
  method: string,
  params: unknown,
): Extract<CodexAppServerProjection, { kind: "lifecycle" }> | undefined {
  if (method === "thread/started" && exactRecord(params, ["thread"]) && validThread(params.thread))
    return { kind: "lifecycle", event: method, threadId: params.thread.id };
  if (
    method === "turn/started" &&
    exactRecord(params, ["threadId", "turn"]) &&
    nonEmpty(params.threadId) &&
    validTurn(params.turn) &&
    params.turn.status === "inProgress"
  )
    return { kind: "lifecycle", event: method, threadId: params.threadId, turnId: params.turn.id };
  if (
    method === "turn/completed" &&
    exactRecord(params, ["threadId", "turn"]) &&
    nonEmpty(params.threadId) &&
    validTurn(params.turn) &&
    (params.turn.status === "completed" ||
      params.turn.status === "failed" ||
      params.turn.status === "interrupted")
  )
    return {
      kind: "lifecycle",
      event: method,
      threadId: params.threadId,
      turnId: params.turn.id,
      terminalStatus: params.turn.status,
    };
  if (
    ["item/started", "item/completed"].includes(method) &&
    allowedRecord(params, ["threadId", "turnId", "item", "startedAtMs", "completedAtMs"]) &&
    nonEmpty(params.threadId) &&
    nonEmpty(params.turnId) &&
    isRecord(params.item) &&
    nonEmpty(params.item.id) &&
    validJsonValue(params.item, 0) &&
    ((method === "item/started" &&
      nonNegativeInteger(params.startedAtMs) &&
      params.completedAtMs === undefined) ||
      (method === "item/completed" &&
        nonNegativeInteger(params.completedAtMs) &&
        params.startedAtMs === undefined))
  )
    return {
      kind: "lifecycle",
      event: method,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.item.id,
    };
  return undefined;
}

function parseFrame(frame: string): CodexAppServerResult<CodexAppServerMessage> {
  if (bytes(frame) + 1 > MAX_FRAME_BYTES) return denied("frame-oversized");
  const parsed = parseOpenCodeJson(frame);
  return parsed.ok && isRecord(parsed.value)
    ? { ok: true, value: parsed.value }
    : denied("frame-invalid");
}
function validInitializeCapabilities(value: unknown): boolean {
  return (
    exactRecord(value, [
      "experimentalApi",
      "requestAttestation",
      "mcpServerOpenaiFormElicitation",
      "optOutNotificationMethods",
    ]) &&
    value.experimentalApi === false &&
    value.requestAttestation === false &&
    value.mcpServerOpenaiFormElicitation === false &&
    Array.isArray(value.optOutNotificationMethods) &&
    value.optOutNotificationMethods.length === 0
  );
}
function validBrowserLoginResponse(
  value: unknown,
): value is { readonly type: "chatgpt"; readonly authUrl: string; readonly loginId: string } {
  return exactStringRecord(value, ["type", "authUrl", "loginId"]) && value.type === "chatgpt";
}
function validDeviceLoginResponse(value: unknown): value is {
  readonly type: "chatgptDeviceCode";
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly loginId: string;
} {
  return (
    exactStringRecord(value, ["type", "verificationUrl", "userCode", "loginId"]) &&
    value.type === "chatgptDeviceCode"
  );
}
function validAccountResponse(
  value: unknown,
): value is Record<string, unknown> & { readonly requiresOpenaiAuth: boolean } {
  return (
    allowedRecord(value, ["account", "requiresOpenaiAuth"]) &&
    Object.prototype.hasOwnProperty.call(value, "requiresOpenaiAuth") &&
    typeof value.requiresOpenaiAuth === "boolean" &&
    (value.account === undefined || value.account === null || validChatgptAccount(value.account))
  );
}
function validChatgptAccount(value: unknown): boolean {
  return (
    exactRecord(value, ["type", "email", "planType"]) &&
    value.type === "chatgpt" &&
    (value.email === null || nonEmpty(value.email)) &&
    typeof value.planType === "string" &&
    PLAN_TYPES.has(value.planType)
  );
}
// eslint-disable-next-line complexity -- required and optional generated response fields are checked independently.
function validThreadStartResponse(
  value: unknown,
): value is Record<string, unknown> & { readonly thread: Record<"id", string> } {
  return (
    allowedRecord(value, [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "instructionSources",
      "model",
      "modelProvider",
      "serviceTier",
      "reasoningEffort",
      "sandbox",
      "thread",
    ]) &&
    [
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    validApprovalPolicy(value.approvalPolicy) &&
    (value.approvalsReviewer === "user" ||
      value.approvalsReviewer === "auto_review" ||
      value.approvalsReviewer === "guardian_subagent") &&
    nonEmpty(value.cwd) &&
    nonEmpty(value.model) &&
    nonEmpty(value.modelProvider) &&
    (value.instructionSources === undefined ||
      (Array.isArray(value.instructionSources) && value.instructionSources.every(nonEmpty))) &&
    (value.serviceTier === undefined ||
      value.serviceTier === null ||
      nonEmpty(value.serviceTier)) &&
    (value.reasoningEffort === undefined ||
      value.reasoningEffort === null ||
      nonEmpty(value.reasoningEffort)) &&
    validSandbox(value.sandbox) &&
    validThread(value.thread)
  );
}
// eslint-disable-next-line complexity, max-lines-per-function -- mirrors the generated Thread required/optional surface.
function validThread(value: unknown): value is Record<"id", string> & Record<string, unknown> {
  if (
    !allowedRecord(value, [
      "agentNickname",
      "agentRole",
      "cliVersion",
      "createdAt",
      "cwd",
      "ephemeral",
      "forkedFromId",
      "gitInfo",
      "id",
      "modelProvider",
      "name",
      "parentThreadId",
      "path",
      "preview",
      "recencyAt",
      "sessionId",
      "source",
      "status",
      "threadSource",
      "turns",
      "updatedAt",
    ])
  )
    return false;
  const required = [
    "cliVersion",
    "createdAt",
    "cwd",
    "ephemeral",
    "id",
    "modelProvider",
    "preview",
    "sessionId",
    "source",
    "status",
    "turns",
    "updatedAt",
  ];
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    [
      value.cliVersion,
      value.cwd,
      value.id,
      value.modelProvider,
      value.sessionId,
      value.source,
    ].every(nonEmpty) &&
    typeof value.preview === "string" &&
    typeof value.ephemeral === "boolean" &&
    nonNegativeInteger(value.createdAt) &&
    nonNegativeInteger(value.updatedAt) &&
    validThreadStatus(value.status) &&
    Array.isArray(value.turns) &&
    value.turns.every(validTurn) &&
    validOptionalThreadFields(value)
  );
}
// eslint-disable-next-line complexity -- generated nullable Thread optionals are checked independently.
function validOptionalThreadFields(value: Record<string, unknown>): boolean {
  for (const key of [
    "agentNickname",
    "agentRole",
    "forkedFromId",
    "name",
    "parentThreadId",
    "path",
  ]) {
    const item = value[key];
    if (item !== undefined && item !== null && typeof item !== "string") return false;
  }
  if (
    value.recencyAt !== undefined &&
    value.recencyAt !== null &&
    !nonNegativeInteger(value.recencyAt)
  )
    return false;
  if (value.gitInfo !== undefined && value.gitInfo !== null && !validJsonValue(value.gitInfo, 0))
    return false;
  return (
    value.threadSource === undefined ||
    value.threadSource === null ||
    typeof value.threadSource === "string"
  );
}
function validThreadStatus(value: unknown): boolean {
  return (
    (exactRecord(value, ["type"]) &&
      ["notLoaded", "idle", "systemError"].includes(value.type as string)) ||
    (exactRecord(value, ["type", "activeFlags"]) &&
      value.type === "active" &&
      Array.isArray(value.activeFlags) &&
      value.activeFlags.every(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      ))
  );
}
function validTurn(value: unknown): value is Record<"id", string> & Record<string, unknown> {
  return (
    allowedRecord(value, [
      "completedAt",
      "durationMs",
      "error",
      "id",
      "items",
      "itemsView",
      "startedAt",
      "status",
    ]) &&
    ["id", "items", "status"].every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    nonEmpty(value.id) &&
    Array.isArray(value.items) &&
    value.items.every((item) => validJsonValue(item, 0)) &&
    typeof value.status === "string" &&
    ["completed", "interrupted", "failed", "inProgress"].includes(value.status)
  );
}
function validToolContentItem(
  value: unknown,
): value is { readonly type: "inputText"; readonly text: string } {
  return exactRecord(value, ["type", "text"]) && value.type === "inputText" && nonEmpty(value.text);
}
function validApprovalPolicy(value: unknown): boolean {
  return (
    value === "untrusted" ||
    value === "on-request" ||
    value === "never" ||
    (exactRecord(value, ["granular"]) && validGranularApproval(value.granular))
  );
}
function validGranularApproval(value: unknown): boolean {
  return (
    allowedRecord(value, [
      "mcp_elicitations",
      "request_permissions",
      "rules",
      "sandbox_approval",
      "skill_approval",
    ]) &&
    ["mcp_elicitations", "rules", "sandbox_approval"].every(
      (key) => typeof value[key] === "boolean",
    ) &&
    (value.request_permissions === undefined || typeof value.request_permissions === "boolean") &&
    (value.skill_approval === undefined || typeof value.skill_approval === "boolean")
  );
}
// eslint-disable-next-line complexity -- every generated SandboxPolicy variant is closed independently.
function validSandbox(value: unknown): boolean {
  if (exactRecord(value, ["type"])) return value.type === "dangerFullAccess";
  if (allowedRecord(value, ["type", "networkAccess"]) && value.type === "readOnly")
    return value.networkAccess === undefined || typeof value.networkAccess === "boolean";
  if (allowedRecord(value, ["type", "networkAccess"]) && value.type === "externalSandbox")
    return (
      value.networkAccess === undefined ||
      value.networkAccess === "restricted" ||
      value.networkAccess === "enabled"
    );
  return (
    allowedRecord(value, [
      "type",
      "excludeSlashTmp",
      "excludeTmpdirEnvVar",
      "networkAccess",
      "writableRoots",
    ]) &&
    value.type === "workspaceWrite" &&
    (value.excludeSlashTmp === undefined || typeof value.excludeSlashTmp === "boolean") &&
    (value.excludeTmpdirEnvVar === undefined || typeof value.excludeTmpdirEnvVar === "boolean") &&
    (value.networkAccess === undefined || typeof value.networkAccess === "boolean") &&
    (value.writableRoots === undefined ||
      (Array.isArray(value.writableRoots) && value.writableRoots.every(nonEmpty)))
  );
}
function validTurnInput(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every(
      (item) => exactRecord(item, ["type", "text"]) && item.type === "text" && nonEmpty(item.text),
    )
  );
}
function validJsonValue(value: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return bytes(value) <= MAX_TEXT_BYTES;
  if (Array.isArray(value))
    return value.length <= 256 && value.every((item) => validJsonValue(item, depth + 1));
  return (
    isRecord(value) &&
    Object.keys(value).length <= 256 &&
    Object.entries(value).every(([key, item]) => nonEmpty(key) && validJsonValue(item, depth + 1))
  );
}
function hasForbiddenData(value: unknown): boolean {
  return isRecord(value)
    ? Object.entries(value).some(
        ([key, item]) => FORBIDDEN_KEYS.test(key) || hasForbiddenData(item),
      )
    : Array.isArray(value)
      ? value.some(hasForbiddenData)
      : false;
}
function exactStringRecord<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, string> {
  return exactRecord(value, keys) && keys.every((key) => nonEmpty(value[key]));
}
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function allowedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && bytes(value) <= MAX_TEXT_BYTES;
}
function validId(value: unknown): value is CodexAppServerId {
  return (
    (typeof value === "string" && nonEmpty(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function denied<T extends CodexAppServerFailure>(
  reason: T,
): { readonly ok: false; readonly reason: T } {
  return { ok: false, reason };
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
