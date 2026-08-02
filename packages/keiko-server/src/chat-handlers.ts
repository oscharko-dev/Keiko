// Desktop chat BFF routes for the Keiko canvas UI. These routes intentionally keep the model call
// behind the existing ModelPort/Gateway boundary: the browser sends only chat content and a registry
// model id, while provider endpoints and keys remain resolved from the local gateway config/.env.

import type { IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
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
  isCodingWorkbenchMode,
  DEFAULT_CONTEXT_PROFILE,
  type ConversationDocumentContextWire,
  type CodingWorkbenchMode,
  type DiscussionMode,
  type ChatMessageContentPart,
} from "@oscharko-dev/keiko-contracts";
import {
  MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS,
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  MAX_DESKTOP_CHAT_INPUT_CHARS,
  isConversationMemoryCaptureSurfaceWire,
  isGroundingScopeIdentity,
  type ConversationMemoryCaptureSurfaceWire,
  type ConversationMemoryActionWire,
  type ConversationMemoryRequestWire,
  type ConversationMemoryResultWire,
  type DesktopChatSendRequestWire,
  type DesktopChatSendResponse,
  CONVERSATION_IMAGE_DELIVERY_INTENT,
  classifyAttachmentMime,
  normalizeAttachmentMime,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";
import { retrieveMemoryContext } from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  isMaintenanceDue,
  maybeRunAutoMaintenance,
  memoryMaintenanceAuditSink,
  memorySemanticizationMultipliers,
  resolveMaintenanceAutonomyMode,
  resolveMemoryRetentionPolicy,
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
  type ChatTurnInspection,
  type Project,
} from "./store/index.js";
import {
  validateConversationPayload,
  validateConversationPayloadSafety,
  type ConversationAttachment,
} from "./conversation-validation.js";
import { validateProjectPath } from "./store/validation.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";
import { redact } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "./deps.js";
import {
  currentAuditRedactString,
  currentContextProfileForModel,
  currentGatewayConfig,
  currentRedactionSecrets,
} from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { createMemoryTargetResolver } from "./memory-target-resolver.js";
import {
  FORGOTTEN_MEMORY_SUPPRESSION_REASON,
  isPersistableMemoryCandidate,
  memoryCaptureAutoAcceptEligible,
  memoryCapturePolicyForDeps,
  promoteEligibleMemoryRecord,
  resolveMemoryCaptureAutonomyMode,
  SENSITIVE_MEMORY_ACTION_BODY,
  SENSITIVE_MEMORY_REJECTION_REASON,
} from "./memory-capture-policy.js";
import { isSuppressedByForgetTombstone } from "./memory-suppression.js";
import { vaultAsQueryPort } from "./memory-conv-handlers.js";
import {
  conversationMemoryScopes,
  resolveConversationMemoryContext,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { embedAndStoreMemory } from "./memory-embedding.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { recordAutoAcceptedMemoryCaptureDecision } from "./memory-capture-audit.js";
import { scheduleMemorySalienceCapture } from "./memory-salience.js";
import { contentFreeErrorClass, emitServerDiagnostic } from "./diagnostics-log.js";
import {
  assertUsableAssistantContent,
  isLegacyEmptyAssistantPlaceholder,
} from "./assistant-response.js";
import type { ConversationCompactionOutcome } from "./conversation-compaction.js";
import {
  persistChatCompactionEvidence,
  type ChatCompactionEvidenceInput,
} from "./chat-compaction-evidence.js";
import { enrichChatCompactionWithModelSummary } from "./chat-compaction-model-summary.js";
import { CHAT_TURN_WAIT_CANCELLED, runSerializedChatTurn } from "./chat-turn-serializer.js";
import {
  canonicalChatTurnGroundingScopeIdentity,
  canonicalChatTurnIdentityContent,
  canonicalChatTurnMemorySemantics,
} from "./chat-turn-identity.js";
import { createRequestCancellation } from "./request-cancellation.js";
import {
  readBoundedRequestBody,
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
} from "./bounded-request-body.js";
import { userFacingProjects } from "./workspace-root-membership.js";
import {
  buildChatCompactionContextText,
  selectGatewayPromptAssembly,
  type GatewayPromptAssembly,
} from "./chat-prompt-budget.js";
import { MAX_CONTEXT_MESSAGES, usableGatewayMessages } from "./conversation-gateway.js";
import type { GatewayConversationMessage } from "./conversation-gateway.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { ConversationAttachmentStoreError } from "./conversation-attachment-store.js";
export {
  MAX_CONTEXT_MESSAGES,
  conversationForGateway,
  usableGatewayMessages,
} from "./conversation-gateway.js";
export type { GatewayConversationMessage } from "./conversation-gateway.js";
export type { GatewayPromptAssembly } from "./chat-prompt-budget.js";

const DEFAULT_CHAT_MODEL = "example-chat-model";
const CHAT_HISTORY_READ_LIMIT = MAX_CONTEXT_MESSAGES * 2;
const CHAT_SIDEBAR_LIST_LIMIT = 100;
const DEFAULT_CHAT_TITLE = "New chat";
// A canonical turn permits 256 kB of UTF-8 user text. JSON escaping can expand a valid string by
// up to six bytes per code unit, so retain a bounded envelope large enough to admit the contract's
// worst-case encoded content plus request metadata.
const MAX_BODY_BYTES = 2_000_000;
const MAX_PENDING_COMPACTION_SUMMARIES = 4;
let pendingCompactionSummaries = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(
  req: IncomingMessage,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBoundedRequestBody(req, MAX_BODY_BYTES, signal);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof RequestBodyCancelledError) return requestCancelledResult();
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
  const chat = deps.store.findChatById(chatId);
  return chat?.projectPath === projectPath ? chat : undefined;
}

