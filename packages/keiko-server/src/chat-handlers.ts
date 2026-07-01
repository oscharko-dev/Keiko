// Desktop chat BFF routes for the Keiko canvas UI. These routes intentionally keep the model call
// behind the existing ModelPort/Gateway boundary: the browser sends only chat content and a registry
// model id, while provider endpoints and keys remain resolved from the local gateway config/.env.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  GatewayError,
  ContextOverflowError,
  findCapability,
  findConfiguredCapability,
  listCapabilities,
  listConfiguredCapabilities,
  type ModelCapability,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  isDiscussionMode,
  stripUnsafeFormatChars,
  DEFAULT_CONTEXT_PROFILE,
  type ConversationDocumentContextWire,
  type DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import type {
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
  GroundedAnswer,
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
  maybeRunAutoMaintenance,
  type AutoMaintenanceState,
} from "./memory-maintenance-handlers.js";
import {
  buildConversationRetrievalSignals,
  conversationFusionMode,
  semanticRetrievalGateForText,
} from "./memory-retrieval-signals.js";
import { reinforcementAccessIdsForAssistantUse } from "./memory-reinforcement.js";
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
import {
  validateConversationPayload,
  type ConversationAttachment,
} from "./conversation-validation.js";
import { validateProjectPath } from "./store/validation.js";
import { redact } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "./deps.js";
import {
  currentContextProfileForModel,
  currentGatewayConfig,
  currentRedactionSecrets,
} from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { createMemoryTargetResolver } from "./memory-target-resolver.js";
import {
  isPersistableMemoryCandidate,
  memoryCapturePolicyForDeps,
  SENSITIVE_MEMORY_ACTION_BODY,
  SENSITIVE_MEMORY_REJECTION_REASON,
} from "./memory-capture-policy.js";
import { vaultAsQueryPort } from "./memory-conv-handlers.js";
import {
  conversationMemoryScopes,
  resolveConversationMemoryContext,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { embedAndStoreMemory } from "./memory-embedding.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { captureSalientFromTurn } from "./memory-salience.js";
import {
  assertUsableAssistantContent,
  isLegacyEmptyAssistantPlaceholder,
} from "./assistant-response.js";
import { conversationForGatewayWithCompaction } from "./conversation-compaction.js";
import type { ConversationCompactionOutcome } from "./conversation-compaction.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import {
  buildChatCompactionContextText,
  selectGatewayPromptAssembly,
  type GatewayPromptAssembly,
} from "./chat-prompt-budget.js";
import { usableGatewayMessages } from "./conversation-gateway.js";
import type { GatewayConversationMessage } from "./conversation-gateway.js";
export {
  MAX_CONTEXT_MESSAGES,
  conversationForGateway,
  usableGatewayMessages,
} from "./conversation-gateway.js";
export type { GatewayConversationMessage } from "./conversation-gateway.js";
export type { GatewayPromptAssembly } from "./chat-prompt-budget.js";

const DEFAULT_CHAT_MODEL = "example-chat-model";
const DEFAULT_CHAT_TITLE = "New chat";
const MAX_BODY_BYTES = 128_000;
const MAX_CHAT_INPUT_CHARS = 16_000;
const MAX_PENDING_SALIENCE_CAPTURES = 32;
let pendingSalienceCaptures = 0;

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
  const projects = deps.store.listProjects();
  const preferred = projects.find(
    (project) => project.path === deps.preferredProjectPath && isProjectAvailable(project),
  );
  if (preferred !== undefined) {
    return preferred.path;
  }
  const available = projects.find((project) => isProjectAvailable(project));
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
  const messages = deps.store
    .listMessages(chat.id)
    .filter((message) => !isLegacyEmptyAssistantPlaceholder(message));
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
export function redactErrorMessage(message: string, deps: UiHandlerDeps): string {
  return redact(message, currentRedactionSecrets(deps));
}

function gatewayErrorResult(error: GatewayError, deps: UiHandlerDeps): RouteResult {
  const status = error.code === "GATEWAY_AUTHENTICATION" ? 401 : error.retryable ? 503 : 502;
  return { status, body: errorBody(error.code, redactErrorMessage(error.message, deps)) };
}

