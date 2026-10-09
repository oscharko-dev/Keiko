import { evidenceAtomStableId } from "@oscharko-dev/keiko-workspace";
import type { GroundedAnswerOptions } from "./grounded-orchestrator.js";
import type { ContinuityReferentSource } from "@oscharko-dev/keiko-contracts/connected-context";
import type { RetrievalIntent, SearchReference } from "@oscharko-dev/keiko-workflows";
import {
  caughtGroundedPackValidation,
  inspectGroundedPack,
  recordGroundedPackValidation,
  GROUNDED_PACK_VALIDATION_MESSAGE,
} from "./grounded-pack-validation.js";
import {
  deriveChatGroundingScopeIdentity,
  parseExpectedGroundingScopeIdentity,
} from "./store/chat-grounding-scope-identity.js";
import { withAdoptedContextWindowRetry } from "./gateway-context-window.js";
import { sentPromptContext, type SentGroundedPrompt } from "./grounded-prompt-context.js";
import { compactCurrentChatPrompt } from "./chat-prompt-compaction.js";
import { logChatResponseMessage } from "./chat-activity.js";
import {
  groundedConversationContinuity,
  type GroundedConversationContinuity,
} from "./grounded-conversation-continuity.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
// BFF route POST /api/chats/messages/grounded (Issue #185 / Epic #177). Composes the
// orchestrator's pure pipeline with the UiStore so a single HTTP round trip persists both
// the user question and the assistant answer alongside a redacted citation projection.
// All path validation runs in the composed layers; this module only validates wire-shape
// inputs (chatId + content) and enforces that the chat carries a connected scope.

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { basename } from "node:path";
import {
  CancelledError,
  ContextOverflowError,
  GatewayError,
  ProviderError,
  findCapability,
  findConfiguredCapability,
  resolveCostClass,
  type ChatMessage as GatewayChatMessage,
  type ModelCapability,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { DEFAULT_LEXICAL_MATCH_LIMIT } from "@oscharko-dev/keiko-workflows";
import {
  persistConnectedContextEvidence,
  type ConnectedContextEvidenceInput,
} from "@oscharko-dev/keiko-evidence";
import { redact } from "@oscharko-dev/keiko-security";
import {
  isDenied,
  PathDeniedError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  WorkspaceNotFoundError,
  WorkspaceError,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import {
  connectedContextOmittedCount,
  connectedContextOmittedCounts,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  isValidScopePath,
  type ConnectedContextPack,
  type ContextExcerpt,
  type EvidenceAtom,
  type ExplorationBudget,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  buildGroundedAnswerContextPackSummary,
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  MAX_DESKTOP_CHAT_INPUT_CHARS,
  type ConversationMemoryResultWire,
  type GroundedAnswer,
  type GroundedAnswerContextPackSummary,
  type GroundedEvidenceCitation,
  type GroundedUncertainty,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { GroundedAnswerEvidenceDeclaration } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  deriveContextProfileFromCapability,
  DEFAULT_CONTEXT_PROFILE,
  maxUtf8BytesForTokenBudget,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";

import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import {
  currentContextProfileForModel,
  currentGatewayConfig,
  currentGroundingLimits,
  currentRedactionSecrets,
} from "./deps.js";
import type { Chat, ChatConnectedScope, ChatMessage } from "./store/index.js";
import {
  ClarificationNeededError,
  clarificationUserMessage,
  runGroundedExploration,
  type GroundedAnswerer,
  type OrchestratorInput,
  type OrchestratorOutput,
} from "./grounded-orchestrator.js";
import { createEntailmentStage, type EntailmentStage } from "./grounded-entailment-stage.js";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import { microIndexForGroundedScope } from "./grounded-context-index.js";
import { deriveGroundedContextAssembly } from "./grounded-context-diagnostics.js";
import { configuredContextPackRerankerFor } from "./grounded-context-pack-reranker.js";
import { configuredRepoSemanticSearchProviderLeaseFor } from "./grounded-repo-semantic-search.js";
import { handleLocalKnowledgeGroundedAsk } from "./local-knowledge-grounded-qa.js";
import {
  buildConnectedScopes,
  createMultiSourceAnswerer,
  defaultRetriever,
  groundedSourceScopeFingerprint,
  runMultiSourceAsk,
  type GroundedRetriever,
  type MultiSourceAnswerer,
} from "./grounded-qa-multi-source.js";
import {
  buildLocalKnowledgeScopes,
  runHybridGroundedAsk,
  type ConnectorRetrieve,
  type EntailmentStageFactory,
  type FolderRetriever,
  type HybridAnswerer,
} from "./grounded-qa-hybrid.js";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import {
  isExpectedWorkspaceRootFailure,
  recordWorkspaceRootDenial,
  recordWorkspaceRootDenied,
  recordWorkspaceRootUnavailable,
  resolveRecordedWorkspaceRoot,
  workspaceRootFailureStatus,
  type WorkspaceRootDenialLogContext,
} from "./workspace-root-denial-log.js";
import {
  uncitedMemoryContextMarker,
  connectedSearchNoEvidenceAnswer,
  type NumericEntailmentEvidence,
} from "./grounded-faithfulness.js";
import {
  commitGroundedTurn,
  discardGroundedTurn,
  rememberGroundedTurn,
  stageGroundedTurn,
  type GroundedTurnRecord,
} from "./grounded-turn-registry.js";
import { assertUsableAssistantContent } from "./assistant-response.js";
import {
  buildCanonicalTurnMemoryResult,
  buildMemoryResult,
  chatClosedResult,
  parseClientTurnId,
  parseMemoryRequest,
  logChatRejection,
  runPostCommitCanonicalTurnMemorySideEffects,
  type CanonicalTurnMemoryRequest,
  type ParsedConversationMemoryRequest,
} from "./chat-handlers.js";
import {
  canonicalChatTurnGroundingScopeIdentity,
  canonicalChatTurnIdentityContent,
  canonicalChatTurnMemorySemantics,
} from "./chat-turn-identity.js";
import { CHAT_TURN_WAIT_CANCELLED, runSerializedChatTurn } from "./chat-turn-serializer.js";
import { createRequestCancellation } from "./request-cancellation.js";
import {
  beginAppSessionOperation,
  resolveAppSessionReadAuthority,
} from "./coding-app-session/appSessionReadAuthority.js";
import {
  createOrdinaryWorkspaceRootAccess,
  requiresConfiguredManagedWorkspaceAuthority,
  resolveManagedWorkspaceRootAccess,
  type WorkspaceRootAccess,
} from "./task-workspace/workspace-root-access.js";
import {
  readBoundedRequestBody,
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
} from "./bounded-request-body.js";
import {
  resolveConversationMemoryContext,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { renderConversationMemoryContextBlock } from "./conversation-prompt.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { evidenceRetentionObserver } from "./evidence-retention-log.js";
import { emitGatewayErrorDiagnostic } from "./gateway-error-diagnostic.js";
import {
  buildAnswerCitations as projectAnswerCitations,
  buildPackCitations,
  documentFormatForAtom,
} from "./grounded-citation-projection.js";
import { persistGroundedExchange } from "./grounded-message-persistence.js";
import { awaitInitializedConversationReadiness } from "./gateway-readiness.js";
import {
  captureConversationReadinessAdmission,
  mappedConversationReadinessError,
  validateConversationReadinessAdmission,
  withConversationReadinessAdmission,
  type ConversationReadinessAdmission,
} from "./conversation-readiness-admission.js";

export { persistGroundedExchange } from "./grounded-message-persistence.js";

// ─── Body parsing (mirrors store-handlers' bounded reader) ────────────────────

// Keep the grounded and plain canonical-chat admission envelope identical. JSON escaping can
// expand a valid 256 kB transcript by up to six bytes per code unit; the content itself remains
// authoritatively bounded by UTF-8 bytes in parseBody.
const MAX_BODY_BYTES = 2_000_000;

export function badRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

export function clarificationRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("CLARIFICATION_NEEDED", message) };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: errorBody("NOT_FOUND", message) };
}

function payloadTooLarge(): RouteResult {
  return {
    status: 413,
    body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
  };
}

export function internalError(message: string, correlationId?: string): RouteResult {
  return { status: 500, body: errorBody("INTERNAL", message, correlationId) };
}

function groundedCompletionFailure(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  completionKind: "conflict",
): RouteResult {
  const message = "Canonical grounded chat turn completion conflicted.";
  emitServerDiagnostic(deps.diagnostics, {
    ...serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(correlationId),
      operation: "POST /api/chats/messages/grounded",
      source: "grounded.qa.turn-completion",
      error: new Error(message),
      summary: "grounded-turn-completion-conflicted",
      redact: (value): string => redactString(deps.redactor, value),
    }),
    code: "GROUNDED_TURN_COMPLETION_CONFLICTED",
    httpStatus: 500,
    diagnosticStage: "grounded-turn-completion",
    diagnosticOutcome: "request-failed",
    completionKind,
  });
  return internalError(message, correlationId);
}

export function mappedContextPackValidationError(
  error: unknown,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): RouteResult | undefined {
  const failure = caughtGroundedPackValidation(error);
  if (failure === undefined) return undefined;
  recordGroundedPackValidation(deps, correlationId, failure, "request-failed");
  return internalError(GROUNDED_PACK_VALIDATION_MESSAGE, correlationId);
}

// Issue #154 (GAP-B) — the dynamic `error.message` of a GatewayError may echo the provider base
// URL, an `Authorization: Bearer …` header, or an `api-key: …` value back from the provider's
// response. It is scrubbed through the SAME boundary as the desktop chat path
// (redact + currentRedactionSecrets) before crossing the browser wire. The static `error.code`
// enum and the fixed cancellation string carry no caller data and stay verbatim. Reading the LIVE
// secrets via currentRedactionSecrets(deps) (not the startup snapshot) scrubs apiKey/baseUrl values
// added through PATCH /api/gateway/config after process start (Epic #177).
export function gatewayErrorStatus(error: GatewayError): number {
  if (error.code === "GATEWAY_AUTHENTICATION") return 401;
  if (error.retryable) return 503;
  return 502;
}

// ADR-0173 D5 g25/g27 — mirrors the buffered desktop chat path (`chat-handlers.ts`): a GatewayError
// mapped straight to an HTTP response used to leave no trace in the operator diagnostic sink, unlike
// the SSE chat path, which already routed the same error class through it. A cancellation is the
// caller's own choice, not a failure, so it is excluded — matching the buffered path's convention
// of never diagnosing an intentional cancel.
function gatewayErrorResult(
  error: GatewayError,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): RouteResult {
  if (error instanceof CancelledError) {
    return { status: 499, body: errorBody(error.code, "Grounded request was cancelled.") };
  }
  emitGatewayErrorDiagnostic(
    deps,
    error,
    correlationId,
    "POST /api/chats/messages/grounded",
    "grounded.qa",
  );
  const status = gatewayErrorStatus(error);
  const message = redact(error.message, currentRedactionSecrets(deps));
  return { status, body: errorBody(error.code, message) };
}

export function mappedGatewayError(
  error: unknown,
  deps: UiHandlerDeps,
  correlationId?: string,
): RouteResult | undefined {
  return (
    mappedConversationReadinessError(error) ??
    (error instanceof GatewayError ? gatewayErrorResult(error, deps, correlationId) : undefined)
  );
}

function pathDeniedResult(error: PathDeniedError): RouteResult {
  return {
    status: 400,
    body: errorBody(error.code, "The workspace path is denied by policy."),
  };
}

function primaryWorkspaceFailure(error: unknown): unknown {
  if (!(error instanceof AggregateError)) return error;
  const primary: unknown = error.cause;
  if (primary instanceof WorkspaceError) return primary;
  if (primary instanceof Error && primary.cause instanceof WorkspaceError) return primary.cause;
  return error;
}

function unavailableWorkspaceResult(error: unknown, correlationId?: string): RouteResult {
  return workspaceRootFailureStatus(error) === 503
    ? {
        status: 503,
        body: errorBody(
          "UNAVAILABLE",
          "The connected source is temporarily unavailable. Please try again.",
          correlationId,
        ),
      }
    : badRequest("Connected scope root is not accessible.");
}

export function mappedWorkspaceError(
  error: unknown,
  context: WorkspaceRootDenialLogContext = {},
): RouteResult | undefined {
  const failure = primaryWorkspaceFailure(error);
  if (failure instanceof PathDeniedError) return pathDeniedResult(failure);
  if (failure instanceof WorkspaceNotFoundError) {
    recordWorkspaceRootUnavailable(failure, context);
    return unavailableWorkspaceResult(failure, context.correlationId);
  }
  if (
    failure instanceof RepoSearchInvalidQueryError ||
    failure instanceof RepoSearchInvalidRangeError ||
    failure instanceof RepoSearchUnsupportedFileError
  ) {
    return badRequest(failure.message);
  }
  return undefined;
}

export interface GroundedRetrievalContinuityInput {
  readonly assistantReferents?: readonly SearchReference[] | undefined;
  readonly previousRetrievalIntent?: RetrievalIntent | undefined;
  readonly continuityReferentSource?: ContinuityReferentSource | undefined;
}

export function groundedRetrievalContinuityFields(
  input: GroundedRetrievalContinuityInput,
): GroundedRetrievalContinuityInput {
  return {
    ...(input.assistantReferents === undefined
      ? {}
      : { assistantReferents: input.assistantReferents }),
    ...(input.previousRetrievalIntent === undefined
      ? {}
      : { previousRetrievalIntent: input.previousRetrievalIntent }),
    ...(input.continuityReferentSource === undefined
      ? {}
      : { continuityReferentSource: input.continuityReferentSource }),
  };
}

export interface AskInput extends GroundedRetrievalContinuityInput {
  readonly retrievalContent?: string | undefined;
  readonly chatId: string;
  readonly content: string;
  readonly clientTurnId?: string | undefined;
  readonly expectedGroundingScopeIdentity?: string | undefined;
  readonly answerContent?: string | undefined;
  readonly modelId: string | undefined;
  readonly memory?: ParsedConversationMemoryRequest | undefined;
}

type ParseResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "err"; readonly result: RouteResult };

function parseJsonObject(raw: string): ParseResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { kind: "err", result: badRequest("Request body is not valid JSON.") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "err", result: badRequest("Request body must be a JSON object.") };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}

function parseOptionalModelId(obj: Record<string, unknown>): ParseResult<string | undefined> {
  if (!("modelId" in obj)) return { kind: "ok", value: undefined };
  if (typeof obj.modelId !== "string" || obj.modelId.trim().length === 0) {
    return {
      kind: "err",
      result: badRequest('Field "modelId" must be a non-empty string when provided.'),
    };
  }
  return { kind: "ok", value: obj.modelId.trim() };
}

function parseGroundedExtras(
  obj: Record<string, unknown>,
): ParseResult<Pick<AskInput, "clientTurnId" | "expectedGroundingScopeIdentity" | "memory">> {
  const memory = parseMemoryRequest(obj.memory);
  if (isRouteResult(memory)) return { kind: "err", result: memory };
  const clientTurnId = parseClientTurnId(obj.clientTurnId);
  if (isRouteResult(clientTurnId)) return { kind: "err", result: clientTurnId };
  const expectedGroundingScopeIdentity = parseExpectedGroundingScopeIdentity(
    obj.expectedGroundingScopeIdentity,
  );
  if (isRouteResult(expectedGroundingScopeIdentity)) {
    return { kind: "err", result: expectedGroundingScopeIdentity };
  }
  return {
    kind: "ok",
    value: {
      ...(memory === undefined ? {} : { memory }),
      ...(clientTurnId === undefined ? {} : { clientTurnId }),
      ...(expectedGroundingScopeIdentity === undefined ? {} : { expectedGroundingScopeIdentity }),
    },
  };
}

function parseBody(raw: string): ParseResult<AskInput> {
  const objResult = parseJsonObject(raw);
  if (objResult.kind === "err") return objResult;
  const obj = objResult.value;
  const chatId = typeof obj.chatId === "string" ? obj.chatId : "";
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  const modelIdResult = parseOptionalModelId(obj);
  if (modelIdResult.kind === "err") return modelIdResult;
  if (chatId.length === 0) {
    return { kind: "err", result: badRequest('Field "chatId" is required.') };
  }
  if (
    content.length === 0 ||
    content.length > MAX_DESKTOP_CHAT_INPUT_CHARS ||
    Buffer.byteLength(content, "utf8") > MAX_DESKTOP_CHAT_INPUT_BYTES
  ) {
    return {
      kind: "err",
      result: badRequest(
        `Field "content" must be between 1 and ${String(MAX_DESKTOP_CHAT_INPUT_BYTES)} UTF-8 bytes.`,
      ),
    };
  }
  const extras = parseGroundedExtras(obj);
  if (extras.kind === "err") return extras;
  return {
    kind: "ok",
    value: {
      chatId,
      content,
      modelId: modelIdResult.value,
      ...extras.value,
    },
  };
}

// ─── Scope / query construction ───────────────────────────────────────────────

// SHA-256(chatId + connectedAtMs) truncated to 16 hex chars — deterministic across calls so
// the assembler's pack stableId is stable for a given chat-scope binding. The scopeId is
// observable only inside the BFF; no client trust is placed on the value.
function deriveScopeId(chat: Chat): string {
  if (chat.connectedScope === undefined) {
    return `chat-${chat.id}`;
  }
  const hash = createHash("sha256")
    .update(
      `${chat.id}|${String(chat.connectedScope.connectedAtMs)}|${chat.connectedScope.root ?? ""}`,
    )
    .digest("hex");
  return `cs-${hash.slice(0, 16)}`;
}

// Epic #532 — per-source scope id for the multi-source path. The index makes ids distinct even
// when two connected scopes share a root and connectedAtMs (e.g. the same folder added twice with
// differing relativePaths). The single-source path keeps `deriveScopeId(chat)` (index-free) so its
// scopeId — which the microIndex key and audit evidence derive from — stays byte-identical (AC5).
export function deriveScopeIdFrom(chat: Chat, cs: ChatConnectedScope, index: number): string {
  const hash = createHash("sha256")
    .update(`${chat.id}|${String(cs.connectedAtMs)}|${cs.root ?? ""}|${String(index)}`)
    .digest("hex");
  return `cs-${hash.slice(0, 16)}`;
}

// Builds ONE SelectedScope from a connected scope. `scopeId` is supplied by the caller so the
// single path can pass the legacy `deriveScopeId(chat)` value while the multi path passes a
// per-source id; everything else is identical between the two paths.
export function buildSelectedScopeFrom(
  chat: Chat,
  cs: ChatConnectedScope,
  scopeId: string,
): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId,
    // Epic #532 — a connected folder may live outside the chat's project. When the scope carries
    // its own validated root, ground against that folder; otherwise fall back to the chat project.
    workspaceRoot: cs.root ?? chat.projectPath,
    kind: cs.kind,
    relativePaths: cs.relativePaths,
    conversationId: chat.id,
    connectedAtMs: cs.connectedAtMs,
    // This scope was built from a user-connected folder/files (Files↔Chat edge or scope pill), so
    // the planner may accept plain natural-language questions without a file/symbol anchor.
    explicitConnection: true,
  };
}

function buildSelectedScope(chat: Chat): SelectedScope | undefined {
  const cs = chat.connectedScope;
  if (cs === undefined) return undefined;
  return buildSelectedScopeFrom(chat, cs, deriveScopeId(chat));
}

const GROUNDED_SCOPE_ACCESS: unique symbol = Symbol("grounded-scope-access");

interface GroundedScopeAccessCarrier {
  readonly [GROUNDED_SCOPE_ACCESS]: WorkspaceRootAccess;
}

function scopeWithWorkspaceAccess(
  scope: ChatConnectedScope,
  access: WorkspaceRootAccess,
): ChatConnectedScope {
  const canonical: ChatConnectedScope & Partial<GroundedScopeAccessCarrier> = {
    ...scope,
    root: access.canonicalRoot,
  };
  Object.defineProperty(canonical, GROUNDED_SCOPE_ACCESS, { value: access });
  return canonical;
}

/** Returns only authority minted during this grounded operation; persisted scopes cannot forge it. */
export function groundedScopeWorkspaceFs(scope: ChatConnectedScope): WorkspaceFs | undefined {
  const access = (scope as Partial<GroundedScopeAccessCarrier>)[GROUNDED_SCOPE_ACCESS];
  return access !== undefined && access.canonicalRoot === scope.root ? access.fs : undefined;
}

function managedGroundedRootAccess(
  rootInput: string,
  deps: UiHandlerDeps,
  request: IncomingMessage | undefined,
  correlationId: string | undefined,
): WorkspaceRootAccess | undefined {
  if (request === undefined || resolveAppSessionReadAuthority(deps, request) === undefined) {
    return undefined;
  }
  return resolveManagedWorkspaceRootAccess(deps, rootInput, { correlationId });
}

function deniedManagedGroundedRoot(correlationId: string | undefined): RouteResult {
  const error = new PathDeniedError(
    "managed workspace authority is required",
    "[managed-task-workspace]",
  );
  recordWorkspaceRootDenial(error, { correlationId });
  return pathDeniedResult(error);
}

function canonicalGroundedRoot(
  rootInput: string,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): string | RouteResult {
  let realRoot: string;
  try {
    realRoot = resolveRecordedWorkspaceRoot(nodeWorkspaceFs, rootInput, { correlationId });
  } catch (error) {
    if (error instanceof PathDeniedError) {
      return pathDeniedResult(error);
    }
    if (!isExpectedWorkspaceRootFailure(error)) throw error;
    recordWorkspaceRootUnavailable(error, { correlationId });
    return unavailableWorkspaceResult(error, correlationId);
  }
  const redacted = deps.redactor(realRoot);
  if (typeof redacted === "string" && redacted !== realRoot) {
    recordWorkspaceRootDenied(
      {
        reason: "credential-shaped-root",
        failureKind: "CREDENTIAL_SHAPED_METADATA",
        errorKind: "permission-denied",
      },
      { correlationId },
    );
    return badRequest("Connected scope root contains credential-shaped metadata.");
  }
  return realRoot;
}

function groundedRootAccess(
  rootInput: string,
  deps: UiHandlerDeps,
  request: IncomingMessage | undefined,
  correlationId: string | undefined,
): WorkspaceRootAccess | RouteResult {
  const managed = managedGroundedRootAccess(rootInput, deps, request, correlationId);
  if (managed !== undefined) return managed;
  if (requiresConfiguredManagedWorkspaceAuthority(deps, rootInput)) {
    return deniedManagedGroundedRoot(correlationId);
  }
  const canonical = canonicalGroundedRoot(rootInput, deps, correlationId);
  return typeof canonical === "string" ? createOrdinaryWorkspaceRootAccess(canonical) : canonical;
}

// A scope that failed canonicalization. `reason` is the original RouteResult (preserved verbatim
// for hard-fail cases when every source is denied). `message` is a safe, non-path skip notice.
interface SkippedFolderScope {
  readonly label: string;
  readonly message: string;
  readonly reason: RouteResult;
}

interface CanonicalizedFolderScopes {
  readonly canonical: readonly ChatConnectedScope[];
  readonly skipped: readonly SkippedFolderScope[];
  readonly sourceScopeFingerprints: ReadonlyMap<ChatConnectedScope, string>;
}

function skippedFolderMessage(result: RouteResult): string {
  const body = result.body as { error?: { message?: string } };
  return body.error?.message ?? "not accessible";
}

// Fail-soft canonicalization: inaccessible/denied scopes are collected in `skipped` instead of
// aborting the entire request. If no healthy scope remains, retain the recorded failure status;
// transient server/filesystem outages take precedence over invalid or unavailable selections.
function canonicalizeGroundedFolderScopes(
  chat: Chat,
  deps: UiHandlerDeps,
  scopes: readonly ChatConnectedScope[],
  request: IncomingMessage | undefined,
  correlationId: string | undefined,
): CanonicalizedFolderScopes {
  const canonical: ChatConnectedScope[] = [];
  const skipped: SkippedFolderScope[] = [];
  const sourceScopeFingerprints = new Map<ChatConnectedScope, string>();
  for (const scope of scopes) {
    const rootInput = scope.root ?? chat.projectPath;
    const access = groundedRootAccess(rootInput, deps, request, correlationId);
    if ("status" in access) {
      const label = scope.root !== undefined ? basename(scope.root) : "project";
      skipped.push({ label, message: skippedFolderMessage(access), reason: access });
      continue;
    }
    const admittedScope = scopeWithWorkspaceAccess(scope, access);
    canonical.push(admittedScope);
    // Attribution retains the human-selected identity; canonical roots govern filesystem access.
    sourceScopeFingerprints.set(
      admittedScope,
      groundedSourceScopeFingerprint(buildSelectedScopeFrom(chat, scope, "source-attribution")),
    );
  }
  return { canonical, skipped, sourceScopeFingerprints };
}

// The canonical list is authoritative even when it is EMPTY. With every folder denied or
// inaccessible, returning the original chat would let its legacy single `connectedScope` resurface
// through `buildConnectedScopes` on the hybrid path (2+ connectors) and be retrieved without the
// authority canonicalization withheld (#3376 review P1).
function withCanonicalFolderScopes(chat: Chat, scopes: readonly ChatConnectedScope[]): Chat {
  return { ...chat, connectedScopes: scopes, connectedScope: scopes[0] };
}

export function buildQuery(content: string, nowMs: () => number): RetrievalQuery {
  return {
    kind: "natural-language",
    text: content,
    caseSensitive: false,
    maxResults: DEFAULT_LEXICAL_MATCH_LIMIT,
    emittedAtMs: nowMs(),
  };
}

// ─── Model Gateway answerer ───────────────────────────────────────────────────

function chatCapability(deps: UiHandlerDeps, modelId: string): ModelCapability | undefined {
  const config = currentGatewayConfig(deps);
  return config === undefined ? findCapability(modelId) : findConfiguredCapability(config, modelId);
}

function resolveGroundedModelId(
  deps: UiHandlerDeps,
  chat: Chat,
  requestedModelId: string | undefined,
): string | RouteResult {
  const modelId = requestedModelId ?? chat.selectedModel;
  const capability = chatCapability(deps, modelId);
  if (capability?.kind !== "chat") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
    };
  }
  return modelId;
}

export function ensureNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError("grounded request cancelled");
  }
}

