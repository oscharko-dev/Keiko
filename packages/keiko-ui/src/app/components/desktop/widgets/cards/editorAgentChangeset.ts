import type {
  EditorPatchFileChange,
  EditorPreviewedPatch,
  EditorTextEdit,
} from "@oscharko-dev/keiko-editor";

import type { EditorAgentAction } from "../../../../../lib/types";

type PreparedChangeset = NonNullable<NonNullable<EditorAgentAction["changeset"]>["prepared"]>;
type PreparedChangesetFile = PreparedChangeset["files"][number];

export interface BuildEditorAgentChangesetPatchInput {
  readonly actionId: string;
  readonly prepared: PreparedChangeset;
}

function preparedEditToEditorEdit(
  edit: PreparedChangesetFile["textEdits"][number],
): EditorTextEdit {
  return {
    range: {
      start: { line: edit.range.start.line, column: edit.range.start.character },
      end: { line: edit.range.end.line, column: edit.range.end.character },
    },
    newText: edit.newText,
  };
}

function preparedFileToPatchChange(file: PreparedChangesetFile): EditorPatchFileChange {
  return {
    uri: file.file,
    edits: file.textEdits.map(preparedEditToEditorEdit),
    isNewFile: file.kind === "create",
    isDeletion: file.kind === "delete",
  };
}

/** Project a server-prepared changeset into the editor's render-only patch descriptor. */
export function buildEditorAgentChangesetPatch(
  input: BuildEditorAgentChangesetPatchInput,
): EditorPreviewedPatch {
  return {
    patchId: `agent-changeset:${input.actionId}`,
    status: "previewed",
    provenance: { origin: "applied-patch" },
    changes: input.prepared.files.map(preparedFileToPatchChange),
  };
}
