/**
 * Typed fetch wrapper for the 12 BFF routes (ADR-0011 D5).
 * Same-origin relative paths (/api/...). Parses the {error:{code,message}} envelope.
 * Never logs response bodies.
 */

import type {
  BffError,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatResponse,
  ChatsResponse,
  ConversationDocumentContextWire,
  ConversationMemoryRequestWire,
  ChatStatus,
  ChatMessageRole,
  ChatWorkflowStatus,
  DesktopChatBootstrapResponse,
  DesktopChatSendResponse,
  EvidenceListEntry,
  EvidenceManifest,
  GroundedAnswer,
  GroundedAskRequest,
  FilesDirectoryListing,
  FilesContentResponse,
  FilesPreviewResponse,
  FilesSearchResponse,
  FilesTreeResponse,
  GatewayReadinessOptions,
  GatewayReadinessReport,
  EditorDocumentVersion,
  EditorCompletionContextSelectors,
  EditorCompletionWireRequest,
  EditorCompletionWireResponse,
  EditorCompletionWireTriggerKind,
  EditorInlineCompletionWireRequest,
  EditorInlineCompletionWireResponse,
  EditorInlineCompletionWireTriggerKind,
  EditorInlineCompletionTelemetryReport,
  EditorTestGenerationWireRequest,
  EditorTestGenerationWireResponse,
  EditorTestGenerationWireTarget,
  EditorPatchApplyDecision,
  EditorPatchApplyWireRequest,
  EditorPatchApplyWireResponse,
  LanguageDiagnosticsResult,
  LanguageServiceCapabilities,
  LanguageHoverResult,
  LanguageSymbolResult,
  LanguageFormattingResult,
  LanguageFormattingOptions,
  EditorAgentAction,
  EditorAgentActionQueuedResponse,
  EditorAgentActionResultRequest,
  EditorAgentSessionSnapshot,
  EditorAgentSessionsResponse,
  EditorAgentSnapshotRequest,
  EditorAgentSnapshotResponse,
  CostClass,
  GroundingLimits,
  MessageResponse,
  MessagesResponse,
  ModelCapability,
  PatchChatMessageBody,
  PatchMessageResponse,
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
  ProjectResponse,
  ProjectsResponse,
  RunReport,
  SafeGatewayConfig,
  WorkspaceSummary,
  WorkflowsResponse,
} from "./types";
import {
  DEFAULT_GROUNDING_LIMITS,
  EDITOR_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
  EDITOR_TEST_GENERATION_SCHEMA_VERSION,
  EDITOR_PATCH_APPLY_SCHEMA_VERSION,
} from "./types";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(isStateChanging ? { "Content-Type": "application/json" } : {}),
      ...(isStateChanging ? { "X-Keiko-CSRF": "1" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as BffError;
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic message, never log body
    }
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Route 1 — health
// ---------------------------------------------------------------------------

export async function fetchHealth(): Promise<{ status: "ok"; version: string }> {
  return fetchJson("/api/health");
}

// ---------------------------------------------------------------------------
// Route 2 — config
// ---------------------------------------------------------------------------

export async function fetchConfig(): Promise<{
  config: SafeGatewayConfig | null;
  configPresent: boolean;
  effectiveGroundingLimits: GroundingLimits;
}> {
  const raw = await fetchJson<{
    config: SafeGatewayConfig | null;
    configPresent: boolean;
    effectiveGroundingLimits?: GroundingLimits;
  }>("/api/config");
  return {
    config: raw.config,
    configPresent: raw.configPresent,
    effectiveGroundingLimits: raw.effectiveGroundingLimits ?? DEFAULT_GROUNDING_LIMITS,
  };
}

// ---------------------------------------------------------------------------
// Route 3 — models
// ---------------------------------------------------------------------------

let modelsRequest: Promise<{ models: ModelCapability[] }> | undefined;

export function clearModelCacheForTests(): void {
  modelsRequest = undefined;
}

export async function fetchModels(): Promise<{ models: ModelCapability[] }> {
  modelsRequest ??= fetchJson<{ models: ModelCapability[] }>("/api/models").catch(
    (error: unknown) => {
      modelsRequest = undefined;
      throw error;
    },
  );
  return modelsRequest;
}

export interface GatewaySetupInput {
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiKeyHeaderName?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly deploymentNames?: readonly string[] | undefined;
  readonly imageInputModelIds?: readonly string[] | undefined;
  readonly figmaAccessToken?: string | undefined;
  readonly preserveExisting?: boolean | undefined;
}

export interface GatewaySetupResponse {
  readonly ok: true;
  readonly testedModelId: string;
  readonly testedModelIds: readonly string[];
  readonly skippedModelIds?: readonly string[] | undefined;
  readonly providerCount: number;
  readonly models: ModelCapability[];
  readonly config: SafeGatewayConfig;
}

export async function setupGateway(body: GatewaySetupInput): Promise<GatewaySetupResponse> {
  const response = await fetchJson<GatewaySetupResponse>("/api/gateway/setup", {
    method: "POST",
    body: JSON.stringify(body),
  });
  clearModelCacheForTests();
  return response;
}

export async function runGatewayReadiness(
  modelId?: string,
  options?: GatewayReadinessOptions,
): Promise<GatewayReadinessReport> {
  return fetchJson<GatewayReadinessReport>("/api/gateway/readiness", {
    method: "POST",
    body: JSON.stringify({
      ...(modelId === undefined ? {} : { modelId }),
      ...(options === undefined ? {} : { options }),
    }),
  });
}

// ---------------------------------------------------------------------------
// Route 4 — workflows
// ---------------------------------------------------------------------------

export async function fetchWorkflows(): Promise<WorkflowsResponse> {
  return fetchJson("/api/workflows");
}

// ---------------------------------------------------------------------------
// Route 5 — start run
// ---------------------------------------------------------------------------

export interface StartRunInput {
  workflowId?: string;
  taskType?: string;
  input: Record<string, unknown>;
  modelId: string;
  apply?: boolean;
  limits?: Record<string, unknown>;
}

export async function startRun(
  body: StartRunInput,
): Promise<{ runId: string; fingerprint: string }> {
  return fetchJson("/api/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Epic #1307 / Issue #1314 — generate a governed, reviewable Enhanced Prompt. Deterministic and
// provider-neutral; the result is data for review, never executed. The optional AbortSignal lets the
// panel cancel an in-flight request when the user edits the draft again.
export async function enhancePrompt(
  body: PromptEnhancementWireRequest,
  signal?: AbortSignal,
): Promise<PromptEnhancementWireResponse> {
  return fetchJson<PromptEnhancementWireResponse>("/api/prompt-enhancement", {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

// ---------------------------------------------------------------------------
// Route 7 — cancel run
// ---------------------------------------------------------------------------

export async function cancelRun(runId: string): Promise<{ ok: true }> {
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

// ---------------------------------------------------------------------------
// Route 8 — get run report
// ---------------------------------------------------------------------------

export async function fetchRunReport(runId: string): Promise<{ report: RunReport }> {
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
}

// ---------------------------------------------------------------------------
// Route 9 — apply patch
// ---------------------------------------------------------------------------

export async function applyRun(runId: string): Promise<{ report: RunReport }> {
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

// ---------------------------------------------------------------------------
// Route 10 — list evidence
// ---------------------------------------------------------------------------

export interface EvidenceFilters {
  workspace?: string;
  date?: string;
  workflow?: string;
  model?: string;
  outcome?: string;
}

export async function fetchEvidenceList(
  filters: EvidenceFilters = {},
): Promise<{ entries: EvidenceListEntry[] }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return fetchJson(`/api/evidence${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Route 11 — get evidence manifest
// ---------------------------------------------------------------------------

export async function fetchEvidenceManifest(
  runId: string,
): Promise<{ manifest: EvidenceManifest }> {
  return fetchJson(`/api/evidence/${encodeURIComponent(runId)}`);
}

// ---------------------------------------------------------------------------
// Route 12 — workspace summary
// ---------------------------------------------------------------------------

export interface WorkspaceSummaryFilters {
  dir: string;
  task?: string;
  budget?: number;
}

export async function fetchWorkspaceSummary(
  filters: WorkspaceSummaryFilters,
): Promise<{ summary: WorkspaceSummary }> {
  const params = new URLSearchParams();
  params.set("dir", filters.dir);
  if (filters.task !== undefined) {
    params.set("task", filters.task);
  }
  if (filters.budget !== undefined) {
    params.set("budget", String(filters.budget));
  }
  const qs = params.toString();
  return fetchJson(`/api/workspace${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// ADR-0013 — UI-local persistence client (routes 13–22)
// ---------------------------------------------------------------------------

let projectsRequest: Promise<ProjectsResponse> | undefined;

export function clearProjectRequestForTests(): void {
  projectsRequest = undefined;
}

export async function fetchProjects(): Promise<ProjectsResponse> {
  projectsRequest ??= fetchJson<ProjectsResponse>("/api/projects").finally(() => {
    projectsRequest = undefined;
  });
  return projectsRequest;
}

export interface CreateProjectInput {
  path: string;
  name?: string;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectResponse> {
  return fetchJson("/api/projects", { method: "POST", body: JSON.stringify(input) });
}

export interface UpdateProjectInput {
  name?: string;
  favorite?: boolean;
}

export async function updateProject(
  path: string,
  patch: UpdateProjectInput,
): Promise<ProjectResponse> {
  return fetchJson(`/api/projects?path=${encodeURIComponent(path)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteProject(path: string): Promise<void> {
  await fetchJson<void>(`/api/projects?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    body: "{}",
  });
}

export async function fetchChats(projectPath: string): Promise<ChatsResponse> {
  return fetchJson(`/api/chats?projectPath=${encodeURIComponent(projectPath)}`);
}

export interface CreateChatInput {
  projectPath: string;
  title: string;
  selectedModel: string;
  branchLabel?: string;
}

export async function createChat(input: CreateChatInput): Promise<ChatResponse> {
  return fetchJson("/api/chats", { method: "POST", body: JSON.stringify(input) });
}

export interface UpdateChatInput {
  title?: string;
  selectedModel?: string;
  branchLabel?: string;
  status?: ChatStatus;
  connectedScope?: ChatConnectedScope | null;
  connectedScopes?: readonly ChatConnectedScope[] | null;
  localKnowledgeScope?: ChatLocalKnowledgeScope | null;
  localKnowledgeScopes?: readonly ChatLocalKnowledgeScope[] | null;
}

export async function updateChat(id: string, patch: UpdateChatInput): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// Epic #532 — M3: bind a list of sources (1+N) to a chat. `null` clears ALL
// connected scopes. Kept separate from the single-source helper so callers
// that still use singular binding are not affected. Always patches the plural
// `connectedScopes` field so the BFF stores and returns the canonical list.
export async function updateChatConnectedScopes(
  chatId: string,
  scopes: readonly ChatConnectedScope[] | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ connectedScopes: scopes }),
  });
}

export async function updateChatLocalKnowledgeScope(
  chatId: string,
  scope: ChatLocalKnowledgeScope | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ localKnowledgeScope: scope }),
  });
}

// Epic #189 — Slice 3 M1: bind a plural list of connector sources to a chat. `null` clears ALL
// localKnowledgeScopes. Mirrors `updateChatConnectedScopes` for the local-knowledge side.
// Always patches the plural `localKnowledgeScopes` field so the BFF stores and returns the list.
export async function updateChatLocalKnowledgeScopes(
  chatId: string,
  scopes: readonly ChatLocalKnowledgeScope[] | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ localKnowledgeScopes: scopes }),
  });
}

