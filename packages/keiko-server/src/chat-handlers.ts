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
import type {
  ConversationDocumentContextWire,
  CodingWorkbenchMode,
  DiscussionMode,
  ChatMessageContentPart,
} from "@oscharko-dev/keiko-contracts";
import { isDiscussionMode } from "@oscharko-dev/keiko-contracts/runtime/discussion-intelligence";
import { isCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  electConversationDefault,
  preferredConversationModelOrder,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
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
  ensureAnyConversationReadyChatModel,
  ensureOnDemandConversationReadiness,
} from "./gateway-readiness.js";
import {
  extractCandidatesFromUserText,
  type CaptureContext,
  type CaptureOutcome,
} from "@oscharko-dev/keiko-memory-capture";
import {
  UiStoreError,
  isProjectAvailable,
  type Chat,
  type ChatGitChangeScope,
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
// Issue #3400 (epic #3384, contract correction 4): the server-minted description authority
// (#3399) that admits model egress of git-change snapshot content outside a running Code task.
// Read-only consumption of the existing owning module — never redefined here.
import { authorizeGitDeliveryModelEgress } from "./gitDelivery/runBoundAuthority.js";
import {
  generateGitChangeChatDescription,
  gitChangeDescriptionAuthorityScopeFor,
} from "./gitChangeChatContext.js";
// Issue #3400 (epic #3384, Frozen Product Decision 6 / issue correction 1): the apply action
// routes ONLY through the existing body-only description application service (#3399), never
// through `executeGovernedPullRequest`'s coupled title+body+base update path. Read-only
// consumption of the existing owning module — never redefined here.
import type { PrDescriptionApplicationResult } from "./gitDelivery/prDescriptionTypes.js";
// Final-audit F5 (#3400): reuses the SAME admitted, per-(project, repository, PR) service factory
// this route group's own preview/approve/apply handlers already run through — never a second,
// independently-composed service surface (AGENTS.md §5).
import {
  resolvePrDescriptionApplicationServiceForRequest,
  type BaseFields as PrDescriptionBaseFields,
  type PrDescriptionRouteOptions,
} from "./gitDelivery/prDescriptionRoutes.js";
// Re-derives the SAME trusted repository root the connect flow resolved, through the SAME
// git-membership check -- never a second, independently-drifting copy of that trust boundary.
import { resolveChatRepository } from "./gitChangeRepository.js";
import { observedGitRunner } from "./gitProcessActivity.js";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import {
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "./coding-context/githubIssueReaderAuthorization.js";
import { hasOnlyAllowedKeys } from "./gitDelivery/requestGuards.js";
import { processServerLogSink } from "./process-log-sink.js";
import {
  currentAuditRedactString,
  currentConversationReady,
  currentConversationReadinessObservation,
  currentContextProfileForModel,
  currentGatewayConfig,
  currentRedactionSecrets,
} from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { conversationModelNotReadyResult } from "./conversation-readiness-admission.js";
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
import { persistCapturedMemory } from "./memory-capture-persistence.js";
import { embedAndStoreMemory } from "./memory-embedding.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { recordAutoAcceptedMemoryCaptureDecision } from "./memory-capture-audit.js";
import { scheduleMemorySalienceCapture } from "./memory-salience.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "./diagnostics-log.js";
import { emitGatewayErrorDiagnostic } from "./gateway-error-diagnostic.js";
import { getServerLogger } from "./observability/index.js";
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
  // Rank-ordered (keiko-contracts conversationDefaultRank): mode-declared chat models first,
  // mode-less special-purpose ids (the customer's first-listed OCR model) last — so neither a
  // fresh generation nor a warm-probed OCR model can capture the default while a better
  // candidate exists. Stable: configured order still breaks ties within a tier.
  const chatModels = preferredConversationModelOrder(
    listConfiguredCapabilities(config).filter((model) => model.kind === "chat"),
  );
  const conversationReady = (model: ModelCapability): boolean =>
    currentConversationReady(deps, model.id);
  const readinessObservation = (model: ModelCapability): boolean | undefined =>
    currentConversationReadinessObservation(deps, model.id);
  // The public create contract makes modelId optional, so the default must not hand
  // modelFromBody an unready model while another configured chat model has a current
  // successful probe — that turned an otherwise valid request into a 400. Readiness only
  // reorders the preference; when nothing is ready the unready default still flows into
  // the guard so the caller keeps the precise "not ready" error.
  // Tier-first election (review finding on the first cut): a verified probe breaks ties only
  // WITHIN the best rank tier — a warm special-purpose model that happened to pass one probe
  // must not outrank an unprobed declared chat model.
  return (
    (
      chatModels.find((model) => model.id === DEFAULT_CHAT_MODEL && conversationReady(model)) ??
      electConversationDefault(chatModels, readinessObservation)
    )?.id ?? DEFAULT_CHAT_MODEL
  );
}

function explicitChatModelId(body: Record<string, unknown>): string | undefined {
  return typeof body.modelId === "string" && body.modelId.length > 0 ? body.modelId : undefined;
}

function modelFromBody(body: Record<string, unknown>, deps: UiHandlerDeps): string | RouteResult {
  // ONE explicitness predicate: the readiness path (create walk vs single probe) and this
  // admission must never disagree on what counts as an explicit model id.
  const modelId = explicitChatModelId(body) ?? defaultChatModelId(deps);
  const capability = chatCapability(deps, modelId);
  if (capability?.kind !== "chat") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
    };
  }
  if (deps.gatewayConfig !== undefined && !currentConversationReady(deps, modelId)) {
    return unreadyChatModelResult();
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
  // KEIKO-0353: a circuit-open failure IS "temporarily unavailable" from the caller's
  // point of view — the same 503 the transport-error branch below already emits. The
  // breaker's own retryable=false signals internal auto-recovery, not that the client
  // should treat the outage as permanent, so it must not fall through to 502.
  if (error.code === "GATEWAY_CIRCUIT_OPEN") return 503;
  if (error.retryable) return 503;
  return 502;
}

// ADR-0173 D5 g25 — every GatewayError this path maps to a response also reaches the redacted
// operator diagnostic sink, the same symmetry `chat-stream-handlers.ts`'s SSE path already had.
// `emitDiagnostic` defaults on for the normal (response-returning) callers below and is turned off
// by the ONE caller that already emitted its own broader diagnostic for this exact error a moment
// earlier and calls back in purely to reuse the code/message mapping (`chat-stream-handlers.ts`'s
// `errorEvent`) — without it that caller would double-log the same failure.
function gatewayErrorResult(
  error: GatewayError,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  emitDiagnostic: boolean,
): RouteResult {
  if (emitDiagnostic) {
    emitGatewayErrorDiagnostic(deps, error, correlationId, "POST /api/desktop/chat", "chat.send");
  }
  const status = gatewayErrorStatus(error);
  return { status, body: errorBody(error.code, redactErrorMessage(error.message, deps)) };
}

export function desktopChatErrorResult(
  error: unknown,
  deps: UiHandlerDeps,
  correlationId?: string,
  emitDiagnostic = true,
): RouteResult {
  if (error instanceof ConversationAttachmentStoreError) {
    return {
      status: 409,
      body: errorBody("INVALID_REQUEST", "Conversation image delivery was refused."),
    };
  }
  if (error instanceof GatewayError) {
    return gatewayErrorResult(error, deps, correlationId, emitDiagnostic);
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
    return deps.gatewayConfig === undefined || currentConversationReady(deps, modelId)
      ? undefined
      : unreadyChatModelResult();
  }
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
  };
}