export function desktopChatErrorResult(error: unknown, deps: UiHandlerDeps): RouteResult {
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

export interface SendDesktopChatRequest {
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
  // Issue #502 — optional colleague-discussion mode selected for THIS turn only. Turn-local: it
  // shapes the additive directive block on the latest user turn and is NEVER replayed into
  // compacted history. An unknown value is dropped to `undefined` (backward-compatible default).
  readonly discussionMode: DiscussionMode | undefined;
}

export interface ParsedConversationMemoryRequest {
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

export function parseMemoryRequest(
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
    discussionMode: parseDiscussionMode(body.discussionMode),
  };
}

// Issue #502 — accepts a known DiscussionMode, otherwise drops to `undefined`. An unknown or
// missing value is NOT a request error (the field is optional and turn-local); it simply leaves
// the turn in the default no-mode behaviour.
function parseDiscussionMode(value: unknown): DiscussionMode | undefined {
  return isDiscussionMode(value) ? value : undefined;
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

export function createUserMessage(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
): ChatMessage {
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

export function createAssistantMessage(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  content: string,
  modelId: string,
): ChatMessage {
  assertUsableAssistantContent(content, modelId);
  return deps.store.createMessage({
    chatId: request.chatId,
    role: "assistant",
    content,
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

export function emptyMemoryResult(enabled: boolean): ConversationMemoryResultWire {
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

// The candidate-id gathering, semantic scoring, and strength projection that both this chat path and
// the BFF /api/memory/context route need now live in ONE place — memory-retrieval-signals.ts — so the
// two surfaces cannot drift (#204, O-F4). See buildConversationRetrievalSignals.

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
        sourceKind: item.sourceKind,
        ...(item.captureRationale !== undefined ? { captureRationale: item.captureRationale } : {}),
        sensitivity: item.sensitivity,
        confidence: item.confidence,
        status: item.status,
        capturedAt: item.capturedAt,
      })),
      budget: retrieval.budget,
    },
    actions: [],
  };
}

// Process-lifetime rate-limit cursor for autonomous maintenance (#204, O-V4). One loopback server =
// one cursor, so the >=6h interval is honoured across chat turns. Module-scoped (not on deps) so it
// is never shared across test fixtures. Auto-maintenance is on by default and can be disabled with
// KEIKO_MEMORY_AUTO_MAINTAIN=0.
const memoryMaintenanceCursor: AutoMaintenanceState = {};

// Opportunistic, bounded, rate-limited (#204, O-V4) maintenance fired once memory is in use. The
// pass short-circuits on the cursor almost every turn and never throws into the chat path.
function maybeRunChatAutoMaintenance(deps: UiHandlerDeps, vault: MemoryVaultStore): void {
  maybeRunAutoMaintenance(vault, deps.evidenceStore, memoryMaintenanceCursor, {
    nowMs: Date.now(),
    enabled: deps.env.KEIKO_MEMORY_AUTO_MAINTAIN !== "0",
  });
}

// Build the embedding/strength/diversity signals and run scoped retrieval — the shared pipeline the
// BFF route also uses (#204, O-F2/O-F3/O-F4/O-P1). semanticById is gated on the secondary-model
// egress check; all signals are passed only when present so a fresh vault ranks byte-identically, and
// conversation recall defaults to RRF unless KEIKO_MEMORY_FUSION=weighted-sum is set.
async function retrieveChatMemory(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
  content: string,
  budgetTokens: number | undefined,
  nowMs: number,
): Promise<ReturnType<typeof retrieveMemoryContext>> {
  const semanticGate = semanticRetrievalGateForText(
    deps,
    content,
    memoryCapturePolicyForDeps(deps),
  );
  const signals = await buildConversationRetrievalSignals(
    deps,
    vault,
    content,
    scopes,
    nowMs,
    semanticGate,
  );
  return retrieveMemoryContext(
    {
      scopes,
      queryText: content,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      ...(signals.semanticById !== undefined ? { semanticById: signals.semanticById } : {}),
      ...(signals.strengthById.size > 0 ? { strengthById: signals.strengthById } : {}),
      ...(signals.embeddingById.size > 0 ? { embeddingById: signals.embeddingById } : {}),
      ...(signals.mmrLambda !== undefined ? { mmrLambda: signals.mmrLambda } : {}),
      fusion: conversationFusionMode(deps),
      nowMs,
    },
    vaultAsQueryPort(vault),
  );
}

export async function buildMemoryResult(
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
  const budgetTokens = memory.budgetTokens;
  if (budgetTokens === 0) {
    return emptyMemoryResult(true);
  }
  const nowMs = Date.now();
  const retrieval = await retrieveChatMemory(
    deps,
    vault,
    scopes,
    request.content,
    budgetTokens,
    nowMs,
  );
  // Autonomous maintenance (#204, O-V4): now that memory is actively in use, opportunistically run
  // ONE bounded, rate-limited maintenance pass so the decay/forget curve advances without a
  // free-running background loop.
  maybeRunChatAutoMaintenance(deps, vault);
  const result = toMemoryResult(retrieval);
  recordConversationMemoryRetrieval(deps, context, result.context.memories);
  return result;
}

export function recordConversationMemoryUse(
  deps: UiHandlerDeps,
  memory: ConversationMemoryResultWire,
  assistantText: string,
): void {
  const vault = deps.memoryVault;
  if (vault === undefined || memory.context.memories.length === 0) return;
  const accessedIds = reinforcementAccessIdsForAssistantUse(memory.context.memories, assistantText);
  if (accessedIds.length > 0) {
    vault.recordAccess(accessedIds, Date.now());
  }
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

async function candidateActionFromOutcome(
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
  deps: UiHandlerDeps,
): Promise<ConversationMemoryActionWire | null> {
  if (deps.memoryVault === undefined) return null;
  if (!isPersistableMemoryCandidate(outcome)) {
    return { kind: "rejected", reason: SENSITIVE_MEMORY_REJECTION_REASON };
  }
  const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
  const record = buildMemoryRecordFromProposal(proposalId, outcome);
  if (record === null) return null;
  const inserted = deps.memoryVault.insertMemory(record);
  // Best-effort embed-on-capture (#204): swallowed on failure / no model — never breaks capture.
  await embedAndStoreMemory(deps, deps.memoryVault, inserted.id, inserted.body);
  return {
    kind: "candidate",
    proposalId: String(inserted.id),
    body:
      outcome.requiresApproval || inserted.provenance.sensitivity !== "public"
        ? SENSITIVE_MEMORY_ACTION_BODY
        : inserted.body,
    scopeLabel: scopeLabel(inserted.scope),
    requiresApproval: outcome.requiresApproval,
  };
}

async function captureActionFromOutcome(
  outcome: CaptureOutcome,
  deps: UiHandlerDeps,
): Promise<ConversationMemoryActionWire | null> {
  switch (outcome.kind) {
    case "candidate":
      return candidateActionFromOutcome(outcome, deps);
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
    ...memoryCapturePolicyForDeps(deps, {
      resolver: createMemoryTargetResolver(deps.memoryVault),
    }),
  });
  const actions: ConversationMemoryActionWire[] = [];
  for (const outcome of outcomes) {
    const action = await captureActionFromOutcome(outcome, deps);
    if (action !== null) actions.push(action);
  }
  return actions;
}

function logSalienceCaptureFailure(surface: string, error: unknown, deps: UiHandlerDeps): void {
  const raw = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`${surface} salience capture failed`, redact(raw, currentRedactionSecrets(deps)));
}

