// Desktop chat BFF routes for the Keiko canvas UI. These routes intentionally keep the model call
// behind the existing ModelPort/Gateway boundary: the browser sends only chat content and a registry
// model id, while provider endpoints and keys remain resolved from the local gateway config/.env.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
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
import type {
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryProposalId,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";
import { retrieveMemoryContext } from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  extractCandidatesFromUserText,
  type CaptureContext,
  type CaptureOutcome,
} from "@oscharko-dev/keiko-memory-capture";
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
import { currentGatewayConfig, currentRedactionSecrets } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { createMemoryTargetResolver } from "./memory-target-resolver.js";
import { vaultAsQueryPort } from "./memory-conv-handlers.js";
import {
  conversationMemoryScopes,
  resolveConversationMemoryContext,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { cosineSimilarity, embedAndStoreMemory, embedMemoryText } from "./memory-embedding.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { captureSalientFromTurn } from "./memory-salience.js";

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
// out of conversation error envelopes (AC #2 + AC #4).
//
// Epic #177 audit: read the LIVE gateway-derived secrets via currentRedactionSecrets(deps) so
// values added through PATCH /api/gateway/config after process start are scrubbed too. The
// `deps.redactionSecrets` field is the startup snapshot frozen by buildUiHandlerDeps and would
// miss any runtime-added apiKey/baseUrl.
function redactErrorMessage(message: string, deps: UiHandlerDeps): string {
  return redact(message, currentRedactionSecrets(deps));
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
  readonly memory: ParsedConversationMemoryRequest | undefined;
}

interface ParsedConversationMemoryRequest {
  readonly enabled: boolean;
  readonly budgetTokens?: number;
  readonly context: Record<string, unknown>;
}

function scopeLabel(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return "User memory";
    case "workspace":
      return "Workspace memory";
    case "project":
      return "Project memory";
    case "workflow":
      return "Workflow memory";
    case "global":
      return "Global memory";
  }
}

function parseMemoryContext(value: unknown): Record<string, unknown> | RouteResult {
  if (!isRecord(value)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "memory.context must be an object.") };
  }
  return value;
}

function parseMemoryEnabled(raw: Record<string, unknown>): boolean | RouteResult {
  if (raw.enabled === undefined) return true;
  if (typeof raw.enabled === "boolean") return raw.enabled;
  return { status: 400, body: errorBody("BAD_REQUEST", "memory.enabled must be a boolean.") };
}

function parseMemoryBudget(raw: Record<string, unknown>): number | RouteResult | undefined {
  const budgetTokens = pickNumber(raw, "budgetTokens");
  if (budgetTokens === undefined) return undefined;
  if (Number.isFinite(budgetTokens) && Number.isInteger(budgetTokens) && budgetTokens >= 0) {
    return budgetTokens;
  }
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "memory.budgetTokens must be a non-negative integer."),
  };
}

function parseMemoryRequest(
  value: unknown,
): ParsedConversationMemoryRequest | RouteResult | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "memory must be an object.") };
  }
  const context = parseMemoryContext(value.context);
  if (isRouteResult(context)) return context;
  const enabled = parseMemoryEnabled(value);
  if (isRouteResult(enabled)) return enabled;
  const budgetTokens = parseMemoryBudget(value);
  if (isRouteResult(budgetTokens)) return budgetTokens;
  return {
    enabled,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    context,
  };
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

// eslint-disable-next-line complexity
function sendRequestFromBody(body: Record<string, unknown>): SendDesktopChatRequest | RouteResult {
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  if (chatId.length === 0 || projectPath.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "chatId and projectPath are required.") };
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (content.length === 0 || content.length > MAX_CHAT_INPUT_CHARS) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "content must be between 1 and 16000 characters."),
    };
  }
  const memory = parseMemoryRequest(body.memory);
  if (isRouteResult(memory)) return memory;
  return {
    chatId,
    projectPath,
    content,
    modelId: typeof body.modelId === "string" && body.modelId.length > 0 ? body.modelId : undefined,
    documentContext: parseDocumentContext(body.documentContext),
    attachments: parseAttachments(body.attachments),
    memory,
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
  memoryText: string | undefined,
): GatewayConversationMessage[] {
  if (
    request.documentContext.length === 0 &&
    (memoryText === undefined || memoryText.length === 0)
  ) {
    return Array.from(history);
  }
  const composed = composeConversationPrompt(request.content, request.documentContext, memoryText);
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

function emptyMemoryResult(enabled: boolean): ConversationMemoryResultWire {
  return {
    context: {
      enabled,
      text: "",
      memories: [],
      budget: { tokens: 0, used: 0 },
    },
    actions: [],
  };
}

function recordConversationMemoryRetrieval(
  deps: UiHandlerDeps,
  context: ConversationMemoryRuntimeContext,
  memories: readonly { readonly memoryId: string }[],
): void {
  if (memories.length === 0) {
    return;
  }
  const event: MemoryAuditEvent = {
    schemaVersion: "1",
    kind: "memory:retrieved",
    eventId: randomUUID(),
    occurredAt: Date.now(),
    initiatorSurface: "conversation-center",
    summary:
      memories.length === 1
        ? "Retrieved 1 memory for a conversation request."
        : `Retrieved ${String(memories.length)} memories for a conversation request.`,
    scopes: conversationMemoryScopes(context),
    matchedMemoryIds: memories.map((memory) => memory.memoryId as MemoryId),
  };
  recordMemoryAudit({ evidenceStore: deps.evidenceStore }, event);
}

// Gathers the candidate memory ids the retrieval layer will rank for these scopes, so the caller
// can score each against the query embedding BEFORE retrieval runs. A superset of the eventually-
// ranked set is harmless: ids the ranker filters out simply never read their semantic score.
function gatherCandidateIds(
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
): readonly MemoryId[] {
  const port = vaultAsQueryPort(vault);
  const ids: MemoryId[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const record of port.listByScope(scope)) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      ids.push(record.id);
    }
  }
  return ids;
}