function chatEnvelope(deps: UiHandlerDeps, project: Project, chat: Chat): Record<string, unknown> {
  const projects = userFacingProjects(deps.store.listProjects(), deps.managedTaskWorkspaceRoot).map(
    (item) => ({
      ...item,
      available: isProjectAvailable(item),
    }),
  );
  const chats = deps.store.listChats(project.path, CHAT_SIDEBAR_LIST_LIMIT);
  const messages = deps.store
    .listMessages(chat.id, CHAT_HISTORY_READ_LIMIT)
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

function gatewayErrorStatus(error: GatewayError): number {
  if (error.code === "GATEWAY_AUTHENTICATION") return 401;
  if (error.retryable) return 503;
  return 502;
}

function gatewayErrorResult(error: GatewayError, deps: UiHandlerDeps): RouteResult {
  const status = gatewayErrorStatus(error);
  return { status, body: errorBody(error.code, redactErrorMessage(error.message, deps)) };
}

export function desktopChatErrorResult(error: unknown, deps: UiHandlerDeps): RouteResult {
  if (error instanceof ConversationAttachmentStoreError) {
    return {
      status: 409,
      body: errorBody("INVALID_REQUEST", "Conversation image delivery was refused."),
    };
  }
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

export type SendDesktopChatRequest = Omit<
  DesktopChatSendRequestWire,
  "modelId" | "memory" | "documentContext" | "attachments" | "discussionMode"
> & {
  readonly modelId: DesktopChatSendRequestWire["modelId"];
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
  readonly discussionMode: DesktopChatSendRequestWire["discussionMode"];
  readonly attachmentAuthority?:
    | {
        readonly sessionId: string;
        readonly sessionRotationCount: number;
        readonly revalidate: () => boolean;
      }
    | undefined;
};

interface RegenerateDesktopChatRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly assistantMessageId: string;
  readonly modelId: string | undefined;
  readonly memory: ParsedConversationMemoryRequest | undefined;
}

export type ParsedConversationMemoryRequest = Omit<
  ConversationMemoryRequestWire,
  "enabled" | "context"
> & {
  readonly enabled: boolean;
  readonly context: Record<string, unknown>;
};

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

function parseMemoryMode(
  raw: Record<string, unknown>,
): ConversationMemoryRequestWire["mode"] | RouteResult {
  if (raw.mode === undefined) return undefined;
  return isCodingWorkbenchMode(raw.mode)
    ? raw.mode
    : { status: 400, body: errorBody("BAD_REQUEST", "memory.mode must be a valid autonomy mode.") };
}

// The originating product surface for this turn's capture (Issue #2550). Absent keeps the historical
// desktop attribution, so an un-migrated caller is byte-identical; an unrecognised value fails closed
// with 400 rather than silently degrading to desktop, matching parseMemoryMode.
function parseMemorySurface(
  raw: Record<string, unknown>,
): ConversationMemoryRequestWire["surface"] | RouteResult {
  if (raw.surface === undefined) return undefined;
  return isConversationMemoryCaptureSurfaceWire(raw.surface)
    ? raw.surface
    : {
        status: 400,
        body: errorBody("BAD_REQUEST", "memory.surface must be a valid capture surface."),
      };
}

type OptionalMemoryRequestFields = Omit<ParsedConversationMemoryRequest, "enabled" | "context">;

// The additive scalars, each absent-preserving so an un-migrated caller keeps the exact legacy shape.
function parseOptionalMemoryFields(
  raw: Record<string, unknown>,
): OptionalMemoryRequestFields | RouteResult {
  const budgetTokens = parseMemoryBudget(raw);
  if (isRouteResult(budgetTokens)) return budgetTokens;
  const mode = parseMemoryMode(raw);
  if (isRouteResult(mode)) return mode;
  const surface = parseMemorySurface(raw);
  if (isRouteResult(surface)) return surface;
  return {
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(surface !== undefined ? { surface } : {}),
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
  const optional = parseOptionalMemoryFields(value);
  if (isRouteResult(optional)) return optional;
  return { enabled, ...optional, context };
}

const MAX_ATTACHMENT_ENTRIES = 16;
const CONTENT_FREE_ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function attachmentKind(value: unknown): ConversationAttachment["kind"] | undefined {
  return value === "image" || value === "document" ? value : undefined;
}

function validAttachmentSize(value: unknown): value is number {
  return (
    typeof value === "number" && value >= 0 && Number.isFinite(value) && Number.isInteger(value)
  );
}

function contentFreeAttachmentId(value: unknown): string | undefined {
  return typeof value === "string" && CONTENT_FREE_ATTACHMENT_ID.test(value) ? value : undefined;
}

function parseAttachmentEntry(value: unknown): ConversationAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const kind = attachmentKind(value.kind);
  if (kind === undefined) return undefined;
  const mimeType = pickString(value, "mimeType");
  if (mimeType === undefined || mimeType.length === 0) return undefined;
  const sizeBytes = value.sizeBytes;
  if (!validAttachmentSize(sizeBytes)) return undefined;
  const id = contentFreeAttachmentId(value.id);
  const attachmentRef = pickString(value, "attachmentRef");
  const sha256 = pickString(value, "sha256");
  return {
    kind,
    mimeType,
    sizeBytes,
    ...(id === undefined ? {} : { id }),
    ...(attachmentRef === undefined ? {} : { attachmentRef }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
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

export function parseClientTurnId(value: unknown): string | RouteResult | undefined {
  if (value === undefined) return undefined;
  // The value is an opaque idempotency key: inspect a trimmed copy only to reject blanks, while
  // preserving every accepted byte so retries cannot be normalized onto a different identity.
  if (
    typeof value !== "string" ||
    value.length > MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS ||
    value.trim().length === 0
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "clientTurnId must be a bounded non-blank string."),
    };
  }
  return value;
}

export function parseExpectedGroundingScopeIdentity(
  value: unknown,
): string | RouteResult | undefined {
  if (value === undefined) return undefined;
  return isGroundingScopeIdentity(value)
    ? value
    : {
        status: 400,
        body: errorBody(
          "BAD_REQUEST",
          "expectedGroundingScopeIdentity must be a valid server-issued identity.",
        ),
      };
}

// eslint-disable-next-line complexity
function sendRequestFromBody(body: Record<string, unknown>): SendDesktopChatRequest | RouteResult {
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  if (chatId.length === 0 || projectPath.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "chatId and projectPath are required.") };
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (
    content.length === 0 ||
    content.length > MAX_DESKTOP_CHAT_INPUT_CHARS ||
    Buffer.byteLength(content, "utf8") > MAX_DESKTOP_CHAT_INPUT_BYTES
  ) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        `content must be between 1 and ${String(MAX_DESKTOP_CHAT_INPUT_BYTES)} UTF-8 bytes.`,
      ),
    };
  }
  const memory = parseMemoryRequest(body.memory);
  if (isRouteResult(memory)) return memory;
  const clientTurnId = parseClientTurnId(body.clientTurnId);
  if (isRouteResult(clientTurnId)) return clientTurnId;
  const expectedGroundingScopeIdentity = parseExpectedGroundingScopeIdentity(
    body.expectedGroundingScopeIdentity,
  );
  if (isRouteResult(expectedGroundingScopeIdentity)) return expectedGroundingScopeIdentity;
  return {
    chatId,
    projectPath,
    content,
    modelId: typeof body.modelId === "string" && body.modelId.length > 0 ? body.modelId : undefined,
    documentContext: parseDocumentContext(body.documentContext),
    attachments: parseAttachments(body.attachments),
    attachmentIntent:
      body.attachmentIntent === CONVERSATION_IMAGE_DELIVERY_INTENT
        ? CONVERSATION_IMAGE_DELIVERY_INTENT
        : undefined,
    memory,
    discussionMode: parseDiscussionMode(body.discussionMode),
    ...(clientTurnId === undefined ? {} : { clientTurnId }),
    ...(expectedGroundingScopeIdentity === undefined ? {} : { expectedGroundingScopeIdentity }),
  };
}

// Issue #502 — accepts a known DiscussionMode, otherwise drops to `undefined`. An unknown or
// missing value is NOT a request error (the field is optional and turn-local); it simply leaves
// the turn in the default no-mode behaviour.
function parseDiscussionMode(value: unknown): DiscussionMode | undefined {
  return isDiscussionMode(value) ? value : undefined;
}

