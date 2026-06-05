// Desktop chat BFF routes for the Keiko canvas UI. These routes intentionally keep the model call
// behind the existing ModelPort/Gateway boundary: the browser sends only chat content and a registry
// model id, while provider endpoints and keys remain resolved from the local gateway config/.env.

import type { IncomingMessage } from "node:http";
import { basename } from "node:path";
import {
  GatewayError,
  findCapability,
  findConfiguredCapability,
  listCapabilities,
  listConfiguredCapabilities,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import type { ConversationDocumentContextWire } from "@oscharko-dev/keiko-contracts";
import {
  UiStoreError,
  isProjectAvailable,
  type Chat,
  type ChatMessage,
  type Project,
} from "./store/index.js";
import { composeConversationPrompt } from "./conversation-prompt.js";
import {
  validateConversationPayload,
  type ConversationAttachment,
} from "./conversation-validation.js";
import { validateProjectPath } from "./store/validation.js";
import { redact } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";

const DEFAULT_CHAT_MODEL = "example-chat-model";
const DEFAULT_CHAT_TITLE = "New chat";
const MAX_BODY_BYTES = 128_000;
const MAX_CHAT_INPUT_CHARS = 16_000;
const MAX_CONTEXT_MESSAGES = 24;

interface GatewayConversationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolveBody(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

async function readJsonObject(
  req: IncomingMessage,
): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function chatCapability(deps: UiHandlerDeps, modelId: string): ModelCapability | undefined {
  const config = currentGatewayConfig(deps);
  return config === undefined ? findCapability(modelId) : findConfiguredCapability(config, modelId);
}

function defaultChatModelId(deps: UiHandlerDeps): string {
  const config = currentGatewayConfig(deps);
  if (config === undefined) {
    return DEFAULT_CHAT_MODEL;
  }
  const configured = listConfiguredCapabilities(config);
  return (
    (
      configured.find((model) => model.id === DEFAULT_CHAT_MODEL && model.kind === "chat") ??
      configured.find((model) => model.kind === "chat")
    )?.id ?? DEFAULT_CHAT_MODEL
  );
}

function modelFromBody(body: Record<string, unknown>, deps: UiHandlerDeps): string | RouteResult {
  const modelId =
    typeof body.modelId === "string" && body.modelId.length > 0
      ? body.modelId
      : defaultChatModelId(deps);
  const capability = chatCapability(deps, modelId);
  if (capability?.kind !== "chat") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
    };
  }
  return modelId;
}

function pickProjectPath(body: Record<string, unknown>, deps: UiHandlerDeps): string {
  const supplied =
    typeof body.projectPath === "string" && body.projectPath.length > 0
      ? body.projectPath
      : undefined;
  if (supplied !== undefined) {
    return validateProjectPath(supplied, { mustExist: true });
  }
  const available = deps.store.listProjects().find((project) => isProjectAvailable(project));
  if (available !== undefined) {
    return available.path;
  }
  return validateProjectPath(process.cwd(), { mustExist: true });
}

function ensureProject(deps: UiHandlerDeps, path: string): Project {
  const existing = deps.store.listProjects().find((project) => project.path === path);
  if (existing !== undefined) {
    deps.store.updateProject(path, {});
    return existing;
  }
  const name = basename(path) || "Local workspace";
  return deps.store.createProject(path, name);
}

function findChat(deps: UiHandlerDeps, projectPath: string, chatId: string): Chat | undefined {
  return deps.store.listChats(projectPath).find((chat) => chat.id === chatId);
}

function chatEnvelope(deps: UiHandlerDeps, project: Project, chat: Chat): Record<string, unknown> {
  const projects = deps.store.listProjects().map((item) => ({
    ...item,
    available: isProjectAvailable(item),
  }));
  const chats = deps.store.listChats(project.path);
  const messages = deps.store.listMessages(chat.id);
  return {
    project: { ...project, available: isProjectAvailable(project) },
    chat,
    messages,
    projects,
    chats,
  };
}

