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
  FilesPreviewResponse,
  FilesTreeResponse,
  MessageResponse,
  MessagesResponse,
  ModelCapability,
  PatchChatMessageBody,
  PatchMessageResponse,
  ProjectResponse,
  ProjectsResponse,
  RunReport,
  SafeGatewayConfig,
  WorkspaceSummary,
  WorkflowsResponse,
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
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method === "GET" || method === "HEAD" ? {} : { "X-Keiko-CSRF": "1" }),
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
}> {
  return fetchJson("/api/config");
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
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string | undefined;
  readonly deploymentNames?: readonly string[] | undefined;
}

export interface GatewaySetupResponse {
  readonly ok: true;
  readonly testedModelId: string;
  readonly testedModelIds: readonly string[];
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

export interface StartChatRunInput {
  chatId: string;
  projectPath: string;
  run: StartRunInput;
  user: {
    content: string;
    timestamp: number;
  };
  summary: {
    content: string;
    timestamp: number;
  };
}

export async function startChatRun(body: StartChatRunInput): Promise<{
  run: { runId: string; fingerprint: string };
  messages: MessagesResponse["messages"];
}> {
  return fetchJson("/api/chats/runs", {
    method: "POST",
    body: JSON.stringify(body),
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
  localKnowledgeScope?: ChatLocalKnowledgeScope | null;
}

export async function updateChat(id: string, patch: UpdateChatInput): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// Issue #184 — binds a Files-window scope to a chat. `null` clears the binding; a
// ChatConnectedScope object sets/replaces it. All path validation runs at the BFF boundary;
// invalid input surfaces as ApiError with HTTP 400 invalid_request.
export async function updateChatConnectedScope(
  chatId: string,
  scope: ChatConnectedScope | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      connectedScope: scope,
      ...(scope !== null ? { localKnowledgeScope: null } : {}),
    }),
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
// Desktop terminal — ADR-0018 bounded permitted-command execution; client moved to
// ./terminal-api.ts. The PTY routes (/api/terminal/shells, /sessions, WS upgrade) are removed.

// ---------------------------------------------------------------------------
// Desktop files — read-only selected-root browser and preview control plane
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

export async function fetchFilesPreview(root: string, path: string): Promise<FilesPreviewResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("path", path);
  return fetchJson(`/api/files/preview?${params.toString()}`);
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