export async function deleteChat(id: string): Promise<void> {
  await fetchJson<void>(`/api/chats?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: "{}",
  });
}

export async function fetchChatMessages(
  chatId: string,
  projectPath: string,
): Promise<MessagesResponse> {
  const params = new URLSearchParams();
  params.set("chatId", chatId);
  params.set("projectPath", projectPath);
  return fetchJson(`/api/chats/messages?${params.toString()}`);
}

export interface CreateMessageInput {
  chatId: string;
  projectPath: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  runId?: string;
  workflowId?: string;
  workflowStatus?: ChatWorkflowStatus;
  shortResult?: string;
  /** Issue #66 — labels harness task runs (verify, explain-plan). */
  taskType?: string;
}

export async function createChatMessage(input: CreateMessageInput): Promise<MessageResponse> {
  return fetchJson("/api/chats/messages", { method: "POST", body: JSON.stringify(input) });
}

export interface CreateRunSummaryPairInput {
  chatId: string;
  projectPath: string;
  user: {
    content: string;
    timestamp: number;
  };
  summary: {
    content: string;
    timestamp: number;
    runId: string;
    workflowId?: string;
    workflowStatus: ChatWorkflowStatus;
    shortResult?: string;
    /** Issue #66 — labels harness task runs (verify, explain-plan). */
    taskType?: string;
  };
}

export async function createRunSummaryPair(
  input: CreateRunSummaryPairInput,
): Promise<MessagesResponse> {
  return fetchJson("/api/chats/messages/run-summary-pair", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Issue #66 — PATCH the run-summary message in place and keep the selected project's
// normalized path on the request so the BFF can enforce chat ownership before patching.
export async function patchChatMessage(
  id: string,
  chatId: string,
  projectPath: string,
  body: PatchChatMessageBody,
): Promise<PatchMessageResponse> {
  const params = new URLSearchParams();
  params.set("id", id);
  params.set("chatId", chatId);
  params.set("projectPath", projectPath);
  return fetchJson(`/api/chats/messages?${params.toString()}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Desktop canvas V1 — real chat through the existing model gateway
// ---------------------------------------------------------------------------

export interface CreateDesktopChatInput {
  projectPath?: string;
  title?: string;
  modelId?: string;
}

export async function createDesktopChat(
  input: CreateDesktopChatInput = {},
): Promise<DesktopChatBootstrapResponse> {
  return fetchJson("/api/desktop/chats", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface SendDesktopChatInput {
  chatId: string;
  projectPath: string;
  content: string;
  modelId?: string;
  memory?: ConversationMemoryRequestWire;
  // Issue #148 — client-extracted, byte-bounded text from attached documents. The server
  // re-validates the caps before any of this reaches a model prompt.
  documentContext?: readonly ConversationDocumentContextWire[];
}

// Issue #152 — accepts an optional AbortSignal so the Conversation Center can
// cancel an in-flight ungrounded send. RequestInit.signal is `AbortSignal |
// null` under exactOptionalPropertyTypes; convert at the boundary so callers
// pass `AbortSignal | undefined` like every other API helper here.
export async function sendDesktopChat(
  input: SendDesktopChatInput,
  signal?: AbortSignal,
): Promise<DesktopChatSendResponse> {
  return fetchJson("/api/desktop/chat", {
    method: "POST",
    body: JSON.stringify(input),
    signal: signal ?? null,
  });
}

// ---------------------------------------------------------------------------
// Desktop chat SSE streaming — Issue #152 Layer 3
// ---------------------------------------------------------------------------

// Thrown pre-stream when the BFF responds with a non-SSE content-type (e.g.
// STREAMING_UNSUPPORTED). The caller falls back to sendDesktopChat.
export class StreamingUnavailableError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StreamingUnavailableError";
  }
}

// Typed SSE event payloads — no `any`.
interface SseTokenPayload {
  readonly text: string;
}
interface SseDonePayload {
  readonly chat: import("./types").Chat;
  readonly messages: readonly import("./types").ChatMessage[];
  readonly usage?: import("@oscharko-dev/keiko-contracts/bff-wire").DesktopChatSendUsage;
  readonly memory?: import("./types").ConversationMemoryResultWire;
}
interface SseErrorPayload {
  readonly code: string;
  readonly message: string;
}

// Narrow an unknown SSE data value to a specific payload shape.
function asSseTokenPayload(value: unknown): SseTokenPayload | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof (value as Record<string, unknown>).text === "string"
  ) {
    return value as SseTokenPayload;
  }
  return undefined;
}