function formatLineRange(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) return citation.scopePath;
  return `${citation.scopePath}:${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function redactedString(redactor: Redactor, value: string): string {
  // GRD-001: strip Trojan-source / invisible format chars BEFORE redaction so a zero-width
  // character cannot split a secret shape past the redactor, and so reordered/hidden text
  // never reaches the prompt or the browser-rendered wire.
  const safe = stripUnsafeFormatChars(value);
  const redacted = redactor(safe);
  return typeof redacted === "string" ? redacted : safe;
}

export function promptSafeExcerptText(value: string): string {
  return value.replaceAll("```", "` ` `");
}

export function promptByteLength(messages: readonly GatewayChatMessage[]): number {
  return Buffer.byteLength(messages.map((message) => message.content).join("\n"), "utf8");
}

export function modelInputPromptByteLimit(modelInputTokensMax: number): number {
  return maxUtf8BytesForTokenBudget(modelInputTokensMax);
}

function contextProfileForGroundedModel(
  deps: UiHandlerDeps,
  modelId: string,
): ContextProfile | undefined {
  const resolvedProfile = currentContextProfileForModel(deps, modelId);
  if (resolvedProfile !== undefined) {
    return resolvedProfile;
  }
  const config = currentGatewayConfig(deps);
  if (config === undefined) {
    return undefined;
  }
  const capability = findConfiguredCapability(config, modelId);
  return capability?.kind === "chat" ? deriveContextProfileFromCapability(capability) : undefined;
}

export function modelWindowAwareBudget(deps: UiHandlerDeps, modelId: string): ExplorationBudget {
  const profile = contextProfileForGroundedModel(deps, modelId);
  if (profile === undefined) return DEFAULT_EXPLORATION_BUDGET;
  return {
    ...DEFAULT_EXPLORATION_BUDGET,
    modelInputTokensMax: profile.effectiveInputBudget,
    modelOutputTokensMax: profile.reservedOutputTokens,
  };
}

function clampUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return value.slice(0, low);
}

function positiveInteger(value: number): number | undefined {
  const n = Math.floor(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function groundedPromptInputTokensForCapability(
  capability: ModelCapability | undefined,
): number | undefined {
  if (capability?.kind !== "chat") return undefined;
  // Reuse the shared capability→profile fallback (context-engineering.ts) so a
  // placeholder capability (contextWindow=0 / maxOutputTokens=0) yields the same
  // DEFAULT_CONTEXT_PROFILE-scaled budget the exploration phase already uses,
  // instead of returning undefined and silently inheriting a second, independently
  // derived default.
  return deriveContextProfileFromCapability(capability).effectiveInputBudget;
}

export interface GroundedGatewayPromptOptions {
  readonly modelInputTokensMax?: number | undefined;
  readonly tokenAccounting?: ContextProfile["tokenAccounting"];
}

function withPromptModelInputBudget(
  pack: ConnectedContextPack,
  modelInputTokensMax: number | undefined,
): ConnectedContextPack {
  const effective =
    modelInputTokensMax === undefined ? undefined : positiveInteger(modelInputTokensMax);
  if (effective === undefined || effective === pack.budget.modelInputTokensMax) return pack;
  return { ...pack, budget: { ...pack.budget, modelInputTokensMax: effective } };
}

function packExcerptCount(pack: ConnectedContextPack): number {
  return pack.files.reduce((count, file) => count + file.excerpts.length, 0);
}

const PROMPT_PROVENANCE_PRIORITY: Record<EvidenceAtom["provenance"]["kind"], number> = {
  "model-rerank": 7,
  "semantic-search": 7,
  structural: 6,
  "excerpt-read": 5,
  "lexical-search": 4,
  "document-extract": 4,
  "git-history": 3,
  "file-listing": 2,
};

function promptExcerptScore(excerpt: ContextExcerpt): number {
  return Number.isFinite(excerpt.atom.score) ? excerpt.atom.score : 0;
}

function promptExcerptProvenancePriority(excerpt: ContextExcerpt): number {
  return PROMPT_PROVENANCE_PRIORITY[excerpt.atom.provenance.kind];
}

export function withPromptExcerptByteLimit(
  pack: ConnectedContextPack,
  maxExcerptBytes: number,
): ConnectedContextPack {
  const excerptCount = packExcerptCount(pack);
  return withPromptExcerptTotalByteBudget(pack, Math.max(0, maxExcerptBytes) * excerptCount);
}

interface RankedPromptExcerpt {
  readonly fileIndex: number;
  readonly excerptIndex: number;
  readonly excerpt: ContextExcerpt;
}

function rankedPromptExcerpts(pack: ConnectedContextPack): readonly RankedPromptExcerpt[] {
  const ranked: RankedPromptExcerpt[] = [];
  for (let fileIndex = 0; fileIndex < pack.files.length; fileIndex += 1) {
    const file = pack.files[fileIndex];
    if (file === undefined) continue;
    for (let excerptIndex = 0; excerptIndex < file.excerpts.length; excerptIndex += 1) {
      const excerpt = file.excerpts[excerptIndex];
      if (excerpt === undefined) continue;
      ranked.push({ fileIndex, excerptIndex, excerpt });
    }
  }
  ranked.sort(
    (a, b) =>
      promptExcerptScore(b.excerpt) - promptExcerptScore(a.excerpt) ||
      promptExcerptProvenancePriority(b.excerpt) - promptExcerptProvenancePriority(a.excerpt) ||
      a.fileIndex - b.fileIndex ||
      a.excerptIndex - b.excerptIndex,
  );
  return ranked;
}

function excerptWithContent(
  excerpt: ContextExcerpt,
  content: string,
  scopeId: string,
): ContextExcerpt {
  const original = excerpt.atom.lineRange;
  if (original === undefined || content.length === excerpt.content.length)
    return { ...excerpt, content, contentBytes: Buffer.byteLength(content, "utf8") };
  const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  const lineRange = {
    startLine: original.startLine,
    endLine: Math.min(original.endLine, original.startLine + Math.max(1, lineCount) - 1),
  };
  const atom = {
    ...excerpt.atom,
    lineRange,
    stableId: evidenceAtomStableId({
      scopeId,
      scopePath: excerpt.atom.scopePath,
      lineRange,
      provenanceKind: excerpt.atom.provenance.kind,
      provenanceTool: excerpt.atom.provenance.tool,
      queryFingerprint: excerpt.atom.provenance.queryFingerprint,
    }),
  };
  return { ...excerpt, atom, content, contentBytes: Buffer.byteLength(content, "utf8") };
}

function withPromptExcerptTotalByteBudget(
  pack: ConnectedContextPack,
  maxExcerptBytes: number,
): ConnectedContextPack {
  if (maxExcerptBytes <= 0) return { ...pack, files: [] };
  const byFile = new Map<number, ContextExcerpt[]>();
  let remaining = Math.floor(maxExcerptBytes);
  for (const ranked of rankedPromptExcerpts(pack)) {
    if (remaining <= 0) break;
    const fullBytes = Buffer.byteLength(ranked.excerpt.content, "utf8");
    if (fullBytes === 0) continue;
    const content =
      fullBytes <= remaining
        ? ranked.excerpt.content
        : clampUtf8Bytes(ranked.excerpt.content, remaining);
    if (content.length === 0) break;
    const bucket = byFile.get(ranked.fileIndex) ?? [];
    bucket.push(excerptWithContent(ranked.excerpt, content, pack.scope.scopeId));
    byFile.set(ranked.fileIndex, bucket);
    remaining -= Buffer.byteLength(content, "utf8");
    if (fullBytes > Buffer.byteLength(content, "utf8")) break;
  }
  const files = [...byFile.entries()]
    .sort((a, b) => {
      const bestA = a[1][0];
      const bestB = b[1][0];
      const scoreA = bestA === undefined ? 0 : promptExcerptScore(bestA);
      const scoreB = bestB === undefined ? 0 : promptExcerptScore(bestB);
      const provenanceA = bestA === undefined ? 0 : promptExcerptProvenancePriority(bestA);
      const provenanceB = bestB === undefined ? 0 : promptExcerptProvenancePriority(bestB);
      return scoreB - scoreA || provenanceB - provenanceA || a[0] - b[0];
    })
    .map(([fileIndex, excerpts]) => {
      const file = pack.files[fileIndex];
      if (file === undefined) throw new ContextOverflowError("Prompt excerpt file missing.");
      return { ...file, excerpts };
    });
  return {
    ...pack,
    files,
  };
}

export function withPromptExcerptBudget(
  pack: ConnectedContextPack,
  totalExcerptBytes: number,
): ConnectedContextPack {
  return withPromptExcerptTotalByteBudget(pack, totalExcerptBytes);
}

type GroundedPromptBuilder = (
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
  omissionPathBytes?: number,
) => readonly GatewayChatMessage[];

interface FittedPromptPack {
  readonly omissionPathBytes: number;
  readonly messages: readonly GatewayChatMessage[];
  readonly pack: ConnectedContextPack;
}

export function fitPromptOmissionMetadata(
  build: (pathBytes: number) => readonly GatewayChatMessage[],
  fits: (messages: readonly GatewayChatMessage[]) => boolean,
  pathByteLimit: number,
):
  | { readonly messages: readonly GatewayChatMessage[]; readonly omissionPathBytes: number }
  | undefined {
  const minimum = build(0);
  if (!fits(minimum)) return undefined;
  let best = { messages: minimum, omissionPathBytes: 0 };
  let low = 1;
  let high = pathByteLimit;
  while (low <= high) {
    const bytes = Math.floor((low + high) / 2);
    const messages = build(bytes);
    if (fits(messages)) {
      best = { messages, omissionPathBytes: bytes };
      low = bytes + 1;
    } else high = bytes - 1;
  }
  return best;
}

function fitGroundedPrompt(
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
  build: GroundedPromptBuilder,
  options: GroundedGatewayPromptOptions = {},
): FittedPromptPack {
  const budgetedPack = withPromptModelInputBudget(pack, options.modelInputTokensMax);
  const limit = modelInputPromptByteLimit(budgetedPack.budget.modelInputTokensMax);
  const fits = (candidate: readonly GatewayChatMessage[]): boolean =>
    promptByteLength(candidate) <= limit &&
    countGatewayPromptTokens({ messages: candidate }, options.tokenAccounting) <=
      budgetedPack.budget.modelInputTokensMax;
  const messages = build(question, budgetedPack, redactor);
  if (fits(messages)) return { messages, pack: budgetedPack, omissionPathBytes: limit };
  const metadataFit = fitPromptOmissionMetadata(
    (bytes) => build(question, budgetedPack, redactor, bytes),
    fits,
    limit,
  );
  if (metadataFit !== undefined) return { ...metadataFit, pack: budgetedPack };

  const emptyPack = withPromptExcerptBudget(budgetedPack, 0);
  const emptyMessages = build(question, emptyPack, redactor, 0);
  const overheadBytes = promptByteLength(emptyMessages);
  // When overhead alone (system prompt + question + framing) exceeds the limit, no amount of
  // excerpt trimming can bring the prompt within budget. Throw instead of sending an over-limit
  // prompt to the provider which would result in an opaque 400 context-window error.
  if (!fits(emptyMessages)) {
    throw new ContextOverflowError(
      `Grounded prompt overhead (${String(overheadBytes)} bytes) exceeds model input limit (${String(limit)} bytes).`,
    );
  }
  let low = 0;
  let high = Math.max(0, limit - overheadBytes);
  let best: FittedPromptPack = { messages: emptyMessages, pack: emptyPack, omissionPathBytes: 0 };
  while (low <= high) {
    const totalExcerptBytes = Math.floor((low + high) / 2);
    const candidatePack = withPromptExcerptBudget(budgetedPack, totalExcerptBytes);
    const candidate = build(question, candidatePack, redactor, 0);
    if (fits(candidate)) {
      best = { messages: candidate, pack: candidatePack, omissionPathBytes: 0 };
      low = totalExcerptBytes + 1;
    } else {
      high = totalExcerptBytes - 1;
    }
  }
  return best;
}

function promptBudgetedMessages(
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
  build: GroundedPromptBuilder,
  options: GroundedGatewayPromptOptions = {},
): readonly GatewayChatMessage[] {
  return fitGroundedPrompt(question, pack, redactor, build, options).messages;
}

/** Excerpts that carry content: what a rendered folder prompt actually shows the model. */
export function promptExcerptCount(packs: readonly ConnectedContextPack[]): number {
  return packs.reduce(
    (total, pack) =>
      total +
      pack.files.reduce(
        (count, file) =>
          count + file.excerpts.filter((excerpt) => excerpt.content.length > 0).length,
        0,
      ),
    0,
  );
}

/**
 * The folder prompt exactly as it is sent — fitted to the model's input budget — with the same
 * prompt rendered without excerpts, so the context meter can count the share the sources took
 * (grounded-prompt-context.ts).
 */
export function fittedGroundedGatewayPrompt(
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
  options?: GroundedGatewayPromptOptions,
): SentGroundedPrompt {
  const fitted = fitGroundedPrompt(
    question,
    pack,
    redactor,
    buildRawGroundedGatewayMessages,
    options,
  );
  return {
    messages: fitted.messages,
    sentEvidencePacks: [fitted.pack],
    withoutSources: buildRawGroundedGatewayMessages(
      question,
      withPromptExcerptBudget(fitted.pack, 0),
      redactor,
      -1,
    ),
    sentReferenceCount: promptExcerptCount([fitted.pack]),
    availableReferenceCount: promptExcerptCount([pack]),
  };
}

export function packBudgetSummary(pack: ConnectedContextPack): string {
  const { usage, budget } = pack;
  return [
    `search calls ${String(usage.searchCalls)}/${String(budget.searchCallsMax)}`,
    budget.filesReadMax === null
      ? `files read ${String(usage.filesRead)}`
      : `files read ${String(usage.filesRead)}/${String(budget.filesReadMax)}`,
    `excerpt bytes ${String(usage.excerptBytes)}/${String(budget.excerptBytesMax)}`,
    `model input tokens ${String(usage.modelInputTokens)}/${String(budget.modelInputTokensMax)}`,
    `model output tokens ${String(usage.modelOutputTokens)}/${String(budget.modelOutputTokensMax)}`,
    `rerank calls ${String(usage.rerankCalls)}/${String(budget.rerankCallsMax)}`,
    budget.elapsedMsMax === null
      ? `elapsed ${String(usage.elapsedMs)} ms (no search time limit)`
      : `elapsed ${String(usage.elapsedMs)}/${String(budget.elapsedMsMax)} ms`,
  ].join("; ");
}

export function evidenceLines(pack: ConnectedContextPack, redactor: Redactor): readonly string[] {
  const lines: string[] = [];
  for (const file of pack.files) {
    lines.push(`File: ${redactedString(redactor, file.scopePath)}`);
    if (file.excerpts.length === 0) {
      lines.push("- No excerpt content was available for this selected file.");
      continue;
    }
    for (const excerpt of file.excerpts) {
      const citation = formatLineRange({
        scopePath: excerpt.atom.scopePath,
        lineRange: excerpt.atom.lineRange,
        score: excerpt.atom.score,
        stableId: excerpt.atom.stableId,
      });
      const documentFormat = documentFormatForAtom(excerpt.atom);
      const label =
        documentFormat === undefined
          ? "Evidence"
          : `Document evidence (${documentFormat.toUpperCase()}, extracted text)`;
      lines.push(
        `- ${label} ${redactedString(redactor, citation)} (score ${excerpt.atom.score.toFixed(2)}):`,
        evidenceProvenanceLine(excerpt.atom.provenance, redactor),
        "```",
        promptSafeExcerptText(
          numberedEvidenceText(redactedString(redactor, excerpt.content), excerpt.atom.lineRange),
        ),
        "```",
      );
    }
  }
  if (lines.length === 0) {
    lines.push("No evidence excerpts were selected for this question.");
  }
  return lines;
}