function regenerateRequestFromBody(
  body: Record<string, unknown>,
): RegenerateDesktopChatRequest | RouteResult {
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const projectPath = typeof body.projectPath === "string" ? body.projectPath : "";
  const assistantMessageId =
    typeof body.assistantMessageId === "string" ? body.assistantMessageId : "";
  if (chatId.length === 0 || projectPath.length === 0 || assistantMessageId.length === 0) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "chatId, projectPath, and assistantMessageId are required."),
    };
  }
  const memory = parseMemoryRequest(body.memory);
  if (isRouteResult(memory)) return memory;
  return {
    chatId,
    projectPath,
    assistantMessageId,
    modelId: typeof body.modelId === "string" && body.modelId.length > 0 ? body.modelId : undefined,
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

export type DesktopChatTurnAdmission =
  | { readonly kind: "admitted"; readonly userMessage: ChatMessage }
  | { readonly kind: "replay"; readonly response: DesktopChatSendResponse }
  | { readonly kind: "rejected"; readonly result: RouteResult };

export type DesktopChatTurnInspection =
  | { readonly kind: "continue" }
  | { readonly kind: "replay"; readonly response: DesktopChatSendResponse }
  | { readonly kind: "rejected"; readonly result: RouteResult };

export { canonicalChatTurnIdentityContent } from "./chat-turn-identity.js";

function desktopChatTurnIdentityContent(
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
): string {
  return canonicalChatTurnIdentityContent({
    routeKind: "plain",
    content: request.content,
    modelId,
    groundingScopeIdentity:
      request.expectedGroundingScopeIdentity ?? canonicalChatTurnGroundingScopeIdentity(chat),
    memory: canonicalChatTurnMemorySemantics(request.memory, memoryContext),
    documentContext: request.documentContext,
    attachments: request.attachments,
    discussionMode: request.discussionMode ?? null,
  });
}

function turnConflictResult(
  code: "CHAT_TURN_IDEMPOTENCY_CONFLICT" | "CHAT_TURN_IN_PROGRESS",
): RouteResult {
  return {
    status: 409,
    body: errorBody(
      code,
      code === "CHAT_TURN_IN_PROGRESS"
        ? "The canonical chat turn is still in progress."
        : "The canonical chat turn identity conflicts with this request.",
    ),
  };
}

export function chatClosedResult(chat: Chat): RouteResult | undefined {
  return chat.status === "closed"
    ? {
        status: 409,
        body: errorBody("CHAT_CLOSED", "The chat is closed and cannot accept new turns."),
      }
    : undefined;
}

function desktopChatReplayResponse(
  deps: UiHandlerDeps,
  chat: Chat,
  turn: Extract<ChatTurnInspection, { readonly kind: "replay" }>,
): DesktopChatSendResponse {
  return {
    chat: deps.store.findChatById(chat.id) ?? chat,
    messages: [turn.userMessage, turn.assistantMessage],
  };
}

export function inspectDesktopChatTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
): DesktopChatTurnInspection {
  const { request, chat, turnIdentityContent } = prepared;
  if (request.clientTurnId === undefined) return { kind: "continue" };
  const inspection = deps.store.inspectChatTurn(
    request.chatId,
    request.clientTurnId,
    turnIdentityContent,
  );
  if (inspection.kind === "missing" || inspection.kind === "retryable") {
    return { kind: "continue" };
  }
  if (inspection.kind === "replay") {
    return { kind: "replay", response: desktopChatReplayResponse(deps, chat, inspection) };
  }
  return {
    kind: "rejected",
    result: turnConflictResult(
      inspection.kind === "in-progress"
        ? "CHAT_TURN_IN_PROGRESS"
        : "CHAT_TURN_IDEMPOTENCY_CONFLICT",
    ),
  };
}

export function admitDesktopChatTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
): DesktopChatTurnAdmission {
  const { request, chat, turnIdentityContent } = prepared;
  if (request.clientTurnId === undefined) {
    return { kind: "admitted", userMessage: createUserMessage(deps, request) };
  }
  const admission = deps.store.admitChatTurn(
    request.clientTurnId,
    {
      chatId: request.chatId,
      role: "user",
      content: request.content,
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    },
    { identityContent: turnIdentityContent },
  );
  if (admission.kind === "admitted") return admission;
  if (admission.kind === "replay") {
    return { kind: "replay", response: desktopChatReplayResponse(deps, chat, admission) };
  }
  return {
    kind: "rejected",
    result: turnConflictResult(
      admission.kind === "in-progress" ? "CHAT_TURN_IN_PROGRESS" : "CHAT_TURN_IDEMPOTENCY_CONFLICT",
    ),
  };
}

export function completeDesktopChatTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
): readonly [ChatMessage, ChatMessage] {
  const { request, turnIdentityContent } = prepared;
  if (request.clientTurnId === undefined) return [userMessage, assistantMessage];
  const completion = deps.store.completeChatTurn(
    request.chatId,
    request.clientTurnId,
    turnIdentityContent,
    assistantMessage.id,
  );
  if (completion.kind === "conflict") {
    throw new UiStoreError("INTERNAL", "Canonical chat turn completion conflicted.", 500);
  }
  return [completion.userMessage, completion.assistantMessage];
}

export function failDesktopChatTurn(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  terminalState: "failed" | "cancelled" = "failed",
): void {
  if (request.clientTurnId !== undefined) {
    deps.store.failChatTurn(request.chatId, request.clientTurnId, terminalState);
  }
}

export function createAssistantMessage(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  content: string,
  modelId: string,
  userMessage: ChatMessage,
): ChatMessage {
  assertUsableAssistantContent(content, modelId);
  return deps.store.createTurnAssistant(userMessage.id, {
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
  recordMemoryAudit(
    {
      evidenceStore: deps.evidenceStore,
      redactString: currentAuditRedactString(deps),
      ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
    },
    event,
  );
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
//
// GOVERNED (ADR-0146 D2): this sweep shares the promotion lever with at-capture promotion, so it is
// handed the SAME effective posture — the operator's persisted memory mode clamped by the
// deployment ceiling. In "Ask for approval" it promotes nothing; an unresolvable posture fails
// closed to exactly that.
function maybeRunChatAutoMaintenance(deps: UiHandlerDeps, vault: MemoryVaultStore): void {
  if (deps.env.KEIKO_MEMORY_AUTO_MAINTAIN === "0") return;
  const nowMs = Date.now();
  if (!isMaintenanceDue(memoryMaintenanceCursor.lastRunAtMs, nowMs)) return;
  const multipliers = memorySemanticizationMultipliers(deps.env);
  const retention = resolveMemoryRetentionPolicy(deps);
  // A malformed retention setting disables only the retention phase. The resolver already emits a
  // diagnostic; promotion, consolidation, supersession, and fade must keep running so one invalid
  // optional setting cannot silently suspend all pre-existing vault maintenance.
  const retentionPolicy = retention.ok ? retention.policy : undefined;
  maybeRunAutoMaintenance(vault, memoryMaintenanceAuditSink(deps), memoryMaintenanceCursor, {
    nowMs,
    enabled: true,
    autonomyMode: resolveMaintenanceAutonomyMode(deps),
    ...(multipliers !== undefined ? { decayHalfLifeMultiplierByType: multipliers } : {}),
    ...(retentionPolicy !== undefined ? { retentionPolicy } : {}),
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

function canonicalCaptureSeed(
  input: ConversationMemoryRuntimeContext,
  clientTurnId: string,
  lane: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "canonical-memory-capture-v1",
        input.userId,
        input.workspaceId,
        input.projectId,
        input.conversationId,
        clientTurnId,
        lane,
      ]),
    )
    .digest("hex");
}

function canonicalCaptureId(seed: string, kind: "memory" | "proposal", ordinal: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([seed, kind, ordinal]))
    .digest("hex");
  return `canonical-${digest}`;
}

function buildCaptureContext(
  input: ConversationMemoryRuntimeContext,
  clientTurnId?: string,
  lane = 0,
): CaptureContext {
  if (clientTurnId === undefined) {
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
  const seed = canonicalCaptureSeed(input, clientTurnId, lane);
  let memoryOrdinal = 0;
  let proposalOrdinal = 0;
  return {
    userId: input.userId,
    nowMs: Date.now(),
    newMemoryId: () => canonicalCaptureId(seed, "memory", memoryOrdinal++) as MemoryId,
    newProposalId: () =>
      canonicalCaptureId(seed, "proposal", proposalOrdinal++) as MemoryProposalId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  };
}

function memoryCaptureProjection(record: MemoryRecord): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    type: record.type,
    body: record.body,
    payload: record.payload ?? null,
    provenance: { ...record.provenance, capturedAt: 0 },
    validity: { ...record.validity, validFrom: 0 },
    pinned: record.pinned,
    staleReason: record.staleReason ?? null,
    retentionHint: record.retentionHint ?? null,
    tags: record.tags,
  });
}

function insertOrReuseCanonicalMemory(
  vault: MemoryVaultStore,
  record: MemoryRecord,
): { readonly memory: MemoryRecord; readonly inserted: boolean } {
  const existing = vault.getMemory(record.id);
  if (existing === undefined) return { memory: vault.insertMemory(record), inserted: true };
  if (memoryCaptureProjection(existing) !== memoryCaptureProjection(record)) {
    throw new Error("Canonical memory capture conflicted.");
  }
  return { memory: existing, inserted: false };
}

