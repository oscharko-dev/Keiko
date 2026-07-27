// Co-located tests: `workspace-trust-api.test.ts` in this directory covers `fetchWorkspaceTrustStatus`,
// `mutateWorkspaceTrust`, the `WORKSPACE_TRUST_CHANGED_EVENT` broadcast contract, and the event-shape
// guard `workspaceTrustEventProjectId`.
import { isWorkspaceTrustStatus, type WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import { bffFetchJson } from "./http";

const TRUST_URL = "/api/editor/verification/trust";
export const WORKSPACE_TRUST_CHANGED_EVENT = "keiko:workspace-trust-changed";

export type WorkspaceTrustMutation = "grant" | "revoke";

export interface WorkspaceTrustFailure {
  readonly code: string;
  readonly correlationId?: string;
}

function isApiErrorLike(
  error: unknown,
): error is Error & { readonly code: string; readonly correlationId?: string | undefined } {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return false;
  }
  if (!("correlationId" in error) || error.correlationId === undefined) return true;
  return typeof error.correlationId === "string";
}

export function workspaceTrustFailure(error: unknown): WorkspaceTrustFailure | undefined {
  if (!isApiErrorLike(error)) return undefined;
  return error.correlationId === undefined
    ? { code: error.code }
    : { code: error.code, correlationId: error.correlationId };
}

function assertStatus(path: string, value: unknown, projectId: string): WorkspaceTrustStatus {
  if (!isWorkspaceTrustStatus(value) || value.projectId !== projectId) {
    throw new Error(`Workspace trust response invalid for ${path}.`);
  }
  return value;
}

function statusValidator(
  projectId: string,
): (path: string, value: unknown) => WorkspaceTrustStatus {
  return (path, value) => assertStatus(path, value, projectId);
}

export async function fetchWorkspaceTrustStatus(projectId: string): Promise<WorkspaceTrustStatus> {
  const params = new URLSearchParams({ projectId });
  return bffFetchJson(`${TRUST_URL}?${params.toString()}`, undefined, {
    validator: statusValidator(projectId),
    parseFailureMessage: () => "workspace trust request rejected",
  });
}

export async function mutateWorkspaceTrust(
  projectId: string,
  mutation: WorkspaceTrustMutation,
): Promise<WorkspaceTrustStatus> {
  const status = await bffFetchJson(
    TRUST_URL,
    {
      method: mutation === "grant" ? "POST" : "DELETE",
      body: JSON.stringify({ projectId }),
    },
    {
      validator: statusValidator(projectId),
      parseFailureMessage: () => "workspace trust request rejected",
    },
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId } }));
  }
  return status;
}

export function workspaceTrustEventProjectId(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const projectId = (detail as Record<string, unknown>).projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
}
