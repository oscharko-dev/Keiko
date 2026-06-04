// Desktop chat BFF routes for the Keiko canvas UI. These routes intentionally keep the model call
// behind the existing ModelPort/Gateway boundary: the browser sends only chat content and a registry
// model id, while provider endpoints and keys remain resolved from the local gateway config/.env.

import type { IncomingMessage } from "node:http";
import { basename } from "node:path";
import {
  GatewayError,
  findCapability,
  findConfiguredCapability,
  listConfiguredCapabilities,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import {
  UiStoreError,
  isProjectAvailable,
  type Chat,
  type ChatMessage,
  type Project,
} from "./store/index.js";
import { validateProjectPath } from "./store/validation.js";
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

function gatewayErrorResult(error: GatewayError): RouteResult {
  const status = error.code === "GATEWAY_AUTHENTICATION" ? 401 : error.retryable ? 503 : 502;
  return { status, body: errorBody(error.code, error.message) };
}

function desktopChatErrorResult(error: unknown): RouteResult {
  if (error instanceof GatewayError) {
    return gatewayErrorResult(error);
  }
  if (error instanceof UiStoreError) {
    return { status: error.status, body: errorBody(error.code, error.message) };
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
    const response = await model.call(
      {
        modelId,
        messages: conversationForGateway(deps.store.listMessages(request.chatId)),
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
    return desktopChatErrorResult(error);
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
      return { status: error.status, body: errorBody(error.code, error.message) };
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
  return persistModelChatTurn(deps, request, chat, modelId);
}