function unreadyChatModelResult(): RouteResult {
  return conversationModelNotReadyResult();
}

function logChatCreationRejection(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  modelId: string,
  status: number,
): void {
  const modelKind = chatCapability(deps, modelId)?.kind ?? "unknown";
  const readinessFailure = modelKind === "chat";
  getServerLogger().warn({
    category: "gateway",
    op: "chat.creation.rejected",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    status,
    errorKind: readinessFailure ? "model-not-ready" : "invalid-model",
    extra: { reason: readinessFailure ? "readiness" : "configuration", modelKind },
  });
}

type ChatRejectionReason = "readiness" | "generation" | "grounding-scope";

function chatRejectionErrorKind(reason: ChatRejectionReason): string {
  if (reason === "generation") return "config-changed";
  return reason === "grounding-scope" ? "grounding-scope-changed" : "model-not-ready";
}

export function logChatRejection(
  operation: "chat.send.rejected" | "chat.regeneration.rejected",
  correlationId: string | undefined,
  modelId: string,
  deps: UiHandlerDeps,
  status: number,
  reason: ChatRejectionReason = "readiness",
): void {
  const event = {
    category: "gateway",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    status,
    errorKind: chatRejectionErrorKind(reason),
    extra: {
      reason,
      modelKind: chatCapability(deps, modelId)?.kind ?? "unknown",
    },
  } as const;
  if (operation === "chat.send.rejected") {
    getServerLogger().warn({ ...event, op: "chat.send.rejected" });
  } else {
    getServerLogger().warn({ ...event, op: "chat.regeneration.rejected" });
  }
}

function routeErrorFields(
  result: RouteResult,
): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(result.body) || !isRecord(result.body.error)) return undefined;
  const { code, message } = result.body.error;
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
}

function chatExecutionRejectionReason(result: RouteResult): ChatRejectionReason | undefined {
  const actual = routeErrorFields(result);
  if (actual?.code === "GROUNDING_SCOPE_CHANGED") return "grounding-scope";
  const expected = routeErrorFields(conversationModelNotReadyResult());
  if (actual === undefined || expected === undefined) return undefined;
  return result.status === 400 &&
    actual.code === expected.code &&
    actual.message === expected.message
    ? "readiness"
    : undefined;
}

