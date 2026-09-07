/**
 * Typed fetch wrapper for the #446 active task-workspace binding BFF routes (Epic #443, ADR-0090).
 * Mirrors lib/commands-api.ts: same-origin relative paths, CSRF header on state-changing methods, no
 * response-body logging. This module is the SINGLE network boundary between the browser and the
 * server-side active-binding authority — the UI never value-imports keiko-server (ADR-0019 rule 8);
 * it consumes only the #444 contract TYPES and reaches the BFF over fetch.
 */

import { ApiError, fetchGitStatus } from "./api";
import { runtimeIssueFailure } from "./coding-workbench-issue-errors";
import { bffFetchJson } from "./http";
import type {
  TaskWorkspaceDriftMarker,
  CodingWorkbenchIssueBindingFailure,
  WorkspaceBinding,
  WorkspaceFailureClass,
  WorkspaceInstance,
  WorkspaceReconciliationReport,
  WorkspaceReconciliationStatus,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { isWorkspaceFailureClass } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

// A task-workspace BFF error that also carries the caller-facing failure class (#449, ADR-0093 D3) when
// the server surfaced one. Modelled as a TYPE on the existing `ApiError` (not a subclass) so this module
// has no load-time dependency on the `ApiError` binding — partial mocks of `@/lib/api` in unrelated UI
// tests must not break at import. Callers narrow on `.failureClass` (retryable / repairable / blocked /
// policy-denied / terminal) instead of matching raw codes; it is `undefined` when the error did not
// originate from the structured task-workspace taxonomy.
export type TaskWorkspaceApiError = ApiError & {
  readonly failureClass?: WorkspaceFailureClass;
  readonly issueBindingFailure?: CodingWorkbenchIssueBindingFailure;
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
      // A non-2xx body that parsed but is not the `{ error: { … } }` envelope (a proxy answering
      // with `{}`) must still yield the redacted ApiError, never a TypeError from this hook.
      const raw = envelope?.error?.["failureClass"];
      const failureClass: WorkspaceFailureClass | undefined = isWorkspaceFailureClass(raw)
        ? raw
        : undefined;
      Object.assign(error, { failureClass, issueBindingFailure: runtimeIssueFailure(envelope) });
    },
  });
}

// Provision (create or idempotently resume) a managed task workspace from a repository root via the
// #445 route. #446 exposes it so the switcher can create the workspaces it then binds; the governed
// worktree/branch creation and all policy stay owned by #445 — this is only the wire call.
export type TaskWorkspaceProvisionSource =
  | { readonly baseBranch: string; readonly source?: never }
  | {
      readonly baseBranch?: never;
      readonly source: {
        readonly kind: "github-issue";
        readonly issueRef: string;
        readonly expectedBindingDigest: string;
      };
    };

export type TaskWorkspaceProvisionInput = TaskWorkspaceProvisionSource & {
  readonly root: string;
  readonly taskId: string;
  readonly requestedBy: string;
};

export async function provisionTaskWorkspace(
  input: TaskWorkspaceProvisionInput,
): Promise<WorkspaceMutationResult & { readonly created: boolean }> {
  return taskWorkspaceFetch("/api/task-workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Run a live #447 reconciliation pass (verifies disk + git and stamps the verified head the runtime
// launch authority requires) scoped to a repository root, then return the fresh content-free report.
// #446 exposes it so the workbench bootstrap can make a freshly hand-bound workspace startable without
// an out-of-band API call: provisioning leaves `lastVerifiedHead` unstamped, and only this pass stamps
// it. The report is inspected by the caller to gate activation on a verified, healthy workspace.
export async function reconcileTaskWorkspaces(input: {
  readonly root: string;
}): Promise<WorkspaceReconciliationReport> {
  const body = await taskWorkspaceFetch<{ report: WorkspaceReconciliationReport }>(
    "/api/task-workspaces/reconciliation",
    { method: "POST", body: JSON.stringify({ root: input.root }) },
  );
  return body.report;
}

// Every managed workspace across repositories when no root is given — the switcher's inventory,
// because the active pointer is global and a switch may target any repository — or one
// repository's when a root is.
export async function listTaskWorkspaces(root?: string): Promise<readonly WorkspaceInstance[]> {
  const path =
    root === undefined
      ? "/api/task-workspaces"
      : `/api/task-workspaces?${new URLSearchParams({ root }).toString()}`;
  const body = await taskWorkspaceFetch<{ instances: readonly WorkspaceInstance[] }>(path);
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

// The #447 repair route's answer: `applied` is true when the controlled mutation completed, false
// when the recovery still needs a human (then `driftMarkers` says what). Mirrors the server
// WorkspaceRepairResult minus nothing the browser is allowed to see.
export interface WorkspaceRepairResult extends WorkspaceMutationResult {
  readonly strategy: WorkspaceRecoveryStrategy;
  readonly applied: boolean;
  readonly outcome: "repaired" | "operator-required";
  readonly status: WorkspaceReconciliationStatus;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly operatorActionRequired: boolean;
}

// Controlled, operator-approval-gated repair (#447). `operatorApproved` is the operator's explicit
// consent — a click on a control that names the repair — and travels on the wire as such: the
// server refuses every automatic strategy without it, and the browser never sets it on its own.
export async function repairTaskWorkspace(input: {
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly strategy: WorkspaceRecoveryStrategy;
  readonly operatorApproved: boolean;
}): Promise<WorkspaceRepairResult> {
  return taskWorkspaceFetch(
    `/api/task-workspaces/${encodeURIComponent(input.workspaceId)}/repair`,
    {
      method: "POST",
      body: JSON.stringify({
        requestedBy: input.requestedBy,
        strategy: input.strategy,
        operatorApproved: input.operatorApproved,
      }),
    },
  );
}

// The checked-out branch of a local repository, as the sensible default base branch for a
// workbench-initiated binding: a repository whose integration branch is `dev` must not be offered
// `main`, which does not resolve there and refuses the bind with INVALID_BASE_BRANCH. Resolves to
// null (never throws) when the path is not an available repository or its HEAD is detached — the
// caller keeps its previous default; a transport failure is the caller's to report.
export async function fetchRepositoryBaseBranch(root: string): Promise<string | null> {
  const status = await fetchGitStatus(root);
  if (!status.available || status.detached) return null;
  const branch = status.branch?.trim() ?? "";
  return branch.length === 0 ? null : branch;
}
