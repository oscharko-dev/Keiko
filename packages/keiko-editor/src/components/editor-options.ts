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
  /**
   * Whether a governed inline-completion (ghost-text) provider is wired (Issue #1200). Monaco's
   * inline-suggest UI is enabled only when true; absent/false keeps it fully disabled (ADR-0042 D3.7
   * baseline). Defaults to false. Even when enabled, the inline-suggest toolbar stays off and ghost
   * text never renders Markdown, so the vendored DOMPurify sink is never reached.
   */
  readonly inlineCompletionEnabled?: boolean | undefined;
}

/** Stable monospace stack: a dense tool surface needs a predictable, ligature-free code font. */
const EDITOR_FONT_FAMILY =
  '"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace';
const EDITOR_FONT_SIZE = 13;

const GOVERNED_COMPLETION_SUGGEST_OPTIONS = {
  showStatusBar: false,
  preview: false,
  showInlineDetails: false,
  showIcons: true,
  showMethods: true,
  showFunctions: true,
  showConstructors: true,
  showFields: true,
  showVariables: true,
  showClasses: true,
  showStructs: true,
  showInterfaces: true,
  showModules: true,
  showProperties: true,
  showEvents: false,
  showOperators: false,
  showUnits: false,
  showValues: true,
  showConstants: true,
  showEnums: true,
  showEnumMembers: true,
  showKeywords: true,
  showWords: false,
  showColors: false,
  showFiles: false,
  showReferences: false,
  showFolders: false,
  showTypeParameters: true,
  showIssues: false,
  showUsers: false,
  showSnippets: true,
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
  const inlineCompletionEnabled = args.inlineCompletionEnabled ?? false;
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
    suggestOnTriggerCharacters: true,
    parameterHints: { enabled: false },
    suggest: { ...GOVERNED_COMPLETION_SUGGEST_OPTIONS },
    inlineSuggest: {
      // Enabled only when a governed inline-completion provider is wired (Issue #1200). The toolbar
      // stays off and syntax highlighting of ghost text stays off so no Markdown sink runs (the
      // vendored DOMPurify is never reached); `suppressSuggestions: false` lets the #1199 completion
      // dropdown and inline ghost text coexist without one hiding the other.
      enabled: inlineCompletionEnabled,
      showToolbar: "never",
      syntaxHighlightingEnabled: false,
      suppressSuggestions: !inlineCompletionEnabled,
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