function asSseErrorPayload(value: unknown): SseErrorPayload | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  ) {
    return value as SseErrorPayload;
  }
  return undefined;
}

function asSseDonePayload(value: unknown): SseDonePayload | undefined {
  if (typeof value === "object" && value !== null && "chat" in value && "messages" in value) {
    return value as SseDonePayload;
  }
  return undefined;
}

export interface StreamHandlers {
  readonly onToken: (text: string) => void;
  readonly onDone: (payload: SseDonePayload) => void;
  readonly onError: (payload: SseErrorPayload) => void;
  readonly onCancelled: () => void;
}

// Re-export so callers (useChatSession.ts) can type the done payload without
// reaching into the private SSE types above.
export type { SseDonePayload };

// Dispatches a parsed SSE (event, data) pair to the appropriate handler.
function dispatchSseEvent(
  eventName: string | undefined,
  parsed: unknown,
  handlers: StreamHandlers,
): void {
  switch (eventName) {
    case "token": {
      const token = asSseTokenPayload(parsed);
      if (token !== undefined) handlers.onToken(token.text);
      break;
    }
    case "done": {
      const done = asSseDonePayload(parsed);
      if (done !== undefined) handlers.onDone(done);
      break;
    }
    case "error": {
      const err = asSseErrorPayload(parsed);
      if (err !== undefined) handlers.onError(err);
      break;
    }
    case "cancelled": {
      handlers.onCancelled();
      break;
    }
  }
}

