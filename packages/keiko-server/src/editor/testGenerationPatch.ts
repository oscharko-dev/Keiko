// Pure translation of a unit-test workflow's proposed unified diff into the editor test-generation
// wire patch (Issue #1202, ADR-0042 D2/D7). The unified-diff parser and the hunk applier stay
// server-side (ADR-0042 D2: keiko-tools owns diff parsing; the browser tier only renders the resulting
// `{ range, newText }` edits). Pure over its inputs: the original-content lookup is injected so this is
// fully unit-testable without the filesystem.

import { computeFileContent, parseUnifiedDiff, PatchParseError } from "@oscharko-dev/keiko-tools";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import type {
  EditorTestGenerationWireChangeKind,
  EditorTestGenerationWireEdit,
  EditorTestGenerationWireFileChange,
  EditorTestGenerationWirePatch,
  PatchChangeKind,
  PatchFileChange,
} from "@oscharko-dev/keiko-contracts";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts";

/** Resolves the current workspace content of a file, or undefined when it does not exist / is unreadable. */
export type OriginalContentReader = (relativePath: string) => string | undefined;

const CHANGE_KIND: Readonly<Record<PatchChangeKind, EditorTestGenerationWireChangeKind>> = {
  create: "added",
  modify: "modified",
  delete: "deleted",
};

// The end position of a full-file span: the last line index and its UTF-16 length. Empty content maps
// to the zero position (an insertion at the start of the file).
function endPosition(content: string): { readonly line: number; readonly character: number } {
  if (content === "") {
    return { line: 0, character: 0 };
  }
  const lines = content.split("\n");
  const lastIndex = lines.length - 1;
  return { line: lastIndex, character: (lines[lastIndex] ?? "").length };
}

// Translates one parsed file change into a single full-file-replacement edit (range = the original
// span; `newText` = the post-image). Returns undefined when the original is required but unavailable,
// or when applying the hunks conflicts — the candidate then omits that file rather than corrupting it.
function fileChangeToWire(
  change: PatchFileChange,
  readOriginal: OriginalContentReader,
): EditorTestGenerationWireFileChange | undefined {
  if (!isValidScopePath(change.path, { mustBeRelative: true }) || isDenied(change.path)) {
    return undefined;
  }
  const original = change.kind === "create" ? undefined : readOriginal(change.path);
  if (change.kind !== "create" && original === undefined) {
    return undefined;
  }
  const outcome = computeFileContent(change, original);
  if (outcome.conflicts.length > 0) {
    return undefined;
  }
  const end = original === undefined ? { line: 0, character: 0 } : endPosition(original);
  const edit: EditorTestGenerationWireEdit = {
    range: { start: { line: 0, character: 0 }, end },
    newText: outcome.content ?? "",
  };
  return { path: change.path, changeKind: CHANGE_KIND[change.kind], edits: [edit] };
}

/**
 * Parses the proposed unified diff and projects it to the wire patch. Returns undefined when the diff
 * is unparseable or yields no renderable file change, so the caller can degrade to `deferred`/`failed`
 * rather than surface an empty patch.
 */
export function translateDiffToWirePatch(
  diff: string,
  patchId: string,
  readOriginal: OriginalContentReader,
): EditorTestGenerationWirePatch | undefined {
  let parsed: ReturnType<typeof parseUnifiedDiff>;
  try {
    parsed = parseUnifiedDiff(diff);
  } catch (error) {
    if (error instanceof PatchParseError) {
      return undefined;
    }
    throw error;
  }
  const files = parsed.files
    .map((change) => fileChangeToWire(change, readOriginal))
    .filter((change): change is EditorTestGenerationWireFileChange => change !== undefined);
  return files.length === 0 ? undefined : { patchId, files };
}
