/**
 * Rename-changeset preview adapter (Epic #2089, Issue #2105).
 *
 * Converts the governed language-service rename changeset into the existing render-only
 * `PatchPreviewModel` consumed by `KeikoDiffEditor`. It never applies edits or reads files; the host
 * supplies source buffers, and Accept remains a separate, explicit host action.
 *
 * The changeset is a BOUNDED result: the language service stops selecting references at its
 * `maxRenameChangesetFiles`/`maxRenameChangesetEdits` caps, drops reference files whose content it
 * could not read, and reports all of that alongside the files it did return. Those facts are carried
 * into the preview model ({@link PatchPreviewSourceTruncation}) rather than dropped, because a
 * preview built from the returned files alone is internally consistent and therefore looks like the
 * whole rename — and applying 128 of 400 files leaves the workspace referring to a symbol that no
 * longer exists. {@link isRenameChangesetComplete} is the host's gate for Accept.
 */
import type { LanguageRenameChangeset, LanguageTextEdit } from "@oscharko-dev/keiko-contracts";

import {
  buildPatchPreview,
  isPatchSourceTruncated,
  type PatchPreviewLimits,
  type PatchPreviewModel,
  type PatchPreviewSource,
  type PatchPreviewSourceTruncation,
} from "./patch-preview.js";
import { fromLanguagePosition } from "./position-adapters.js";
import type { EditorPatchFileChange, EditorPreviewedPatch, EditorTextEdit } from "./types.js";

export interface BuildRenamePreviewInput {
  readonly changeset: LanguageRenameChangeset;
  readonly sources?: Readonly<Record<string, PatchPreviewSource>> | undefined;
  readonly limits?: Partial<PatchPreviewLimits> | undefined;
  readonly patchId?: string | undefined;
}

function toEditorTextEdit(edit: LanguageTextEdit): EditorTextEdit {
  return {
    range: {
      start: fromLanguagePosition(edit.range.start),
      end: fromLanguagePosition(edit.range.end),
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

function payloadEditCount(changeset: LanguageRenameChangeset): number {
  return changeset.files.reduce((count, file) => count + file.edits.length, 0);
}

/**
 * Whether the changeset's own report describes the payload it actually carries. A report that
 * disagrees with its payload is treated as truncated: the counts a reviewer is shown come from the
 * report, but only the payload is ever applied.
 */
function reportMatchesPayload(changeset: LanguageRenameChangeset): boolean {
  return (
    changeset.returnedFileCount === changeset.files.length &&
    changeset.returnedEditCount === payloadEditCount(changeset)
  );
}

function toSourceTruncation(changeset: LanguageRenameChangeset): PatchPreviewSourceTruncation {
  return {
    // Honour every incompleteness signal the language service set, not just the count comparison:
    // `truncated` is also true when the project graph itself was bounded, in which case even
    // `totalFileCount` is a lower bound on the real reference set.
    truncated: changeset.truncated || changeset.filesTruncated || !reportMatchesPayload(changeset),
    // Derived from the payload, not from the report, so an inflated report cannot claim files or
    // edits the changeset does not carry.
    returnedFileCount: changeset.files.length,
    totalFileCount: changeset.totalFileCount,
    returnedEditCount: payloadEditCount(changeset),
    totalEditCount: changeset.totalEditCount,
    unreadableFileCount: changeset.unreadableFileCount,
  };
}

/**
 * What the language service left out of this changeset, or `null` when the changeset IS the whole
 * rename and is therefore safe to apply.
 *
 * Non-null when the service stopped short — result caps reached, a reference file it could not read,
 * a bounded project graph, or a report that disagrees with its own payload. Applying such a changeset
 * renames some occurrences of the symbol and leaves the rest pointing at the old name, so a host must
 * state these counts and refuse Accept rather than present a capped result as a finished rename.
 */
export function renameChangesetTruncation(
  changeset: LanguageRenameChangeset,
): PatchPreviewSourceTruncation | null {
  const source = toSourceTruncation(changeset);
  return isPatchSourceTruncated(source) ? source : null;
}

export function buildRenamePreview(input: BuildRenamePreviewInput): PatchPreviewModel {
  return buildPatchPreview({
    patch: toPreviewPatch(input),
    sources: input.sources,
    limits: input.limits,
    sourceTruncation: toSourceTruncation(input.changeset),
  });
}