// Processes one chunk of lines from the SSE stream. Returns the updated
// `pendingEvent` name (carries over across chunk boundaries).
function processSseLines(
  lines: readonly string[],
  pendingEvent: string | undefined,
  handlers: StreamHandlers,
): string | undefined {
  let current = pendingEvent;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      current = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      const dataText = line.slice("data:".length).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataText) as unknown;
      } catch {
        continue;
      }
      dispatchSseEvent(current, parsed, handlers);
      current = undefined;
    } else if (line === "") {
      current = undefined;
    }
  }
  return current;
}

// Reads `response.body` as a text/event-stream, buffering partial lines across
// reads. Dispatches typed events to `handlers`. Respects the passed `signal` —
// when aborted it stops reading without dispatching further events.
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let pendingEvent: string | undefined;
  let reachedEof = false;

  try {
    while (!signal.aborted) {
      const read = await reader.read();
      if (read.done) {
        reachedEof = true;
        break;
      }
      lineBuffer += decoder.decode(read.value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      pendingEvent = processSseLines(lines, pendingEvent, handlers);
    }
    // Flush any residual content left in lineBuffer when the stream ends
    // naturally (EOF). A proxy or buffer that drops the terminal \n\n would
    // otherwise silently lose the final SSE frame. Skipped on abort because
    // the contract is "stop reading without dispatching further events".
    if (reachedEof && lineBuffer !== "") {
      processSseLines([lineBuffer], pendingEvent, handlers);
    }
  } finally {
    reader.releaseLock();
  }
}