// Issue #154 — every conversation error message is scrubbed through redact() before it can
// reach the wire. GatewayError messages may carry the provider base URL, response body excerpts,
// or `Bearer …` tokens echoed back by the provider; UiStoreError messages may carry user-controlled
// path fragments. Redaction at this single boundary keeps gateway credentials and provider endpoints
// out of conversation error envelopes (AC #2 + AC #4). `deps.redactionSecrets` carries the resolved
// gateway literals (apiKey, baseUrl, env values) so non-standard credential shapes are still scrubbed.
function redactErrorMessage(message: string, deps: UiHandlerDeps): string {
  return redact(message, deps.redactionSecrets ?? []);
}

function gatewayErrorResult(error: GatewayError, deps: UiHandlerDeps): RouteResult {
  const status = error.code === "GATEWAY_AUTHENTICATION" ? 401 : error.retryable ? 503 : 502;
  return { status, body: errorBody(error.code, redactErrorMessage(error.message, deps)) };
}

function desktopChatErrorResult(error: unknown, deps: UiHandlerDeps): RouteResult {
  if (error instanceof GatewayError) {
    return gatewayErrorResult(error, deps);
  }
  if (error instanceof UiStoreError) {
    return {
      status: error.status,
      body: errorBody(error.code, redactErrorMessage(error.message, deps)),
    };
  }
  throw error;
}

function messageForGateway(
  message: ChatMessage,
): { role: "user" | "assistant"; content: string } | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  return { role: message.role, content: message.content };
}

function conversationForGateway(messages: readonly ChatMessage[]): GatewayConversationMessage[] {
  const usable = messages
    .map(messageForGateway)
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } => message !== null,
    )
    .slice(-MAX_CONTEXT_MESSAGES);
  return [
    {
      role: "system",
      content:
        "You are Keiko, an enterprise developer-assist AI. Be concise, practical, and explicit about uncertainty. Do not claim tool access you do not have in this chat.",
    },
    ...usable,
  ];
}

interface SendDesktopChatRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly content: string;
  readonly modelId: string | undefined;
  // Issue #148 — client-extracted document text. Already redacted by keiko-workspace at the
  // extraction boundary; the server passes these into a structured prompt block but does NOT
  // re-extract from disk (server-side modality enforcement is owned by issue #149).
  readonly documentContext: readonly ConversationDocumentContextWire[];
  // Issue #149 — image and document carrier descriptors (no payload bytes on the wire here;
  // attachments arriving via the conversation send path are kind/mime/size metadata the
  // validator uses to enforce modality+mime+size before the gateway is called).
  readonly attachments: readonly ConversationAttachment[];
}

const MAX_ATTACHMENT_ENTRIES = 16;

function parseAttachmentEntry(value: unknown): ConversationAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "image" && kind !== "document") return undefined;
  const mimeType = pickString(value, "mimeType");
  const sizeBytes = pickNumber(value, "sizeBytes");
  if (mimeType === undefined || mimeType.length === 0) return undefined;
  if (
    sizeBytes === undefined ||
    sizeBytes < 0 ||
    !Number.isFinite(sizeBytes) ||
    !Number.isInteger(sizeBytes)
  )
    return undefined;
  return { kind, mimeType, sizeBytes };
}