function persistCapturedMemory(
  vault: MemoryVaultStore,
  candidate: MemoryRecord,
  canonicalCapture: boolean,
): { readonly memory: MemoryRecord; readonly inserted: boolean } {
  if (canonicalCapture) return insertOrReuseCanonicalMemory(vault, candidate);
  return { memory: vault.insertMemory(candidate), inserted: true };
}

function capturedMemoryBody(
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
  memory: MemoryRecord,
): string {
  if (outcome.requiresApproval || memory.provenance.sensitivity !== "public") {
    return SENSITIVE_MEMORY_ACTION_BODY;
  }
  return memory.body;
}

function captureCandidateForMode(
  record: MemoryRecord,
  mode: CodingWorkbenchMode,
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
): MemoryRecord {
  return memoryCaptureAutoAcceptEligible(mode, outcome)
    ? promoteEligibleMemoryRecord(record)
    : record;
}

async function candidateActionFromOutcome(
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  surface: ConversationMemoryCaptureSurfaceWire,
  canonicalCapture: boolean,
): Promise<ConversationMemoryActionWire | null> {
  if (deps.memoryVault === undefined) return null;
  if (!isPersistableMemoryCandidate(outcome)) {
    return { kind: "rejected", reason: SENSITIVE_MEMORY_REJECTION_REASON };
  }
  const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
  const record = buildMemoryRecordFromProposal(proposalId, outcome);
  if (record === null) return null;
  if (isSuppressedByForgetTombstone(deps.memoryVault, record)) {
    return { kind: "rejected", reason: FORGOTTEN_MEMORY_SUPPRESSION_REASON };
  }
  const candidate = captureCandidateForMode(record, mode, outcome);
  const persisted = persistCapturedMemory(deps.memoryVault, candidate, canonicalCapture);
  const inserted = persisted.memory;
  if (persisted.inserted && inserted.status === "accepted") {
    recordAutoAcceptedMemoryCaptureDecision(deps, mode, surface, inserted);
  }
  // Best-effort embed-on-capture (#204): swallowed on failure / no model — never breaks capture.
  if (persisted.inserted) {
    await embedAndStoreMemory(deps, deps.memoryVault, inserted.id, inserted.body);
  }
  return {
    kind: "candidate",
    proposalId: String(inserted.id),
    body: capturedMemoryBody(outcome, inserted),
    scopeLabel: scopeLabel(inserted.scope),
    requiresApproval: inserted.status === "accepted" ? false : outcome.requiresApproval,
    status: inserted.status === "accepted" ? "accepted" : "proposed",
  };
}