/** Retrieval provenance describes selection, not proof that a requested literal occurs. */
export function evidenceProvenanceLine(
  provenance: EvidenceAtom["provenance"],
  redactor: Redactor,
): string {
  const label =
    provenance.kind === "semantic-search" || provenance.tool.startsWith("repo.semanticSearch:")
      ? "Related semantic context (not verified as an exact literal match)"
      : "Retrieval provenance";
  return `${label}: ${provenance.kind}; tool: ${redactedString(redactor, provenance.tool)}.`;
}

/** Line annotations belong to the prompt; source content and citation ranges remain unchanged. */
export function numberedEvidenceText(content: string, range: EvidenceAtom["lineRange"]): string {
  if (range === undefined || content.length === 0) return content;
  return content
    .split("\n")
    .slice(0, range.endLine - range.startLine + 1)
    .map((line, index) => `${String(range.startLine + index)} | ${line}`)
    .join("\n");
}

/** Closed canonical counts disclose unavailable evidence without revealing excluded paths. */
export function omissionReasonLines(pack: ConnectedContextPack): readonly string[] {
  const omittedCounts = connectedContextOmittedCounts(pack);
  const counts = Object.entries(omittedCounts).filter(([, count]) => count > 0);
  const reasons =
    counts.length === 0
      ? []
      : [
          "Known omission reason counts (metadata only, not file-content evidence):",
          ...counts.map(([reason, count]) => `- ${reason}: ${String(count)}`),
        ];
  const unavailable = omittedCounts["tool-unavailable"];
  const coverage = pack.diagnostics?.coverage;
  return [
    ...reasons,
    ...(unavailable > 0
      ? [`Candidate file evidence unavailable for reading/retrieval: ${String(unavailable)}.`]
      : []),
    ...(coverage === undefined
      ? []
      : [
          `Current traversal incomplete: ${String(coverage.incomplete)}; reasons: ${coverage.reasons.join(", ") || "none"}.`,
        ]),
  ];
}

function allowedSizeExclusionPaths(pack: ConnectedContextPack): readonly string[] {
  const paths = pack.omitted
    .filter(
      (entry) =>
        entry.reason === "size-exceeded" &&
        isValidScopePath(entry.scopePath, { mustBeRelative: true }) &&
        stripUnsafeFormatChars(entry.scopePath) === entry.scopePath,
    )
    .map((entry) => entry.scopePath)
    .filter((path) => isValidScopePath(path, { mustBeRelative: true }) && !isDenied(path));
  return [...new Set(paths)];
}

// The existing pack owns eligibility decisions. Project only safe omission metadata, never
// unread file bodies; bound prompt bytes without changing which files retrieval inspects.
const MAX_SIZE_EXCLUSION_PATH_BYTES = 4096;

export function sizeExclusionLines(
  pack: ConnectedContextPack,
  redactor: Redactor,
  pathByteLimit = MAX_SIZE_EXCLUSION_PATH_BYTES,
): readonly string[] {
  if (pathByteLimit < 0) return [];
  const paths = allowedSizeExclusionPaths(pack);
  const total =
    pack.omittedCounts === undefined
      ? paths.length
      : connectedContextOmittedCounts(pack)["size-exceeded"];
  if (total === 0) return [];
  const lines = [
    "Known file-size exclusions (metadata only, not file-content evidence):",
    `Files excluded by file-size policy: ${String(total)}.`,
  ];
  let pathBytes = 0;
  let listed = 0;
  for (const path of paths) {
    const line = `- omitted path: ${JSON.stringify(redactedString(redactor, path))}; reason=size-exceeded`;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (pathBytes + bytes > Math.min(pathByteLimit, MAX_SIZE_EXCLUSION_PATH_BYTES)) break;
    lines.push(line);
    pathBytes += bytes;
    listed += 1;
  }
  if (listed < total)
    lines.push(`Additional excluded paths not listed: ${String(total - listed)}.`);
  lines.push(
    "These files were not read as evidence. Do not infer their contents or invent line references.",
  );
  return lines;
}

