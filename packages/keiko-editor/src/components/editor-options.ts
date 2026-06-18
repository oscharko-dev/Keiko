/**
 * Pure builder for the Monaco editor construction options (Issue #1194).
 *
 * Every editor "fundamental" the issue mandates is encoded here as data, not configured ad hoc in
 * the React shell, so each one is asserted by a node test and the component stays thin. The
 * `monaco-editor` import is type-only (no runtime is loaded), keeping this node-safe and
 * import-side-effect-free.
 */
import type * as monaco from "monaco-editor";

/** Inputs that vary per render; everything else is a stable Keiko editor default. */
export interface BuildEditorOptionsArgs {
  /** Effective read-only (host read-only OR truncated buffer OR explicit override). */
  readonly readOnly: boolean;
  /** Path shown in the accessible editor label, e.g. the buffer's `relativePath`. */
  readonly ariaPath: string;
}

/** Stable monospace stack: a dense tool surface needs a predictable, ligature-free code font. */
const EDITOR_FONT_FAMILY =
  '"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace';
const EDITOR_FONT_SIZE = 13;

/**
 * Build the Monaco options for the Keiko editor.
 *
 * Minimap policy: disabled. The editor mounts inside a dense workspace card (#1196) where a minimap
 * costs horizontal space and paints a second, redundant overview of an already-short viewport;
 * folding + the overview ruler cover navigation. `domReadOnly` is left `false` even when read-only
 * so selection and copy keep working on a read-only buffer.
 */
export function buildEditorOptions(
  args: BuildEditorOptionsArgs,
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontFamily: EDITOR_FONT_FAMILY,
    fontSize: EDITOR_FONT_SIZE,
    bracketPairColorization: { enabled: true },
    matchBrackets: "always",
    lineNumbers: "on",
    folding: true,
    foldingStrategy: "auto",
    find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "always" },
    multiCursorModifier: "alt",
    minimap: { enabled: false },
    readOnly: args.readOnly,
    domReadOnly: false,
    ariaLabel: `Editor: ${args.ariaPath}`,
    accessibilitySupport: "auto",
    renderWhitespace: "selection",
    scrollBeyondLastLine: false,
    tabSize: 2,
    wordWrap: "off",
  };
}
