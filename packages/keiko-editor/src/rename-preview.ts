/**
 * Rename-changeset preview adapter (Epic #2089, Issue #2105).
 *
 * Converts the governed language-service rename changeset into the existing render-only
 * `PatchPreviewModel` consumed by `KeikoDiffEditor`. It never applies edits or reads files; the host
 * supplies source buffers, and Accept remains a separate, explicit host action.
 */
import type { LanguageRenameChangeset } from "@oscharko-dev/keiko-contracts";

import {
  buildPatchPreview,
  type PatchPreviewLimits,
  type PatchPreviewModel,
  type PatchPreviewSource,
} from "./patch-preview.js";
import type { EditorPatchFileChange, EditorPreviewedPatch, EditorTextEdit } from "./types.js";

export interface BuildRenamePreviewInput {
  readonly changeset: LanguageRenameChangeset;
  readonly sources?: Readonly<Record<string, PatchPreviewSource>> | undefined;
  readonly limits?: Partial<PatchPreviewLimits> | undefined;
  readonly patchId?: string | undefined;
}

function toEditorTextEdit(edit: {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
}): EditorTextEdit {
  return {
    range: {
      start: { line: edit.range.start.line, column: edit.range.start.character },
      end: { line: edit.range.end.line, column: edit.range.end.character },
    },
    newText: edit.newText,
  };
}

function toPatchFileChange(file: LanguageRenameChangeset["files"][number]): EditorPatchFileChange {
  return {
    uri: file.path,
    edits: file.edits.map(toEditorTextEdit),
    isNewFile: false,
    isDeletion: false,
  };
}

function toPreviewPatch(input: BuildRenamePreviewInput): EditorPreviewedPatch {
  return {
    patchId: input.patchId ?? "rename-symbol",
    status: "previewed",
    provenance: { origin: "human" },
    changes: input.changeset.files.map(toPatchFileChange),
  };
}

export function buildRenamePreview(input: BuildRenamePreviewInput): PatchPreviewModel {
  return buildPatchPreview({
    patch: toPreviewPatch(input),
    sources: input.sources,
    limits: input.limits,
  });
}
