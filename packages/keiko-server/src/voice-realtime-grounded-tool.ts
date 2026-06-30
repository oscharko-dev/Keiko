import type { IncomingMessage } from "node:http";
import {
  resolveVoiceCapability,
  type VoiceCapabilityResolution,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  ConversationMemoryResultWire,
  GroundedAnswer,
  GroundedEvidenceCitation,
  LocalKnowledgeEvidenceCitation,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { validateProjectPath } from "./store/validation.js";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import { isVoiceDisabledByPolicy } from "./read-handlers.js";
import {
  buildVoiceTurnMemoryResult,
  desktopChatErrorResult,
  parseMemoryRequest,
  type VoiceTurnAppendRequest,
} from "./chat-handlers.js";
import { resolveConversationMemoryContext } from "./memory-conversation-context.js";
import { runGroundedAskInput } from "./grounded-qa.js";
import type { Chat, ChatMessage } from "./store/index.js";

const MAX_BODY_BYTES = 128_000;
const MAX_TEXT_CHARS = 16_000;
const MAX_CALL_ID_CHARS = 200;
const SAFE_CALL_ID = /^[\x21-\x7e]+$/;

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

interface RealtimeGroundedToolRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly callId: string;
  readonly query: string;
  readonly userTranscript?: string | undefined;
  readonly modelId?: string | undefined;
  readonly memory: VoiceTurnAppendRequest["memory"];
}

interface RealtimeGroundedToolOutput {
  readonly status: "ok";
  readonly answer: string;
  readonly groundingKind: GroundedAnswer["groundingKind"];
  readonly elapsedMs: number;
  readonly citations: readonly {
    readonly marker: string;
    readonly label: string;
    readonly source?: string | undefined;
  }[];
  readonly evidenceRunId?: string | undefined;
  readonly persisted: {
    readonly userMessageId: string;
    readonly assistantMessageId: string;
  };
  readonly instruction: string;
}

export interface RealtimeGroundedToolResponse {
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly groundedAnswer: GroundedAnswer;
  readonly toolOutput: RealtimeGroundedToolOutput;
  readonly memory?: ConversationMemoryResultWire | undefined;
}

const responseInFlight = new Map<string, Promise<RealtimeGroundedToolResponse | RouteResult>>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
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

function readRequiredString(
  body: Record<string, unknown>,
  key: string,
  maxChars = MAX_TEXT_CHARS,
): string | RouteResult {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (value.length === 0 || value.length > maxChars) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `${key} must be a non-empty bounded string.`),
    };
  }
  return value;
}

function readOptionalText(
  body: Record<string, unknown>,
  key: string,
): string | RouteResult | undefined {
  if (body[key] === undefined) return undefined;
  if (typeof body[key] !== "string") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `${key} must be a string when provided.`),
    };
  }
  const value = body[key].trim();
  if (value.length === 0 || value.length > MAX_TEXT_CHARS) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `${key} must be a non-empty bounded string when provided.`),
    };
  }
  return value;
}

function parseRequest(body: Record<string, unknown>): RealtimeGroundedToolRequest | RouteResult {
  const chatId = readRequiredString(body, "chatId", MAX_CALL_ID_CHARS);
  if (isRouteResult(chatId)) return chatId;
  const projectPath = readRequiredString(body, "projectPath");
  if (isRouteResult(projectPath)) return projectPath;
  const callId = readRequiredString(body, "callId", MAX_CALL_ID_CHARS);
  if (isRouteResult(callId)) return callId;
  if (!SAFE_CALL_ID.test(callId)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "callId contains invalid characters.") };
  }
  const query = readRequiredString(body, "query");
  if (isRouteResult(query)) return query;
  const userTranscript = readOptionalText(body, "userTranscript");
  if (isRouteResult(userTranscript)) return userTranscript;
  const modelId = readOptionalText(body, "modelId");
  if (isRouteResult(modelId)) return modelId;
  const memory = parseMemoryRequest(body.memory);
  if (isRouteResult(memory)) return memory;
  return { chatId, projectPath, callId, query, userTranscript, modelId, memory };
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