interface ChatReadinessRejectionContext {
  readonly operation: "chat.send.rejected" | "chat.regeneration.rejected";
  readonly correlationId: string | undefined;
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
  | {
      readonly kind: "admitted";
      readonly userMessage: ChatMessage;
      readonly legacyTouchedUpdatedAt?: number | undefined;
    }
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
    const userMessage = createUserMessage(deps, request);
    // Captured synchronously right after the insert (SQLite calls cannot interleave here):
    // the exact updated_at value our createMessage touch wrote. The rejection-path restore
    // compare-and-sets against it so a concurrent accepted update keeps its newer recency.
    const legacyTouchedUpdatedAt = deps.store.findChatById(request.chatId)?.updatedAt;
    return { kind: "admitted", userMessage, legacyTouchedUpdatedAt };
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

// A turn rejected after admission but before any provider output must leave no state behind:
// ledger turns settle through the turn record, but for a legacy request (no clientTurnId) the
// ledger no-ops, so the just-admitted user row is discarded — restoring the pre-#3182
// invariant that a rejected legacy request has no side effect. Post-provider failures keep
// the row on purpose: the send was attempted and history stays honest.
export interface AdmittedTurnHandle {
  readonly userMessage: ChatMessage;
  readonly legacyTouchedUpdatedAt?: number | undefined;
}

export function settleRejectedDesktopChatTurn(
  deps: UiHandlerDeps,
  prepared: Pick<PreparedDesktopChatSend, "request" | "chat">,
  admitted: AdmittedTurnHandle,
  terminalState: "failed" | "cancelled" = "failed",
): void {
  const { request } = prepared;
  if (request.clientTurnId !== undefined) {
    deps.store.failChatTurn(request.chatId, request.clientTurnId, terminalState);
    return;
  }
  // The pre-admission updatedAt undoes the createMessage touch so a rejected legacy request
  // cannot promote its chat in the recency-ordered history; the admission-time touch value
  // makes that rollback a compare-and-set, so a concurrent accepted update survives.
  deps.store.discardLegacyTurnUserMessage(
    request.chatId,
    admitted.userMessage.id,
    prepared.chat.updatedAt,
    admitted.legacyTouchedUpdatedAt,
  );
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
export function maybeRunChatAutoMaintenance(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  state: AutoMaintenanceState = memoryMaintenanceCursor,
  nowMs: number = Date.now(),
  // The triggering chat request's own correlation id, when known (ADR-0173 D5 / g12). This pass
  // is genuinely background-originated (opportunistic, rate-limited, may run well after the turn
  // that triggered it), so it mints its own id below rather than reusing the request's outright —
  // but a known request id still rides as `parentCorrelationId` so an operator can join this
  // pass's diagnostics back to the request that opportunistically triggered it.
  requestCorrelationId?: string,
): void {
  if (deps.env.KEIKO_MEMORY_AUTO_MAINTAIN === "0") return;
  if (!isMaintenanceDue(state.lastRunAtMs, nowMs)) return;
  // Minted ONCE here, at the start of this maintenance pass, rather than inside each helper's own
  // catch block: the retention-policy read, the autonomy-mode read, and the maintenance sweep
  // itself are three separate failure points of the SAME pass, and used to mint three disconnected
  // ids — making it impossible for an operator to tell they came from one invocation (ADR-0173 D5
  // / g12).
  const correlationId = randomUUID();
  const multipliers = memorySemanticizationMultipliers(deps.env);
  const retention = resolveMemoryRetentionPolicy(deps, correlationId);
  // A malformed retention setting disables only the retention phase. The resolver already emits a
  // diagnostic; promotion, consolidation, supersession, and fade must keep running so one invalid
  // optional setting cannot silently suspend all pre-existing vault maintenance.
  const retentionPolicy = retention.ok ? retention.policy : undefined;
  maybeRunAutoMaintenance(vault, memoryMaintenanceAuditSink(deps), state, {
    nowMs,
    enabled: true,
    correlationId,
    autonomyMode: resolveMaintenanceAutonomyMode(deps, correlationId),
    ...(multipliers !== undefined ? { decayHalfLifeMultiplierByType: multipliers } : {}),
    ...(retentionPolicy !== undefined ? { retentionPolicy } : {}),
    onFailure: (error): void => {
      emitServerDiagnostic(deps.diagnostics, {
        correlationId,
        timestamp: new Date(Date.now()).toISOString(),
        operation: "chat.memory.auto-maintenance",
        source: "chat.memory.maintenance",
        errorClass: contentFreeErrorClass(error),
        message: "chat-memory-auto-maintenance-failed",
        ...(requestCorrelationId === undefined
          ? {}
          : { parentCorrelationId: requestCorrelationId }),
      });
    },
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
  if (isSuppressedByForgetTombstone(deps.memoryVault, record)) {
    return { kind: "rejected", reason: FORGOTTEN_MEMORY_SUPPRESSION_REASON };
  }
  const candidate = captureCandidateForMode(record, mode, outcome);
  const persisted = persistCapturedMemory(deps.memoryVault, candidate, canonicalCapture);
  const inserted = persisted.memory;
  if ((persisted.inserted || persisted.promoted) && inserted.status === "accepted") {
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
    requiresApproval: outcome.requiresApproval,
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

// ADR-0173 D5 g9 — the INPUT shape of a chat turn, never its content: how many messages the
// assembled prompt carries (split by role) and how many image attachments rode along (count +
// bytes). Logged once, at the point the assembled prompt and the parsed attachments are both
// already in hand, so an agent reconstructing a defect from the activity log can tell "a
// 40-message context with two images" from "a bare one-line question" without ever seeing a
// token of either. Deliberately NOT the speculative JSON shape-skeleton feature (positional
// locator tuples over the request/response bodies) — that stays a documented forward guardrail,
// not built here (final-design.md Decisions Log D14).
const CHAT_TURN_ROLES = ["system", "user", "assistant", "tool"] as const;
type ChatTurnRole = (typeof CHAT_TURN_ROLES)[number];
const CHAT_TURN_ROLE_SET: ReadonlySet<string> = new Set(CHAT_TURN_ROLES);

export interface ChatTurnShapeFields {
  readonly messageCount: number;
  readonly roleCounts: Readonly<Record<ChatTurnRole, number>>;
  // Denormalized copy of roleCounts.tool: a scalar an agent can grep for directly, without
  // descending into the nested extra.roleCounts object.
  readonly toolCount: number;
  readonly imageAttachmentCount: number;
  readonly imageAttachmentBytes: number;
}

// Exported so its co-located test derives its expectations by calling this exact production
// formula (AGENTS.md §7) rather than restating the counting logic as a second copy that could
// drift from it.
export function chatTurnShapeFields(
  messages: readonly { readonly role: string }[],
  attachments: readonly ConversationAttachment[],
): ChatTurnShapeFields {
  const roleCounts: Record<ChatTurnRole, number> = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const message of messages) {
    if (CHAT_TURN_ROLE_SET.has(message.role)) {
      roleCounts[message.role as ChatTurnRole] += 1;
    }
  }
  let imageAttachmentCount = 0;
  let imageAttachmentBytes = 0;
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      imageAttachmentCount += 1;
      imageAttachmentBytes += attachment.sizeBytes;
    }
  }
  return {
    messageCount: messages.length,
    roleCounts,
    toolCount: roleCounts.tool,
    imageAttachmentCount,
    imageAttachmentBytes,
  };
}

function logChatTurnStarted(
  correlationId: string | undefined,
  messages: readonly { readonly role: string }[],
  attachments: readonly ConversationAttachment[],
): void {
  getServerLogger().info({
    category: "gateway",
    op: "chat.turn.started",
    correlationId,
    extra: { ...chatTurnShapeFields(messages, attachments) },
  });
}

export interface ChatCompactionTurn {
  readonly compaction: ConversationCompactionOutcome["compaction"];
  readonly request: SendDesktopChatRequest;
  readonly modelId: string;
  readonly messageCount: number;
  readonly startedAt: number;
  readonly historyPrefix: readonly ChatMessage[];
  // ADR-0173 D5 g25 — the request's correlation id, carried through so a scheduled-enrichment
  // failure (logged well after the response left, from inside a detached setImmediate) still
  // joins back to the request that triggered it instead of standing alone in the activity log.
  readonly correlationId: string | undefined;
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
  scheduleCompactionModelSummary(deps, input, turn.historyPrefix, turn.correlationId);
}

function scheduleCompactionModelSummary(
  deps: UiHandlerDeps,
  input: ChatCompactionEvidenceInput,
  historyPrefix: readonly ChatMessage[],
  correlationId: string | undefined,
): void {
  if (
    input.compaction === undefined ||
    pendingCompactionSummaries >= MAX_PENDING_COMPACTION_SUMMARIES
  ) {
    return;
  }
  pendingCompactionSummaries += 1;
  const handle = setImmediate(() => {
    void enrichChatCompactionWithModelSummary(deps, { ...input, historyPrefix, correlationId })
      .catch((error: unknown) => {
        logCompactionSummaryFailure(deps, correlationId, error);
      })
      .finally(() => {
        pendingCompactionSummaries -= 1;
      });
  });
  handle.unref();
}

// Replaces a bare `console.warn` (ADR-0173 D5 g25): the scheduled enrichment runs detached from
// the request/response cycle, so its own internal try/catch (`enrichChatCompactionWithModelSummary`)
// already routes the ordinary failure paths to a diagnostic — this outer catch only fires for a
// failure that escapes THAT guard, and must not go back to being invisible.
function logCompactionSummaryFailure(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      operation: "chat.compaction.summary.scheduled",
      source: "chat.compaction.model-summary",
      error,
      redact: (message) => String(deps.redactor(message)),
    }),
  );
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

function bufferedModelAtProviderBoundary(
  deps: UiHandlerDeps,
  modelId: string,
  executionAdmission: DesktopChatExecutionAdmission,
  correlationId: string | undefined,
  operation: "chat.send.rejected" | "chat.regeneration.rejected" = "chat.send.rejected",
): BufferedModelPort | RouteResult {
  const invalidProviderBoundary = validateDesktopChatProviderBoundary(
    modelId,
    executionAdmission,
    deps,
  );
  if (invalidProviderBoundary !== undefined) {
    logChatRejection(
      operation,
      correlationId,
      modelId,
      deps,
      invalidProviderBoundary.status,
      desktopChatProviderBoundaryRejectionReason(modelId, executionAdmission, deps),
    );
    return invalidProviderBoundary;
  }
  return (
    deps.modelPortFactory(modelId) ?? {
      status: 400,
      body: errorBody("NO_MODEL", "No model provider is configured."),
    }
  );
}

function bufferedTurnCancellationResult(
  deps: UiHandlerDeps,
  prepared: Pick<PreparedDesktopChatSend, "request" | "chat">,
  signal: AbortSignal,
  preProviderAdmitted?: AdmittedTurnHandle,
): RouteResult | undefined {
  if (!requestSignalAborted(signal)) return undefined;
  // Before any provider output the settle may still discard a legacy row; after the
  // provider ran, history keeps the user message and only the ledger settles.
  if (preProviderAdmitted !== undefined) {
    settleRejectedDesktopChatTurn(deps, prepared, preProviderAdmitted, "cancelled");
  } else {
    failDesktopChatTurn(deps, prepared.request, "cancelled");
  }
  return requestCancelledResult();
}

// Buffered mirror of the streaming memory guard: the turn is already admitted, so a memory
// failure must settle it — and for a legacy request settling means discarding the
// just-admitted user row, because nothing was sent to a provider yet.
async function resolveBufferedMemory(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  admitted: AdmittedTurnHandle,
  abortSignal: AbortSignal,
  correlationId: string | undefined,
): Promise<ConversationMemoryResultWire | RouteResult> {
  const { request, memoryContext } = prepared;
  let memory: ConversationMemoryResultWire;
  try {
    memory =
      memoryContext === undefined
        ? emptyMemoryResult(false)
        : await buildMemoryResult(request, deps, memoryContext);
  } catch (error) {
    const cancelled = requestSignalAborted(abortSignal);
    settleRejectedDesktopChatTurn(deps, prepared, admitted, cancelled ? "cancelled" : "failed");
    return cancelled
      ? requestCancelledResult()
      : desktopChatErrorResult(error, deps, correlationId);
  }
  // Cancellation that lands during retrieval must be settled HERE, before assembly and the
  // provider call — this is still pre-provider, so a legacy row is discarded rather than
  // left behind by the ledger no-op.
  return bufferedTurnCancellationResult(deps, prepared, abortSignal, admitted) ?? memory;
}

function admitBufferedModelTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  correlationId: string | undefined,
):
  | {
      readonly admitted: AdmittedTurnHandle;
      readonly executionAdmission: DesktopChatExecutionAdmission;
    }
  | RouteResult {
  const { request, chat, modelId } = prepared;
  const legacyAdmission =
    request.clientTurnId === undefined
      ? captureDesktopChatExecutionAdmission(request, chat, modelId, deps, {
          operation: "chat.send.rejected",
          correlationId,
        })
      : undefined;
  if (isRouteResult(legacyAdmission)) return legacyAdmission;
  // Probe the provider for EVERY legacy request while nothing is persisted yet: a NO_MODEL
  // rejection after admission cannot settle the turn (failDesktopChatTurn is a no-op without
  // a clientTurnId) and would orphan the user message — the pre-#3182 invariant. The
  // clientTurnId path keeps resolving after the memory await for provider freshness.
  if (legacyAdmission !== undefined) {
    const probe = bufferedModelAtProviderBoundary(deps, modelId, legacyAdmission, correlationId);
    if (isRouteResult(probe)) return probe;
  }
  const admission = admitDesktopChatTurn(deps, prepared);
  if (admission.kind === "replay") return { status: 200, body: admission.response };
  if (admission.kind === "rejected") return admission.result;
  const executionAdmission =
    legacyAdmission ??
    captureDesktopChatExecutionAdmission(request, chat, modelId, deps, {
      operation: "chat.send.rejected",
      correlationId,
    });
  if (isRouteResult(executionAdmission)) {
    settleRejectedDesktopChatTurn(deps, prepared, admission);
    return executionAdmission;
  }
  return { admitted: admission, executionAdmission };
}