export function uncertaintyLines(
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly string[] {
  if (pack.uncertainty.length === 0) return ["None."];
  return pack.uncertainty.map(
    (marker) => `- ${marker.kind}: ${redactedString(redactor, marker.claim)}`,
  );
}

// The grounded system message is shared verbatim by the single-source and multi-source (#532)
// paths so both apply the identical capability, untrusted-evidence, citation and no-secret rules.
// GROUNDED_SYSTEM_PROMPT now lives in the dependency-free ./grounded-prompt.js leaf (re-exported
// here for back-compat) so the hybrid path can interpolate it without a circular-import TDZ.
export { GROUNDED_SYSTEM_PROMPT };

function buildRawGroundedGatewayMessages(
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
  omissionPathBytes?: number,
): readonly GatewayChatMessage[] {
  const safeQuestion = redactedString(redactor, question);
  const userContent = [
    "User question:",
    safeQuestion,
    "",
    "Connected repository context pack:",
    `- schemaVersion: ${pack.schemaVersion}`,
    `- stableId: ${redactedString(redactor, pack.stableId)}`,
    `- scope kind: ${pack.scope.kind}`,
    `- query kind: ${pack.query.kind}`,
    `- budget/usage: ${packBudgetSummary(pack)}`,
    `- omitted files: ${String(connectedContextOmittedCount(pack))}`,
    ...omissionReasonLines(pack),
    ...sizeExclusionLines(pack, redactor, omissionPathBytes),
    "",
    "Repository evidence excerpts:",
    ...evidenceLines(pack, redactor),
    "",
    "Known uncertainty from retrieval:",
    ...uncertaintyLines(pack, redactor),
  ].join("\n");
  return [
    { role: "system", content: GROUNDED_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export function buildGroundedGatewayMessages(
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
  options?: GroundedGatewayPromptOptions,
): readonly GatewayChatMessage[] {
  return promptBudgetedMessages(question, pack, redactor, buildRawGroundedGatewayMessages, options);
}

interface GroundedGatewayAnswerContext {
  readonly deps: UiHandlerDeps;
  readonly model: ModelPort;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly correlationId: string | undefined;
  readonly tokenAccounting: ContextProfile["tokenAccounting"];
}

function createGatewayAnswerer(
  deps: UiHandlerDeps,
  model: ModelPort,
  modelId: string,
  signal: AbortSignal,
  correlationId: string | undefined,
  tokenAccounting: ContextProfile["tokenAccounting"],
): GroundedAnswerer {
  const ctx = { deps, model, modelId, signal, correlationId, tokenAccounting };
  return {
    answer: (question, pack, options) => gatewayGroundedAnswer(ctx, question, pack, options ?? {}),
  };
}

async function gatewayGroundedAnswer(
  ctx: GroundedGatewayAnswerContext,
  question: string,
  pack: ConnectedContextPack,
  options: GroundedAnswerOptions,
): Promise<GroundedAnswerResult> {
  ensureNotCancelled(ctx.signal);
  const attempt = await withAdoptedContextWindowRetry(
    ctx.deps,
    { modelId: ctx.modelId, surface: "grounded", correlationId: ctx.correlationId },
    () => groundedGatewayAttempt(ctx, question, pack, options),
  );
  if (attempt.response === undefined)
    return {
      content: connectedSearchNoEvidenceAnswer(options.currentQuestion ?? question),
      usage: { promptTokens: 0, completionTokens: 0 },
      modelInvoked: false,
      noEvidence: true,
      sentEvidencePacks: attempt.sent.sentEvidencePacks ?? [],
      filesInPrompt: 0,
    };
  const response = attempt.response;
  assertUsableAssistantContent(response.content.trim(), ctx.modelId);
  return {
    content: response.content.trim(),
    usage: {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    },
    finishReason: response.finishReason,
    modelInvoked: true,
    sentEvidencePacks: attempt.sent.sentEvidencePacks ?? [],
    ...sentPromptContextField(
      attempt.sent,
      response,
      currentContextProfileForModel(ctx.deps, ctx.modelId),
    ),
  };
}

async function groundedGatewayAttempt(
  ctx: GroundedGatewayAnswerContext,
  question: string,
  pack: ConnectedContextPack,
  options: GroundedAnswerOptions,
): Promise<{ readonly sent: SentGroundedPrompt; readonly response?: NormalizedResponse }> {
  const promptOptions = groundedPromptOptions(ctx.deps, ctx.modelId, ctx.tokenAccounting);
  const sent = fittedGroundedGatewayPrompt(question, pack, ctx.deps.redactor, {
    ...promptOptions,
    modelInputTokensMax: Math.min(
      promptOptions.modelInputTokensMax ?? pack.budget.modelInputTokensMax,
      options.modelInputTokensMax ?? pack.budget.modelInputTokensMax,
    ),
  });
  if (sent.sentReferenceCount === 0 && options.answerOnlyContextAvailable !== true) return { sent };
  const response = await ctx.model.call(
    {
      modelId: ctx.modelId,
      messages: sent.messages,
      stream: false,
      maxOutputTokens: options.modelOutputTokensMax ?? pack.budget.modelOutputTokensMax,
      logContext: { correlationId: ctx.correlationId },
    },
    ctx.signal,
  );
  return { sent, response };
}

// The input budget of one attempt, read from the model's current capability.
export function groundedPromptOptions(
  deps: UiHandlerDeps,
  modelId: string,
  tokenAccounting: ContextProfile["tokenAccounting"],
): GroundedGatewayPromptOptions {
  const modelInputTokensMax = groundedPromptInputTokensForCapability(chatCapability(deps, modelId));
  return {
    ...(modelInputTokensMax === undefined ? {} : { modelInputTokensMax }),
    ...(tokenAccounting === undefined ? {} : { tokenAccounting }),
  };
}

function sentPromptContextField(
  sent: SentGroundedPrompt | undefined,
  response: NormalizedResponse,
  profile: ContextProfile | undefined,
): Pick<GroundedAnswerResult, "promptContext"> {
  return sent === undefined
    ? {}
    : { promptContext: sentPromptContext(sent, response.usage.promptTokens, profile) };
}

function resolveGroundedAnswerModel(
  deps: UiHandlerDeps,
  modelId: string,
  readinessAdmission: ConversationReadinessAdmission,
): ModelPort | RouteResult {
  const resolvedModel = deps.modelPortFactory(modelId);
  if (resolvedModel === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return withConversationReadinessAdmission(resolvedModel, modelId, readinessAdmission, deps);
}

interface DefaultRunnerContext {
  readonly deps: UiHandlerDeps;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly contextProfile: UiHandlerDeps["contextProfile"];
  readonly model: ModelPort;
  readonly entailmentStage: EntailmentStage | undefined;
  readonly correlationId: string | undefined;
}

// Split out of defaultRunner to keep it within the line budget: the actual GroundedRunner closure
// invoked once per exploration input.
function runDefaultGroundedExploration(
  runnerCtx: DefaultRunnerContext,
  input: OrchestratorInput,
): Promise<OrchestratorOutput> {
  const { deps, modelId, signal, contextProfile, model, entailmentStage } = runnerCtx;
  const nowMs = Date.now;
  const budgetedInput = {
    ...input,
    budget: input.budget ?? modelWindowAwareBudget(deps, modelId),
  };
  const contextPackReranker = configuredContextPackRerankerFor(
    deps,
    budgetedInput.query,
    signal,
    budgetedInput.budget.excerptBytesMax,
  );
  const semanticLease = configuredRepoSemanticSearchProviderLeaseFor(
    deps,
    signal,
    budgetedInput.workspaceRoot,
  );
  return runGroundedExploration(budgetedInput, {
    answerer: createGatewayAnswerer(
      deps,
      model,
      modelId,
      signal,
      runnerCtx.correlationId,
      contextProfile?.tokenAccounting,
    ),
    nowMs,
    signal,
    // ADR-0173 D5: the same id the Gateway answerer above already carries, so a git-history read
    // that failed during THIS ask is joinable to it in `server.log`.
    correlationId: runnerCtx.correlationId,
    microIndex: microIndexForGroundedScope(budgetedInput.scope, nowMs),
    workspaceIndexForRoot: deps.workspaceIndexForRoot,
    ...(contextPackReranker === undefined ? {} : { contextPackReranker }),
    ...(semanticLease.provider === undefined
      ? {}
      : { repoSemanticSearchProvider: semanticLease.provider }),
    ...(entailmentStage === undefined ? {} : { entailmentStage }),
    // ADR-0055 D1/D5 (PR4-W1): thread the provisioned profile so the diagnostics observer fires
    // on the assembled pack. exactOptionalPropertyTypes — omit the key entirely when absent so
    // the legacy no-profile path stays byte-identical (observer guard never sees a key).
    ...(contextProfile === undefined ? {} : { contextProfile }),
  }).finally(() => {
    semanticLease.close();
  });
}

function defaultRunner(
  deps: UiHandlerDeps,
  modelId: string,
  readinessAdmission: ConversationReadinessAdmission,
  signal: AbortSignal,
  contextProfile: UiHandlerDeps["contextProfile"],
  correlationId: string | undefined,
): GroundedRunner | RouteResult {
  const model = resolveGroundedAnswerModel(deps, modelId, readinessAdmission);
  if ("status" in model) return model;
  // Knowledge M1.2 (#2563): the folder grounded-ask has no knowledge capsule, so entailment is
  // governed only by whether a compatible judge model is configured (empty capsules ⇒ no policy to
  // deny). Undefined ⇒ the stage is inert and the assembled pack is byte-identical to today.
  const entailmentStage = createEntailmentStage(
    deps,
    [],
    modelId,
    // The request's correlation, so the verdict line joins the ask (PR #3678 review).
    { diagnostics: deps.diagnostics, correlationId },
    signal,
  );
  const runnerCtx: DefaultRunnerContext = {
    deps,
    modelId,
    signal,
    contextProfile,
    model,
    entailmentStage,
    correlationId,
  };
  return (input: OrchestratorInput): Promise<OrchestratorOutput> =>
    runDefaultGroundedExploration(runnerCtx, input);
}

// ─── Citation projection ──────────────────────────────────────────────────────

export function redactString(redactor: Redactor, value: string): string {
  // GRD-001: strip Trojan-source / invisible format chars before redaction (see redactedString).
  return redactor(stripUnsafeFormatChars(value)) as string;
}

export function buildCitations(
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  return buildPackCitations(pack, (value) => redactString(redactor, value));
}

export function buildAnswerCitations(
  pack: ConnectedContextPack,
  answerContent: string,
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  return projectAnswerCitations(pack, answerContent, (value) => redactString(redactor, value));
}

export function buildUncertainty(
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  // uncertainty.claim is the one wire-visible string sourced from the in-process pack that
  // can carry user-controlled text (e.g., excerpt fragments paraphrased into a confidence
  // marker). Production packs SHOULD be upstream-redacted (per ADR-0019), but the BFF still
  // applies the live-payload redactor as defense in depth so secret-shaped strings never
  // reach the browser even when the pack assembler skips its own redaction step.
  return pack.uncertainty.map((u) => ({
    kind: u.kind,
    claim: redactor(u.claim) as string,
  }));
}

// Knowledge M1.2 (#2563): run the injected entailment stage over the assembled answer's evidence
// packs and append any resulting markers (redacted, wire-projected) to the answer's uncertainty.
// Shared by the multi-source and hybrid paths so the wire projection lives in exactly one place.
// Generic over the concrete answer shape so each caller keeps its own type. Returns the answer
// unchanged when the stage produced nothing (the inert / byte-identical path).
export async function appendGroundedAnswerEntailment<
  A extends { readonly uncertainty: readonly GroundedUncertainty[] },
>(
  answer: A,
  stage: EntailmentStage,
  answerContent: string,
  packs: readonly ConnectedContextPack[],
  redactor: Redactor,
): Promise<A> {
  const markers = await stage.evaluate(answerContent, packs, Date.now());
  if (markers.length === 0) {
    return answer;
  }
  const projected: readonly GroundedUncertainty[] = markers.map((marker) => ({
    kind: marker.kind,
    claim: redactString(redactor, marker.claim),
  }));
  return { ...answer, uncertainty: [...answer.uncertainty, ...projected] };
}

/** Append shared-Judge results for exact prompt-selected numeric connector citations. */
export async function appendGroundedAnswerNumericEntailment<
  A extends { readonly uncertainty: readonly GroundedUncertainty[] },
>(
  answer: A,
  stage: EntailmentStage,
  answerContent: string,
  selectedEvidence: readonly NumericEntailmentEvidence[],
  redactor: Redactor,
): Promise<A> {
  const markers = await stage.evaluateNumeric(answerContent, selectedEvidence, Date.now());
  if (markers.length === 0) return answer;
  const projected: readonly GroundedUncertainty[] = markers.map((marker) => ({
    kind: marker.kind,
    claim: redactString(redactor, marker.claim),
  }));
  return { ...answer, uncertainty: [...answer.uncertainty, ...projected] };
}

// ─── Composition seam (test injection) ────────────────────────────────────────

// The seam lets the route's tests substitute a deterministic orchestrator runner without
// having to spin up a real workspace fixture for every wire-shape assertion. Production
// callers omit this seam and use the Model Gateway-backed default runner.
export type GroundedRunner = (input: OrchestratorInput) => Promise<OrchestratorOutput>;

function optionalWorkspaceFs(fs: WorkspaceFs | undefined): Pick<OrchestratorInput, "workspaceFs"> {
  return fs === undefined ? {} : { workspaceFs: fs };
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

// Epic #177 audit: the grounded-ask hot path scanned every project's chat list per request
// (O(projects × chats)). The chat id is unique across projects, so `UiStore.findChatById` is a
// single-row SELECT. This helper is kept (instead of inlining the store call) so callers can
// continue to depend on the deps surface rather than the store directly.
function findChatById(deps: UiHandlerDeps, chatId: string): Chat | undefined {
  return deps.store.findChatById(chatId);
}

// ─── Route worker (extracted to keep handleGroundedAsk under the LOC bound) ───

interface AskWorkerCtx extends GroundedRetrievalContinuityInput {
  readonly retrievalContent?: string | undefined;
  readonly chat: Chat;
  readonly scope: SelectedScope;
  readonly content: string;
  readonly answerContent: string;
  readonly answerOnlyContextAvailable: boolean;
  readonly clientTurnId?: string | undefined;
  readonly commitTurnId: string;
  readonly userMessage: ChatMessage;
  readonly modelId: string;
  readonly contextProfile: UiHandlerDeps["contextProfile"];
  readonly deps: UiHandlerDeps;
  readonly runner: GroundedRunner;
  readonly workspaceFs?: WorkspaceFs | undefined;
  readonly signal: AbortSignal;
  // ADR-0173 D5 — carried from PreparedGroundedAsk.correlationId so a GatewayError surfacing from
  // the runner (or a late cancellation) reaches its operator diagnostic joined to the request.
  readonly correlationId: string | undefined;
}

interface PreparedGroundedAsk {
  readonly sourceScopeFingerprints?: ReadonlyMap<ChatConnectedScope, string>;
  readonly messageCountBeforeTurn?: number;
  readonly continuityStartedAt?: number;
  readonly continuity?: GroundedConversationContinuity | undefined;
  readonly chat: Chat;
  readonly input: AskInput;
  readonly signal: AbortSignal;
  readonly request?: IncomingMessage | undefined;
  readonly commitTurnId?: string | undefined;
  readonly scopeIdentity?: string | undefined;
  readonly turnIdentityContent?: string | undefined;
  readonly memoryContext?: ConversationMemoryRuntimeContext | undefined;
  readonly userMessage?: ChatMessage | undefined;
  readonly memory?: GroundedMemoryPreparation | undefined;
  readonly modelId?: string | undefined;
  readonly readinessAdmission?: ConversationReadinessAdmission | undefined;
  // ADR-0173 D5: the request-scoped correlation id (RouteContext.correlationId), carried through
  // every `{ ...prepared, ... }` preparation stage so the model call at the bottom of the
  // orchestrator pipeline can stamp it into GatewayCallRequest.logContext.
  readonly correlationId?: string | undefined;
}

interface GroundedMemoryPreparation {
  readonly context: ConversationMemoryRuntimeContext;
  readonly result: ConversationMemoryResultWire;
  readonly answerOnlyContextAvailable: boolean;
}

function hasAnswerOnlyContext(prepared: PreparedGroundedAsk): boolean {
  return prepared.memory?.answerOnlyContextAvailable === true;
}

function admittedGroundedUser(prepared: PreparedGroundedAsk): ChatMessage {
  if (prepared.userMessage === undefined) {
    throw new Error("grounded ask was dispatched before its user turn was admitted");
  }
  return prepared.userMessage;
}

function groundedCommitTurnId(prepared: PreparedGroundedAsk): string {
  if (prepared.commitTurnId === undefined) {
    throw new Error("grounded ask was dispatched before its turn commit was admitted");
  }
  return prepared.commitTurnId;
}

function groundedReadinessAdmission(prepared: PreparedGroundedAsk): ConversationReadinessAdmission {
  if (prepared.readinessAdmission === undefined) {
    throw new Error("grounded ask was dispatched before model readiness admission");
  }
  return prepared.readinessAdmission;
}

function groundedModelId(prepared: PreparedGroundedAsk): string {
  if (prepared.modelId === undefined) {
    throw new Error("grounded ask was dispatched before model admission");
  }
  return prepared.modelId;
}

function groundedTurnIdentityContent(
  input: AskInput,
  scopeIdentity: string,
  memoryContext: ConversationMemoryRuntimeContext | undefined,
): string {
  if (input.modelId === undefined) {
    throw new Error("Grounded turn identity requires a frozen model.");
  }
  return canonicalChatTurnIdentityContent({
    routeKind: "grounded",
    content: input.content,
    modelId: input.modelId,
    groundingScopeIdentity: input.expectedGroundingScopeIdentity ?? scopeIdentity,
    memory: canonicalChatTurnMemorySemantics(input.memory, memoryContext),
  });
}

function frozenGroundedTurnIdentity(prepared: PreparedGroundedAsk): string {
  if (prepared.turnIdentityContent === undefined) {
    throw new Error("Grounded turn identity was not frozen before admission.");
  }
  return prepared.turnIdentityContent;
}

function freezeGroundedTurn(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): PreparedGroundedAsk | RouteResult {
  const scopeIdentity = deriveChatGroundingScopeIdentity(prepared.chat);
  const input: AskInput = {
    ...prepared.input,
    modelId: prepared.input.modelId ?? prepared.chat.selectedModel,
  };
  const memoryContext =
    input.memory === undefined
      ? undefined
      : resolveConversationMemoryContext(deps, prepared.chat.projectPath, prepared.chat.id);
  if (isRouteResult(memoryContext)) return memoryContext;
  return {
    ...prepared,
    input,
    scopeIdentity,
    memoryContext,
    turnIdentityContent: groundedTurnIdentityContent(
      input,
      canonicalChatTurnGroundingScopeIdentity(prepared.chat),
      memoryContext,
    ),
  };
}

function groundedScopeStillCurrent(prepared: PreparedGroundedAsk, deps: UiHandlerDeps): boolean {
  const current = deps.store.findChatById(prepared.chat.id);
  return (
    current !== undefined &&
    prepared.scopeIdentity !== undefined &&
    deriveChatGroundingScopeIdentity(current) === prepared.scopeIdentity
  );
}

// ADR-0056 W3: regulated EvidenceManifest.contextAssembly? producer for the grounded persist
// path. Returns the conditional-spread fragment for ConnectedContextEvidenceInput. The field is
// emitted ONLY when a ContextProfile was threaded for the active model AND the observer ran on
// this pack (pack.diagnostics?.contextBudget present — the same precondition the PR4 observer
// records). When either is absent the fragment is empty, so the manifest is byte-identical to
// today (exactOptionalPropertyTypes: omit, never set to undefined). Shared by all three grounded
// persist sites (single / multi-source / hybrid) so the gate logic cannot diverge.
export function groundedContextAssemblyInput(
  deps: Pick<UiHandlerDeps, "contextProfile">,
  pack: ConnectedContextPack,
): Pick<ConnectedContextEvidenceInput, "contextAssembly"> {
  const profile = deps.contextProfile;
  if (profile === undefined || pack.diagnostics?.contextBudget === undefined) {
    return {};
  }
  return { contextAssembly: deriveGroundedContextAssembly(pack, profile) };
}

// ADR-0057 D1: the path-free BFF wire-summary projection. Returns the same
// ContextAssemblyDiagnostics the evidence path derives (one shared derivation, no divergence) so
// buildGroundedAnswerContextPackSummary can project a counts-only contextSummary into the
// browser-visible wire shape. Gated identically to groundedContextAssemblyInput: present ONLY when
// a ContextProfile is active AND the observer ran (pack.diagnostics?.contextBudget). When absent
// the builder is called with three args and returns a byte-identical summary (no contextSummary).
export function groundedContextSummaryInput(
  deps: Pick<UiHandlerDeps, "contextProfile">,
  pack: ConnectedContextPack,
): ReturnType<typeof deriveGroundedContextAssembly> | undefined {
  const profile = deps.contextProfile;
  if (profile === undefined || pack.diagnostics?.contextBudget === undefined) {
    return undefined;
  }
  return deriveGroundedContextAssembly(pack, profile);
}

export function groundedEvidenceRunId(input: {
  readonly chatId: string;
  readonly clientTurnId?: string | undefined;
  readonly workspaceRoot: string;
  readonly sourceKind: "folder";
  readonly ordinal: number;
}): string {
  if (input.clientTurnId === undefined) return `grounded-${randomUUID()}`;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "canonical-grounded-evidence-v1",
        input.chatId,
        input.clientTurnId,
        input.sourceKind,
        input.workspaceRoot,
        input.ordinal,
      ]),
    )
    .digest("hex");
  return `grounded-${digest}`;
}

export function registerGroundedTurn(record: GroundedTurnRecord, clientTurnId?: string): void {
  if (clientTurnId === undefined) {
    rememberGroundedTurn(record);
  } else {
    stageGroundedTurn(record);
  }
}

function persistGroundedAuditEvidence(
  workerCtx: AskWorkerCtx,
  output: OrchestratorOutput,
  citationCount: number,
): string {
  const finishedAt = Date.now();
  const startedAt = Math.max(0, finishedAt - output.elapsedMs);
  const runId = groundedEvidenceRunId({
    chatId: workerCtx.chat.id,
    clientTurnId: workerCtx.clientTurnId,
    workspaceRoot: workerCtx.scope.workspaceRoot,
    sourceKind: "folder",
    ordinal: 0,
  });
  persistConnectedContextEvidence(
    {
      runId,
      modelId: workerCtx.modelId,
      // Epic #532 audit (L1): record the root that was ACTUALLY searched. For a connected external
      // folder scope.workspaceRoot is cs.root, not chat.projectPath — the evidence ledger must name
      // the real grounding root so the audit trail is honest about which tree produced the answer.
      workspaceRoot: workerCtx.scope.workspaceRoot,
      chatId: workerCtx.chat.id,
      sourceScopeFingerprint: groundedSourceScopeFingerprint(output.pack.scope),
      plan: output.plan,
      pack: output.pack,
      citationCount,
      elapsedMs: output.elapsedMs,
      startedAt,
      finishedAt,
      ...groundedContextAssemblyInput({ contextProfile: workerCtx.contextProfile }, output.pack),
    },
    {
      store: workerCtx.deps.evidenceStore,
      env: workerCtx.deps.env,
      // Epic #177 audit: read the LIVE gateway-derived secrets list so apiKey/baseUrl values
      // added via the runtime PATCH /api/gateway/config path are scrubbed by the evidence
      // persister. `deps.redactionSecrets` is the startup snapshot frozen by buildUiHandlerDeps.
      additionalSecrets: currentRedactionSecrets(workerCtx.deps),
      costClassResolver: resolveCostClass,
      onRetentionDeleted: evidenceRetentionObserver("grounded-qa"),
    },
  );
  return runId;
}

async function runAsk(workerCtx: AskWorkerCtx): Promise<RouteResult> {
  const { content, deps } = workerCtx;
  const query = buildQuery(workerCtx.retrievalContent ?? content, () => Date.now());
  const output = await runGroundedRunner(workerCtx, query);
  if (isRouteResult(output)) return output;
  const validationFailure = inspectGroundedPack(output.pack, {
    deps,
    correlationId: workerCtx.correlationId,
    outcome: "request-failed",
  });
  if (validationFailure !== undefined) {
    return internalError(GROUNDED_PACK_VALIDATION_MESSAGE, workerCtx.correlationId);
  }
  const cancelResult = ensureRouteNotCancelled(workerCtx.signal, deps, workerCtx.correlationId);
  if (cancelResult !== undefined) return cancelResult;
  return finalizeGroundedAnswer(workerCtx, output);
}

function registerSingleGroundedTurn(
  workerCtx: AskWorkerCtx,
  output: OrchestratorOutput,
  assistantMessageId: string,
  evidenceRunId: string | undefined,
): void {
  registerGroundedTurn(
    {
      assistantMessageId,
      chatId: workerCtx.chat.id,
      workspaceRoot: output.pack.scope.workspaceRoot,
      ...(evidenceRunId === undefined ? {} : { evidenceRunId }),
      packs: [output.pack],
    },
    workerCtx.commitTurnId,
  );
}

function singleAnswerEvidenceDeclaration(
  output: OrchestratorOutput,
): GroundedAnswerEvidenceDeclaration {
  return {
    ...(output.answerKind === undefined ? {} : { answerKind: output.answerKind }),
    ...(output.insufficiencyDeclarations === undefined
      ? {}
      : { insufficiencyDeclarations: output.insufficiencyDeclarations }),
  };
}

function singleAnswerContextSummary(
  workerCtx: AskWorkerCtx,
  output: OrchestratorOutput,
  citationCount: number,
): ReturnType<typeof buildGroundedAnswerContextPackSummary> {
  return buildGroundedAnswerContextPackSummary(
    output.pack,
    citationCount,
    output.elapsedMs,
    groundedContextSummaryInput({ contextProfile: workerCtx.contextProfile }, output.pack),
    output.filesInPrompt === undefined ? undefined : { filesInPrompt: output.filesInPrompt },
  );
}

// Persists the exchange, projects citations/uncertainty, and assembles the wire answer for a
// single-source folder ask. Split out of runAsk to keep both under the LOC bound.
function finalizeGroundedAnswer(workerCtx: AskWorkerCtx, output: OrchestratorOutput): RouteResult {
  const { chat, content, deps } = workerCtx;
  const userContent = redactString(deps.redactor, content);
  const assistantContent = redactString(deps.redactor, output.assistantContent);
  // Citation checks follow model invocation, including answer-only context. Evidence persistence
  // and grounded-turn registration follow source availability so an ungrounded model answer can
  // never be mislabeled as durable source evidence.
  const sourceEvidenceAvailable = output.noEvidence !== true;
  const modelInvoked = output.modelInvoked ?? sourceEvidenceAvailable;
  const citations = modelInvoked
    ? buildAnswerCitations(
        output.sentEvidencePacks?.[0] ?? output.pack,
        output.assistantContent,
        deps.redactor,
      )
    : [];
  const evidenceRunId = sourceEvidenceAvailable
    ? persistGroundedAuditEvidence(workerCtx, output, citations.length)
    : undefined;
  const [userMessage, assistantMessage] = persistGroundedExchange(
    deps,
    chat.id,
    userContent,
    assistantContent,
    workerCtx.userMessage,
  );
  const answer: GroundedAnswer = {
    groundingKind: "connected-context",
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    ...(evidenceRunId === undefined ? {} : { evidenceRunId }),
    content: assistantContent,
    ...singleAnswerEvidenceDeclaration(output),
    citations,
    uncertainty: buildUncertainty(output.pack, deps.redactor),
    omittedCount: connectedContextOmittedCount(output.pack),
    elapsedMs: output.elapsedMs,
    contextPack: singleAnswerContextSummary(workerCtx, output, citations.length),
    ...(modelInvoked && output.promptContext !== undefined
      ? { promptContext: output.promptContext }
      : {}),
  };
  deps.store.attachGroundedAnswer(assistantMessage.id, answer);
  if (sourceEvidenceAvailable) {
    registerSingleGroundedTurn(workerCtx, output, assistantMessage.id, evidenceRunId);
  }
  return { status: 200, body: answer };
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value;
}

function ensureRouteNotCancelled(
  signal: AbortSignal,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): RouteResult | undefined {
  try {
    ensureNotCancelled(signal);
    return undefined;
  } catch (error) {
    const gatewayResult = mappedGatewayError(error, deps, correlationId);
    if (gatewayResult !== undefined) return gatewayResult;
    throw error;
  }
}

async function runGroundedRunner(
  workerCtx: AskWorkerCtx,
  query: RetrievalQuery,
): Promise<OrchestratorOutput | RouteResult> {
  const { answerContent, scope, runner } = workerCtx;
  try {
    ensureNotCancelled(workerCtx.signal);
    // Epic #532 — ground against the scope's own root (a folder that may live outside the chat's
    // project), not the chat projectPath. buildSelectedScope set scope.workspaceRoot = cs.root ??
    // chat.projectPath, so a connected external folder resolves correctly.
    const output = await runner({
      scope,
      query,
      ...groundedRetrievalContinuityFields(workerCtx),
      answerQuestion: answerContent,
      currentQuestion: workerCtx.content,
      answerOnlyContextAvailable: workerCtx.answerOnlyContextAvailable,
      workspaceRoot: scope.workspaceRoot,
      ...optionalWorkspaceFs(workerCtx.workspaceFs),
    });
    ensureNotCancelled(workerCtx.signal);
    return output;
  } catch (error) {
    if (error instanceof ClarificationNeededError) {
      return clarificationRequest(clarificationUserMessage(error));
    }
    const validationResult = mappedContextPackValidationError(
      error,
      workerCtx.deps,
      workerCtx.correlationId,
    );
    if (validationResult !== undefined) return validationResult;
    const workspaceResult = mappedWorkspaceError(error, { correlationId: workerCtx.correlationId });
    if (workspaceResult !== undefined) return workspaceResult;
    const gatewayResult = mappedGatewayError(error, workerCtx.deps, workerCtx.correlationId);
    if (gatewayResult !== undefined) return gatewayResult;
    throw error;
  }
}

async function prepareGroundedAsk(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  signal: AbortSignal,
): Promise<PreparedGroundedAsk | RouteResult> {
  let raw: string;
  try {
    raw = await readBoundedRequestBody(ctx.req, MAX_BODY_BYTES, signal, ctx.correlationId);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return payloadTooLarge();
    if (error instanceof RequestBodyCancelledError) return groundedCancelledResult();
    throw error;
  }
  if (signal.aborted) return groundedCancelledResult();
  const parsed = parseBody(raw);
  if (parsed.kind === "err") return parsed.result;
  const chat = findChatById(deps, parsed.value.chatId);
  if (chat === undefined) return notFound("Chat not found.");
  return { chat, input: parsed.value, signal, request: ctx.req, correlationId: ctx.correlationId };
}

function resolveGroundedRunner(
  deps: UiHandlerDeps,
  modelId: string,
  readinessAdmission: ConversationReadinessAdmission,
  signal: AbortSignal,
  runner: GroundedRunner | undefined,
  correlationId: string | undefined,
):
  | {
      readonly modelId: string;
      readonly contextProfile: UiHandlerDeps["contextProfile"];
      readonly runner: GroundedRunner;
    }
  | RouteResult {
  if (runner !== undefined) {
    return {
      modelId,
      contextProfile: currentContextProfileForModel(deps, modelId),
      runner,
    };
  }
  const contextProfile = currentContextProfileForModel(deps, modelId);
  const builtRunner = defaultRunner(
    deps,
    modelId,
    readinessAdmission,
    signal,
    contextProfile,
    correlationId,
  );
  if (typeof builtRunner !== "function") return builtRunner;
  return { modelId, contextProfile, runner: builtRunner };
}

// ─── Multi-source seam (test injection) ───────────────────────────────────────

// Epic #532 — the multi-source branch's two ports. Tests inject a deterministic retriever (no real
// workspace) plus an answerer; production omits this and builds both from the resolved model port.
export interface MultiSourceSeam {
  readonly retriever: GroundedRetriever;
  readonly answerer: MultiSourceAnswerer;
  /** Test-only: hand the entailment stage in instead of building one from `deps` (KEIKO-0237). */
  readonly entailmentStageFactory?: EntailmentStageFactory;
}

function resolveMultiSourceSeam(
  deps: UiHandlerDeps,
  modelId: string,
  readinessAdmission: ConversationReadinessAdmission,
  signal: AbortSignal,
  override: MultiSourceSeam | undefined,
  correlationId: string | undefined,
): MultiSourceSeam | RouteResult {
  if (override !== undefined) return override;
  const resolvedModel = deps.modelPortFactory(modelId);
  if (resolvedModel === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const model = withConversationReadinessAdmission(
    resolvedModel,
    modelId,
    readinessAdmission,
    deps,
  );
  return {
    retriever: defaultRetriever(signal, deps, correlationId),
    answerer: createMultiSourceAnswerer(deps, model, modelId, signal, correlationId),
  };
}

async function dispatchMultiSourceAsk(
  args: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  scopes: ReturnType<typeof buildConnectedScopes>,
  skippedFolders: readonly SkippedFolderScope[],
  seamOverride: MultiSourceSeam | undefined,
): Promise<RouteResult> {
  const { chat, input, signal } = args;
  // An injected seam (tests) bypasses model-capability resolution exactly as the single-source path
  // does for an injected runner: there is no real model port to validate against. Production (no
  // override) resolves the chat-model guardrails once, shared with the single path.
  const modelId = groundedModelId(args);
  const seam = resolveMultiSourceSeam(
    deps,
    modelId,
    groundedReadinessAdmission(args),
    signal,
    seamOverride,
    args.correlationId,
  );
  if ("status" in seam) return seam;
  return runMultiSourceAsk({
    ...groundedRetrievalContinuityFields(input),
    chat,
    scopes,
    ...(args.sourceScopeFingerprints === undefined
      ? {}
      : { sourceScopeFingerprints: args.sourceScopeFingerprints }),
    content: input.content,
    retrievalContent: input.retrievalContent,
    answerContent: input.answerContent ?? input.content,
    answerOnlyContextAvailable: hasAnswerOnlyContext(args),
    ...(input.clientTurnId === undefined ? {} : { clientTurnId: input.clientTurnId }),
    commitTurnId: groundedCommitTurnId(args),
    userMessage: admittedGroundedUser(args),
    modelId,
    contextProfile: currentContextProfileForModel(deps, modelId),
    deps,
    retriever: seam.retriever,
    answerer: seam.answerer,
    signal,
    ...(seam.entailmentStageFactory !== undefined
      ? { entailmentStageFactory: seam.entailmentStageFactory }
      : {}),
    preSkipped: skippedFolders.map((s) => ({ label: s.label, message: s.message })),
    correlationId: args.correlationId,
  });
}

// Epic #532 — builds the single-source SelectedScope from the canonical list when the legacy
// `connectedScope` field is absent. Uses index 0's per-source id; this branch never applies to a
// legacy chat (which carries `connectedScope`), so the byte-identical legacy path is untouched.
function singleScopeFromList(
  chat: Chat,
  scopes: ReturnType<typeof buildConnectedScopes>,
): SelectedScope | undefined {
  const cs = scopes[0];
  if (cs === undefined) return undefined;
  return buildSelectedScopeFrom(chat, cs, deriveScopeIdFrom(chat, cs, 0));
}

function firstScopeWorkspaceFs(
  scopes: ReturnType<typeof buildConnectedScopes>,
): WorkspaceFs | undefined {
  const first = scopes[0];
  return first === undefined ? undefined : groundedScopeWorkspaceFs(first);
}

// Epic #532 — the folder-only branch (0 handled by caller; 1 → single-source runner unless
// there are pre-skipped folders, in which case multi-source carries the skip notice; 2+ → the
// multi-source merge). Extracted so handleGroundedAsk stays the thin count-based dispatcher.
// Release 0.2.0 — ask-path defense-in-depth (mirror of the hybrid path's capSourcesToLimits):
// a stored over-cap chat (legacy rows, or an operator who later lowered the limits) must not
// fan out unboundedly at ask time. The first `cap` folders (connection order) stay live; the
// rest surface as source-skipped notices (basename label only — no path leak).
function capFolderScopesForAsk(
  deps: UiHandlerDeps,
  scopes: ReturnType<typeof buildConnectedScopes>,
  skippedFolders: readonly SkippedFolderScope[],
): { scopes: ReturnType<typeof buildConnectedScopes>; skipped: readonly SkippedFolderScope[] } {
  const cap = currentGroundingLimits(deps).maxConnectedSources;
  if (scopes.length <= cap) return { scopes, skipped: skippedFolders };
  const overCap = scopes.slice(cap).map((scope): SkippedFolderScope => {
    const label = scope.root !== undefined ? basename(scope.root) : "project";
    const message = "skipped: over the connected-source limit";
    return { label, message, reason: badRequest(`Source "${label}" ${message}.`) };
  });
  return { scopes: scopes.slice(0, cap), skipped: [...skippedFolders, ...overCap] };
}

async function dispatchFolderAsk(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  allScopes: ReturnType<typeof buildConnectedScopes>,
  allSkippedFolders: readonly SkippedFolderScope[],
  runner: GroundedRunner | undefined,
  multiSource: MultiSourceSeam | undefined,
): Promise<RouteResult> {
  const { chat, input, signal } = prepared;
  const { scopes, skipped: skippedFolders } = capFolderScopesForAsk(
    deps,
    allScopes,
    allSkippedFolders,
  );
  // 2+ healthy folders or 1 healthy + some skipped → multi-source (carries skip-notice).
  if (scopes.length >= 2 || (scopes.length === 1 && skippedFolders.length > 0)) {
    return dispatchMultiSourceAsk(prepared, deps, scopes, skippedFolders, multiSource);
  }
  const scope = buildSelectedScope(chat) ?? singleScopeFromList(chat, scopes);
  if (scope === undefined) {
    return badRequest("Chat has no connected scope.");
  }
  const resolved = resolveGroundedRunner(
    deps,
    groundedModelId(prepared),
    groundedReadinessAdmission(prepared),
    signal,
    runner,
    prepared.correlationId,
  );
  if ("status" in resolved) return resolved;
  return runAsk({
    ...groundedRetrievalContinuityFields(input),
    chat,
    scope,
    content: input.content,
    retrievalContent: input.retrievalContent,
    answerContent: input.answerContent ?? input.content,
    answerOnlyContextAvailable: hasAnswerOnlyContext(prepared),
    ...(input.clientTurnId === undefined ? {} : { clientTurnId: input.clientTurnId }),
    commitTurnId: groundedCommitTurnId(prepared),
    userMessage: admittedGroundedUser(prepared),
    modelId: resolved.modelId,
    contextProfile: resolved.contextProfile,
    deps,
    runner: resolved.runner,
    ...optionalWorkspaceFs(firstScopeWorkspaceFs(scopes)),
    signal,
    correlationId: prepared.correlationId,
  });
}

// ─── Hybrid seam (test injection) ─────────────────────────────────────────────

// Epic #189 — the hybrid branch's three ports. Tests inject deterministic retrieval/answer (no real
// workspace or embeddings); production omits this and builds them inside runHybridGroundedAsk.
export interface HybridSeam {
  readonly folderRetriever?: FolderRetriever;
  readonly connectorRetrieve?: ConnectorRetrieve;
  readonly answer?: HybridAnswerer;
  /** Test-only: hand the entailment stage in instead of building one from `deps` (KEIKO-0237). */
  readonly entailmentStageFactory?: EntailmentStageFactory;
}

function hybridSeamFields(seam: HybridSeam | undefined): Partial<{
  folderRetriever: FolderRetriever;
  connectorRetrieve: ConnectorRetrieve;
  answer: HybridAnswerer;
  entailmentStageFactory: EntailmentStageFactory;
}> {
  if (seam === undefined) return {};
  return {
    ...(seam.folderRetriever !== undefined ? { folderRetriever: seam.folderRetriever } : {}),
    ...(seam.connectorRetrieve !== undefined ? { connectorRetrieve: seam.connectorRetrieve } : {}),
    ...(seam.answer !== undefined ? { answer: seam.answer } : {}),
    ...(seam.entailmentStageFactory !== undefined
      ? { entailmentStageFactory: seam.entailmentStageFactory }
      : {}),
  };
}

async function dispatchHybridAsk(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  skippedFolders: readonly SkippedFolderScope[],
  seam: HybridSeam | undefined,
): Promise<RouteResult> {
  const { chat, input, signal } = prepared;
  // An injected answerer (tests) bypasses model-capability resolution exactly as the multi-source
  // path does: there is no real model port to validate. Production resolves the guardrails once.
  const modelId = groundedModelId(prepared);
  return runHybridGroundedAsk({
    ...groundedRetrievalContinuityFields(input),
    chat,
    ...(prepared.sourceScopeFingerprints === undefined
      ? {}
      : { sourceScopeFingerprints: prepared.sourceScopeFingerprints }),
    content: input.content,
    retrievalContent: input.retrievalContent,
    answerContent: input.answerContent ?? input.content,
    answerOnlyContextAvailable: hasAnswerOnlyContext(prepared),
    ...(input.clientTurnId === undefined ? {} : { clientTurnId: input.clientTurnId }),
    userMessage: admittedGroundedUser(prepared),
    modelId,
    contextProfile: currentContextProfileForModel(deps, modelId),
    deps,
    signal,
    correlationId: prepared.correlationId,
    readinessAdmission: groundedReadinessAdmission(prepared),
    preSkippedFolders: skippedFolders.map((s) => ({
      label: s.label,
      reason: "not-accessible",
      message: s.message,
    })),
    ...hybridSeamFields(seam),
  });
}

// ─── Public handler ───────────────────────────────────────────────────────────

function canonicalizePreparedFolderScopes(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): CanonicalizedFolderScopes {
  return canonicalizeGroundedFolderScopes(
    prepared.chat,
    deps,
    buildConnectedScopes(prepared.chat),
    prepared.request,
    prepared.correlationId,
  );
}

function unavailableFolderResult(skipped: readonly SkippedFolderScope[]): RouteResult {
  return (
    skipped.find((entry) => entry.reason.status === 503)?.reason ??
    skipped[0]?.reason ??
    badRequest("Chat has no connected scope.")
  );
}

async function dispatchPreparedGroundedAsk(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  runner?: GroundedRunner,
  multiSource?: MultiSourceSeam,
  hybrid?: HybridSeam,
): Promise<RouteResult> {
  const { chat } = prepared;
  // Epic #189 — count-based dispatch over BOTH source kinds. 0+0 → no scope. Connector-free chats
  // keep the EXISTING folder path (#532, byte-identical). A lone connector with no folders keeps the
  // EXISTING single-connector path (#189, byte-identical). Everything else (folders+connector, or
  // 2+ connectors) is the hybrid merge.
  // Fail-soft: inaccessible/denied folders are skipped; only effective (canonical) counts drive
  // dispatch. With no usable source, preserve the admission failure or retriable outage status.
  const {
    canonical: canonicalFolderScopes,
    skipped: skippedFolders,
    sourceScopeFingerprints,
  } = canonicalizePreparedFolderScopes(prepared, deps);
  const preparedWithCanonicalFolders: PreparedGroundedAsk = {
    ...prepared,
    chat: withCanonicalFolderScopes(chat, canonicalFolderScopes),
    sourceScopeFingerprints,
  };
  const connectorCount = buildLocalKnowledgeScopes(chat).length;
  const effectiveFolders = canonicalFolderScopes.length;
  if (effectiveFolders === 0 && connectorCount === 0) {
    return unavailableFolderResult(skippedFolders);
  }
  if (connectorCount === 0) {
    return dispatchFolderAsk(
      preparedWithCanonicalFolders,
      deps,
      canonicalFolderScopes,
      skippedFolders,
      runner,
      multiSource,
    );
  }
  if (effectiveFolders === 0 && connectorCount === 1) {
    return handleLocalKnowledgeGroundedAsk(
      chat,
      {
        ...prepared.input,
        answerOnlyContextAvailable: hasAnswerOnlyContext(prepared),
        userMessage: admittedGroundedUser(prepared),
      },
      deps,
      prepared.signal,
      groundedReadinessAdmission(prepared),
      prepared.correlationId,
    );
  }
  return dispatchHybridAsk(preparedWithCanonicalFolders, deps, skippedFolders, hybrid);
}

function admitGroundedUser(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): PreparedGroundedAsk | RouteResult {
  if (prepared.userMessage !== undefined) return prepared;
  const messageCountBeforeTurn = deps.store.countMessages(prepared.chat.id);
  const newUserMessage = {
    chatId: prepared.chat.id,
    role: "user",
    content: redactString(deps.redactor, prepared.input.content),
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  } as const;
  const commitTurnId = prepared.input.clientTurnId ?? randomUUID();
  const admission = deps.store.admitChatTurn(commitTurnId, newUserMessage, {
    identityContent: frozenGroundedTurnIdentity(prepared),
  });
  if (admission.kind === "admitted") {
    return {
      ...prepared,
      commitTurnId,
      userMessage: admission.userMessage,
      messageCountBeforeTurn,
    };
  }
  if (admission.kind === "replay") {
    return admission.assistantMessage.groundedAnswer === undefined
      ? groundedTurnConflict("CHAT_TURN_IDEMPOTENCY_CONFLICT")
      : { status: 200, body: admission.assistantMessage.groundedAnswer };
  }
  return groundedTurnConflict(
    admission.kind === "in-progress" ? "CHAT_TURN_IN_PROGRESS" : "CHAT_TURN_IDEMPOTENCY_CONFLICT",
  );
}

async function admitGroundedModel(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  allowInjectedModelSeam: boolean,
): Promise<PreparedGroundedAsk | RouteResult> {
  const requestedModelId = prepared.input.modelId ?? prepared.chat.selectedModel;
  const resolvedModelId = resolveGroundedModelId(deps, prepared.chat, prepared.input.modelId);
  if (typeof resolvedModelId !== "string") {
    if (!allowInjectedModelSeam) return resolvedModelId;
    // Deterministic injected answer ports do not perform provider egress. Preserve those test
    // seams without weakening production model validation.
    return {
      ...prepared,
      modelId: requestedModelId,
      readinessAdmission: { modelId: requestedModelId },
    };
  }
  const modelId = resolvedModelId;
  // Join configuration-owned initialization after restart or replacement. Grounded questions
  // never start provider probes; injected deterministic answer ports skip this await.
  if (!allowInjectedModelSeam) {
    await awaitInitializedConversationReadiness(deps, modelId, prepared.correlationId);
  }
  const readinessAdmission = captureConversationReadinessAdmission(deps, modelId);
  return "status" in readinessAdmission
    ? readinessAdmission
    : { ...prepared, modelId, readinessAdmission };
}

function groundedTurnConflict(
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

function compactGroundedCurrentPrompt(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): Promise<string> {
  const modelId = groundedModelId(prepared);
  return compactCurrentChatPrompt({
    content: prepared.input.content,
    modelId,
    profile: currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE,
    signal: prepared.signal,
    correlationId: prepared.correlationId,
    redact: (value) => redactedString(deps.redactor, value),
    call: (request, signal) => {
      const model = resolveGroundedAnswerModel(deps, modelId, groundedReadinessAdmission(prepared));
      if (isRouteResult(model))
        throw new ProviderError("The prompt compaction model is unavailable.", model.status);
      return model.call(request, signal);
    },
  });
}

async function withGroundedContinuity(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): Promise<PreparedGroundedAsk> {
  const continuityStartedAt = Date.now();
  const content = await compactGroundedCurrentPrompt(prepared, deps);
  const continuity = groundedConversationContinuity(
    deps,
    { ...admittedGroundedUser(prepared), content },
    groundedModelId(prepared),
    prepared.correlationId,
    admittedGroundedUser(prepared).content,
  );
  return {
    ...prepared,
    continuity,
    continuityStartedAt,
    input: {
      ...prepared.input,
      content,
      retrievalContent: continuity.retrievalContent,
      ...groundedRetrievalContinuityFields(continuity),
      answerContent: [continuity.answerContext, content].filter(Boolean).join("\n\n"),
    },
  };
}

function persistGroundedContinuity(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  result: RouteResult,
): void {
  if (result.status !== 200 || prepared.continuity?.compaction === undefined) return;
  if (prepared.messageCountBeforeTurn === undefined || prepared.continuityStartedAt === undefined)
    throw new Error("Grounded continuity evidence was not admitted.");
  persistChatCompactionEvidence(deps, {
    compaction: prepared.continuity.compaction,
    chatId: prepared.chat.id,
    modelId: groundedModelId(prepared),
    messageCount: prepared.messageCountBeforeTurn,
    startedAt: prepared.continuityStartedAt,
    finishedAt: Date.now(),
    correlationId: prepared.correlationId,
  });
}

function groundedAnswerContent(content: string, memory: ConversationMemoryResultWire): string {
  const memoryText = memory.context.text.trim();
  if (!memory.context.enabled || memoryText.length === 0) return content;
  return ["User question:", content, "", renderConversationMemoryContextBlock(memoryText)].join(
    "\n",
  );
}

function groundedMemoryPreparationFailure(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  error: unknown,
): PreparedGroundedAsk | RouteResult {
  recordGroundedMemoryFailure(prepared, deps, error);
  return prepared;
}

function withPreparedGroundedMemory(
  prepared: PreparedGroundedAsk,
  context: ConversationMemoryRuntimeContext,
  result: ConversationMemoryResultWire,
): PreparedGroundedAsk {
  return {
    ...prepared,
    input: {
      ...prepared.input,
      answerContent: groundedAnswerContent(
        prepared.input.answerContent ?? prepared.input.content,
        result,
      ),
    },
    memory: {
      context,
      result,
      answerOnlyContextAvailable:
        result.context.enabled &&
        result.context.memories.length > 0 &&
        result.context.text.trim().length > 0,
    },
  };
}

async function prepareGroundedMemory(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): Promise<PreparedGroundedAsk | RouteResult> {
  const memoryRequest = prepared.input.memory;
  if (memoryRequest === undefined) return prepared;
  const context = prepared.memoryContext;
  if (context === undefined) {
    return groundedMemoryPreparationFailure(
      prepared,
      deps,
      Object.assign(new Error("Grounded memory context is unavailable"), {
        name: "GroundedMemoryContextUnavailable",
      }),
    );
  }
  try {
    const result = await buildMemoryResult(
      {
        chatId: prepared.chat.id,
        projectPath: prepared.chat.projectPath,
        content: prepared.input.content,
        modelId: prepared.input.modelId,
        documentContext: [],
        attachments: [],
        memory: memoryRequest,
        discussionMode: undefined,
      },
      deps,
      context,
    );
    return withPreparedGroundedMemory(prepared, context, result);
  } catch (error) {
    return groundedMemoryPreparationFailure(prepared, deps, error);
  }
}

function groundedScopeRefusal(
  admitted: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  reason: "scope-identity-mismatch" | "grounding-mode-changed" | "scope-changed-during-answer",
): RouteResult {
  const message = {
    "scope-identity-mismatch": "The grounded source scope changed before the turn could run.",
    "grounding-mode-changed": "The chat grounding mode changed before the turn could run.",
    "scope-changed-during-answer":
      "The grounded source scope changed while the answer was in progress.",
  }[reason];
  logChatRejection(
    "chat.send.rejected",
    admitted.correlationId,
    groundedModelId(admitted),
    deps,
    409,
    "grounding-scope",
  );
  emitServerDiagnostic(deps.diagnostics, {
    ...serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(admitted.correlationId),
      operation: "POST /api/chats/messages/grounded",
      source: `grounded.qa.${reason}`,
      error: Object.assign(new Error(message), { code: "GROUNDING_SCOPE_CHANGED" }),
      redact: (value): string => redactString(deps.redactor, value),
    }),
    errorClass: "invalid-request",
    httpStatus: 409,
    diagnosticOutcome: "request-refused",
  });
  return settleGroundedChatTurn(admitted, deps, {
    status: 409,
    body: errorBody("GROUNDING_SCOPE_CHANGED", message, admitted.correlationId),
  });
}

function admittedGroundingScopeFailure(
  admitted: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): RouteResult | undefined {
  const expectedIdentity = admitted.input.expectedGroundingScopeIdentity;
  if (
    expectedIdentity !== undefined &&
    expectedIdentity !== deriveChatGroundingScopeIdentity(admitted.chat)
  ) {
    return groundedScopeRefusal(admitted, deps, "scope-identity-mismatch");
  }
  if (
    expectedIdentity === undefined ||
    buildConnectedScopes(admitted.chat).length > 0 ||
    buildLocalKnowledgeScopes(admitted.chat).length > 0
  ) {
    return undefined;
  }
  return groundedScopeRefusal(admitted, deps, "grounding-mode-changed");
}

function withHistoryCompactionSummary(
  pack: GroundedAnswerContextPackSummary,
): GroundedAnswerContextPackSummary {
  return pack.contextSummary === undefined
    ? pack
    : {
        ...pack,
        contextSummary: { ...pack.contextSummary, compactionActive: true },
      };
}

function withGroundedCompactionSummary(
  prepared: PreparedGroundedAsk,
  result: RouteResult,
): RouteResult {
  if (
    prepared.continuity?.compaction === undefined ||
    result.status !== 200 ||
    !groundedAnswerBody(result.body)
  )
    return result;
  const answer = result.body;
  if (answer.groundingKind === "local-knowledge") return result;
  const contextPack =
    answer.groundingKind === "hybrid"
      ? { ...answer.contextPack, folder: withHistoryCompactionSummary(answer.contextPack.folder) }
      : withHistoryCompactionSummary(answer.contextPack);
  return { ...result, body: { ...answer, contextPack } };
}

async function prepareGroundedMemoryWithContinuity(
  admitted: PreparedGroundedAsk,
  deps: UiHandlerDeps,
): Promise<PreparedGroundedAsk | RouteResult> {
  return prepareGroundedMemory(await withGroundedContinuity(admitted, deps), deps);
}

async function runAdmittedGroundedAsk(
  admitted: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  runner?: GroundedRunner,
  multiSource?: MultiSourceSeam,
  hybrid?: HybridSeam,
): Promise<RouteResult> {
  let stagedAssistantId: string | undefined;
  try {
    const memoryPrepared = await prepareGroundedMemoryWithContinuity(admitted, deps);
    ensureNotCancelled(admitted.signal);
    if (isRouteResult(memoryPrepared)) {
      return settleGroundedChatTurn(admitted, deps, memoryPrepared);
    }
    const staleReadiness = validateConversationReadinessAdmission(
      deps,
      groundedReadinessAdmission(memoryPrepared),
      groundedModelId(memoryPrepared),
    );
    if (staleReadiness !== undefined) {
      return settleGroundedChatTurn(memoryPrepared, deps, staleReadiness);
    }
    const result = await dispatchPreparedGroundedAsk(
      memoryPrepared,
      deps,
      runner,
      multiSource,
      hybrid,
    );
    if (result.status === 200 && groundedAnswerBody(result.body)) {
      stagedAssistantId = result.body.assistantMessageId;
    }
    ensureNotCancelled(memoryPrepared.signal);
    const withMemory = withGroundedCompactionSummary(
      memoryPrepared,
      await attachGroundedMemory(memoryPrepared, deps, result),
    );
    ensureNotCancelled(memoryPrepared.signal);
    const settled = settleGroundedChatTurn(memoryPrepared, deps, withMemory);
    persistGroundedContinuity(memoryPrepared, deps, settled);
    return settled;
  } catch (error) {
    if (stagedAssistantId !== undefined) discardGroundedTurn(stagedAssistantId);
    deps.store.failChatTurn(admitted.chat.id, groundedCommitTurnId(admitted));
    if (admitted.signal.aborted) return groundedCancelledResult();
    throw error;
  }
}

async function executeGroundedAskInTurn(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  runner?: GroundedRunner,
  multiSource?: MultiSourceSeam,
  hybrid?: HybridSeam,
): Promise<RouteResult> {
  const modelAdmitted = await admitGroundedModel(
    prepared,
    deps,
    runner !== undefined || multiSource !== undefined || hybrid?.answer !== undefined,
  );
  if (isRouteResult(modelAdmitted)) return modelAdmitted;
  const admitted = admitGroundedUser(modelAdmitted, deps);
  if (isRouteResult(admitted)) return admitted;
  const scopeFailure = admittedGroundingScopeFailure(admitted, deps);
  if (scopeFailure !== undefined) return scopeFailure;
  const releaseSession = beginAppSessionOperation(deps, admitted.request, admitted.signal, {
    correlationId: admitted.correlationId,
    surface: "grounded-chat",
  });
  try {
    return await runAdmittedGroundedAsk(admitted, deps, runner, multiSource, hybrid);
  } finally {
    releaseSession();
  }
}

async function executeGroundedAsk(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  runner?: GroundedRunner,
  multiSource?: MultiSourceSeam,
  hybrid?: HybridSeam,
): Promise<RouteResult> {
  const result = await runSerializedChatTurn(deps, prepared.chat.id, prepared.signal, () => {
    const chat = findChatById(deps, prepared.chat.id);
    if (chat === undefined) return notFound("Chat not found.");
    const frozen = freezeGroundedTurn({ ...prepared, chat }, deps);
    if (isRouteResult(frozen)) return frozen;
    if (frozen.input.clientTurnId !== undefined) {
      const inspection = deps.store.inspectChatTurn(
        chat.id,
        frozen.input.clientTurnId,
        frozenGroundedTurnIdentity(frozen),
      );
      if (inspection.kind === "replay") {
        return inspection.assistantMessage.groundedAnswer === undefined
          ? groundedTurnConflict("CHAT_TURN_IDEMPOTENCY_CONFLICT")
          : { status: 200, body: inspection.assistantMessage.groundedAnswer };
      }
    }
    const closed = chatClosedResult(chat);
    if (closed !== undefined) return closed;
    if (
      frozen.input.expectedGroundingScopeIdentity === undefined &&
      buildConnectedScopes(chat).length === 0 &&
      buildLocalKnowledgeScopes(chat).length === 0
    ) {
      return badRequest("Chat has no connected scope.");
    }
    return executeGroundedAskInTurn(frozen, deps, runner, multiSource, hybrid);
  });
  return result === CHAT_TURN_WAIT_CANCELLED ? groundedCancelledResult() : result;
}

function groundedCancelledResult(): RouteResult {
  return { status: 499, body: errorBody("CANCELLED", "Grounded request was cancelled.") };
}

function settleGroundedChatTurn(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  result: RouteResult,
): RouteResult {
  const commitTurnId = groundedCommitTurnId(prepared);
  if (result.status !== 200 || !groundedAnswerBody(result.body)) {
    deps.store.failChatTurn(prepared.chat.id, commitTurnId);
    return result;
  }
  if (!groundedScopeStillCurrent(prepared, deps)) {
    discardGroundedTurn(result.body.assistantMessageId);
    return groundedScopeRefusal(prepared, deps, "scope-changed-during-answer");
  }
  if (
    result.body.memory !== undefined ||
    hasAnswerOnlyContext(prepared) ||
    prepared.continuity?.compaction !== undefined
  ) {
    deps.store.attachGroundedAnswer(result.body.assistantMessageId, result.body);
  }
  let completion;
  try {
    completion = deps.store.completeChatTurn(
      prepared.chat.id,
      commitTurnId,
      frozenGroundedTurnIdentity(prepared),
      result.body.assistantMessageId,
    );
  } catch (error) {
    discardGroundedTurn(result.body.assistantMessageId);
    throw error;
  }
  if (completion.kind !== "completed") {
    discardGroundedTurn(result.body.assistantMessageId);
    deps.store.failChatTurn(prepared.chat.id, commitTurnId);
    return groundedCompletionFailure(deps, prepared.correlationId, completion.kind);
  }
  commitGroundedTurn(result.body.assistantMessageId);
  runGroundedPostCommitMemorySideEffects(prepared, deps, result.body);
  return result;
}

function runGroundedPostCommitMemorySideEffects(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  answer: GroundedAnswer,
): void {
  if (answer.memory === undefined || prepared.memory === undefined) return;
  runPostCommitCanonicalTurnMemorySideEffects(
    deps,
    groundedCanonicalMemoryRequest(prepared, answer.content),
    prepared.memory.context,
    prepared.input.modelId ?? prepared.chat.selectedModel,
    answer.memory,
    answer.content,
    answer.assistantMessageId,
  );
}

export async function runGroundedAskInput(
  input: AskInput,
  deps: UiHandlerDeps,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly runner?: GroundedRunner | undefined;
    readonly multiSource?: MultiSourceSeam | undefined;
    readonly hybrid?: HybridSeam | undefined;
  } = {},
): Promise<RouteResult> {
  const chat = findChatById(deps, input.chatId);
  if (chat === undefined) return notFound("Chat not found.");
  return executeGroundedAsk(
    { chat, input, signal: options.signal ?? new AbortController().signal },
    deps,
    options.runner,
    options.multiSource,
    options.hybrid,
  );
}

function groundedAnswerBody(value: unknown): value is GroundedAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "groundingKind" in value &&
    "userMessageId" in value &&
    "assistantMessageId" in value &&
    "content" in value
  );
}

