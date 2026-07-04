/**
 * Typed fetch wrapper for the #446 active task-workspace binding BFF routes (Epic #443, ADR-0090).
 * Mirrors lib/commands-api.ts: same-origin relative paths, CSRF header on state-changing methods, no
 * response-body logging. This module is the SINGLE network boundary between the browser and the
 * server-side active-binding authority — the UI never value-imports keiko-server (ADR-0019 rule 8);
 * it consumes only the #444 contract TYPES and reaches the BFF over fetch.
 */

import { ApiError } from "./api";
import { bffFetchJson } from "./http";
import {
  isWorkspaceFailureClass,
  type WorkspaceBinding,
  type WorkspaceFailureClass,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";

// A task-workspace BFF error that also carries the caller-facing failure class (#449, ADR-0093 D3) when
// the server surfaced one. Modelled as a TYPE on the existing `ApiError` (not a subclass) so this module
// has no load-time dependency on the `ApiError` binding — partial mocks of `@/lib/api` in unrelated UI
// tests must not break at import. Callers narrow on `.failureClass` (retryable / repairable / blocked /
// policy-denied / terminal) instead of matching raw codes; it is `undefined` when the error did not
// originate from the structured task-workspace taxonomy.
export type TaskWorkspaceApiError = ApiError & {
  readonly failureClass?: WorkspaceFailureClass | undefined;
};

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

// Thin wrapper over the shared BFF scaffold (GEN-DUP-NEAR-004). Beyond the standard CSRF/JSON headers,
// error-envelope parse, and 204 short-circuit, this route copies the caller-facing failure class off
// the parsed envelope onto the thrown `ApiError` (#449, ADR-0093 D3) via the `enrichError` hook.
// `ApiError` is referenced only in that hook (runtime throw path), never at module load, so a partial
// `@/lib/api` mock in unrelated UI tests is unaffected.
async function taskWorkspaceFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init, {
    enrichError: (error, envelope) => {
      const raw = envelope?.error["failureClass"];
      const failureClass: WorkspaceFailureClass | undefined = isWorkspaceFailureClass(raw)
        ? raw
        : undefined;
      Object.assign(error, { failureClass });
    },
  });
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