async function persistModelChatTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  abortSignal: AbortSignal,
  correlationId: string | undefined,
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
      correlationId,
    );
  } catch (error) {
    const cancelled = requestSignalAborted(abortSignal);
    failDesktopChatTurn(deps, request, cancelled ? "cancelled" : "failed");
    return cancelled
      ? requestCancelledResult()
      : desktopChatErrorResult(error, deps, correlationId);
  }
}

async function executeBufferedModelTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  abortSignal: AbortSignal,
  messageCountBeforeTurn: number,
  startedAt: number,
  correlationId: string | undefined,
): Promise<RouteResult> {
  const { request, modelId } = prepared;
  const outcome = admitBufferedModelTurn(deps, prepared, correlationId);
  if (isRouteResult(outcome)) return outcome;
  const { admitted, executionAdmission } = outcome;
  const { userMessage } = admitted;
  const gatewayTurn = captureGatewayTurnSnapshot(deps, request, userMessage);
  const memory = await resolveBufferedMemory(deps, prepared, admitted, abortSignal, correlationId);
  if (isRouteResult(memory)) return memory;
  const baseAssembly = buildGatewayAssembly(deps, request, memory, modelId, gatewayTurn);
  // Logged from the base assembly, BEFORE image content parts are spliced in: image delivery can
  // still fail its own (unrelated) authority/session check below, and this shape evidence must
  // exist either way. Splicing only augments the final message's contentParts, never message
  // count or role — so the counted shape is identical from either assembly.
  logChatTurnStarted(correlationId, baseAssembly.messages, request.attachments);
  const assembly = assemblyWithConversationImages(deps, request, modelId, baseAssembly);
  const model = bufferedModelAtProviderBoundary(deps, modelId, executionAdmission, correlationId);
  if (isRouteResult(model)) {
    settleRejectedDesktopChatTurn(deps, prepared, admitted);
    return model;
  }
  const response = await model.call(
    { modelId, messages: assembly.messages, stream: false, logContext: { correlationId } },
    abortSignal,
  );
  const cancelledAfterCall = bufferedTurnCancellationResult(deps, prepared, abortSignal);
  if (cancelledAfterCall !== undefined) return cancelledAfterCall;
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
      correlationId,
    },
  );
}

type BufferedTurnContext = PreparedDesktopChatSend;

interface BufferedCompactionContext {
  readonly assembly: ReturnType<typeof buildGatewayAssembly>;
  readonly messageCount: number;
  readonly startedAt: number;
  readonly historyPrefix: readonly ChatMessage[];
  readonly correlationId: string | undefined;
}

async function finalizeAndRecordBufferedTurn(
  deps: UiHandlerDeps,
  turn: BufferedTurnContext,
  memory: ConversationMemoryResultWire,
  result: {
    userMessage: ChatMessage;
    response: Pick<NormalizedResponse, "content"> & { usage?: NormalizedResponse["usage"] };
  },
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
      correlationId: compaction.correlationId,
    });
  }
  return finalized;
}

