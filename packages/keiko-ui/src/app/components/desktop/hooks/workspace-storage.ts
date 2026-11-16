import { createContext } from "react";

// The desktop boot boundary resolves this from the server before mounting any persisted windows.
// Standalone workspace consumers may supply the scope explicitly through useWorkspace options.
export const WorkspaceStorageScopeContext = createContext<string | undefined>(undefined);

export function workspaceStorageKey(key: string, scope: string | undefined): string {
  return scope === undefined ? key : `${key}:${scope}`;
}