function recordGroundedMemoryFailure(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(prepared.correlationId),
      operation: "grounded.memory",
      source: "grounded-qa.attach-memory",
      summary: "grounded-memory-enrichment-failed",
      error,
      redact: (value): string => redactString(deps.redactor, value),
    }),
  );
}

function groundedCanonicalMemoryRequest(
  prepared: PreparedGroundedAsk,
  assistantContent: string,
): CanonicalTurnMemoryRequest {
  return {
    chatId: prepared.chat.id,
    projectPath: prepared.chat.projectPath,
    messages: [
      { role: "user", content: prepared.input.content },
      { role: "assistant", content: assistantContent },
    ],
    modelId: prepared.input.modelId,
    memory: prepared.input.memory,
    ...(prepared.input.clientTurnId === undefined
      ? {}
      : { clientTurnId: prepared.input.clientTurnId }),
  };
}

async function attachGroundedMemory(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  result: RouteResult,
): Promise<RouteResult> {
  const memoryRequest = prepared.input.memory;
  if (memoryRequest === undefined || result.status !== 200 || !groundedAnswerBody(result.body)) {
    return result;
  }
  const memoryPreparation = prepared.memory;
  if (memoryPreparation === undefined) return result;
  const body = hasAnswerOnlyContext(prepared)
    ? groundedAnswerWithMemoryUncertainty(result.body, deps)
    : result.body;
  const markedResult: RouteResult = body === result.body ? result : { ...result, body };
  const chat = deps.store.findChatById(prepared.chat.id) ?? prepared.chat;
  try {
    const memory = await buildCanonicalTurnMemoryResult(
      deps,
      groundedCanonicalMemoryRequest(
        { ...prepared, chat, input: { ...prepared.input, memory: memoryRequest } },
        result.body.content,
      ),
      memoryPreparation.context,
      {
        retrievalContent: prepared.input.content,
        precomputedMemory: memoryPreparation.result,
      },
    );
    return memory === undefined ? markedResult : { ...markedResult, body: { ...body, memory } };
  } catch (error) {
    recordGroundedMemoryFailure(prepared, deps, error);
    return markedResult;
  }
}

function groundedAnswerWithMemoryUncertainty(
  body: GroundedAnswer,
  deps: UiHandlerDeps,
): GroundedAnswer {
  const marker = uncitedMemoryContextMarker(Date.now());
  return {
    ...body,
    uncertainty: [
      ...body.uncertainty,
      { kind: marker.kind, claim: redactString(deps.redactor, marker.claim) },
    ],
  };
}

export async function handleGroundedAsk(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runner?: GroundedRunner,
  multiSource?: MultiSourceSeam,
  hybrid?: HybridSeam,
): Promise<RouteResult> {
  const cancellation = createRequestCancellation(ctx, "grounded request cancelled");
  try {
    const prepared = await prepareGroundedAsk(ctx, deps, cancellation.signal);
    if (cancellation.signal.aborted) return groundedCancelledResult();
    if ("status" in prepared) return prepared;
    const result = await executeGroundedAsk(prepared, deps, runner, multiSource, hybrid);
    if (result.status === 200 && groundedAnswerBody(result.body)) {
      logChatResponseMessage(result.body.assistantMessageId, ctx.correlationId);
    }
    return result;
  } finally {
    cancellation.dispose();
  }
}