function parseAttachments(value: unknown): readonly ConversationAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationAttachment[] = [];
  for (const entry of value.slice(0, MAX_ATTACHMENT_ENTRIES)) {
    const parsed = parseAttachmentEntry(entry);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

// Snapshot of the model capability registry the validator inspects. When a gateway config is
// loaded, the configured-capabilities path takes precedence so private models registered by
// .env participate in the modality check exactly as they do at chatCapability() lookup time.
// With no config, we fall back to the static built-in capability list — matches the same
// resolution semantics chatCapability() uses for the single-id check.
function modelCapabilityRegistry(deps: UiHandlerDeps): ReadonlyMap<string, ModelCapability> {
  const config = currentGatewayConfig(deps);
  const capabilities =
    config === undefined ? listCapabilities() : listConfiguredCapabilities(config);
  const registry = new Map<string, ModelCapability>();
  for (const capability of capabilities) {
    registry.set(capability.id, capability);
  }
  return registry;
}

const MAX_DOCUMENT_CONTEXT_ENTRIES = 16;
const MAX_DOCUMENT_CONTEXT_TEXT_BYTES = 65_536; // mirrors MAX_EXTRACTED_BYTES per doc
const MAX_DOCUMENT_DISPLAY_NAME = 256;
const MAX_DOCUMENT_TRUNCATION_MARKER_BYTES = 256;

interface DocumentContextFields {
  readonly id: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly extractedBytes: number;
  readonly truncated: boolean;
  readonly text: string;
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
function pickBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readDocumentContextFields(
  value: Record<string, unknown>,
): DocumentContextFields | undefined {
  const id = pickString(value, "id");
  const displayName = pickString(value, "displayName");
  const mimeType = pickString(value, "mimeType");
  const sizeBytes = pickNumber(value, "sizeBytes");
  const extractedBytes = pickNumber(value, "extractedBytes");
  const truncated = pickBoolean(value, "truncated");
  const text = pickString(value, "text");
  if (
    id === undefined ||
    displayName === undefined ||
    mimeType === undefined ||
    sizeBytes === undefined ||
    extractedBytes === undefined ||
    truncated === undefined ||
    text === undefined
  ) {
    return undefined;
  }
  return { id, displayName, mimeType, sizeBytes, extractedBytes, truncated, text };
}

function fieldsWithinCaps(fields: DocumentContextFields): boolean {
  // `string.length` returns UTF-16 code units, which under-counts bytes for any non-ASCII
  // content (e.g. "漢" = 1 code unit but 3 UTF-8 bytes). The model prompt is bounded in UTF-8
  // bytes, so we MUST measure the same way here. Also enforce that the declared sizes are
  // finite non-negative INTEGERS so callers cannot ship NaN/Infinity/1.5 and bypass the cap.
  return (
    fields.displayName.length > 0 &&
    fields.displayName.length <= MAX_DOCUMENT_DISPLAY_NAME &&
    Buffer.byteLength(fields.text, "utf8") <= MAX_DOCUMENT_CONTEXT_TEXT_BYTES &&
    Number.isInteger(fields.sizeBytes) &&
    fields.sizeBytes >= 0 &&
    Number.isInteger(fields.extractedBytes) &&
    fields.extractedBytes >= 0
  );
}

function parseDocumentContextEntry(value: unknown): ConversationDocumentContextWire | undefined {
  if (!isRecord(value)) return undefined;
  const fields = readDocumentContextFields(value);
  if (fields === undefined) return undefined;
  // Defence-in-depth caps. The client extractor already enforces these, but the server is
  // the trust boundary for what reaches the model prompt.
  if (!fieldsWithinCaps(fields)) return undefined;
  const truncationMarker =
    typeof value.truncationMarker === "string" ? value.truncationMarker : undefined;
  if (
    truncationMarker !== undefined &&
    Buffer.byteLength(truncationMarker, "utf8") > MAX_DOCUMENT_TRUNCATION_MARKER_BYTES
  ) {
    return undefined;
  }
  return { ...fields, truncationMarker };
}

function parseDocumentContext(value: unknown): readonly ConversationDocumentContextWire[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationDocumentContextWire[] = [];
  for (const entry of value.slice(0, MAX_DOCUMENT_CONTEXT_ENTRIES)) {
    const parsed = parseDocumentContextEntry(entry);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function sendRequestFromBody(body: Record<string, unknown>): SendDesktopChatRequest | RouteResult {
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (chatId.length === 0 || projectPath.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "chatId and projectPath are required.") };
  }
  if (content.length === 0 || content.length > MAX_CHAT_INPUT_CHARS) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "content must be between 1 and 16000 characters."),
    };
  }
  return {
    chatId,
    projectPath,
    content,
    modelId: typeof body.modelId === "string" && body.modelId.length > 0 ? body.modelId : undefined,
    documentContext: parseDocumentContext(body.documentContext),
    attachments: parseAttachments(body.attachments),
  };
}

function invalidChatModelResult(modelId: string, deps: UiHandlerDeps): RouteResult | undefined {
  const capability = chatCapability(deps, modelId);
  if (capability?.kind === "chat") {
    return undefined;
  }
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
  };
}