function commitBufferedTurn(
  deps: UiHandlerDeps,
  turn: BufferedTurnContext,
  memory: ConversationMemoryResultWire,
  result: {
    readonly userMessage: ChatMessage;
    readonly response: Pick<NormalizedResponse, "content"> & {
      readonly usage?: NormalizedResponse["usage"];
    };
  },
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
      ...(result.response.usage === undefined ? {} : { usage: result.response.usage }),
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
  result: {
    userMessage: ChatMessage;
    response: Pick<NormalizedResponse, "content"> & { usage?: NormalizedResponse["usage"] };
  },
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

interface HeldChatDescription {
  readonly proposalId?: string;
  readonly status: ChatGitChangeScope["descriptionStatus"];
  readonly service?: import("./gitDelivery/prDescriptionTypes.js").PrDescriptionApplicationService;
}

async function holdChatDescriptionProposal(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  chat: Chat,
  scope: ChatGitChangeScope,
  artifact: import("@oscharko-dev/keiko-contracts").PrDescriptionArtifact,
  correlationId: string,
): Promise<HeldChatDescription> {
  if (scope.pullRequestNumber === undefined) {
    return { status: artifact.outcome === "complete" ? "current" : artifact.outcome };
  }
  const repository = await resolveGitChangeApplyOwnerAndRepo(deps, chat, correlationId);
  if (!repository.ok) {
    gitChangeDescriptionTargetUnavailable(deps, correlationId, repository.reason);
    return { status: "blocked" };
  }
  const resolution = resolvePrDescriptionApplicationServiceForRequest(
    deps,
    ctx,
    {
      projectId: chat.projectPath,
      ownerAndRepo: repository.ownerAndRepo,
      prNumber: scope.pullRequestNumber,
      snapshotDigest: scope.snapshotDigest,
    },
    correlationId,
    {},
    gitChangeDescriptionAuthorityScopeFor(scope),
  );
  if (!resolution.ok) return { status: "blocked" };
  const preview = await resolution.service.previewArtifact(artifact);
  return preview.outcome === "preview"
    ? {
        proposalId: preview.preview.proposalId,
        status: preview.preview.status.state,
        service: resolution.service,
      }
    : {
        status: preview.outcome === "observed" ? preview.status.state : "blocked",
        service: resolution.service,
      };
}

function updateChatDescriptionScope(
  deps: UiHandlerDeps,
  chatId: string,
  expected: ChatGitChangeScope,
  held: HeldChatDescription,
): Chat | undefined {
  const current = deps.store.findChatById(chatId);
  const scopes = current?.gitChangeScopes;
  if (current === undefined || scopes === undefined) return undefined;
  const selected = scopes.find((scope) => scope.relationshipId === expected.relationshipId);
  if (selected?.snapshotDigest !== expected.snapshotDigest) return undefined;
  const next = scopes.map((scope): ChatGitChangeScope => {
    if (scope.relationshipId !== expected.relationshipId) return scope;
    const base = { ...scope };
    delete base.descriptionProposalId;
    return {
      ...base,
      descriptionStatus: held.status,
      ...(held.proposalId === undefined ? {} : { descriptionProposalId: held.proposalId }),
    };
  });
  return deps.store.updateChat(chatId, { gitChangeScopes: next });
}

async function generateAdmittedGitChangeTurn(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  scope: ChatGitChangeScope,
  admission: AdmittedTurnHandle,
  signal: AbortSignal,
  correlationId: string,
): Promise<Awaited<ReturnType<typeof generateGitChangeChatDescription>>> {
  const gatewayTurn = captureGatewayTurnSnapshot(deps, prepared.request, admission.userMessage);
  return generateGitChangeChatDescription({
    deps,
    projectPath: prepared.chat.projectPath,
    scope,
    correlationId,
    signal,
    history: gatewayHistoryPrefix(gatewayTurn),
    latestIntent: prepared.request.content,
  });
}

function descriptionTurnResponse(
  content: string,
  usage:
    | import("@oscharko-dev/keiko-model-gateway").PrDescription.PrDescriptionGenerationUsage
    | undefined,
): Pick<NormalizedResponse, "content"> & { usage?: NormalizedResponse["usage"] } {
  return {
    content,
    ...(usage === undefined
      ? {}
      : {
          usage: {
            requestId: usage.requestId,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            latencyMs: usage.latencyMs,
            costClass: usage.costClass,
          },
        }),
  };
}

function gitChangeGenerationFailure(reason: string): RouteResult {
  return reason === "cancelled"
    ? requestCancelledResult()
    : {
        status: reason === "snapshot-unavailable" || reason === "invalid-snapshot" ? 409 : 503,
        body: errorBody(
          "GIT_CHANGE_DESCRIPTION_UNAVAILABLE",
          "The connected Git change could not produce a current description.",
        ),
      };
}

function rejectUnavailableGitChangeGeneration(
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  admission: AdmittedTurnHandle,
  reason: string,
): RouteResult {
  settleRejectedDesktopChatTurn(
    deps,
    prepared,
    admission,
    reason === "cancelled" ? "cancelled" : "failed",
  );
  return gitChangeGenerationFailure(reason);
}

export async function persistGitChangeDescriptionTurn(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  abortSignal: AbortSignal,
): Promise<RouteResult> {
  const scope = activeGitChangeScope(prepared.chat);
  if (scope === undefined)
    return { status: 409, body: errorBody("GIT_CHANGE_SCOPE_NOT_FOUND", "Scope not found.") };
  const admission = admitDesktopChatTurn(deps, prepared);
  if (admission.kind === "replay") return { status: 200, body: admission.response };
  if (admission.kind === "rejected") return admission.result;
  const memory = await resolveBufferedMemory(
    deps,
    prepared,
    admission,
    abortSignal,
    ctx.correlationId,
  );
  if (isRouteResult(memory)) return memory;
  return completeGitChangeDescriptionTurn(
    ctx,
    deps,
    prepared,
    scope,
    admission,
    memory,
    abortSignal,
  );
}

async function completeGitChangeDescriptionTurn(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  prepared: PreparedDesktopChatSend,
  scope: ChatGitChangeScope,
  admission: AdmittedTurnHandle,
  memory: ConversationMemoryResultWire,
  abortSignal: AbortSignal,
): Promise<RouteResult> {
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const generated = await generateAdmittedGitChangeTurn(
    deps,
    prepared,
    scope,
    admission,
    abortSignal,
    correlationId,
  );
  if (generated.status === "unavailable") {
    return rejectUnavailableGitChangeGeneration(deps, prepared, admission, generated.reason);
  }
  const held = await holdChatDescriptionProposal(
    ctx,
    deps,
    prepared.chat,
    scope,
    generated.artifact,
    correlationId,
  );
  if (updateChatDescriptionScope(deps, prepared.chat.id, scope, held) === undefined) {
    held.service?.invalidate();
    failDesktopChatTurn(deps, prepared.request);
    return gitChangeGenerationFailure("snapshot-unavailable");
  }
  const result = await finalizeBufferedTurn(
    deps,
    prepared,
    memory,
    {
      userMessage: admission.userMessage,
      response: descriptionTurnResponse(generated.artifact.markdown, generated.usage),
    },
    abortSignal,
  );
  if (result.status !== 200) {
    held.service?.invalidate();
    updateChatDescriptionScope(deps, prepared.chat.id, scope, { status: "blocked" });
  }
  return result;
}

export async function handleCreateDesktopChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  // Fresh-install gap: verify a usable model on demand BEFORE the sync readiness guard —
  // walking past an unsuitable default (e.g. an OCR model first in the list) so a
  // configured-but-never-probed gateway does not reject the very first chat. The walk runs
  // only for a DEFAULTED request: for an explicit modelId the admission validates that model
  // alone, so probing its siblings could never change the outcome — it would only add their
  // probe latency to an already-decided answer.
  const explicitModelId = explicitChatModelId(body);
  await (explicitModelId === undefined
    ? ensureAnyConversationReadyChatModel(deps, defaultChatModelId(deps))
    : ensureOnDemandConversationReadiness(deps, explicitModelId));
  const modelId = modelFromBody(body, deps);
  if (isRouteResult(modelId)) {
    logChatCreationRejection(
      ctx,
      deps,
      explicitModelId ?? defaultChatModelId(deps),
      modelId.status,
    );
    return modelId;
  }
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

export interface DesktopChatExecutionAdmission {
  readonly gatewayConfigGeneration: number | undefined;
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
  readonly executionAdmission: DesktopChatExecutionAdmission;
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

export function captureDesktopChatExecutionAdmission(
  request: SendDesktopChatRequest,
  chat: Chat,
  modelId: string,
  deps: UiHandlerDeps,
  rejectionContext?: ChatReadinessRejectionContext,
): DesktopChatExecutionAdmission | RouteResult {
  const invalidExecution = validateDesktopChatExecution(request, chat, modelId, deps);
  const rejectionReason =
    invalidExecution === undefined ? undefined : chatExecutionRejectionReason(invalidExecution);
  if (
    invalidExecution !== undefined &&
    rejectionContext !== undefined &&
    rejectionReason !== undefined
  ) {
    logChatRejection(
      rejectionContext.operation,
      rejectionContext.correlationId,
      modelId,
      deps,
      invalidExecution.status,
      rejectionReason,
    );
  }
  return invalidExecution ?? { gatewayConfigGeneration: deps.gatewayConfig?.generation() };
}

export function validateDesktopChatProviderBoundary(
  modelId: string,
  admission: DesktopChatExecutionAdmission,
  deps: UiHandlerDeps,
): RouteResult | undefined {
  const reason = desktopChatProviderBoundaryRejectionReason(modelId, admission, deps);
  if (reason === undefined) return undefined;
  if (reason === "generation") {
    return {
      status: 409,
      body: errorBody(
        "GATEWAY_CONFIG_CHANGED",
        "The model gateway configuration changed before the turn could run.",
      ),
    };
  }
  return unreadyChatModelResult();
}

export function desktopChatProviderBoundaryRejectionReason(
  modelId: string,
  admission: DesktopChatExecutionAdmission,
  deps: UiHandlerDeps,
): ChatRejectionReason | undefined {
  const holder = deps.gatewayConfig;
  if (holder === undefined) return undefined;
  if (holder.generation() !== admission.gatewayConfigGeneration) return "generation";
  return currentConversationReady(deps, modelId) ? undefined : "readiness";
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

// ─── Issue #3400 (epic #3384) — git-change description-authority admission ─────────────────────
//
// A chat's connected git-change scope is not model-egress authority by itself (Architecture
// Invariants: "Connecting context is not model-egress authority"). Every turn on a git-change-
// scoped chat re-derives the server-minted description authority (#3399, contract correction 4)
// before any snapshot content reaches the Model Gateway. `deps.gitChangeDescriptionAuthorityPort`
// is a direct, official `UiHandlerDeps` field (description-composition-closeout): production
// composition threads the SAME minted port onto it and onto `gitDeliveryDescriptionAuthority`
// (deps.test.ts pins the two are `===`) — `undefined` (an unqualified runtime host, or a test
// fixture that never wired one) fails admission CLOSED, never open: no port to consult is exactly
// the same as no live authority record.

// The scope always keys on the immutable base/head pair rather than a PR identity: `remoteDigest`
// (correction 6) plus `baseRef`/`headRef` are present on every connected git-change scope whether
// or not a pull request was resolved, while the PR-identity variant of
// `GitDeliveryDescriptionAuthorityScope` needs an `ownerAndRepo` slug this wire shape deliberately
// does not carry (correction 2 admits only safe, server-issued facts). Whichever module mints this
// authority for a Chat-originated scope (#3399/#3401) must mint it under the SAME
// (remoteDigest, {baseRef, headRef}, snapshotDigest) key for this admission check to find it.
// Exported (final-audit F4, #3400) so the git-change connect flow (gitChangeRoutes.ts) can mint an
// authority record under the EXACT SAME scope shape this admission check derives — one formula,
// never a second, independently-drifting copy of it at the mint call site.
// #3400/#3401 final-audit F1: the closed reason a denied Chat admission carries — distinguishes a
// description authority record that existed for the exact scope but has passed its `expiresAt`
// from every other closed case (no port wired at all, or a scope that was never minted), reusing
// `authorizeGitDeliveryModelEgress`'s own expired-vs-absent discriminant rather than a second one.
export type GitChangeDescriptionTurnDenial = "authority-expired" | "model-egress-denied";

export type GitChangeDescriptionTurnAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: GitChangeDescriptionTurnDenial };

/**
 * Admits only when a live, unexpired description authority record exists for the EXACT scope
 * (remoteDigest, base/head, snapshotDigest) the caller re-derived just now — never a cached or
 * assumed admission. A denial carries the closed reason: `authority-expired` when the record was
 * minted for this exact scope and has since expired, `model-egress-denied` for every other closed
 * case (no port wired, or a scope that was never minted).
 */
export function admitGitChangeDescriptionTurn(
  deps: UiHandlerDeps,
  scope: ChatGitChangeScope,
  nowIso: string,
): GitChangeDescriptionTurnAdmission {
  const port = deps.gitChangeDescriptionAuthorityPort;
  if (port === undefined) return { admitted: false, reason: "model-egress-denied" };
  const decision = authorizeGitDeliveryModelEgress(
    port,
    gitChangeDescriptionAuthorityScopeFor(scope),
    nowIso,
  );
  if (decision.allowed) return { admitted: true };
  return {
    admitted: false,
    reason: decision.reason === "authority-expired" ? "authority-expired" : "model-egress-denied",
  };
}

function logGitChangeTurnAuthority(
  correlationId: string | undefined,
  admission: GitChangeDescriptionTurnAdmission,
  relationshipId: string,
): void {
  getServerLogger()[admission.admitted ? "info" : "warn"]({
    category: "security",
    op: admission.admitted
      ? "pr-description.chat.turn.admitted"
      : "pr-description.chat.turn.denied",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    ...(admission.admitted ? {} : { errorKind: admission.reason }),
    extra: { relationshipId },
  });
}

// V1 connects at most one git-change comparison per chat in practice; a chat that somehow carries
// several treats the most-recently-connected one as the active turn scope.
export function activeGitChangeScope(chat: Chat): ChatGitChangeScope | undefined {
  const scopes = chat.gitChangeScopes;
  return scopes?.at(-1);
}

/**
 * Denies a normal Chat turn on a git-change-connected chat BEFORE the Model Gateway is reached
 * when the description authority for its active scope is missing or expired. Returns `undefined`
 * (proceed) for a chat with no connected git-change scope at all.
 */
// Exported so the streaming send path (chat-stream-handlers.ts) re-derives the SAME admission —
// via the SAME formula, never a restated copy — rather than only the buffered /api/desktop/chat
// path gating a git-change-connected chat. Both are real client transports for sending a turn.
export function admitGitChangeScopedTurn(
  deps: UiHandlerDeps,
  chat: Chat,
  acceptedMode: CodingWorkbenchMode | undefined,
  correlationId: string,
): RouteResult | undefined {
  const scope = activeGitChangeScope(chat);
  if (scope === undefined) return undefined;
  if (acceptedMode === undefined || deps.mintDescriptionAuthority === undefined) {
    const admission = { admitted: false, reason: "model-egress-denied" } as const;
    logGitChangeTurnAuthority(correlationId, admission, scope.relationshipId);
    return {
      status: 409,
      body: errorBody(
        "GIT_CHANGE_DESCRIPTION_AUTHORITY_DENIED",
        "The description authority for this connected Git change is missing or has expired.",
      ),
    };
  }
  const nowIso = new Date().toISOString();
  deps.mintDescriptionAuthority({
    scope: gitChangeDescriptionAuthorityScopeFor(scope),
    requestedMode: acceptedMode,
    nowIso,
    correlationId,
  });
  const admission = admitGitChangeDescriptionTurn(deps, scope, nowIso);
  logGitChangeTurnAuthority(correlationId, admission, scope.relationshipId);
  if (admission.admitted) return undefined;
  return {
    status: 409,
    body: errorBody(
      "GIT_CHANGE_DESCRIPTION_AUTHORITY_DENIED",
      "The description authority for this connected Git change is missing or has expired.",
    ),
  };
}

export function acceptedGitChangeChatMode(
  deps: UiHandlerDeps,
  request: Pick<SendDesktopChatRequest, "memory">,
): CodingWorkbenchMode | undefined {
  const requestedMode = request.memory?.mode;
  return requestedMode === undefined
    ? undefined
    : resolveMemoryCaptureAutonomyMode(deps, requestedMode);
}

// ─── Issue #3400 — apply routes only through the description application service (#3399) ────────
//
// Frozen Product Decision 6 / issue correction 1: the ONLY admitted write from a git-change-
// connected Chat is a body-only description apply through the existing #3399 service. Final-audit
// F7: production composition now reaches this handler with a real, composed
// `PrDescriptionApplicationService` (`deps.prDescriptionApplicationService`, deps.ts's own
// composition root) — a typed field, no optional-cast seam. Absent under the same closed
// condition `deps.prDescriptionGeneration` is absent under (no configured model profile), apply is
// unavailable — it NEVER falls back to `executeGovernedPullRequest` (prExecution.ts), which is the
// only other PR-update path and is coupled title+body+base, not body-only.

/**
 * Applies an already-approved PR-description proposal through the existing body-only service.
 * Returns `undefined` when the service is not yet composed (apply unavailable) rather than
 * substituting any other write path.
 */
export function applyGitChangeDescription(
  deps: UiHandlerDeps,
  proposalId: string,
  lease: object,
): Promise<PrDescriptionApplicationResult> | undefined {
  return deps.prDescriptionApplicationService?.executeApproved(proposalId, lease);
}

// ─── Issue #3400 — the real handler Chat reaches for the apply action (final-audit F5) ──────────
//
// Before this fix, `applyGitChangeDescription` above had zero production callers: nothing ever
// invoked it from a route, so the apply effect was reachable only in tests. This handler is that
// caller. A Chat-connected git-change scope only ever names a repository via `remoteDigest`
// (contract correction 6) and only carries a `pullRequestNumber` once a PR was resolved at connect
// time, so `ownerAndRepo` (the raw slug #3399's admission needs) is re-derived live from the SAME
// trusted repository root the connect flow used, through the SAME git-membership check
// (`resolveChatRepository`) and the SAME GitHub-reader authorization gate every other git-change
// route reuses -- never a fresh, browser-authored identity.
//
// routes.ts registers the approve/review/apply handlers lazily to avoid the existing ESM cycle;
// every request names only the server-held Chat scope and proposal.
interface GitChangeApplyDescriptionRequest {
  readonly chatId: string;
  readonly relationshipId: string;
  readonly proposalId: string;
}

const GIT_CHANGE_APPLY_DESCRIPTION_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "chatId",
  "relationshipId",
  "proposalId",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Every field beyond this closed set is rejected before any lookup runs -- the same
// "binding smuggling" guard prDescriptionRoutes.ts's own `baseFields` applies: a request that adds
// `ownerAndRepo`, `prNumber`, or any other field this action never accepts is refused at
// validation, never silently ignored.
function parseGitChangeApplyDescriptionRequest(
  value: unknown,
): GitChangeApplyDescriptionRequest | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, GIT_CHANGE_APPLY_DESCRIPTION_KEYS)) {
    return undefined;
  }
  if (value.schemaVersion !== "1") return undefined;
  const { chatId, relationshipId, proposalId } = value;
  if (!nonEmptyString(chatId) || !nonEmptyString(relationshipId) || !nonEmptyString(proposalId)) {
    return undefined;
  }
  return { chatId, relationshipId, proposalId };
}

