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
  /** Optional host-provided accessible name when the path alone is ambiguous. */
  readonly ariaLabel?: string | undefined;
}

/** Stable monospace stack: a dense tool surface needs a predictable, ligature-free code font. */
const EDITOR_FONT_FAMILY =
  '"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace';
const EDITOR_FONT_SIZE = 13;

const DISABLED_SUGGEST_OPTIONS = {
  showStatusBar: false,
  preview: false,
  showInlineDetails: false,
  showIcons: false,
  showMethods: false,
  showFunctions: false,
  showConstructors: false,
  showFields: false,
  showVariables: false,
  showClasses: false,
  showStructs: false,
  showInterfaces: false,
  showModules: false,
  showProperties: false,
  showEvents: false,
  showOperators: false,
  showUnits: false,
  showValues: false,
  showConstants: false,
  showEnums: false,
  showEnumMembers: false,
  showKeywords: false,
  showWords: false,
  showColors: false,
  showFiles: false,
  showReferences: false,
  showFolders: false,
  showTypeParameters: false,
  showIssues: false,
  showUsers: false,
  showSnippets: false,
} satisfies monaco.editor.ISuggestOptions;

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
    hover: { enabled: false },
    quickSuggestions: false,
    quickSuggestionsDelay: 0,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    suggest: { ...DISABLED_SUGGEST_OPTIONS },
    inlineSuggest: {
      enabled: false,
      showToolbar: "never",
      syntaxHighlightingEnabled: false,
      suppressSuggestions: true,
    },
    wordBasedSuggestions: "off",
    links: false,
    colorDecorators: false,
    codeLens: false,
    lightbulb: { enabled: "off" as monaco.editor.ShowLightbulbIconMode },
    inlayHints: { enabled: "off" },
    multiCursorModifier: "alt",
    minimap: { enabled: false },
    readOnly: args.readOnly,
    domReadOnly: false,
    ariaLabel: args.ariaLabel ?? `Editor: ${args.ariaPath}`,
    accessibilitySupport: "auto",
    renderWhitespace: "selection",
    scrollBeyondLastLine: false,
    tabSize: 2,
    wordWrap: "off",
  };
}