function logSalienceCaptureDropped(surface: string): void {
  // eslint-disable-next-line no-console
  console.error(
    `${surface} salience capture skipped: background queue full (${String(
      pendingSalienceCaptures,
    )}/${String(MAX_PENDING_SALIENCE_CAPTURES)})`,
  );
}

function scheduleMemorySalienceCapture(
  deps: UiHandlerDeps,
  request: { readonly content: string; readonly memory: { readonly enabled: boolean } | undefined },
  context: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
  assistantText: string,
  surface: string,
): void {
  if (context === undefined || request.memory?.enabled !== true || deps.memoryVault === undefined) {
    return;
  }
  if (pendingSalienceCaptures >= MAX_PENDING_SALIENCE_CAPTURES) {
    logSalienceCaptureDropped(surface);
    return;
  }
  pendingSalienceCaptures += 1;
  setImmediate(() => {
    void captureSalientFromTurn(deps, request, context, modelId, assistantText)
      .catch((error: unknown) => {
        logSalienceCaptureFailure(surface, error, deps);
      })
      .finally(() => {
        pendingSalienceCaptures -= 1;
      });
  });
}

// Returns deterministic local/regex captures immediately and schedules model-assisted salience
// off the response path. Regex runs before scheduling so its inserts are present when the
// background salience extractor later performs dedup.
export async function collectMemoryActions(
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
  scheduleMemorySalienceCapture(deps, request, memoryContext, modelId, assistantText, "desktop");
  return regexActions;
}