interface FoundGitChangeApplyScope {
  readonly chat: Chat;
  readonly scope: ChatGitChangeScope;
}

function findConnectedGitChangeScope(
  deps: UiHandlerDeps,
  chatId: string,
  relationshipId: string,
): FoundGitChangeApplyScope | undefined {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined) return undefined;
  const scope = (chat.gitChangeScopes ?? []).find(
    (entry) => entry.relationshipId === relationshipId,
  );
  return scope === undefined ? undefined : { chat, scope };
}

// Re-derives `ownerAndRepo` live rather than reading it from the persisted scope (which never
// stores it -- only its `remoteDigest`, contract correction 6): the SAME resolution the connect
// flow performs for pull-request mode, so a live apply always checks the repository's CURRENT
// GitHub-reader grant rather than trusting one observed at connect time.
type GitChangeRepositoryResolution =
  | { readonly ok: true; readonly ownerAndRepo: string }
  | {
      readonly ok: false;
      readonly reason: "repository-unavailable" | "reader-unauthorized" | "remote-unresolved";
    };

async function resolveGitChangeApplyOwnerAndRepo(
  deps: UiHandlerDeps,
  chat: Chat,
  correlationId: string,
): Promise<GitChangeRepositoryResolution> {
  const runner = observedGitRunner(
    defaultGitProcessRunner,
    deps.activityLog ?? processServerLogSink(),
    correlationId,
  );
  const repository = await resolveChatRepository(chat.projectPath, runner, 30_000);
  if (repository === undefined) return { ok: false, reason: "repository-unavailable" };
  if (!isGitHubIssueReaderAuthorized(deps, repository.repositoryRoot, { correlationId })) {
    return { ok: false, reason: "reader-unauthorized" };
  }
  const ownerAndRepo = await githubRemoteOwnerAndRepoFor(
    repository.repositoryRoot,
    deps.env,
    undefined,
    { correlationId },
  );
  return ownerAndRepo === undefined
    ? { ok: false, reason: "remote-unresolved" }
    : { ok: true, ownerAndRepo };
}