// Issue #152 Layer 3 — POST to /api/desktop/chat/stream with the same
// headers/body as sendDesktopChat. If the response is NOT text/event-stream
// (BFF returned a JSON pre-stream error), throws StreamingUnavailableError
// so the caller can fall back. Otherwise reads the stream and dispatches to
// handlers. Respects `signal` (abort stops reading immediately).
export async function sendDesktopChatStream(
  input: SendDesktopChatInput,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const res = await fetch("/api/desktop/chat/stream", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    },
    body: JSON.stringify(input),
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // Pre-stream error — parse the JSON envelope and throw typed.
    let code = "STREAMING_UNSUPPORTED";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as { error?: { code?: string; message?: string } };
      code = envelope.error?.code ?? code;
      message = envelope.error?.message ?? message;
    } catch {
      // parse failure — keep generic values, never log body
    }
    throw new StreamingUnavailableError(code, message);
  }

  if (res.body === null) {
    throw new StreamingUnavailableError("STREAMING_UNSUPPORTED", "Response body was null.");
  }

  await consumeSseStream(res.body, signal, handlers);
}

// ---------------------------------------------------------------------------
// Desktop terminal — ADR-0018 bounded permitted-command execution; client moved to
// ./terminal-api.ts. The PTY routes (/api/terminal/shells, /sessions, WS upgrade) are removed.

