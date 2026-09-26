// Co-located tests: `workspace-trust-api.test.ts` in this directory covers `fetchWorkspaceTrustStatus`,
// `mutateWorkspaceTrust`, the `WORKSPACE_TRUST_CHANGED_EVENT` broadcast contract, and the event-shape
// guard `workspaceTrustEventProjectId`.
import type {
  EditorVerificationCatalog,
  WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import { isEditorVerificationCatalog } from "@oscharko-dev/keiko-contracts/runtime/editor-verification";
import { isWorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";

const TRUST_URL = "/api/editor/verification/trust";
const CATALOG_URL = "/api/editor/verification/catalog";
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

// Issue #2768 / #2625 AC1 — a bare Error carries no `code`, so `workspaceTrustFailure` rejected it
// and the trust surface showed a failure with no code and no correlation id: the one case where the
// server answered 200 was also the only one the user could not report. A coded ApiError puts a
// validation failure on the same footing as every non-2xx trust failure (bffFetchJson attaches the
// correlation id to it).
function assertStatus(path: string, value: unknown, projectId: string): WorkspaceTrustStatus {
  if (!isWorkspaceTrustStatus(value) || value.projectId !== projectId) {
    throw new ApiError(
      "CONTRACT_VALIDATION_FAILED",
      `BFF response for ${path} failed contract validation: workspace trust status invalid.`,
      502,
    );
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

// The server-owned verification catalog for one root: the detected kinds and, per kind, the
// package-script trust decision the verification runner itself would make right now (ADR-0147 D3).
// Re-detected on every call; a client never trusts a cached catalog. Shared by the Editor's
// verification card and the Coding Workbench's trust affordance so both read the runner's decision
// through one path (AGENTS.md §5).
export async function fetchVerificationCatalog(
  root: string,
  signal?: AbortSignal,
): Promise<EditorVerificationCatalog> {
  const url = `${CATALOG_URL}?projectId=${encodeURIComponent(root)}`;
  const response = await fetch(url, signal === undefined ? undefined : { signal });
  if (!response.ok) throw new Error("verification catalog rejected");
  const payload: unknown = await response.json();
  if (!isEditorVerificationCatalog(payload) || payload.projectId !== root) {
    throw new Error("malformed verification catalog");
  }
  return payload;
}

export function workspaceTrustEventProjectId(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const projectId = (detail as Record<string, unknown>).projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
}
