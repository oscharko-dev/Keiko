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
  /**
   * Whether a governed hover (quick-info) provider is wired (Issue #1201). Monaco's hover widget is
   * enabled only when true; absent/false keeps it disabled (ADR-0042 D3.7 baseline). Defaults to
   * false. The hover bridge renders the server's plain-text quick info inside an inert Markdown code
   * fence (HTML-escaped, no active markup), so the vendored DOMPurify sink only processes inert text;
   * no other Markdown sink (suggest docs, parameter hints, links, code lens, lightbulb) is enabled.
   */
  readonly hoverEnabled?: boolean | undefined;
  /**
   * Whether a governed code-action provider is wired (Epic #2089). Monaco's lightbulb is enabled
   * only when true; absent/false keeps it disabled so unsupported languages retain today's behavior.
   */
  readonly codeActionsEnabled?: boolean | undefined;
  /**
   * Whether a governed signature-help provider is wired (Epic #2089). Monaco parameter hints are
   * enabled only when true; absent/false keeps the parameter-hints UI disabled.
   */
  readonly signatureHelpEnabled?: boolean | undefined;
  /** Whether the governed TypeScript/JavaScript inlay-hints provider is wired. */
  readonly inlayHintsEnabled?: boolean | undefined;
  /**
   * Whether the buffer is in large-file degraded mode (Issue #1207, ADR-0042 D3.6: buffers > 500 KB
   * or > 10,000 lines). Defaults to false. In degraded mode the per-render/per-keystroke-expensive
   * features (bracket-pair colorization, folding, occurrence highlighting, whitespace rendering) are
   * turned off and Monaco's `largeFileOptimizations` is engaged, keeping per-keystroke main-thread
   * work within the typing budget on large buffers. Derived by {@link
   * import("./large-file-mode.js").deriveLargeFileMode}.
   */
  readonly degraded?: boolean | undefined;
}

/** Stable monospace stack: a dense tool surface needs a predictable, ligature-free code font. */
const EDITOR_FONT_FAMILY =
  '"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace';
const EDITOR_FONT_SIZE = 13;
const EDITOR_SCROLLBAR_SIZE = 8;
type EditorConstructionOptions = monaco.editor.IStandaloneEditorConstructionOptions;

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

function buildPerformanceOptions(degraded: boolean): EditorConstructionOptions {
  return {
    // Engaged explicitly (default-on in Monaco) so the ADR-0042 D3.6 large-file contract is asserted,
    // not merely inherited; it tokenises/highlights large models lazily.
    largeFileOptimizations: true,
    bracketPairColorization: { enabled: !degraded },
    matchBrackets: degraded ? "never" : "always",
    folding: !degraded,
    foldingStrategy: "auto",
    occurrencesHighlight: degraded ? "off" : "singleFile",
    renderWhitespace: degraded ? "none" : "selection",
  };
}

function buildAssistanceOptions(
  inlineCompletionEnabled: boolean,
  hoverEnabled: boolean,
  codeActionsEnabled: boolean,
  signatureHelpEnabled: boolean,
  inlayHintsEnabled: boolean,
): EditorConstructionOptions {
  return {
    // Force below-line placement so top-of-editor diagnostics do not render under Keiko window chrome.
    // The bridge renders quick info as inert Markdown, so hover remains the only enabled Markdown sink.
    hover: { enabled: hoverEnabled, above: false },
    quickSuggestions: false,
    quickSuggestionsDelay: 0,
    suggestOnTriggerCharacters: true,
    parameterHints: { enabled: signatureHelpEnabled },
    suggest: { ...GOVERNED_COMPLETION_SUGGEST_OPTIONS },
    inlineSuggest: {
      // Enabled only when a governed inline-completion provider is wired (Issue #1200). The toolbar
      // stays off and syntax highlighting of ghost text stays off so no Markdown sink runs.
      enabled: inlineCompletionEnabled,
      showToolbar: "never",
      syntaxHighlightingEnabled: false,
      suppressSuggestions: !inlineCompletionEnabled,
    },
    wordBasedSuggestions: "off",
    links: false,
    colorDecorators: false,
    codeLens: false,
    lightbulb: {
      enabled: (codeActionsEnabled ? "on" : "off") as monaco.editor.ShowLightbulbIconMode,
    },
    inlayHints: { enabled: inlayHintsEnabled ? "on" : "off" },
  };
}

