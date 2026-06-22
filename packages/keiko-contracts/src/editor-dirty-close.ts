export type EditorDirtyCloseReason =
  | "tab-close"
  | "pane-close"
  | "root-change"
  | "window-close"
  | "reload-file";

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
