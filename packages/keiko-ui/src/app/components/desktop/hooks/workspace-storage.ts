import { createContext } from "react";

// The desktop boot boundary resolves this from the server before mounting any persisted windows.
// Standalone workspace consumers may supply the scope explicitly through useWorkspace options.
export const WorkspaceStorageScopeContext = createContext<string | undefined>(undefined);

export function workspaceStorageKey(key: string, scope: string | undefined): string {
  return scope === undefined ? key : `${key}:${scope}`;
}

// The server answers 409 WORKSPACE_STORAGE_CHANGED on the workspace state route when the request
// names another data store than the one it serves: the Keiko behind this page was started again
// with different state while the page stayed open. The page's windows belong to the old store, so
// polling on would only be refused again; the persistence boundary re-reads the ownership and mounts
// the workspace afresh for the store that now answers (ADR-0027).
const WORKSPACE_STORAGE_CHANGED_STATUS = 409;
const WORKSPACE_STORAGE_CHANGED_CODE = "WORKSPACE_STORAGE_CHANGED";
export const WORKSPACE_STORAGE_CHANGED_EVENT = "keiko:workspace-storage-changed";

/**
 * Whether a refused workspace response is the server's store-change answer, nothing else. A 409
 * without the server's JSON body (a proxy, a cut response) is no store change: the caller then
 * reports it as an ordinary sync failure with its status, so nothing is lost here.
 */
export async function isWorkspaceStorageChanged(response: Response): Promise<boolean> {
  if (response.status !== WORKSPACE_STORAGE_CHANGED_STATUS) return false;
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const error = body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === WORKSPACE_STORAGE_CHANGED_CODE
  );
}

// The event names the store the refused request belonged to, so a late refusal of a request the
// old workspace sent (its unmount flush) cannot remount the workspace of the new store.
export function announceWorkspaceStorageChanged(refusedScope: string | undefined): void {
  if (typeof window === "undefined" || refusedScope === undefined) return;
  window.dispatchEvent(
    new CustomEvent<string>(WORKSPACE_STORAGE_CHANGED_EVENT, { detail: refusedScope }),
  );
}