// On the first turn of a freshly-created chat (still bearing the default title), adopt the user's
// message prefix as the title; otherwise just pin the selected model.
export function buildChatPatch(
  chat: Chat,
  request: SendDesktopChatRequest,
  modelId: string,
): { selectedModel: string; title?: string } {
  return chat.title === DEFAULT_CHAT_TITLE
    ? { selectedModel: modelId, title: request.content.slice(0, 60) }
    : { selectedModel: modelId };
}

// #152 — assembles the exact gateway prompt for the latest user turn (history + document context +
// memory text). Shared by the buffered (persistModelChatTurn) and streaming
// (handleSendDesktopChatStream) paths so both send a byte-identical prompt. `memoryText` is
// `memory.context.text`.
// ADR-0057 D3: the full compaction outcome for the latest turn, including the optional
// ContextCompactionRecord that buildGatewayMessages drops. Both send paths call this to capture the
// record for best-effort regulated evidence; buildGatewayMessages delegates here for the messages.
// Reads store.listMessages once — identical history slice the prompt is built from.
export function deriveCompactionOutcome(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  modelId: string | undefined,
): ConversationCompactionOutcome {
  const contextProfile = currentContextProfileForModel(deps, modelId);
  return conversationForGatewayWithCompaction(deps.store.listMessages(request.chatId), {
    contextProfile: contextProfile ?? DEFAULT_CONTEXT_PROFILE,
    redactionSecrets: currentRedactionSecrets(deps),
  });
}

export function buildGatewayAssembly(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memory: ConversationMemoryResultWire,
  modelId: string | undefined,
): GatewayPromptAssembly {
  const history = deps.store.listMessages(request.chatId);
  const historyPrefix = history.slice(0, Math.max(0, history.length - 1));
  const selected = selectGatewayPromptAssembly({
    historyPrefix,
    historyTurnCount: usableGatewayMessages(historyPrefix).length,
    request: {
      content: request.content,
      discussionMode: request.discussionMode,
    },
    profile: currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE,
    memoryEntries: memory.context.memories,
    compactionContextText: buildChatCompactionContextText(deps.evidenceStore, request.chatId),
    documentContext: request.documentContext,
    redactionSecrets: currentRedactionSecrets(deps),
  });
  if (selected === undefined) {
    throw new ContextOverflowError(
      "conversation prompt exceeds the effective input budget and cannot be assembled without overflow.",
    );
  }
  return selected;
}

export function buildGatewayMessages(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memory: ConversationMemoryResultWire,
  modelId: string | undefined,
): GatewayConversationMessage[] {
  return buildGatewayAssembly(deps, request, memory, modelId).messages;
}

export interface ChatCompactionTurn {
  readonly compaction: ConversationCompactionOutcome["compaction"];
  readonly request: SendDesktopChatRequest;
  readonly modelId: string;
  readonly messageCount: number;
  readonly startedAt: number;
}