// Builds the per-memory semantic score map for the candidate set, or undefined when no embedding
// model is configured (query embedding null) — that undefined drives the byte-identical lexical
// fallback in the ranker. A candidate whose stored vector is missing or dimension-mismatched is
// simply omitted from the map (semantic subscore 0 for it).
async function buildSemanticScores(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  queryText: string,
  candidateIds: readonly MemoryId[],
): Promise<ReadonlyMap<MemoryId, number> | undefined> {
  const queryEmbedding = await embedMemoryText(deps, queryText);
  if (queryEmbedding === null) return undefined;
  const scores = new Map<MemoryId, number>();
  for (const id of candidateIds) {
    const stored = vault.getEmbedding(id);
    if (stored === undefined) continue;
    scores.set(id, cosineSimilarity(queryEmbedding.vector, stored.vector));
  }
  return scores;
}

function toMemoryResult(
  retrieval: ReturnType<typeof retrieveMemoryContext>,
): ConversationMemoryResultWire {
  return {
    context: {
      enabled: true,
      text: retrieval.contextBlock.text,
      memories: retrieval.contextBlock.memories.map((item) => ({
        memoryId: String(item.memoryId),
        bodyExcerpt: item.bodyExcerpt,
        inclusionReason: item.inclusionReason,
      })),
      budget: retrieval.budget,
    },
    actions: [],
  };
}

async function buildMemoryResult(
  request: SendDesktopChatRequest,
  deps: UiHandlerDeps,
  context: ConversationMemoryRuntimeContext,
): Promise<ConversationMemoryResultWire> {
  const memory = request.memory;
  if (memory === undefined) {
    return emptyMemoryResult(false);
  }
  const vault = deps.memoryVault;
  if (vault === undefined || !memory.enabled) {
    return emptyMemoryResult(memory.enabled);
  }
  const scopes = conversationMemoryScopes(context);
  const semanticById = await buildSemanticScores(
    deps,
    vault,
    request.content,
    gatherCandidateIds(vault, scopes),
  );
  const retrieval = retrieveMemoryContext(
    {
      scopes,
      queryText: request.content,
      ...(memory.budgetTokens !== undefined ? { budgetTokens: memory.budgetTokens } : {}),
      ...(semanticById !== undefined ? { semanticById } : {}),
      nowMs: Date.now(),
    },
    vaultAsQueryPort(vault),
  );
  // Reinforcement reflex (#204): every recall is an access. Bumping the access counter for the
  // included memories feeds the decay/reinforcement maintenance cycle so frequently-recalled
  // memories strengthen over time. Guarded above (vault is defined here).
  const includedIds = retrieval.contextBlock.memories.map((item) => item.memoryId);
  if (includedIds.length > 0) {
    vault.recordAccess(includedIds, Date.now());
  }
  const result = toMemoryResult(retrieval);
  recordConversationMemoryRetrieval(deps, context, result.context.memories);
  return result;
}

function buildCaptureContext(input: ConversationMemoryRuntimeContext): CaptureContext {
  return {
    userId: input.userId,
    nowMs: Date.now(),
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  };
}

async function captureActionFromOutcome(
  outcome: CaptureOutcome,
  deps: UiHandlerDeps,
): Promise<ConversationMemoryActionWire | null> {
  switch (outcome.kind) {
    case "candidate": {
      if (deps.memoryVault === undefined) return null;
      const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
      const record = buildMemoryRecordFromProposal(proposalId, outcome);
      if (record === null) return null;
      const inserted = deps.memoryVault.insertMemory(record);
      // Best-effort embed-on-capture (#204): swallowed on failure / no model — never breaks capture.
      await embedAndStoreMemory(deps, deps.memoryVault, inserted.id, inserted.body);
      return {
        kind: "candidate",
        proposalId: String(inserted.id),
        body: inserted.body,
        scopeLabel: scopeLabel(inserted.scope),
        requiresApproval: outcome.requiresApproval,
      };
    }
    case "update":
      return {
        kind: "update",
        memoryId: String(outcome.operation.memoryId),
        bodyPatch: outcome.operation.bodyPatch,
      };
    case "forget":
      return {
        kind: "forget",
        memoryId: String(outcome.operation.memoryId),
        requiresConfirmation: outcome.requiresConfirmation,
      };
    case "rejected":
      return { kind: "rejected", reason: outcome.reason };
    case "supersession":
      return null;
  }
}

