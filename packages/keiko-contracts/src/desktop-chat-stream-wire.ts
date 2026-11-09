/**
 * Runtime validation of the desktop Chat SSE stream (`/api/desktop/chat/stream`) and of the tool
 * approval and read-consent views it carries. A write approval names one of every governed Jira
 * write operation, so this closed vocabulary lives apart from `bff-wire`: the first page load
 * imports `bff-wire`, while only a Chat turn needs the stream validation, which the UI loads on
 * demand (`check:editor-bundle-size`).
 */
import { exactKeys, isRecord as isWireRecord } from "./contract-validation-primitives.js";
import { parseSafely } from "./managed-lsp-parse-safely.js";
import {
  CHAT_TOOL_READ_DISCLOSURE_VERSION,
  MCP_CHAT_READ_DISCLOSURE_VERSION,
  CHAT_TOOL_READ_GRANT_STATES,
  type ChatToolReadGrantView,
  type ChatToolWriteApprovalView,
  validateChatToolWriteApprovalView,
} from "./chat-tool-authority.js";
import {
  CHAT_TOOL_BATCH_TOOL_NAME,
  isChatToolBatchProgress,
  type ChatToolExchange,
  type DesktopChatStreamEvent,
} from "./bff-wire.js";

function isDesktopChatTokenData(data: unknown): boolean {
  return isWireRecord(data) && typeof data.text === "string";
}

function isDesktopChatErrorData(data: unknown): boolean {
  return isWireRecord(data) && typeof data.code === "string" && typeof data.message === "string";
}

function isDesktopChatDoneData(data: unknown): boolean {
  return isWireRecord(data) && isWireRecord(data.chat) && Array.isArray(data.messages);
}

export function isChatToolWriteApprovalView(value: unknown): value is ChatToolWriteApprovalView {
  return validateChatToolWriteApprovalView(value).ok;
}

function isRuntimeToolOrigin(value: unknown): boolean {
  return value === undefined || value === "runtime";
}

function isChatToolCallView(value: unknown): value is ChatToolExchange["call"] {
  const parsed = parseSafely(() => {
    if (
      !isWireRecord(value) ||
      exactKeys(value, ["id", "name", "arguments", "origin"], "call").length > 0 ||
      !isRuntimeToolOrigin(value.origin) ||
      typeof value.id !== "string" ||
      !/^[\w-]{1,128}$/u.test(value.id) ||
      typeof value.name !== "string" ||
      !/^[\w.-]{1,128}$/u.test(value.name) ||
      !isWireRecord(value.arguments)
    )
      return { ok: true, value: false };
    const serialized = JSON.stringify(value.arguments);
    return {
      ok: true,
      value:
        typeof serialized === "string" && new TextEncoder().encode(serialized).length <= 262144,
    };
  });
  return parsed.ok && parsed.value;
}

function isDesktopChatWriteApprovalData(data: unknown): boolean {
  return (
    isWireRecord(data) &&
    exactKeys(data, ["messageId", "call", "approval"], "data").length === 0 &&
    typeof data.messageId === "string" &&
    /^[\w-]{1,128}$/u.test(data.messageId) &&
    isChatToolCallView(data.call) &&
    isChatToolWriteApprovalView(data.approval) &&
    data.call.name === data.approval.operation.replaceAll(".", "_")
  );
}

function isDesktopChatDraftProgress(name: unknown, progress: unknown): boolean {
  if (progress === undefined) return true;
  const parsed = parseSafely(() => ({
    ok: true,
    value:
      name === "jira_draft" &&
      isWireRecord(progress) &&
      new TextEncoder().encode(JSON.stringify(progress)).length <= 262144,
  }));
  return parsed.ok && parsed.value;
}
function isDesktopChatBatchProgress(name: unknown, progress: unknown): boolean {
  return (
    progress === undefined ||
    (name === CHAT_TOOL_BATCH_TOOL_NAME && isChatToolBatchProgress(progress))
  );
}
function isDesktopChatStreamedExchange(exchange: unknown): boolean {
  return (
    isWireRecord(exchange) &&
    exactKeys(
      exchange,
      ["call", "result", "mutationOutcome", "draftProgress", "batchProgress"],
      "exchange",
    ).length === 0 &&
    isChatToolCallView(exchange.call) &&
    (exchange.result === undefined || isWireRecord(exchange.result)) &&
    isDesktopChatDraftProgress(exchange.call.name, exchange.draftProgress) &&
    isDesktopChatBatchProgress(exchange.call.name, exchange.batchProgress) &&
    (exchange.mutationOutcome === undefined || typeof exchange.mutationOutcome === "string")
  );
}

