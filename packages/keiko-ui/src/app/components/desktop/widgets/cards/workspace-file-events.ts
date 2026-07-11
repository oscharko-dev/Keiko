export const WORKSPACE_FILE_MUTATED_EVENT = "keiko:workspace-file-mutated";

export function notifyWorkspaceFileMutated(root: string): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_FILE_MUTATED_EVENT, { detail: { root } }));
}

export function workspaceFileMutationRoot(event: Event): string | null {
  if (
    !(event instanceof CustomEvent) ||
    typeof event.detail !== "object" ||
    event.detail === null
  ) {
    return null;
  }
  const root = (event.detail as { readonly root?: unknown }).root;
  return typeof root === "string" && root.length > 0 ? root : null;
}