// ADR-0057 D3: best-effort persist of the turn's compaction record AFTER the response completes.
// finishedAt is captured here (post-turn). Shared by the buffered and streaming send paths so the
// runId + timing are identical. Never throws into the send path (persistChatCompactionEvidence is
// fully guarded and a no-op on the fast path).
export function recordChatCompaction(deps: UiHandlerDeps, turn: ChatCompactionTurn): void {
  persistChatCompactionEvidence(deps, {
    compaction: turn.compaction,
    chatId: turn.request.chatId,
    modelId: turn.modelId,
    messageCount: turn.messageCount,
    startedAt: turn.startedAt,
    finishedAt: Date.now(),
  });
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
  // ADR-0057 D3: pin the pre-user-message count BEFORE createUserMessage stores the turn, so the
  // compaction-evidence runId is collision-free and matches the streaming path's lifecycle moment.
  const messageCountBeforeTurn = deps.store.listMessages(request.chatId).length;
  const startedAt = Date.now();
  try {
    const memory =
      memoryContext === undefined
        ? emptyMemoryResult(false)
        : await buildMemoryResult(request, deps, memoryContext);
    const userMessage = createUserMessage(deps, request);
    const assembly = buildGatewayAssembly(deps, request, memory, modelId);
    const messages = assembly.messages;
    const response = await model.call(
      { modelId, messages, stream: false },
      new AbortController().signal,
    );
    recordChatCompaction(deps, {
      compaction: assembly.compaction,
      request,
      modelId,
      messageCount: messageCountBeforeTurn,
      startedAt,
    });
    return await finalizeBufferedTurn(deps, { request, chat, modelId, memoryContext }, memory, {
      userMessage,
      response,
    });
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
}

// Post-response assembly for the buffered send: redacts the model content, persists the assistant
// message, collects memory actions, and builds the 200 body. Extracted to keep persistModelChatTurn
// within the function-length budget after the ADR-0057 D3 compaction wiring.
async function finalizeBufferedTurn(
  deps: UiHandlerDeps,
  turn: {
    request: SendDesktopChatRequest;
    chat: Chat;
    modelId: string;
    memoryContext: ConversationMemoryRuntimeContext | undefined;
  },
  memory: ConversationMemoryResultWire,
  result: { userMessage: ChatMessage; response: NormalizedResponse },
): Promise<RouteResult> {
  const { request, chat, modelId, memoryContext } = turn;
  // Issue #631 — redact the model's raw content before persisting and before returning it to the
  // browser, mirroring the grounded-QA path which already applies deps.redactor here.
  const redactedContent = deps.redactor(result.response.content) as string;
  const assistantMessage = createAssistantMessage(deps, request, redactedContent, modelId);
  recordConversationMemoryUse(deps, memory, redactedContent);
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
      messages: [result.userMessage, assistantMessage],
      usage: result.response.usage,
      memory: { ...memory, actions: memoryActions },
    },
  };
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

// #152 — the front-matter shared by the buffered and streaming send paths: parse → normalize path →
// find chat → resolve+validate model → #149 modality guardrail → resolve memory context. Returns a
// RouteResult on ANY failure (the streaming path RETURNS it as a JSON error BEFORE any SSE header, so
// the client can fall back to the buffered route). On success it returns the validated send context.
// Behaviour-preserving extraction from handleSendDesktopChat — the ordering of every guardrail is
// unchanged, so the buffered path's tests stay byte-identical.
export interface PreparedDesktopChatSend {
  readonly request: SendDesktopChatRequest;
  readonly chat: Chat;
  readonly modelId: string;
  readonly memoryContext: ConversationMemoryRuntimeContext | undefined;
}

export async function prepareDesktopChatSend(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<PreparedDesktopChatSend | RouteResult> {
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
  return { request, chat, modelId, memoryContext };
}

export async function handleSendDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const prepared = await prepareDesktopChatSend(ctx, deps);
  if (isRouteResult(prepared)) return prepared;
  const { request, chat, modelId, memoryContext } = prepared;
  return persistModelChatTurn(deps, request, chat, modelId, memoryContext);
}

type VoiceTurnMessageRole = "user" | "assistant";

interface VoiceTurnAppendMessage {
  readonly role: VoiceTurnMessageRole;
  readonly content: string;
  readonly timestamp?: number | undefined;
}

export interface VoiceTurnAppendRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly messages: readonly VoiceTurnAppendMessage[];
  readonly modelId: string | undefined;
  readonly memory: ParsedConversationMemoryRequest | undefined;
}