function gitChangeApplyUnavailableResult(): RouteResult {
  return {
    status: 409,
    body: errorBody(
      "GIT_CHANGE_APPLY_UNAVAILABLE",
      "This connected Git change has no pull request to apply a description to.",
    ),
  };
}

function gitChangeDescriptionTargetUnavailable(
  deps: UiHandlerDeps,
  correlationId: string,
  reason: Exclude<GitChangeRepositoryResolution, { readonly ok: true }>["reason"],
): RouteResult {
  (deps.activityLog ?? processServerLogSink()).write({
    category: "security",
    op: "git-change.chat.description-target.denied",
    correlationId,
    level: "warn",
    errorKind: reason,
  });
  const unauthorized = reason === "reader-unauthorized";
  return {
    status: unauthorized ? 403 : 409,
    body: errorBody(
      unauthorized
        ? "GIT_CHANGE_APPLY_READER_UNAUTHORIZED"
        : reason === "repository-unavailable"
          ? "GIT_CHANGE_APPLY_REPOSITORY_UNAVAILABLE"
          : "GIT_CHANGE_APPLY_REMOTE_UNRESOLVED",
      unauthorized
        ? "Repository-reader authority is required for this connected Git change."
        : "The connected Git repository identity is unavailable.",
    ),
  };
}

interface GitChangeApplyDescriptionTarget {
  readonly request: GitChangeApplyDescriptionRequest;
  readonly baseFields: PrDescriptionBaseFields;
  readonly scope: ChatGitChangeScope;
}

async function resolveGitChangeApplyTarget(
  deps: UiHandlerDeps,
  request: GitChangeApplyDescriptionRequest,
  correlationId: string,
): Promise<GitChangeApplyDescriptionTarget | RouteResult> {
  const found = findConnectedGitChangeScope(deps, request.chatId, request.relationshipId);
  if (found === undefined) {
    return { status: 404, body: errorBody("GIT_CHANGE_SCOPE_NOT_FOUND", "Scope not found.") };
  }
  if (found.scope.pullRequestNumber === undefined) return gitChangeApplyUnavailableResult();
  const repository = await resolveGitChangeApplyOwnerAndRepo(deps, found.chat, correlationId);
  if (!repository.ok) {
    return gitChangeDescriptionTargetUnavailable(deps, correlationId, repository.reason);
  }
  return {
    request,
    scope: found.scope,
    baseFields: {
      projectId: found.chat.projectPath,
      ownerAndRepo: repository.ownerAndRepo,
      prNumber: found.scope.pullRequestNumber,
      snapshotDigest: found.scope.snapshotDigest,
    },
  };
}

function logGitChangeApplyOutcome(
  deps: UiHandlerDeps,
  correlationId: string,
  outcome: PrDescriptionApplicationResult["outcome"],
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "git-change.chat.apply",
    correlationId,
    extra: { outcome },
  });
}

/**
 * Final-audit F5: the real handler Chat reaches for the apply action. Resolves the connected
 * git-change scope, reuses #3399's own admitted service factory for the exact (project,
 * repository, PR) the scope now names, consumes the one-use approval, and executes through
 * `applyGitChangeDescription` above -- the SAME narrow gateway, never a second write path.
 */