function retrievalText(request: RealtimeGroundedToolRequest): string {
  return stripUnsafeFormatChars(request.userTranscript ?? request.query).trim();
}

function inFlightKey(request: RealtimeGroundedToolRequest, projectPath: string): string {
  return JSON.stringify([
    projectPath,
    request.chatId,
    request.callId,
    normalizeText(retrievalText(request)),
  ]);
}

function realtimeGroundedVoiceAvailable(resolution: VoiceCapabilityResolution): boolean {
  return (
    resolution.available &&
    resolution.profile === "full-realtime" &&
    resolution.capabilities.realtimeVoice &&
    resolution.capabilities.realtimeToolCalling === true &&
    resolution.transport.webrtcMedia
  );
}

function validateVoiceToolCapability(deps: UiHandlerDeps): RouteResult | undefined {
  const resolution = resolveVoiceCapability(currentGatewayConfig(deps) ?? { providers: [] }, {
    policyDisabled: isVoiceDisabledByPolicy(deps.env),
  });
  if (realtimeGroundedVoiceAvailable(resolution)) {
    return undefined;
  }
  return {
    status: 403,
    body: errorBody(
      "VOICE_TOOL_UNAVAILABLE",
      "Realtime grounded voice is not available for this deployment.",
    ),
  };
}

function normalizeProjectPath(projectPath: string, deps: UiHandlerDeps): string | RouteResult {
  try {
    return validateProjectPath(projectPath, { mustExist: false });
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
}

function findValidatedChat(
  deps: UiHandlerDeps,
  projectPath: string,
  chatId: string,
): Chat | RouteResult {
  const chat = deps.store.findChatById(chatId);
  if (chat?.projectPath !== projectPath) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  return chat;
}

function citationMarker(index: number, citation: GroundedEvidenceCitation): string {
  return citation.marker !== undefined ? `[${String(citation.marker)}]` : `[${String(index + 1)}]`;
}

function summarizeFolderCitation(
  citation: GroundedEvidenceCitation,
  index: number,
): RealtimeGroundedToolOutput["citations"][number] {
  return {
    marker: citationMarker(index, citation),
    label: citation.scopePath,
    ...(citation.source !== undefined ? { source: citation.source } : {}),
  };
}

function summarizeKnowledgeCitation(
  citation: LocalKnowledgeEvidenceCitation,
): RealtimeGroundedToolOutput["citations"][number] {
  return {
    marker: citation.marker,
    label: citation.label,
    ...(citation.source !== undefined ? { source: citation.source } : {}),
  };
}

function summarizeCitations(answer: GroundedAnswer): RealtimeGroundedToolOutput["citations"] {
  if (answer.groundingKind === "local-knowledge") {
    return answer.citations.slice(0, 8).map(summarizeKnowledgeCitation);
  }
  const folder = answer.citations.slice(0, 8).map(summarizeFolderCitation);
  if (answer.groundingKind === "hybrid") {
    return [...folder, ...answer.knowledgeCitations.slice(0, 8).map(summarizeKnowledgeCitation)];
  }
  return folder;
}

function buildToolOutput(answer: GroundedAnswer): RealtimeGroundedToolOutput {
  return {
    status: "ok",
    answer: answer.content,
    groundingKind: answer.groundingKind,
    elapsedMs: answer.elapsedMs,
    citations: summarizeCitations(answer),
    ...(answer.evidenceRunId !== undefined ? { evidenceRunId: answer.evidenceRunId } : {}),
    persisted: {
      userMessageId: answer.userMessageId,
      assistantMessageId: answer.assistantMessageId,
    },
    instruction:
      "Speak this answer faithfully in a concise voice-friendly way. Do not add facts that are not in the answer.",
  };
}

function isGroundedAnswer(value: unknown): value is GroundedAnswer {
  return (
    isRecord(value) &&
    (value.groundingKind === "connected-context" ||
      value.groundingKind === "local-knowledge" ||
      value.groundingKind === "hybrid") &&
    typeof value.userMessageId === "string" &&
    typeof value.assistantMessageId === "string" &&
    typeof value.content === "string"
  );
}

function messagesForAnswer(
  deps: UiHandlerDeps,
  answer: GroundedAnswer,
): readonly ChatMessage[] | RouteResult {
  const user = deps.store.findMessageById(answer.userMessageId);
  const assistant = deps.store.findMessageById(answer.assistantMessageId);
  if (user === undefined || assistant === undefined) {
    return {
      status: 500,
      body: errorBody("INTERNAL", "Grounded voice turn was not persisted correctly."),
    };
  }
  return [user, assistant];
}

async function buildMemory(
  deps: UiHandlerDeps,
  request: RealtimeGroundedToolRequest,
  projectPath: string,
  chat: Chat,
  messages: readonly ChatMessage[],
): Promise<ConversationMemoryResultWire | RouteResult | undefined> {
  if (request.memory === undefined) return undefined;
  const memoryContext = resolveConversationMemoryContext(deps, projectPath, request.chatId);
  if (isRouteResult(memoryContext)) return memoryContext;
  return buildVoiceTurnMemoryResult(
    deps,
    {
      chatId: request.chatId,
      projectPath,
      messages: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        timestamp: message.timestamp,
      })),
      modelId: request.modelId,
      memory: request.memory,
    },
    chat,
    memoryContext,
  );
}

