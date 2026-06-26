/**
 * Typed fetch wrapper for the #446 active task-workspace binding BFF routes (Epic #443, ADR-0090).
 * Mirrors lib/commands-api.ts: same-origin relative paths, CSRF header on state-changing methods, no
 * response-body logging. This module is the SINGLE network boundary between the browser and the
 * server-side active-binding authority — the UI never value-imports keiko-server (ADR-0019 rule 8);
 * it consumes only the #444 contract TYPES and reaches the BFF over fetch.
 */

import { ApiError } from "./api";
import {
  isWorkspaceFailureClass,
  type WorkspaceBinding,
  type WorkspaceFailureClass,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";

// A task-workspace BFF error that also carries the caller-facing failure class (#449, ADR-0093 D3) when
// the server surfaced one. Callers can `instanceof TaskWorkspaceApiError` and branch on `.failureClass`
// (retryable / repairable / blocked / policy-denied / terminal) instead of matching raw codes; it is
// `undefined` only when the error did not originate from the structured task-workspace taxonomy.
export class TaskWorkspaceApiError extends ApiError {
  public readonly failureClass: WorkspaceFailureClass | undefined;
  public constructor(
    code: string,
    message: string,
    status: number,
    failureClass: WorkspaceFailureClass | undefined,
  ) {
    super(code, message, status);
    this.name = "TaskWorkspaceApiError";
    this.failureClass = failureClass;
  }
}

// The active view the BFF returns: the durable instance, the DERIVED binding, and the pointer
// metadata (who set it / when) the switcher renders. Mirrors the server ActiveWorkspaceView shape.
export interface ActiveWorkspaceView {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
  readonly pointer: {
    readonly workspaceId: string;
    readonly setBy: string;
    readonly setAt: string;
    readonly updatedAt: string;
  };
}

export interface WorkspaceMutationResult {
  readonly instance: WorkspaceInstance;
  readonly binding: WorkspaceBinding;
}

interface BffError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly failureClass?: string;
  };
}

async function taskWorkspaceFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
    let failureClass: WorkspaceFailureClass | undefined;
    try {
      const envelope = (await res.json()) as BffError;
      code = envelope.error.code;
      message = envelope.error.message;
      failureClass = isWorkspaceFailureClass(envelope.error.failureClass)
        ? envelope.error.failureClass
        : undefined;
    } catch {
      // parse failure — keep generic, never log
    }
    throw new TaskWorkspaceApiError(code, message, res.status, failureClass);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Provision (create or idempotently resume) a managed task workspace from a repository root via the
// #445 route. #446 exposes it so the switcher can create the workspaces it then binds; the governed
// worktree/branch creation and all policy stay owned by #445 — this is only the wire call.
export async function provisionTaskWorkspace(input: {
  readonly root: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly requestedBy: string;
}): Promise<WorkspaceMutationResult & { readonly created: boolean }> {
  return taskWorkspaceFetch("/api/task-workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listTaskWorkspaces(root: string): Promise<readonly WorkspaceInstance[]> {
  const params = new URLSearchParams();
  params.set("root", root);
  const body = await taskWorkspaceFetch<{ instances: readonly WorkspaceInstance[] }>(
    `/api/task-workspaces?${params.toString()}`,
  );
  return body.instances;
}

export async function getActiveTaskWorkspace(): Promise<ActiveWorkspaceView | null> {
  const body = await taskWorkspaceFetch<{ active: ActiveWorkspaceView | null }>(
    "/api/task-workspaces/active",
  );
  return body.active;
}

export async function setActiveTaskWorkspace(input: {
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly acquireLock?: boolean;
}): Promise<WorkspaceMutationResult> {
  return taskWorkspaceFetch("/api/task-workspaces/active", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function clearActiveTaskWorkspace(): Promise<void> {
  await taskWorkspaceFetch<{ active: null }>("/api/task-workspaces/active", { method: "DELETE" });
}

export async function pauseTaskWorkspace(input: {
  readonly workspaceId: string;
  readonly requestedBy: string;
}): Promise<WorkspaceMutationResult> {
  return taskWorkspaceFetch(`/api/task-workspaces/${encodeURIComponent(input.workspaceId)}/pause`, {
    method: "POST",
    body: JSON.stringify({ requestedBy: input.requestedBy }),
  });
}

export async function resumeTaskWorkspace(input: {
  readonly workspaceId: string;
  readonly requestedBy: string;
}): Promise<WorkspaceMutationResult> {
  return taskWorkspaceFetch(
    `/api/task-workspaces/${encodeURIComponent(input.workspaceId)}/resume`,
    { method: "POST", body: JSON.stringify({ requestedBy: input.requestedBy }) },
  );
}

export async function prepareHandoffTaskWorkspace(input: {
  readonly workspaceId: string;
  readonly requestedBy: string;
}): Promise<WorkspaceMutationResult> {
  return taskWorkspaceFetch(
    `/api/task-workspaces/${encodeURIComponent(input.workspaceId)}/handoff`,
    { method: "POST", body: JSON.stringify({ requestedBy: input.requestedBy }) },
  );
}