// ---------------------------------------------------------------------------
// Desktop files — selected-root browser, preview, and editor control plane
// ---------------------------------------------------------------------------

export async function fetchFilesDirectories(
  root: string,
  path?: string,
): Promise<FilesDirectoryListing> {
  const params = new URLSearchParams();
  params.set("root", root);
  if (path !== undefined && path.length > 0) params.set("path", path);
  return fetchJson(`/api/files/directories?${params.toString()}`);
}

export async function fetchFilesTree(root: string, path = ""): Promise<FilesTreeResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  if (path.length > 0) params.set("path", path);
  return fetchJson(`/api/files/tree?${params.toString()}`);
}

export async function fetchFilesSearch(
  root: string,
  query: string,
  limit?: number,
  init?: Pick<RequestInit, "signal">,
): Promise<FilesSearchResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("q", query);
  if (limit !== undefined) params.set("limit", String(limit));
  return fetchJson(`/api/files/search?${params.toString()}`, init);
}

export async function fetchFilesPreview(root: string, path: string): Promise<FilesPreviewResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("path", path);
  return fetchJson(`/api/files/preview?${params.toString()}`);
}

export async function fetchFilesContent(root: string, path: string): Promise<FilesContentResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("path", path);
  return fetchJson(`/api/files/content?${params.toString()}`);
}