async function buildRealtimeGroundedToolResponse(
  deps: UiHandlerDeps,
  request: RealtimeGroundedToolRequest,
  projectPath: string,
  chat: Chat,
): Promise<RealtimeGroundedToolResponse | RouteResult> {
  const content = retrievalText(request);
  const grounded = await runGroundedAskInput(
    {
      chatId: request.chatId,
      content,
      modelId: request.modelId,
    },
    deps,
  );
  if (grounded.status !== 200) return grounded;
  if (!isGroundedAnswer(grounded.body)) {
    return { status: 500, body: errorBody("INTERNAL", "Grounded voice tool returned no answer.") };
  }
  const answer = grounded.body;
  const messages = messagesForAnswer(deps, answer);
  if (isRouteResult(messages)) return messages;
  const updatedChat = deps.store.findChatById(request.chatId) ?? chat;
  const memory = await buildMemory(deps, request, projectPath, updatedChat, messages);
  if (isRouteResult(memory)) return memory;
  return {
    chat: updatedChat,
    messages,
    groundedAnswer: answer,
    toolOutput: buildToolOutput(answer),
    ...(memory === undefined ? {} : { memory }),
  };
}

export async function handleRealtimeGroundedVoiceTool(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  const request = parseRequest(body);
  if (isRouteResult(request)) return request;
  const capability = validateVoiceToolCapability(deps);
  if (capability !== undefined) return capability;
  const projectPath = normalizeProjectPath(request.projectPath, deps);
  if (isRouteResult(projectPath)) return projectPath;
  const chat = findValidatedChat(deps, projectPath, request.chatId);
  if (isRouteResult(chat)) return chat;
  const key = inFlightKey(request, projectPath);
  const inFlight = responseInFlight.get(key);
  if (inFlight !== undefined) {
    const result = await inFlight;
    return isRouteResult(result) ? result : { status: 200, body: result };
  }
  const responsePromise = buildRealtimeGroundedToolResponse(deps, request, projectPath, chat);
  responseInFlight.set(key, responsePromise);
  const response = await responsePromise.finally(() => {
    responseInFlight.delete(key);
  });
  if (isRouteResult(response)) return response;
  return { status: 200, body: response };
}