const MAX_VOICE_TURN_MESSAGES = 8;

function parseVoiceTurnAppendMessage(value: unknown): VoiceTurnAppendMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (content.length === 0 || content.length > MAX_CHAT_INPUT_CHARS) return undefined;
  const timestamp = value.timestamp;
  if (timestamp !== undefined) {
    if (!Number.isInteger(timestamp) || (timestamp as number) < 0) return undefined;
    return { role, content, timestamp: timestamp as number };
  }
  return { role, content };
}

function parseOptionalVoiceTurnModelId(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): string | RouteResult | undefined {
  if (body.modelId === undefined) return undefined;
  if (typeof body.modelId !== "string" || body.modelId.trim().length === 0) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
    };
  }
  const modelId = body.modelId.trim();
  const capability = chatCapability(deps, modelId);
  if (capability?.kind !== "chat") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
    };
  }
  return modelId;
}

function parseVoiceTurnAppendMessages(
  value: unknown,
): readonly VoiceTurnAppendMessage[] | RouteResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "messages must be a non-empty array.") };
  }
  if (value.length > MAX_VOICE_TURN_MESSAGES) {
    return { status: 400, body: errorBody("BAD_REQUEST", "messages contains too many entries.") };
  }
  const messages = value.map(parseVoiceTurnAppendMessage);
  if (messages.some((message) => message === undefined)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "messages must contain committed user or assistant text."),
    };
  }
  return messages as readonly VoiceTurnAppendMessage[];
}

function voiceTurnAppendRequestFromBody(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): VoiceTurnAppendRequest | RouteResult {
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  if (chatId.length === 0 || projectPath.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "chatId and projectPath are required.") };
  }
  const messages = parseVoiceTurnAppendMessages(body.messages);
  if (isRouteResult(messages)) return messages;
  const modelId = parseOptionalVoiceTurnModelId(body, deps);
  if (isRouteResult(modelId)) return modelId;
  const memory = parseMemoryRequest(body.memory);
  if (isRouteResult(memory)) return memory;
  return {
    chatId,
    projectPath,
    messages,
    modelId,
    memory,
  };
}

function sanitizeVoiceTurnText(text: string, deps: UiHandlerDeps): string {
  return deps.redactor(stripUnsafeFormatChars(text)) as string;
}

function voiceTurnCombinedText(messages: readonly VoiceTurnAppendMessage[]): string {
  return messages
    .map((message) => message.content)
    .join("\n")
    .trim();
}

function voiceTurnAsSendRequest(
  request: VoiceTurnAppendRequest,
  content: string,
): SendDesktopChatRequest {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    content,
    modelId: request.modelId,
    documentContext: [],
    attachments: [],
    memory: request.memory,
    discussionMode: undefined,
  };
}

async function collectVoiceTurnLocalMemoryActions(
  deps: UiHandlerDeps,
  request: VoiceTurnAppendRequest,
  context: ConversationMemoryRuntimeContext | undefined,
): Promise<readonly ConversationMemoryActionWire[]> {
  if (context === undefined || request.memory?.enabled !== true) {
    return [];
  }
  if (deps.memoryVault === undefined) {
    return [];
  }
  const actions: ConversationMemoryActionWire[] = [];
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    const outcomes = extractCandidatesFromUserText(message.content, buildCaptureContext(context), {
      ...memoryCapturePolicyForDeps(deps, {
        resolver: createMemoryTargetResolver(deps.memoryVault),
      }),
    });
    for (const outcome of outcomes) {
      const action = await captureActionFromOutcome(outcome, deps);
      if (action !== null) actions.push(action);
    }
  }
  return actions;
}

interface VoiceTurnSaliencePair {
  readonly userText: string;
  readonly assistantText: string;
}

function pushVoiceTurnSaliencePair(
  pairs: VoiceTurnSaliencePair[],
  userParts: readonly string[],
  assistantParts: readonly string[],
): void {
  const userText = userParts.join("\n").trim();
  if (userText.length === 0) return;
  pairs.push({
    userText,
    assistantText: assistantParts.join("\n").trim(),
  });
}