function isDesktopChatToolExchangeData(data: unknown): boolean {
  return (
    isWireRecord(data) &&
    exactKeys(data, ["messageId", "exchange"], "data").length === 0 &&
    typeof data.messageId === "string" &&
    /^[\w-]{1,128}$/u.test(data.messageId) &&
    isDesktopChatStreamedExchange(data.exchange)
  );
}

const CHAT_READ_VIEW_KEYS = [
  "kind",
  "grantId",
  "chatId",
  "state",
  "disclosureVersion",
  "requestedAt",
  "expiresAt",
];
function validReadGrantSubject(value: Record<string, unknown>): boolean {
  if (value.kind === "mcp-chat-read")
    return (
      value.disclosureVersion === MCP_CHAT_READ_DISCLOSURE_VERSION &&
      typeof value.configurationDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(value.configurationDigest)
    );
  return (
    value.kind === "jira-chat-read" &&
    value.disclosureVersion === CHAT_TOOL_READ_DISCLOSURE_VERSION &&
    typeof value.podId === "string" &&
    /^[\w-]{1,128}$/u.test(value.podId) &&
    [value.bindingGeneration, value.authenticationGeneration].every(
      (n) => Number.isSafeInteger(n) && Number(n) > 0,
    )
  );
}
export function isChatToolReadGrantView(value: unknown): value is ChatToolReadGrantView {
  if (!isWireRecord(value)) return false;
  const keys = [
    ...CHAT_READ_VIEW_KEYS,
    ...(value.kind === "mcp-chat-read"
      ? ["configurationDigest"]
      : ["podId", "bindingGeneration", "authenticationGeneration"]),
  ];
  return (
    exactKeys(value, keys, "readGrant").length === 0 &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    validReadGrantSubject(value) &&
    [value.grantId, value.chatId].every(
      (id) => typeof id === "string" && /^[\w-]{1,128}$/u.test(id),
    ) &&
    [value.requestedAt, value.expiresAt].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) &&
    Number(value.expiresAt) > Number(value.requestedAt) &&
    typeof value.state === "string" &&
    (CHAT_TOOL_READ_GRANT_STATES as readonly string[]).includes(value.state)
  );
}

function isDesktopChatReadConsentData(data: unknown): boolean {
  return (
    isWireRecord(data) &&
    exactKeys(data, ["messageId", "grant"], "data").length === 0 &&
    typeof data.messageId === "string" &&
    /^[\w-]{1,128}$/u.test(data.messageId) &&
    isChatToolReadGrantView(data.grant)
  );
}

const DESKTOP_CHAT_TOOL_EVENT_DATA: ReadonlyMap<unknown, (data: unknown) => boolean> = new Map([
  ["tool-write-approval", isDesktopChatWriteApprovalData],
  ["tool-read-consent", isDesktopChatReadConsentData],
  ["tool-exchange", isDesktopChatToolExchangeData],
]);

export function isDesktopChatStreamEvent(value: unknown): value is DesktopChatStreamEvent {
  if (!isWireRecord(value)) return false;
  const { event, data } = value;
  const isToolData = DESKTOP_CHAT_TOOL_EVENT_DATA.get(event);
  if (isToolData !== undefined)
    return exactKeys(value, ["event", "data"], "event").length === 0 && isToolData(data);
  switch (event) {
    case "token":
      return isDesktopChatTokenData(data);
    case "error":
      return isDesktopChatErrorData(data);
    case "cancelled":
      return isWireRecord(data);
    case "done":
      return isDesktopChatDoneData(data);
    default:
      return false;
  }
}
