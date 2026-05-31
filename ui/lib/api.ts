/**
 * Typed fetch wrapper for the 12 BFF routes (ADR-0011 D5).
 * Same-origin relative paths (/api/...). Parses the {error:{code,message}} envelope.
 * Never logs response bodies.
 */

import type {
  BffError,
  ChatResponse,
  ChatsResponse,
  ChatStatus,
  ChatMessageRole,
  ChatWorkflowStatus,
  EvidenceListEntry,
  EvidenceManifest,
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

export async function fetchModels(): Promise<{ models: ModelCapability[] }> {
  return fetchJson("/api/models");
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

export async function fetchProjects(): Promise<ProjectsResponse> {
  return fetchJson("/api/projects");
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
}

export async function updateChat(id: string, patch: UpdateChatInput): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
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