export const createHandleGitChangeApplyDescription = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const cancellation = createRequestCancellation(ctx, "git-change description apply cancelled");
    const parsed = await readJsonObject(ctx.req, cancellation.signal).finally(cancellation.dispose);
    if (isRouteResult(parsed)) return parsed;
    const request = parseGitChangeApplyDescriptionRequest(parsed);
    if (request === undefined) {
      return { status: 400, body: errorBody("BAD_REQUEST", "Invalid apply-description request.") };
    }
    const target = await resolveGitChangeApplyTarget(deps, request, correlationId);
    if (!("baseFields" in target)) return target;
    const resolution = resolvePrDescriptionApplicationServiceForRequest(
      deps,
      ctx,
      target.baseFields,
      correlationId,
      options,
      gitChangeDescriptionAuthorityScopeFor(target.scope),
    );
    if (!resolution.ok) return resolution.result;
    const lease = resolution.service.consumeApproval(request.proposalId);
    if (lease === undefined) {
      return {
        status: 409,
        body: errorBody("GIT_CHANGE_APPLY_UNKNOWN_PROPOSAL", "Proposal is unknown or expired."),
      };
    }
    const applied = await applyGitChangeDescription(
      { ...deps, prDescriptionApplicationService: resolution.service },
      request.proposalId,
      lease,
    );
    if (applied === undefined) return gitChangeApplyUnavailableResult();
    updateChatDescriptionScope(deps, target.request.chatId, target.scope, {
      status: applied.outcome === "observed" ? applied.status.state : "blocked",
    });
    logGitChangeApplyOutcome(deps, correlationId, applied.outcome);
    return { status: 200, body: deps.redactor(applied) };
  };
};

/** Issues the one-use approval for the exact Chat-held artifact and snapshot-bound service. */
export const createHandleGitChangeApproveDescription = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const cancellation = createRequestCancellation(
      ctx,
      "git-change description approval cancelled",
    );
    const parsed = await readJsonObject(ctx.req, cancellation.signal).finally(cancellation.dispose);
    if (isRouteResult(parsed)) return parsed;
    const request = parseGitChangeApplyDescriptionRequest(parsed);
    if (request === undefined) {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "Invalid approve-description request."),
      };
    }
    const target = await resolveGitChangeApplyTarget(deps, request, correlationId);
    if (!("baseFields" in target)) return target;
    const resolution = resolvePrDescriptionApplicationServiceForRequest(
      deps,
      ctx,
      target.baseFields,
      correlationId,
      options,
      gitChangeDescriptionAuthorityScopeFor(target.scope),
    );
    if (!resolution.ok) return resolution.result;
    const issued = resolution.service.issueApproval(request.proposalId);
    if (issued === undefined) {
      return {
        status: 409,
        body: errorBody("GIT_CHANGE_APPROVE_UNKNOWN_PROPOSAL", "Proposal is unknown or expired."),
      };
    }
    return {
      status: 200,
      body: deps.redactor({
        schemaVersion: "1",
        proposalId: request.proposalId,
        expiresAt: new Date(issued.expiresAtMs).toISOString(),
      }),
    };
  };
};

/** Returns the exact Chat-held proposal body without invoking description generation again. */
export const createHandleGitChangeReviewDescription = (
  options: PrDescriptionRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const cancellation = createRequestCancellation(ctx, "git-change description review cancelled");
    const parsed = await readJsonObject(ctx.req, cancellation.signal).finally(cancellation.dispose);
    if (isRouteResult(parsed)) return parsed;
    const request = parseGitChangeApplyDescriptionRequest(parsed);
    if (request === undefined) {
      return { status: 400, body: errorBody("BAD_REQUEST", "Invalid review-description request.") };
    }
    const target = await resolveGitChangeApplyTarget(deps, request, correlationId);
    if (!("baseFields" in target)) return target;
    const resolution = resolvePrDescriptionApplicationServiceForRequest(
      deps,
      ctx,
      target.baseFields,
      correlationId,
      options,
      gitChangeDescriptionAuthorityScopeFor(target.scope),
    );
    if (!resolution.ok) return resolution.result;
    const review = resolution.service.review(request.proposalId);
    return review === undefined
      ? {
          status: 409,
          body: errorBody("GIT_CHANGE_REVIEW_UNKNOWN_PROPOSAL", "Proposal is unknown or expired."),
        }
      : { status: 200, body: deps.redactor({ outcome: "preview", preview: review }) };
  };
};

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
    if (activeGitChangeScope(prepared.chat) === undefined) {
      await ensureOnDemandConversationReadiness(deps, prepared.modelId);
    }
    const gitChangeDenial = admitGitChangeScopedTurn(
      deps,
      prepared.chat,
      acceptedGitChangeChatMode(deps, prepared.request),
      ctx.correlationId,
    );
    if (gitChangeDenial !== undefined) return gitChangeDenial;
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
        // Re-derived immediately before dispatch (not only at the earlier fast-fail check above):
        // a queued turn may wait long enough for the authority to expire in between.
        const gitChangeDenial = admitGitChangeScopedTurn(
          deps,
          current.chat,
          acceptedGitChangeChatMode(deps, current.request),
          ctx.correlationId,
        );
        if (gitChangeDenial !== undefined) return gitChangeDenial;
        return activeGitChangeScope(current.chat) === undefined
          ? persistModelChatTurn(deps, current, cancellation.signal, ctx.correlationId)
          : persistGitChangeDescriptionTurn(ctx, deps, current, cancellation.signal);
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
  correlationId: string | undefined,
): PreparedDesktopChatRegenerate | RouteResult {
  const normalizedProjectPath = normalizeDesktopProjectPath(request.projectPath, deps);
  if (isRouteResult(normalizedProjectPath)) return normalizedProjectPath;
  const chat = findChat(deps, normalizedProjectPath, request.chatId);
  if (chat === undefined) return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  const closed = chatClosedResult(chat);
  if (closed !== undefined) return closed;
  if (hasGroundingScope(chat)) return groundedRegenerateResult();
  const modelId = request.modelId ?? chat.selectedModel;
  const invalidModel = invalidRegenerationModelResult(modelId, deps, correlationId);
  if (invalidModel !== undefined) return invalidModel;
  const executionAdmission = captureGatewayGeneration(deps);
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
  return { request, chat, modelId, turn, memoryRequest, memoryContext, executionAdmission };
}

function invalidRegenerationModelResult(
  modelId: string,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): RouteResult | undefined {
  const invalidModel = invalidChatModelResult(modelId, deps);
  if (invalidModel === undefined) return undefined;
  if (chatExecutionRejectionReason(invalidModel) === "readiness") {
    logChatRejection(
      "chat.regeneration.rejected",
      correlationId,
      modelId,
      deps,
      invalidModel.status,
    );
  }
  return invalidModel;
}

function captureGatewayGeneration(deps: UiHandlerDeps): DesktopChatExecutionAdmission {
  return { gatewayConfigGeneration: deps.gatewayConfig?.generation() };
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
  correlationId: string | undefined,
): Promise<RouteResult> {
  const { chat, modelId, memoryRequest, executionAdmission } = prepared;
  try {
    const { memory, messages } = await buildRegenerateMemoryAndMessages(deps, prepared);
    if (requestSignalAborted(signal)) return requestCancelledResult();
    const model = bufferedModelAtProviderBoundary(
      deps,
      modelId,
      executionAdmission,
      correlationId,
      "chat.regeneration.rejected",
    );
    if (isRouteResult(model)) return model;
    const response = await model.call(
      { modelId, messages, stream: false, logContext: { correlationId } },
      signal,
    );
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
    return signal.aborted
      ? requestCancelledResult()
      : desktopChatErrorResult(error, deps, correlationId);
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
        const current = prepareDesktopChatRegenerateRequest(
          prepared.request,
          deps,
          ctx.correlationId,
        );
        return isRouteResult(current)
          ? current
          : persistRegeneratedChatTurn(deps, current, cancellation.signal, ctx.correlationId);
      },
    );
    return result === CHAT_TURN_WAIT_CANCELLED ? requestCancelledResult() : result;
  } finally {
    cancellation.dispose();
  }
}
