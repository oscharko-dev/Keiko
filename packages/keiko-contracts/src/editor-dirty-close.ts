/**
 * Why an editor buffer with unsaved changes is about to be closed, replaced, or orphaned.
 *
 * `path-mutation` is the out-of-editor case: a Files-tree rename, drag-move, or delete of the
 * buffer's own path — or of a directory containing it — would leave the unsaved buffer pointing at a
 * path that no longer exists. Unlike every other reason, this intent is raised BEFORE the mutation
 * is sent, so a `cancel` decision vetoes the filesystem mutation instead of discarding the buffer
 * (ADR-0065 D1, amended).
 */
export type EditorDirtyCloseReason =
  "tab-close" | "pane-close" | "root-change" | "window-close" | "reload-file" | "path-mutation";

export interface EditorDirtyCloseIntent {
  readonly paneId: string;
  readonly files: readonly string[];
  readonly reason: EditorDirtyCloseReason;
}

export type EditorDirtyCloseDecision = "save" | "discard" | "cancel";

export interface EditorDirtyCloseResolution {
  readonly decision: EditorDirtyCloseDecision;
  readonly files: readonly string[];
}

export function createEditorDirtyCloseIntent(input: {
  readonly paneId: string;
  readonly files: readonly string[];
  readonly reason: EditorDirtyCloseReason;
}): EditorDirtyCloseIntent {
  const files: string[] = [];
  for (const file of input.files) {
    if (file.length > 0 && !files.includes(file)) files.push(file);
  }
  return { paneId: input.paneId, files, reason: input.reason };
}