function buildChromeOptions(): EditorConstructionOptions {
  return {
    lineNumbers: "on",
    find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "always" },
    minimap: { enabled: false },
    scrollbar: {
      verticalScrollbarSize: EDITOR_SCROLLBAR_SIZE,
      verticalSliderSize: EDITOR_SCROLLBAR_SIZE,
      horizontalScrollbarSize: EDITOR_SCROLLBAR_SIZE,
      horizontalSliderSize: EDITOR_SCROLLBAR_SIZE,
      useShadows: false,
    },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    renderValidationDecorations: "on",
    scrollBeyondLastLine: false,
  };
}

/**
 * Build the Monaco options for the Keiko editor.
 *
 * Minimap policy: disabled. The editor mounts inside a dense workspace card (#1196) where a minimap
 * costs horizontal space and paints a second, redundant overview of an already-short viewport;
 * folding and the Keiko diagnostic overlay cover navigation. `domReadOnly` is left `false` even
 * when read-only so selection and copy keep working on a read-only buffer.
 */
export function buildEditorOptions(
  args: BuildEditorOptionsArgs,
): monaco.editor.IStandaloneEditorConstructionOptions {
  const inlineCompletionEnabled = args.inlineCompletionEnabled ?? false;
  const hoverEnabled = args.hoverEnabled ?? false;
  const codeActionsEnabled = args.codeActionsEnabled ?? false;
  const signatureHelpEnabled = args.signatureHelpEnabled ?? false;
  const inlayHintsEnabled = args.inlayHintsEnabled ?? false;
  // Large-file degraded mode (Issue #1207, ADR-0042 D3.6). On buffers > 500 KB or > 10,000 lines the
  // per-render/per-keystroke-expensive features are disabled and Monaco's large-file optimizations are
  // engaged, so typing stays within the < 50 ms main-thread budget. Normal buffers are unaffected.
  const degraded = args.degraded ?? false;
  return {
    automaticLayout: true,
    fontFamily: EDITOR_FONT_FAMILY,
    fontSize: EDITOR_FONT_SIZE,
    ...buildPerformanceOptions(degraded),
    ...buildAssistanceOptions(
      inlineCompletionEnabled,
      hoverEnabled,
      codeActionsEnabled,
      signatureHelpEnabled,
      inlayHintsEnabled,
    ),
    ...buildChromeOptions(),
    multiCursorModifier: "alt",
    readOnly: args.readOnly,
    domReadOnly: false,
    ariaLabel: args.ariaLabel ?? `Editor: ${args.ariaPath}`,
    // Accessibility (Issue #1205, epic #1189 Review Addendum). `"auto"` makes Monaco detect an active
    // screen reader and switch the editing surface into screen-reader mode (an accessible ARIA
    // textarea) automatically; it is preferred over a hard `"on"`, which would degrade the experience
    // for sighted keyboard users by forcing SR mode unconditionally. Monaco's accessibility-help
    // dialog (`editor.action.accessibilityHelp`, Alt+F1 / on macOS ⌥F1) stays enabled — no option
    // here disables it — so screen-reader users can discover the editing-surface keybindings. The
    // editor chrome (tabs, status bar, command palette, find) holds WCAG 2.2 AA; the Monaco editing
    // canvas inherits Monaco's documented accessibility behaviour. See the editor UX spec.
    accessibilitySupport: "auto",
    tabSize: 2,
    wordWrap: "off",
  };
}
