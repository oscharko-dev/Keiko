/**
 * Pure selection/navigation derivation for {@link import("./KeikoDiffEditor.js").KeikoDiffEditor}
 * (Issue #1195).
 *
 * Resolves which file is under review from the (internal) selected URI, falling back to the first
 * file when the selection is absent or stale (e.g. the model changed underneath it), and decides
 * whether next/previous-diff navigation is meaningful for that file. No DOM, no Monaco, no clocks.
 */
import type { PatchPreviewFile, PatchPreviewModel } from "../patch-preview.js";

export interface SelectedFile {
  /** The resolved file, or null when the patch has no files. */
  readonly file: PatchPreviewFile | null;
  /** Index of the resolved file in `model.files`, or -1 when none. */
  readonly index: number;
}

/**
 * Resolve the file to review. Uses `selectedUri` when it still names a file in `model`; otherwise
 * falls back to the first file. Returns `{ file: null, index: -1 }` for an empty patch.
 */
export function resolveSelectedFile(
  model: PatchPreviewModel,
  selectedUri: string | null,
): SelectedFile {
  if (selectedUri !== null) {
    const index = model.files.findIndex((file) => file.uri === selectedUri);
    const found = model.files[index];
    if (found !== undefined) {
      return { file: found, index };
    }
  }
  const first = model.files[0];
  return first === undefined ? { file: null, index: -1 } : { file: first, index: 0 };
}

/**
 * Whether next/previous-diff navigation should be enabled: the file must be a renderable diff that
 * actually differs between its two sides.
 */
export function canNavigateDiffs(file: PatchPreviewFile | null): boolean {
  return file !== null && file.diffable && file.hasChanges;
}