function createUserMessage(deps: UiHandlerDeps, request: SendDesktopChatRequest): ChatMessage {
  return deps.store.createMessage({
    chatId: request.chatId,
    role: "user",
    content: request.content,
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

function createAssistantMessage(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  content: string,
): ChatMessage {
  return deps.store.createMessage({
    chatId: request.chatId,
    role: "assistant",
    content: content.length > 0 ? content : "The model returned an empty response.",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

// Issue #148 — projects the latest user turn into the structured prompt form (user message +
// attached document blocks). Earlier history turns stay verbatim — the document context is a
// per-send payload and never replayed across the conversation log.
function applyDocumentContextToLatestUserTurn(
  history: readonly GatewayConversationMessage[],
  request: SendDesktopChatRequest,
): GatewayConversationMessage[] {
  if (request.documentContext.length === 0) {
    return Array.from(history);
  }
  const composed = composeConversationPrompt(request.content, request.documentContext);
  // Replace ONLY the last user turn (the one we just persisted). System and assistant turns
  // are untouched. Walking from the end avoids rewriting a same-text earlier turn.
  const out: GatewayConversationMessage[] = Array.from(history);
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const entry = out[i];
    if (entry?.role === "user" && entry.content === request.content) {
      out[i] = { role: "user", content: composed };
      break;
    }
  }
  return out;
}

async function persistModelChatTurn(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
): Promise<RouteResult> {
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  try {
    const userMessage = createUserMessage(deps, request);
    const history = conversationForGateway(deps.store.listMessages(request.chatId));
    const messages = applyDocumentContextToLatestUserTurn(history, request);
    const response = await model.call(
      {
        modelId,
        messages,
        stream: false,
      },
      new AbortController().signal,
    );
    const assistantMessage = createAssistantMessage(deps, request, response.content);
    const chatPatch =
      chat.title === DEFAULT_CHAT_TITLE
        ? { selectedModel: modelId, title: request.content.slice(0, 60) }
        : { selectedModel: modelId };
    return {
      status: 200,
      body: {
        chat: deps.store.updateChat(request.chatId, chatPatch),
        messages: [userMessage, assistantMessage],
        usage: response.usage,
      },
    };
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
}

export async function handleCreateDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  const modelId = modelFromBody(body, deps);
  if (isRouteResult(modelId)) return modelId;
  try {
    const projectPath = pickProjectPath(body, deps);
    const project = ensureProject(deps, projectPath);
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : DEFAULT_CHAT_TITLE;
    const chat = deps.store.createChat(project.path, title, modelId);
    return { status: 201, body: chatEnvelope(deps, project, chat) };
  } catch (error) {
    if (error instanceof UiStoreError) {
      // Issue #154 — redact at the boundary so user-controlled path fragments cannot
      // echo configured gateway secrets back to the client.
      return {
        status: error.status,
        body: errorBody(error.code, redactErrorMessage(error.message, deps)),
      };
    }
    throw error;
  }
}

export async function handleSendDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  const request = sendRequestFromBody(body);
  if (isRouteResult(request)) return request;
  const normalizedProjectPath = validateProjectPath(request.projectPath, { mustExist: false });
  const chat = findChat(deps, normalizedProjectPath, request.chatId);
  if (chat === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  const modelId = request.modelId ?? chat.selectedModel;
  const invalidModel = invalidChatModelResult(modelId, deps);
  if (invalidModel !== undefined) return invalidModel;
  // Issue #149 — server-side modality guardrails. Run BEFORE any provider adapter call so a
  // text-only model cannot receive image/document payloads, an embedding/OCR model cannot be
  // used on the send path, and oversized aggregate context is rejected with a typed wire code.
  // The validator returns static English messages (no value echo) — safe to render verbatim.
  const validation = validateConversationPayload({
    modelId,
    modelCapabilities: modelCapabilityRegistry(deps),
    attachments: request.attachments,
    documentContext: request.documentContext,
  });
  if (!validation.ok) {
    return { status: 400, body: errorBody(validation.code, validation.message) };
  }
  return persistModelChatTurn(deps, request, chat, modelId);
}