async function captureMemoryActions(
  request: SendDesktopChatRequest,
  deps: UiHandlerDeps,
  context: ConversationMemoryRuntimeContext,
): Promise<readonly ConversationMemoryActionWire[]> {
  if (request.memory === undefined || !request.memory.enabled || deps.memoryVault === undefined) {
    return [];
  }
  const outcomes = extractCandidatesFromUserText(request.content, buildCaptureContext(context), {
    resolver: createMemoryTargetResolver(deps.memoryVault),
  });
  const actions: ConversationMemoryActionWire[] = [];
  for (const outcome of outcomes) {
    const action = await captureActionFromOutcome(outcome, deps);
    if (action !== null) actions.push(action);
  }
  return actions;
}

// Merges the regex intent capture (synchronous) with model-assisted salience capture (async).
// Regex runs FIRST so its inserts are part of the vault state the salience extractor reads for
// dedup. Salience reuses the same `memory.enabled` gate; when memory is off, both paths no-op.
async function collectMemoryActions(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
  assistantText: string,
): Promise<readonly ConversationMemoryActionWire[]> {
  if (memoryContext === undefined) {
    return [];
  }
  const regexActions = await captureMemoryActions(request, deps, memoryContext);
  const salientActions = await captureSalientFromTurn(
    deps,
    request,
    memoryContext,
    modelId,
    assistantText,
  );
  return [...regexActions, ...salientActions];
}

// On the first turn of a freshly-created chat (still bearing the default title), adopt the user's
// message prefix as the title; otherwise just pin the selected model.
function buildChatPatch(
  chat: Chat,
  request: SendDesktopChatRequest,
  modelId: string,
): { selectedModel: string; title?: string } {
  return chat.title === DEFAULT_CHAT_TITLE
    ? { selectedModel: modelId, title: request.content.slice(0, 60) }
    : { selectedModel: modelId };
}

async function persistModelChatTurn(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
): Promise<RouteResult> {
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  try {
    const memory =
      memoryContext === undefined
        ? emptyMemoryResult(false)
        : await buildMemoryResult(request, deps, memoryContext);
    const userMessage = createUserMessage(deps, request);
    const history = conversationForGateway(deps.store.listMessages(request.chatId));
    const messages = applyDocumentContextToLatestUserTurn(history, request, memory.context.text);
    const response = await model.call(
      {
        modelId,
        messages,
        stream: false,
      },
      new AbortController().signal,
    );
    // Issue #631 — redact the model's raw content before persisting and before returning it to
    // the browser. A model that echoes a secret from its context (e.g. an apiKey injected via
    // system prompt) would otherwise surface it un-redacted on the success path, mirroring the
    // grounded-QA path (grounded-qa.ts line 549) which already applies deps.redactor here.
    const redactedContent = deps.redactor(response.content) as string;
    const assistantMessage = createAssistantMessage(deps, request, redactedContent);
    const memoryActions = await collectMemoryActions(
      deps,
      request,
      memoryContext,
      modelId,
      redactedContent,
    );
    const chatPatch = buildChatPatch(chat, request, modelId);
    return {
      status: 200,
      body: {
        chat: deps.store.updateChat(request.chatId, chatPatch),
        messages: [userMessage, assistantMessage],
        usage: response.usage,
        memory: { ...memory, actions: memoryActions },
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

// Issue #623 — validate the project path, returning a typed 400 RouteResult on failure instead of
// letting validateProjectPath throw into the generic 500 handler. Kept as a helper so the send
// handler stays within the complexity budget.
function normalizeDesktopProjectPath(
  projectPath: string,
  deps: UiHandlerDeps,
): string | RouteResult {
  try {
    return validateProjectPath(projectPath, { mustExist: false });
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
}

// Resolves the optional conversation memory context, surfacing a typed RouteResult on lookup
// failure. Extracted so handleSendDesktopChat stays within the complexity budget.
function resolveDesktopMemoryContext(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  normalizedProjectPath: string,
): ConversationMemoryRuntimeContext | RouteResult | undefined {
  if (request.memory === undefined) return undefined;
  return resolveConversationMemoryContext(deps, normalizedProjectPath, request.chatId);
}

export async function handleSendDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  const request = sendRequestFromBody(body);
  if (isRouteResult(request)) return request;
  const normalizedProjectPath = normalizeDesktopProjectPath(request.projectPath, deps);
  if (isRouteResult(normalizedProjectPath)) return normalizedProjectPath;
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
  const memoryContext = resolveDesktopMemoryContext(deps, request, normalizedProjectPath);
  if (isRouteResult(memoryContext)) return memoryContext;
  return persistModelChatTurn(deps, request, chat, modelId, memoryContext);
}