async function captureActionFromOutcome(
  outcome: CaptureOutcome,
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  surface: ConversationMemoryCaptureSurfaceWire,
  canonicalCapture = false,
): Promise<ConversationMemoryActionWire | null> {
  switch (outcome.kind) {
    case "candidate":
      return candidateActionFromOutcome(outcome, deps, mode, surface, canonicalCapture);
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
  const outcomes = extractCandidatesFromUserText(
    request.content,
    buildCaptureContext(context, request.clientTurnId),
    {
      ...memoryCapturePolicyForDeps(deps, {
        resolver: createMemoryTargetResolver(deps.memoryVault),
      }),
    },
  );
  const actions: ConversationMemoryActionWire[] = [];
  const mode = resolveMemoryCaptureAutonomyMode(deps, request.memory.mode);
  const surface = request.memory.surface ?? "desktop";
  for (const outcome of outcomes) {
    const action = await captureActionFromOutcome(
      outcome,
      deps,
      mode,
      surface,
      request.clientTurnId !== undefined,
    );
    if (action !== null) actions.push(action);
  }
  return actions;
}

export async function collectMemoryActions(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
): Promise<readonly ConversationMemoryActionWire[]> {
  if (memoryContext === undefined) {
    return [];
  }
  return captureMemoryActions(request, deps, memoryContext);
}

function recordPostCommitMemoryFailure(
  deps: UiHandlerDeps,
  correlationId: string,
  operation: string,
  error: unknown,
): void {
  emitServerDiagnostic(deps.diagnostics, {
    correlationId,
    timestamp: new Date(Date.now()).toISOString(),
    operation,
    source: "chat.memory.post-commit",
    errorClass: contentFreeErrorClass(error),
    message: "chat-memory-post-commit-side-effect-failed",
  });
}

function runPostCommitMemoryEffect(
  deps: UiHandlerDeps,
  correlationId: string,
  operation: string,
  effect: () => void,
): void {
  try {
    effect();
  } catch (error) {
    recordPostCommitMemoryFailure(deps, correlationId, operation, error);
  }
}

export function runPostCommitConversationMemorySideEffects(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  context: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
  memory: ConversationMemoryResultWire,
  assistantText: string,
  correlationId: string,
): void {
  runPostCommitMemoryEffect(deps, correlationId, "chat.memory.reinforcement", () => {
    recordConversationMemoryUse(deps, memory, assistantText);
  });
  if (context === undefined) return;
  runPostCommitMemoryEffect(deps, correlationId, "chat.memory.salience", () => {
    scheduleMemorySalienceCapture(
      deps,
      request,
      context,
      modelId,
      assistantText,
      request.memory?.surface ?? "desktop",
      correlationId,
    );
  });
}

// On the first turn of a freshly-created chat (still bearing the default title), adopt the user's
// message prefix as the title; otherwise just pin the selected model.
export function commitChatAfterTurn(
  deps: UiHandlerDeps,
  admittedChat: Chat,
  request: SendDesktopChatRequest,
  modelId: string,
): Chat {
  const current = deps.store.findChatById(request.chatId);
  if (current === undefined) throw new UiStoreError("NOT_FOUND", "Chat not found.", 404);
  const title =
    admittedChat.title === DEFAULT_CHAT_TITLE && current.title === DEFAULT_CHAT_TITLE
      ? request.content.slice(0, 60)
      : undefined;
  const selectedModel =
    current.selectedModel === admittedChat.selectedModel && current.selectedModel !== modelId
      ? modelId
      : undefined;
  if (title === undefined && selectedModel === undefined) return current;
  return deps.store.updateChat(request.chatId, {
    ...(title === undefined ? {} : { title }),
    ...(selectedModel === undefined ? {} : { selectedModel }),
  });
}

// #152 — assemble the exact gateway prompt from the history snapshot captured synchronously after
// admission. Both buffered and streaming callers exclude the admitted user by stable message id and
// append the request exactly once, so concurrent non-turn writers cannot mutate the in-flight prompt.
export interface GatewayTurnSnapshot {
  readonly history: readonly ChatMessage[];
  readonly currentUserMessageId: string;
}

export function gatewayHistoryPrefix(snapshot: GatewayTurnSnapshot): readonly ChatMessage[] {
  return snapshot.history.filter(
    (message): boolean => message.id !== snapshot.currentUserMessageId,
  );
}

export function captureGatewayTurnSnapshot(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  userMessage: ChatMessage,
): GatewayTurnSnapshot {
  return {
    history: deps.store.listGatewayMessages(
      request.chatId,
      userMessage.id,
      CHAT_HISTORY_READ_LIMIT,
    ),
    currentUserMessageId: userMessage.id,
  };
}

export function buildGatewayAssembly(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memory: ConversationMemoryResultWire,
  modelId: string | undefined,
  snapshot: GatewayTurnSnapshot,
): GatewayPromptAssembly {
  const currentUserIndex = snapshot.history.findIndex(
    (message) => message.id === snapshot.currentUserMessageId,
  );
  if (currentUserIndex < 0) {
    throw new UiStoreError("INTERNAL", "Admitted chat turn is missing from its history.", 500);
  }
  const historyPrefix = gatewayHistoryPrefix(snapshot);
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

export interface ChatCompactionTurn {
  readonly compaction: ConversationCompactionOutcome["compaction"];
  readonly request: SendDesktopChatRequest;
  readonly modelId: string;
  readonly messageCount: number;
  readonly startedAt: number;
  readonly historyPrefix: readonly ChatMessage[];
}

// ADR-0057 D3: best-effort persist of the turn's compaction record AFTER the response completes.
// finishedAt is captured here (post-turn). Shared by the buffered and streaming send paths so the
// runId + timing are identical. Never throws into the send path (persistChatCompactionEvidence is
// fully guarded and a no-op on the fast path).
export function recordChatCompaction(deps: UiHandlerDeps, turn: ChatCompactionTurn): void {
  const input = {
    compaction: turn.compaction,
    chatId: turn.request.chatId,
    modelId: turn.modelId,
    messageCount: turn.messageCount,
    startedAt: turn.startedAt,
    finishedAt: Date.now(),
  } satisfies ChatCompactionEvidenceInput;
  persistChatCompactionEvidence(deps, input);
  scheduleCompactionModelSummary(deps, input, turn.historyPrefix);
}

function scheduleCompactionModelSummary(
  deps: UiHandlerDeps,
  input: ChatCompactionEvidenceInput,
  historyPrefix: readonly ChatMessage[],
): void {
  if (
    input.compaction === undefined ||
    pendingCompactionSummaries >= MAX_PENDING_COMPACTION_SUMMARIES
  ) {
    return;
  }
  pendingCompactionSummaries += 1;
  const handle = setImmediate(() => {
    void enrichChatCompactionWithModelSummary(deps, { ...input, historyPrefix })
      .catch((error: unknown) => {
        logCompactionSummaryFailure(error);
      })
      .finally(() => {
        pendingCompactionSummaries -= 1;
      });
  });
  handle.unref();
}

function logCompactionSummaryFailure(error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn("chat-compaction-model-summary: scheduled enrichment failed", error);
}

function buildRegenerateGatewayAssembly(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  memory: ConversationMemoryResultWire,
  modelId: string,
  historyBeforeAssistant: readonly ChatMessage[],
): GatewayPromptAssembly {
  let latestUserIndex = -1;
  for (let index = historyBeforeAssistant.length - 1; index >= 0; index -= 1) {
    if (historyBeforeAssistant[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const historyPrefix =
    latestUserIndex < 0 ? historyBeforeAssistant : historyBeforeAssistant.slice(0, latestUserIndex);
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

function latestRegenerableTurn(
  messages: readonly ChatMessage[],
  assistantMessageId: string,
):
  | {
      readonly assistant: ChatMessage;
      readonly user: ChatMessage;
      readonly beforeAssistant: readonly ChatMessage[];
    }
  | RouteResult {
  const targetIndex = messages.findIndex((message) => message.id === assistantMessageId);
  const assistant = messages[targetIndex];
  if (assistant?.role !== "assistant") {
    return { status: 404, body: errorBody("NOT_FOUND", "Assistant message not found.") };
  }
  if (assistant.groundedAnswer !== undefined) return groundedRegenerateResult();
  const conversational = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (conversational.at(-1)?.id !== assistant.id) {
    return {
      status: 409,
      body: errorBody("NOT_APPLIABLE", "Only the latest assistant response can be regenerated."),
    };
  }
  const previousUser = messages
    .slice(0, targetIndex)
    .reverse()
    .find((message) => message.role === "user");
  if (previousUser === undefined) {
    return {
      status: 409,
      body: errorBody("NOT_APPLIABLE", "Assistant response has no user turn to regenerate."),
    };
  }
  return { assistant, user: previousUser, beforeAssistant: messages.slice(0, targetIndex) };
}

function hasGroundingScope(chat: Chat): boolean {
  return (
    chat.connectedScope !== undefined ||
    (chat.connectedScopes?.length ?? 0) > 0 ||
    chat.localKnowledgeScope !== undefined ||
    (chat.localKnowledgeScopes?.length ?? 0) > 0
  );
}

function groundedRegenerateResult(): RouteResult {
  return {
    status: 409,
    body: errorBody("NOT_APPLIABLE", "Grounded answers cannot be regenerated from plain chat."),
  };
}

function regenerateMemoryRequest(
  request: RegenerateDesktopChatRequest,
  turn: { readonly user: ChatMessage },
): SendDesktopChatRequest {
  return {
    chatId: request.chatId,
    projectPath: request.projectPath,
    content: turn.user.content,
    modelId: request.modelId,
    documentContext: [],
    attachments: [],
    memory: request.memory,
    discussionMode: undefined,
  };
}

function requestSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

type BufferedModelPort = NonNullable<ReturnType<UiHandlerDeps["modelPortFactory"]>>;

interface BufferedModelPreflight {
  readonly legacyModel: BufferedModelPort | undefined;
}

function preflightBufferedModelTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
): BufferedModelPreflight | RouteResult {
  const { request, chat, modelId } = prepared;
  if (request.clientTurnId !== undefined) return { legacyModel: undefined };
  const invalidExecution = validateDesktopChatExecution(request, chat, modelId, deps);
  if (invalidExecution !== undefined) return invalidExecution;
  const legacyModel = deps.modelPortFactory(modelId);
  return legacyModel === undefined
    ? { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") }
    : { legacyModel };
}

function admitBufferedModelTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
):
  | {
      readonly userMessage: ChatMessage;
      readonly model: BufferedModelPort;
    }
  | RouteResult {
  const { request, chat, modelId } = prepared;
  const preflight = preflightBufferedModelTurn(deps, prepared);
  if (isRouteResult(preflight)) return preflight;
  const admission = admitDesktopChatTurn(deps, prepared);
  if (admission.kind === "replay") return { status: 200, body: admission.response };
  if (admission.kind === "rejected") return admission.result;
  const invalidExecution =
    request.clientTurnId === undefined
      ? undefined
      : validateDesktopChatExecution(request, chat, modelId, deps);
  if (invalidExecution !== undefined) {
    failDesktopChatTurn(deps, request);
    return invalidExecution;
  }
  const model = preflight.legacyModel ?? deps.modelPortFactory(modelId);
  if (model !== undefined) return { userMessage: admission.userMessage, model };
  failDesktopChatTurn(deps, request);
  return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
}

async function persistModelChatTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  abortSignal: AbortSignal,
): Promise<RouteResult> {
  const { request } = prepared;
  // ADR-0057 D3: pin the pre-user-message count BEFORE createUserMessage stores the turn, so the
  // compaction-evidence runId is collision-free and matches the streaming path's lifecycle moment.
  const messageCountBeforeTurn = deps.store.countMessages(request.chatId);
  const startedAt = Date.now();
  try {
    return await executeBufferedModelTurn(
      deps,
      prepared,
      abortSignal,
      messageCountBeforeTurn,
      startedAt,
    );
  } catch (error) {
    const cancelled = requestSignalAborted(abortSignal);
    failDesktopChatTurn(deps, request, cancelled ? "cancelled" : "failed");
    return cancelled ? requestCancelledResult() : desktopChatErrorResult(error, deps);
  }
}

async function executeBufferedModelTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  abortSignal: AbortSignal,
  messageCountBeforeTurn: number,
  startedAt: number,
): Promise<RouteResult> {
  const { request, modelId, memoryContext } = prepared;
  const admitted = admitBufferedModelTurn(deps, prepared);
  if (isRouteResult(admitted)) return admitted;
  const { userMessage, model } = admitted;
  const gatewayTurn = captureGatewayTurnSnapshot(deps, request, userMessage);
  const memory =
    memoryContext === undefined
      ? emptyMemoryResult(false)
      : await buildMemoryResult(request, deps, memoryContext);
  if (requestSignalAborted(abortSignal)) {
    failDesktopChatTurn(deps, request, "cancelled");
    return requestCancelledResult();
  }
  const assembly = assemblyWithConversationImages(
    deps,
    request,
    modelId,
    buildGatewayAssembly(deps, request, memory, modelId, gatewayTurn),
  );
  const response = await model.call(
    { modelId, messages: assembly.messages, stream: false },
    abortSignal,
  );
  if (requestSignalAborted(abortSignal)) {
    failDesktopChatTurn(deps, request, "cancelled");
    return requestCancelledResult();
  }
  return finalizeAndRecordBufferedTurn(
    deps,
    prepared,
    memory,
    { userMessage, response },
    abortSignal,
    {
      assembly,
      messageCount: messageCountBeforeTurn,
      startedAt,
      historyPrefix: gatewayHistoryPrefix(gatewayTurn),
    },
  );
}

type BufferedTurnContext = PreparedDesktopChatSend;

interface BufferedCompactionContext {
  readonly assembly: ReturnType<typeof buildGatewayAssembly>;
  readonly messageCount: number;
  readonly startedAt: number;
  readonly historyPrefix: readonly ChatMessage[];
}

async function finalizeAndRecordBufferedTurn(
  deps: UiHandlerDeps,
  turn: BufferedTurnContext,
  memory: ConversationMemoryResultWire,
  result: { userMessage: ChatMessage; response: NormalizedResponse },
  abortSignal: AbortSignal,
  compaction: BufferedCompactionContext,
): Promise<RouteResult> {
  const finalized = await finalizeBufferedTurn(deps, turn, memory, result, abortSignal);
  if (finalized.status === 200) {
    recordChatCompaction(deps, {
      compaction: compaction.assembly.compaction,
      request: turn.request,
      modelId: turn.modelId,
      messageCount: compaction.messageCount,
      startedAt: compaction.startedAt,
      historyPrefix: compaction.historyPrefix,
    });
  }
  return finalized;
}

function commitBufferedTurn(
  deps: UiHandlerDeps,
  turn: BufferedTurnContext,
  memory: ConversationMemoryResultWire,
  result: { readonly userMessage: ChatMessage; readonly response: NormalizedResponse },
  redactedContent: string,
  memoryActions: readonly ConversationMemoryActionWire[],
): RouteResult {
  const { request, chat, modelId, memoryContext } = turn;
  const createdAssistant = createAssistantMessage(
    deps,
    request,
    redactedContent,
    modelId,
    result.userMessage,
  );
  const updatedChat = commitChatAfterTurn(deps, chat, request, modelId);
  const [userMessage, assistantMessage] = completeDesktopChatTurn(
    deps,
    turn,
    result.userMessage,
    createdAssistant,
  );
  runPostCommitConversationMemorySideEffects(
    deps,
    request,
    memoryContext,
    modelId,
    memory,
    redactedContent,
    assistantMessage.id,
  );
  return {
    status: 200,
    body: {
      chat: updatedChat,
      messages: [userMessage, assistantMessage],
      usage: result.response.usage,
      memory: { ...memory, actions: memoryActions },
      ...(conversationImageDeliveries(request).length === 0
        ? {}
        : { attachmentDeliveries: conversationImageDeliveries(request) }),
    } satisfies DesktopChatSendResponse,
  };
}

// Post-response assembly for the buffered send: redacts the model content, persists the assistant
// message, collects memory actions, and builds the 200 body. Extracted to keep persistModelChatTurn
// within the function-length budget after the ADR-0057 D3 compaction wiring.
async function finalizeBufferedTurn(
  deps: UiHandlerDeps,
  turn: BufferedTurnContext,
  memory: ConversationMemoryResultWire,
  result: { userMessage: ChatMessage; response: NormalizedResponse },
  abortSignal: AbortSignal,
): Promise<RouteResult> {
  const { request, modelId, memoryContext } = turn;
  // Issue #631 — redact the model's raw content before persisting and before returning it to the
  // browser, mirroring the grounded-QA path which already applies deps.redactor here.
  const redactedContent = deps.redactor(result.response.content) as string;
  assertUsableAssistantContent(redactedContent, modelId);
  const memoryActions = await collectMemoryActions(deps, request, memoryContext);
  if (requestSignalAborted(abortSignal)) {
    failDesktopChatTurn(deps, request, "cancelled");
    return requestCancelledResult();
  }
  return commitBufferedTurn(deps, turn, memory, result, redactedContent, memoryActions);
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
  readonly turnIdentityContent: string;
}

export interface ParsedDesktopChatSend {
  readonly request: SendDesktopChatRequest;
  readonly chat: Chat;
  readonly normalizedProjectPath: string;
}

interface PreparedDesktopChatRegenerate {
  readonly request: RegenerateDesktopChatRequest;
  readonly chat: Chat;
  readonly modelId: string;
  readonly turn: {
    readonly assistant: ChatMessage;
    readonly user: ChatMessage;
    readonly beforeAssistant: readonly ChatMessage[];
  };
  readonly memoryRequest: SendDesktopChatRequest;
  readonly memoryContext: ConversationMemoryRuntimeContext | undefined;
}

interface ParsedDesktopChatRegenerate {
  readonly request: RegenerateDesktopChatRequest;
  readonly chat: Chat;
}

export async function parseDesktopChatSend(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  signal?: AbortSignal,
): Promise<ParsedDesktopChatSend | RouteResult> {
  const body = await readJsonObject(ctx.req, signal);
  if (isRouteResult(body)) return body;
  const parsedRequest = sendRequestFromBody(body);
  if (isRouteResult(parsedRequest)) return parsedRequest;
  const hasImages = parsedRequest.attachments.some((attachment) => attachment.kind === "image");
  const session = hasImages ? resolveAppSessionReadAuthority(deps, ctx.req) : undefined;
  const request: SendDesktopChatRequest =
    session === undefined
      ? parsedRequest
      : {
          ...parsedRequest,
          attachmentAuthority: {
            sessionId: session.sessionId,
            sessionRotationCount: session.rotationCount,
            revalidate: (): boolean => {
              const current = resolveAppSessionReadAuthority(deps, ctx.req);
              return (
                current?.sessionId === session.sessionId &&
                current.rotationCount === session.rotationCount
              );
            },
          },
        };
  const normalizedProjectPath = normalizeDesktopProjectPath(request.projectPath, deps);
  if (isRouteResult(normalizedProjectPath)) return normalizedProjectPath;
  const chat = findChat(deps, normalizedProjectPath, request.chatId);
  if (chat === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  return { request, chat, normalizedProjectPath };
}

export function validateDesktopChatSend(
  parsed: ParsedDesktopChatSend,
  deps: UiHandlerDeps,
): PreparedDesktopChatSend | RouteResult {
  const { request, chat, normalizedProjectPath } = parsed;
  const modelId = request.modelId ?? chat.selectedModel;
  // MIME, byte-budget, path, chat, and memory-scope checks remain pre-admission trust guards.
  // Model existence and modality are execution availability, so a valid final transcript is
  // admitted before those mutable deployment checks and can be retried with the same identity.
  const safety = validateConversationPayloadSafety({
    attachments: request.attachments,
    documentContext: request.documentContext,
  });
  if (!safety.ok) {
    return { status: 400, body: errorBody(safety.code, safety.message) };
  }
  const memoryContext = resolveDesktopMemoryContext(deps, request, normalizedProjectPath);
  if (isRouteResult(memoryContext)) return memoryContext;
  return {
    request,
    chat,
    modelId,
    memoryContext,
    turnIdentityContent: desktopChatTurnIdentityContent(request, chat, modelId, memoryContext),
  };
}

export function validateDesktopChatExecution(
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
  deps: UiHandlerDeps,
): RouteResult | undefined {
  if (
    request.expectedGroundingScopeIdentity !== undefined &&
    request.expectedGroundingScopeIdentity !== deriveChatGroundingScopeIdentity(chat)
  ) {
    return {
      status: 409,
      body: errorBody(
        "GROUNDING_SCOPE_CHANGED",
        "The grounded source scope changed before the turn could run.",
      ),
    };
  }
  if (hasGroundingScope(chat)) {
    return {
      status: 409,
      body: errorBody(
        "GROUNDING_SCOPE_CHANGED",
        "The chat grounding mode changed before the turn could run.",
      ),
    };
  }
  const invalidModel = invalidChatModelResult(modelId, deps);
  if (invalidModel !== undefined) return invalidModel;
  const validation = validateConversationPayload({
    modelId,
    modelCapabilities: modelCapabilityRegistry(deps),
    attachments: request.attachments,
    documentContext: request.documentContext,
  });
  return validation.ok
    ? undefined
    : { status: 400, body: errorBody(validation.code, validation.message) };
}

export function validateCurrentDesktopChatSend(
  prepared: Pick<ParsedDesktopChatSend, "request" | "chat">,
  deps: UiHandlerDeps,
): PreparedDesktopChatSend | RouteResult {
  const chat = deps.store.findChatById(prepared.request.chatId);
  if (chat?.projectPath !== prepared.chat.projectPath) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  const closed = chatClosedResult(chat);
  if (closed !== undefined) return closed;
  return validateDesktopChatSend(
    { request: prepared.request, chat, normalizedProjectPath: chat.projectPath },
    deps,
  );
}

export async function handleSendDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const cancellation = createRequestCancellation(ctx, "desktop chat request cancelled");
  try {
    const parsed = await parseDesktopChatSend(ctx, deps, cancellation.signal);
    if (cancellation.signal.aborted) return requestCancelledResult();
    if (isRouteResult(parsed)) return parsed;
    const prepared = validateDesktopChatSend(parsed, deps);
    if (isRouteResult(prepared)) return prepared;
    const inspection = inspectDesktopChatTurn(deps, prepared);
    if (inspection.kind === "replay") return { status: 200, body: inspection.response };
    if (inspection.kind === "rejected") return inspection.result;
    const result = await runSerializedChatTurn(
      deps,
      parsed.request.chatId,
      cancellation.signal,
      () => {
        const current = validateCurrentDesktopChatSend(parsed, deps);
        if (isRouteResult(current)) return current;
        return persistModelChatTurn(deps, current, cancellation.signal);
      },
    );
    return result === CHAT_TURN_WAIT_CANCELLED ? requestCancelledResult() : result;
  } finally {
    cancellation.dispose();
  }
}

function requestCancelledResult(): RouteResult {
  return { status: 499, body: errorBody("REQUEST_CANCELLED", "Request was cancelled.") };
}

interface CanonicalTurnMemoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CanonicalTurnMemoryRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly clientTurnId?: string | undefined;
  readonly messages: readonly CanonicalTurnMemoryMessage[];
  readonly modelId: string | undefined;
  readonly memory: ParsedConversationMemoryRequest | undefined;
}

function canonicalTurnCombinedText(messages: readonly CanonicalTurnMemoryMessage[]): string {
  return messages
    .map((message) => message.content)
    .join("\n")
    .trim();
}

function canonicalTurnAsSendRequest(
  request: CanonicalTurnMemoryRequest,
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
    ...(request.clientTurnId === undefined ? {} : { clientTurnId: request.clientTurnId }),
  };
}

async function collectCanonicalTurnLocalMemoryActions(
  deps: UiHandlerDeps,
  request: CanonicalTurnMemoryRequest,
  context: ConversationMemoryRuntimeContext | undefined,
): Promise<readonly ConversationMemoryActionWire[]> {
  if (context === undefined || request.memory?.enabled !== true) {
    return [];
  }
  if (deps.memoryVault === undefined) {
    return [];
  }
  const actions: ConversationMemoryActionWire[] = [];
  const mode = resolveMemoryCaptureAutonomyMode(deps, request.memory.mode);
  for (const [messageOrdinal, message] of request.messages.entries()) {
    if (message.role !== "user") continue;
    const outcomes = extractCandidatesFromUserText(
      message.content,
      buildCaptureContext(context, request.clientTurnId, messageOrdinal),
      {
        ...memoryCapturePolicyForDeps(deps, {
          resolver: createMemoryTargetResolver(deps.memoryVault),
        }),
      },
    );
    for (const outcome of outcomes) {
      const action = await captureActionFromOutcome(
        outcome,
        deps,
        mode,
        request.memory.surface ?? "desktop",
        request.clientTurnId !== undefined,
      );
      if (action !== null) actions.push(action);
    }
  }
  return actions;
}

interface CanonicalTurnSaliencePair {
  readonly userText: string;
  readonly assistantText: string;
}

function pushCanonicalTurnSaliencePair(
  pairs: CanonicalTurnSaliencePair[],
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

function conversationImageParts(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  modelId: string,
): readonly ChatMessageContentPart[] {
  const images = request.attachments.filter((attachment) => attachment.kind === "image");
  if (images.length === 0) return [];
  const authority = request.attachmentAuthority;
  if (authority === undefined || !conversationImageDeliveryAllowed(deps, request, modelId)) {
    throw new ConversationAttachmentStoreError();
  }
  return images.map((attachment): ChatMessageContentPart => {
    const mimeType = normalizeAttachmentMime(attachment.mimeType);
    if (
      mimeType === undefined ||
      classifyAttachmentMime(mimeType) !== "image" ||
      attachment.attachmentRef === undefined ||
      attachment.sha256 === undefined ||
      attachment.id === undefined ||
      !CONTENT_FREE_ATTACHMENT_ID.test(attachment.id)
    ) {
      throw new ConversationAttachmentStoreError();
    }
    const bytes = deps.conversationAttachmentStore?.resolve(attachment.attachmentRef, {
      sessionId: authority.sessionId,
      sessionRotationCount: authority.sessionRotationCount,
      projectPath: request.projectPath,
      chatId: request.chatId,
      mimeType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    });
    if (bytes === undefined) throw new ConversationAttachmentStoreError();
    return {
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` },
    };
  });
}

function conversationImageDeliveryAllowed(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  modelId: string,
): boolean {
  const authority = request.attachmentAuthority;
  const capability = chatCapability(deps, modelId);
  return (
    request.attachmentIntent === CONVERSATION_IMAGE_DELIVERY_INTENT &&
    authority !== undefined &&
    authority.revalidate() &&
    deps.store.findChatById(request.chatId)?.projectPath === request.projectPath &&
    capability?.kind === "chat" &&
    capability.supportsImageInput &&
    deps.conversationAttachmentStore !== undefined
  );
}

export function assemblyWithConversationImages(
  deps: UiHandlerDeps,
  request: SendDesktopChatRequest,
  modelId: string,
  assembly: GatewayPromptAssembly,
): GatewayPromptAssembly {
  const imageParts = conversationImageParts(deps, request, modelId);
  if (imageParts.length === 0) return assembly;
  const lastIndex = assembly.messages.length - 1;
  const messages = assembly.messages.map((message, index): GatewayConversationMessage =>
    index === lastIndex
      ? {
          ...message,
          contentParts: [{ type: "text", text: message.content }, ...imageParts],
        }
      : message,
  );
  return { ...assembly, messages };
}

export function conversationImageDeliveries(
  request: SendDesktopChatRequest,
): readonly { readonly id: string; readonly status: "delivered" }[] {
  return request.attachments.flatMap((attachment) =>
    attachment.kind === "image" &&
    attachment.id !== undefined &&
    CONTENT_FREE_ATTACHMENT_ID.test(attachment.id)
      ? [{ id: attachment.id, status: "delivered" as const }]
      : [],
  );
}

function canonicalTurnSaliencePairs(
  request: CanonicalTurnMemoryRequest,
): readonly CanonicalTurnSaliencePair[] {
  const pairs: CanonicalTurnSaliencePair[] = [];
  let userParts: string[] = [];
  let assistantParts: string[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      pushCanonicalTurnSaliencePair(pairs, userParts, assistantParts);
      userParts = [message.content];
      assistantParts = [];
    } else if (userParts.length > 0) {
      assistantParts.push(message.content);
    }
  }
  pushCanonicalTurnSaliencePair(pairs, userParts, assistantParts);
  return pairs;
}

function scheduleCanonicalTurnSalienceCapture(
  deps: UiHandlerDeps,
  request: CanonicalTurnMemoryRequest,
  context: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
  correlationId: string,
): void {
  if (context === undefined || request.memory?.enabled !== true || deps.memoryVault === undefined) {
    return;
  }
  for (const pair of canonicalTurnSaliencePairs(request)) {
    scheduleMemorySalienceCapture(
      deps,
      {
        content: pair.userText,
        memory: request.memory,
      },
      context,
      modelId,
      pair.assistantText,
      request.memory.surface ?? "desktop",
      correlationId,
    );
  }
}

export function runPostCommitCanonicalTurnMemorySideEffects(
  deps: UiHandlerDeps,
  request: CanonicalTurnMemoryRequest,
  context: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
  memory: ConversationMemoryResultWire,
  assistantText: string,
  correlationId: string,
): void {
  runPostCommitMemoryEffect(deps, correlationId, "grounded.memory.reinforcement", () => {
    recordConversationMemoryUse(deps, memory, assistantText);
  });
  runPostCommitMemoryEffect(deps, correlationId, "grounded.memory.salience", () => {
    scheduleCanonicalTurnSalienceCapture(deps, request, context, modelId, correlationId);
  });
}

export async function buildCanonicalTurnMemoryResult(
  deps: UiHandlerDeps,
  request: CanonicalTurnMemoryRequest,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
  options: {
    readonly retrievalContent?: string | undefined;
    readonly precomputedMemory?: ConversationMemoryResultWire | undefined;
  } = {},
): Promise<ConversationMemoryResultWire | undefined> {
  if (request.memory === undefined) {
    return undefined;
  }
  if (memoryContext === undefined) {
    return emptyMemoryResult(false);
  }
  // Grounded Q&A supplies only the user's question here so the assistant's newly generated answer
  // cannot bias memory recall for the same turn.
  const content = options.retrievalContent ?? canonicalTurnCombinedText(request.messages);
  const memory =
    options.precomputedMemory ??
    (await buildMemoryResult(canonicalTurnAsSendRequest(request, content), deps, memoryContext));
  const actions = await collectCanonicalTurnLocalMemoryActions(deps, request, memoryContext);
  return { ...memory, actions };
}

async function parseDesktopChatRegenerate(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  signal: AbortSignal,
): Promise<ParsedDesktopChatRegenerate | RouteResult> {
  const body = await readJsonObject(ctx.req, signal);
  if (isRouteResult(body)) return body;
  const request = regenerateRequestFromBody(body);
  if (isRouteResult(request)) return request;
  const normalizedProjectPath = normalizeDesktopProjectPath(request.projectPath, deps);
  if (isRouteResult(normalizedProjectPath)) return normalizedProjectPath;
  const chat = findChat(deps, normalizedProjectPath, request.chatId);
  if (chat === undefined) return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  return { request, chat };
}

function prepareDesktopChatRegenerateRequest(
  request: RegenerateDesktopChatRequest,
  deps: UiHandlerDeps,
): PreparedDesktopChatRegenerate | RouteResult {
  const normalizedProjectPath = normalizeDesktopProjectPath(request.projectPath, deps);
  if (isRouteResult(normalizedProjectPath)) return normalizedProjectPath;
  const chat = findChat(deps, normalizedProjectPath, request.chatId);
  if (chat === undefined) return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  const closed = chatClosedResult(chat);
  if (closed !== undefined) return closed;
  if (hasGroundingScope(chat)) return groundedRegenerateResult();
  const modelId = request.modelId ?? chat.selectedModel;
  const invalidModel = invalidChatModelResult(modelId, deps);
  if (invalidModel !== undefined) return invalidModel;
  const visibleTurn = latestRegenerableTurn(
    deps.store.listMessages(chat.id),
    request.assistantMessageId,
  );
  if (isRouteResult(visibleTurn)) return visibleTurn;
  const turn = latestRegenerableTurn(
    deps.store.listGatewayMessages(chat.id, "", CHAT_HISTORY_READ_LIMIT),
    request.assistantMessageId,
  );
  if (isRouteResult(turn)) return turn;
  const memoryRequest = regenerateMemoryRequest(request, turn);
  const memoryContext = resolveDesktopMemoryContext(deps, memoryRequest, normalizedProjectPath);
  if (isRouteResult(memoryContext)) return memoryContext;
  return { request, chat, modelId, turn, memoryRequest, memoryContext };
}

async function buildRegenerateMemoryAndMessages(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatRegenerate,
): Promise<{
  readonly memory: ConversationMemoryResultWire;
  readonly messages: readonly GatewayConversationMessage[];
}> {
  const { modelId, turn, memoryRequest, memoryContext } = prepared;
  const memory =
    memoryContext === undefined
      ? emptyMemoryResult(false)
      : await buildMemoryResult(memoryRequest, deps, memoryContext);
  const assembly = buildRegenerateGatewayAssembly(
    deps,
    memoryRequest,
    memory,
    modelId,
    turn.beforeAssistant,
  );
  return { memory, messages: assembly.messages };
}

function validateRegenerateCommit(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatRegenerate,
): ChatMessage | RouteResult {
  const current = latestRegenerableTurn(
    deps.store.listMessages(prepared.chat.id),
    prepared.turn.assistant.id,
  );
  if (isRouteResult(current)) return current;
  if (
    current.assistant.content !== prepared.turn.assistant.content ||
    current.assistant.timestamp !== prepared.turn.assistant.timestamp
  ) {
    return {
      status: 409,
      body: errorBody(
        "NOT_APPLIABLE",
        "Assistant response changed while regeneration was in progress.",
      ),
    };
  }
  return current.assistant;
}

async function persistRegeneratedChatTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatRegenerate,
  signal: AbortSignal,
): Promise<RouteResult> {
  const { chat, modelId, memoryRequest } = prepared;
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  try {
    const { memory, messages } = await buildRegenerateMemoryAndMessages(deps, prepared);
    if (requestSignalAborted(signal)) return requestCancelledResult();
    const response = await model.call({ modelId, messages, stream: false }, signal);
    if (requestSignalAborted(signal)) return requestCancelledResult();
    const redactedContent = deps.redactor(response.content) as string;
    assertUsableAssistantContent(redactedContent, modelId);
    const currentAssistant = validateRegenerateCommit(deps, prepared);
    if (isRouteResult(currentAssistant)) return currentAssistant;
    const assistantMessage = deps.store.createAssistantResponseVersion(
      currentAssistant.id,
      redactedContent,
      Date.now(),
    );
    const updatedChat = commitChatAfterTurn(deps, chat, memoryRequest, modelId);
    return {
      status: 200,
      body: {
        chat: updatedChat,
        messages: [assistantMessage],
        usage: response.usage,
        memory: { ...memory, actions: [] },
      },
    };
  } catch (error) {
    return signal.aborted ? requestCancelledResult() : desktopChatErrorResult(error, deps);
  }
}

export async function handleRegenerateDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const cancellation = createRequestCancellation(ctx, "desktop regeneration cancelled");
  try {
    const prepared = await parseDesktopChatRegenerate(ctx, deps, cancellation.signal);
    if (cancellation.signal.aborted) return requestCancelledResult();
    if (isRouteResult(prepared)) return prepared;
    const result = await runSerializedChatTurn(
      deps,
      prepared.request.chatId,
      cancellation.signal,
      () => {
        const current = prepareDesktopChatRegenerateRequest(prepared.request, deps);
        return isRouteResult(current)
          ? current
          : persistRegeneratedChatTurn(deps, current, cancellation.signal);
      },
    );
    return result === CHAT_TURN_WAIT_CANCELLED ? requestCancelledResult() : result;
  } finally {
    cancellation.dispose();
  }
}