function voiceTurnSaliencePairs(request: VoiceTurnAppendRequest): readonly VoiceTurnSaliencePair[] {
  const pairs: VoiceTurnSaliencePair[] = [];
  let userParts: string[] = [];
  let assistantParts: string[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      pushVoiceTurnSaliencePair(pairs, userParts, assistantParts);
      userParts = [message.content];
      assistantParts = [];
    } else if (userParts.length > 0) {
      assistantParts.push(message.content);
    }
  }
  pushVoiceTurnSaliencePair(pairs, userParts, assistantParts);
  return pairs;
}

function scheduleVoiceTurnSalienceCapture(
  deps: UiHandlerDeps,
  request: VoiceTurnAppendRequest,
  context: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
): void {
  if (context === undefined || request.memory?.enabled !== true || deps.memoryVault === undefined) {
    return;
  }
  for (const pair of voiceTurnSaliencePairs(request)) {
    scheduleMemorySalienceCapture(
      deps,
      {
        content: pair.userText,
        memory: request.memory,
      },
      context,
      modelId,
      pair.assistantText,
      "voice",
    );
  }
}

export async function buildVoiceTurnMemoryResult(
  deps: UiHandlerDeps,
  request: VoiceTurnAppendRequest,
  chat: Chat,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
): Promise<ConversationMemoryResultWire | undefined> {
  if (request.memory === undefined) {
    return undefined;
  }
  if (memoryContext === undefined) {
    return emptyMemoryResult(false);
  }
  const content = voiceTurnCombinedText(request.messages);
  const memory = await buildMemoryResult(
    voiceTurnAsSendRequest(request, content),
    deps,
    memoryContext,
  );
  const actions = await collectVoiceTurnLocalMemoryActions(deps, request, memoryContext);
  scheduleVoiceTurnSalienceCapture(
    deps,
    request,
    memoryContext,
    request.modelId ?? chat.selectedModel,
  );
  return { ...memory, actions };
}

function persistVoiceTurnMessages(
  deps: UiHandlerDeps,
  request: VoiceTurnAppendRequest,
): readonly ChatMessage[] {
  const baseNow = Date.now();
  return deps.store.createMessages(
    request.messages.map((message, index) => ({
      chatId: request.chatId,
      role: message.role,
      content: sanitizeVoiceTurnText(message.content, deps),
      timestamp: message.timestamp ?? baseNow + index,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    })),
  );
}

function updateChatAfterVoiceTurn(
  deps: UiHandlerDeps,
  request: VoiceTurnAppendRequest,
  chat: Chat,
  created: readonly ChatMessage[],
): Chat {
  const firstUser = created.find((message) => message.role === "user");
  const chatPatch =
    chat.title === DEFAULT_CHAT_TITLE && firstUser !== undefined
      ? { title: firstUser.content.slice(0, 60) }
      : {};
  return deps.store.updateChat(request.chatId, chatPatch);
}

export async function handleAppendDesktopVoiceTurn(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  const request = voiceTurnAppendRequestFromBody(body, deps);
  if (isRouteResult(request)) return request;
  const normalizedProjectPath = normalizeDesktopProjectPath(request.projectPath, deps);
  if (isRouteResult(normalizedProjectPath)) return normalizedProjectPath;
  const chat = findChat(deps, normalizedProjectPath, request.chatId);
  if (chat === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  const memoryContext =
    request.memory === undefined
      ? undefined
      : resolveConversationMemoryContext(deps, normalizedProjectPath, request.chatId);
  if (isRouteResult(memoryContext)) return memoryContext;
  try {
    const created = persistVoiceTurnMessages(deps, request);
    
    if (request.groundedAnswer !== undefined) {
      const assistant = created.find((m) => m.role === "assistant");
      if (assistant !== undefined) {
        deps.store.attachGroundedAnswer(assistant.id, request.groundedAnswer);
      }
    }

    const updatedChat = updateChatAfterVoiceTurn(deps, request, chat, created);
    const memory = await buildVoiceTurnMemoryResult(deps, request, updatedChat, memoryContext);
    return {
      status: 200,
      body: {
        chat: updatedChat,
        messages: created,
        ...(memory === undefined ? {} : { memory }),
      },
    };
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
}
