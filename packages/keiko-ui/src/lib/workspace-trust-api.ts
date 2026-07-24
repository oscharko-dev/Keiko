// Co-located tests: `workspace-trust-api.test.ts` in this directory covers `fetchWorkspaceTrustStatus`,
// `mutateWorkspaceTrust`, the `WORKSPACE_TRUST_CHANGED_EVENT` broadcast contract, and the event-shape
// guard `workspaceTrustEventProjectId`.
import { isWorkspaceTrustStatus, type WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";

const TRUST_URL = "/api/editor/verification/trust";
export const WORKSPACE_TRUST_CHANGED_EVENT = "keiko:workspace-trust-changed";

export type WorkspaceTrustMutation = "grant" | "revoke";

function assertStatus(value: unknown, projectId: string): WorkspaceTrustStatus {
  if (!isWorkspaceTrustStatus(value) || value.projectId !== projectId) {
    throw new Error("workspace trust response invalid");
  }
  return value;
}

async function responseStatus(
  response: Response,
  projectId: string,
): Promise<WorkspaceTrustStatus> {
  if (!response.ok) throw new Error("workspace trust request rejected");
  return assertStatus(await response.json(), projectId);
}

export async function fetchWorkspaceTrustStatus(projectId: string): Promise<WorkspaceTrustStatus> {
  const params = new URLSearchParams({ projectId });
  return responseStatus(await fetch(`${TRUST_URL}?${params.toString()}`), projectId);
}

export async function mutateWorkspaceTrust(
  projectId: string,
  mutation: WorkspaceTrustMutation,
): Promise<WorkspaceTrustStatus> {
  const response = await fetch(TRUST_URL, {
    method: mutation === "grant" ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify({ projectId }),
  });
  const status = await responseStatus(response, projectId);
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