export async function saveFilesContent(input: {
  readonly root: string;
  readonly path: string;
  readonly content: string;
  readonly expectedModifiedAt?: number | undefined;
  // Issue #1197: version-aware optimistic-concurrency token. Supersedes expectedModifiedAt.
  readonly baseVersion?: EditorDocumentVersion | undefined;
}): Promise<FilesContentResponse> {
  return fetchJson("/api/files/content", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// Issue #1199 — governed editor completion gateway. Posts the overlay buffer + cursor to the BFF,
// which runs deterministic language-service completion and (when a governed model is configured)
// gated model-assisted completion. The browser never reaches a model directly. `signal` lets the
// editor cancel a superseded request.
export interface EditorCompletionRequestInput {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
  readonly position: { readonly line: number; readonly character: number };
  readonly triggerKind: EditorCompletionWireTriggerKind;
  readonly triggerCharacter?: string | undefined;
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors | undefined;
  readonly maxCostClass?: CostClass | undefined;
}

export async function requestEditorCompletion(
  input: EditorCompletionRequestInput,
  signal?: AbortSignal,
): Promise<EditorCompletionWireResponse> {
  const requestBody: EditorCompletionWireRequest = {
    schemaVersion: EDITOR_COMPLETION_SCHEMA_VERSION,
    root: input.root,
    document: { path: input.path, languageId: input.languageId, text: input.text },
    position: input.position,
    triggerKind: input.triggerKind,
    ...(input.triggerCharacter === undefined ? {} : { triggerCharacter: input.triggerCharacter }),
    contextBudgetBytes: input.contextBudgetBytes,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.maxCostClass === undefined ? {} : { maxCostClass: input.maxCostClass }),
  };
  return fetchJson("/api/editor/completion", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1200 — governed editor inline completion (ghost text). Posts the overlay buffer + cursor to
// the BFF, which runs a gated aligned suffix-aware (FIM) model over coding context and returns a
// single ghost-text continuation (or zero items when degraded/disabled/rate-limited). The browser
// never reaches a model directly. `signal` lets the editor cancel a superseded request.
export interface EditorInlineCompletionRequestInput {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
  readonly position: { readonly line: number; readonly character: number };
  readonly triggerKind: EditorInlineCompletionWireTriggerKind;
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors | undefined;
  readonly maxCostClass?: CostClass | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export async function requestEditorInlineCompletion(
  input: EditorInlineCompletionRequestInput,
  signal?: AbortSignal,
): Promise<EditorInlineCompletionWireResponse> {
  const requestBody: EditorInlineCompletionWireRequest = {
    schemaVersion: EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
    root: input.root,
    document: { path: input.path, languageId: input.languageId, text: input.text },
    position: input.position,
    triggerKind: input.triggerKind,
    contextBudgetBytes: input.contextBudgetBytes,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.maxCostClass === undefined ? {} : { maxCostClass: input.maxCostClass }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
  };
  return fetchJson("/api/editor/inline-completion", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1200 — content-free inline-completion acceptance/rejection telemetry. Best-effort, fire and
// forget: the editor reports cumulative counts (no code content) which the BFF records as evidence.
export interface EditorInlineCompletionTelemetryInput {
  readonly root: string;
  readonly offered: number;
  readonly shown: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly ignored: number;
  readonly partiallyAccepted: number;
  readonly requestCount: number;
  readonly requestLatencyMsP50: number;
  readonly requestLatencyMsP95: number;
}

export async function reportEditorInlineCompletionTelemetry(
  input: EditorInlineCompletionTelemetryInput,
): Promise<void> {
  const report: EditorInlineCompletionTelemetryReport = {
    schemaVersion: EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
    root: input.root,
    offered: input.offered,
    shown: input.shown,
    accepted: input.accepted,
    rejected: input.rejected,
    ignored: input.ignored,
    partiallyAccepted: input.partiallyAccepted,
    requestCount: input.requestCount,
    requestLatencyMsP50: input.requestLatencyMsP50,
    requestLatencyMsP95: input.requestLatencyMsP95,
  };
  await fetchJson("/api/editor/inline-completion/telemetry", {
    method: "POST",
    body: JSON.stringify(report),
  });
}

// Issue #1202 — governed editor-driven test generation (ADR-0042 D7). Posts the editor target (the
// overlay buffer + scope coordinates) to the wave-2 BFF, which returns a `disabled`/`deferred` outcome
// in v1 (no candidate; the feature ships switched off) or, once an enforced egress boundary unlocks it,
// a reviewable candidate patch. The browser never reaches a model directly. `signal` cancels a run.
export interface EditorTestGenerationRequestInput {
  readonly root: string;
  readonly target: EditorTestGenerationWireTarget;
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors | undefined;
}

export async function requestEditorTestGeneration(
  input: EditorTestGenerationRequestInput,
  signal?: AbortSignal,
): Promise<EditorTestGenerationWireResponse> {
  const requestBody: EditorTestGenerationWireRequest = {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    root: input.root,
    target: input.target,
    contextBudgetBytes: input.contextBudgetBytes,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
  return fetchJson("/api/editor/test-generation", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1204 — governed editor-driven patch apply + post-apply verification. Applies (or rejects) a
// reviewed candidate patch only on an explicit user decision; the BFF validates scope/conflict/overwrite,
// applies atomically, then re-confirms the applied test under an enforced egress boundary. The browser
// never writes files or runs tests directly; the response is content-free apart from a guarded revert
// diff. `signal` lets the editor cancel a superseded request.
export interface EditorPatchApplyRequestInput {
  readonly root: string;
  readonly patchId: string;
  readonly decision: EditorPatchApplyDecision;
  readonly diff: string;
  readonly allowOverwrite?: boolean | undefined;
}

export async function requestEditorPatchApply(
  input: EditorPatchApplyRequestInput,
  signal?: AbortSignal,
): Promise<EditorPatchApplyWireResponse> {
  const requestBody: EditorPatchApplyWireRequest = {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    root: input.root,
    patchId: input.patchId,
    decision: input.decision,
    diff: input.diff,
    ...(input.allowOverwrite === undefined ? {} : { allowOverwrite: input.allowOverwrite }),
  };
  return fetchJson("/api/editor/patch-apply", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1201 — deterministic language intelligence (diagnostics, hover, document symbols,
// formatting). All four reuse the governed `POST /api/editor/language` route (#1198): a single
// model-free, workspace-contained, bounded analysis over the in-editor overlay. The browser never
// reaches a model. `signal` lets the editor cancel a superseded or in-flight request.
export interface EditorLanguageRequestInput {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
}

interface LanguageOperationEnvelope<TResult> {
  readonly operation: string;
  readonly result: TResult;
}

function languageDocument(input: EditorLanguageRequestInput): {
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
} {
  return { path: input.path, languageId: input.languageId, text: input.text };
}

export async function fetchEditorLanguageCapabilities(): Promise<LanguageServiceCapabilities> {
  return fetchJson("/api/editor/language/capabilities");
}

export async function requestEditorDiagnostics(
  input: EditorLanguageRequestInput,
  signal?: AbortSignal,
): Promise<LanguageDiagnosticsResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageDiagnosticsResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "diagnostics",
        root: input.root,
        document: languageDocument(input),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function requestEditorHover(
  input: EditorLanguageRequestInput & {
    readonly position: { readonly line: number; readonly character: number };
  },
  signal?: AbortSignal,
): Promise<LanguageHoverResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageHoverResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "hover",
        root: input.root,
        document: languageDocument(input),
        position: input.position,
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function requestEditorSymbols(
  input: EditorLanguageRequestInput,
  signal?: AbortSignal,
): Promise<LanguageSymbolResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageSymbolResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "symbols",
        root: input.root,
        document: languageDocument(input),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function requestEditorFormatting(
  input: EditorLanguageRequestInput & { readonly options?: LanguageFormattingOptions | undefined },
  signal?: AbortSignal,
): Promise<LanguageFormattingResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageFormattingResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "formatting",
        root: input.root,
        document: languageDocument(input),
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function fetchEditorAgentSessions(): Promise<EditorAgentSessionsResponse> {
  return fetchJson("/api/editor/agent/sessions");
}

export async function requestEditorAgentSnapshot(
  input: EditorAgentSnapshotRequest,
): Promise<EditorAgentSnapshotResponse> {
  return fetchJson("/api/editor/agent/snapshot", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function postEditorAgentSessionSnapshot(
  snapshot: EditorAgentSessionSnapshot,
): Promise<EditorAgentSnapshotResponse> {
  return fetchJson("/api/editor/agent/snapshot", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: snapshot.schemaVersion,
      kind: "snapshot",
      snapshot,
    }),
  });
}

export async function queueEditorAgentAction(
  action: EditorAgentAction,
): Promise<EditorAgentActionQueuedResponse> {
  return fetchJson("/api/editor/agent/actions", {
    method: "POST",
    body: JSON.stringify(action),
  });
}

export async function postEditorAgentActionResult(
  result: EditorAgentActionResultRequest,
): Promise<EditorAgentActionQueuedResponse> {
  return fetchJson("/api/editor/agent/actions", {
    method: "POST",
    body: JSON.stringify(result),
  });
}

// ---------------------------------------------------------------------------
// Issue #185 — Grounded repository Q&A
// ---------------------------------------------------------------------------
// POSTs to the BFF orchestrator which composes the #179-#183 connected-context layers,
// persists the chat round-trip as a normal user/assistant message pair, and returns the
// redacted citation projection. The CSRF header is supplied by `fetchJson` for all non-GET
// methods; the caller never sets it directly.

export async function askGrounded(
  req: GroundedAskRequest,
  signal?: AbortSignal,
): Promise<GroundedAnswer> {
  // RequestInit.signal is `AbortSignal | null`. Under exactOptionalPropertyTypes we cannot
  // pass `undefined`, so convert here.
  return fetchJson("/api/chats/messages/grounded", {
    method: "POST",
    body: JSON.stringify(req),
    signal: signal ?? null,
  });
}
