import { editorLayoutPanes, type EditorLayoutStateV2 } from "@oscharko-dev/keiko-contracts";

/**
 * The editor's per-pane index of files with unsaved buffer changes.
 *
 * The authoritative dirty state lives in the shared Monaco model, which is keyed
 * by `(root, file)` and therefore survives a tab moving between panes. This index
 * is the UI-side projection used to scope the unsaved-changes prompt to the pane
 * that owns a tab. Because it is keyed by pane id, it must be re-homed onto the
 * layout whenever a layout operation moves a file between panes or collapses a
 * pane; otherwise a dirty flag is orphaned on a pane that no longer holds the
 * file (Issue #1375 AC3, ADR-0064).
 */
export type EditorDirtyByPane = Readonly<Record<string, Readonly<Record<string, true>>>>;

function dirtyFileSet(dirtyByPane: EditorDirtyByPane): ReadonlySet<string> {
  const files = new Set<string>();
  for (const paneDirty of Object.values(dirtyByPane)) {
    for (const file of Object.keys(paneDirty)) files.add(file);
  }
  return files;
}

function sameDirtyByPane(left: EditorDirtyByPane, right: EditorDirtyByPane): boolean {
  const leftPanes = Object.keys(left);
  if (leftPanes.length !== Object.keys(right).length) return false;
  for (const paneId of leftPanes) {
    const leftFiles = left[paneId] ?? {};
    const rightFiles = right[paneId];
    if (rightFiles === undefined) return false;
    const leftKeys = Object.keys(leftFiles);
    if (leftKeys.length !== Object.keys(rightFiles).length) return false;
    for (const file of leftKeys) {
      if (rightFiles[file] !== true) return false;
    }
  }
  return true;
}

/**
 * Re-home the per-pane dirty index onto the current layout.
 *
 * Every file that is dirty anywhere is re-assigned to exactly the panes that now
 * hold it; entries for panes or files the layout no longer contains are dropped.
 * This keeps dirty markers and the unsaved-changes prompt attached to a tab as it
 * moves between panes (move-tab, drop-tab, keyboard move) and prunes the empty
 * inner records left behind when the last dirty file in a pane is saved.
 *
 * Pure and idempotent. Returns the same reference when nothing changes so the
 * caller's React state stays referentially stable and dependent effects do not
 * re-run.
 */
export function reconcileEditorDirtyByPane(
  dirtyByPane: EditorDirtyByPane,
  layout: EditorLayoutStateV2,
): EditorDirtyByPane {
  const dirtyFiles = dirtyFileSet(dirtyByPane);
  if (dirtyFiles.size === 0) {
    return Object.keys(dirtyByPane).length === 0 ? dirtyByPane : {};
  }
  const next: Record<string, Record<string, true>> = {};
  for (const pane of editorLayoutPanes(layout)) {
    let flagged: Record<string, true> | undefined;
    for (const file of pane.openFiles) {
      if (!dirtyFiles.has(file)) continue;
      flagged ??= {};
      flagged[file] = true;
    }
    if (flagged !== undefined) next[pane.id] = flagged;
  }
  return sameDirtyByPane(dirtyByPane, next) ? dirtyByPane : next;
}
