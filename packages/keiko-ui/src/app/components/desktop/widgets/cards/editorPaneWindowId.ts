/** Canonical runtime identity shared by an editor pane and its hot-exit snapshots. */
export function editorPaneWindowId(windowId: string | undefined, paneId: string): string {
  return `${windowId ?? "editor"}-${paneId}`;
}
