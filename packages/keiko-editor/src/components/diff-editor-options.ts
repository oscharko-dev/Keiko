/**
 * Pure builder for the Monaco diff-editor construction options (Issue #1195).
 *
 * The diff editor is a review surface: it is always read-only on both sides, so a previewed patch can
 * never be mutated through it (AC1 — a generated patch is reviewed without touching workspace files).
 * Whitespace-only changes are shown (`ignoreTrimWhitespace: false`) so a security reviewer sees the
 * true diff. The `monaco-editor` import is type-only — no runtime is loaded here.
 */
import type * as monaco from "monaco-editor";

/** Stable monospace stack shared with the code editor; a dense diff needs a predictable code font. */
const EDITOR_FONT_FAMILY =
  '"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace';
const EDITOR_FONT_SIZE = 13;

export interface BuildDiffEditorOptionsArgs {
  /** Accessible label for the diff editor, e.g. the reviewed file's display path. */
  readonly ariaLabel: string;
}

/**
 * Build the Monaco options for the Keiko diff editor. Read-only on both sides, side-by-side, no
 * minimap (the surface is dense and short), overview ruler on for change density, honest whitespace.
 */
export function buildDiffEditorOptions(
  args: BuildDiffEditorOptionsArgs,
): monaco.editor.IDiffEditorConstructionOptions {
  return {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    enableSplitViewResizing: true,
    renderOverviewRuler: true,
    ignoreTrimWhitespace: false,
    automaticLayout: true,
    fontFamily: EDITOR_FONT_FAMILY,
    fontSize: EDITOR_FONT_SIZE,
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    diffWordWrap: "off",
    ariaLabel: args.ariaLabel,
    accessibilitySupport: "auto",
  };
}
