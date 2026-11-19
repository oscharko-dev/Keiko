import { createContext } from "react";

// The desktop boot boundary resolves this from the server before mounting any persisted windows.
// Standalone workspace consumers may supply the scope explicitly through useWorkspace options.
export const WorkspaceStorageScopeContext = createContext<string | undefined>(undefined);

export function workspaceStorageKey(key: string, scope: string | undefined): string {
  return scope === undefined ? key : `${key}:${scope}`;
}

// The server answers 409 on the workspace state route only when the request names another data
// store than the one it serves (WORKSPACE_STORAGE_CHANGED): the Keiko behind this page was started
// again with different state while the page stayed open. The page's windows belong to the old
// store, so polling on would only be refused again; the persistence boundary re-reads the ownership
// and mounts the workspace afresh for the store that now answers (ADR-0027).
export const WORKSPACE_STORAGE_CHANGED_STATUS = 409;
export const WORKSPACE_STORAGE_CHANGED_EVENT = "keiko:workspace-storage-changed";

export function announceWorkspaceStorageChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WORKSPACE_STORAGE_CHANGED_EVENT));
}
