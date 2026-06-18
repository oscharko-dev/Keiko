/**
 * Pure Keiko Editor -> Monaco theme builder (Issue #1193).
 *
 * Builds Monaco `IStandaloneThemeData` for the dark, light, and high-contrast editor themes by
 * mapping the Keiko Editor design tokens delivered in Issue #1212
 * (`design-system/keiko-editor-tokens.css`, `--ed-*` / `--ed-syn-*`) onto Monaco theme `rules`
 * (TextMate scopes) and `colors` (editor colour ids), following the "How engineering wires it"
 * mapping table in `design-system/editor-theme.html` §06.
 *
 * This module contains **no colour literals**: every `foreground`/colour value comes from the
 * caller-supplied {@link ResolvedEditorThemeTokens}. Resolving the `--ed-*` custom properties (many
 * of which are `oklch()` / `color-mix()` / `var()` references) to the concrete hex strings Monaco's
 * `Color.fromHex` requires is the job of the runtime resolver (`./theme-resolver.ts`), which reads
 * computed styles from the live DOM. Keeping the builder pure makes it fully node-testable and keeps
 * the design tokens the single source of truth (ADR-0042 D1; #1212 design sign-off).
 *
 * Type-only `monaco-editor` import keeps this node-safe (no Monaco runtime is loaded).
 */

import type * as monaco from "monaco-editor";

/** The three editor theme variants, all derived from the same #1212 token source. */
export const EDITOR_THEME_VARIANTS = ["dark", "light", "high-contrast"] as const;

/** A Keiko Editor theme variant. */
export type EditorThemeVariant = (typeof EDITOR_THEME_VARIANTS)[number];

/** Stable Monaco theme name registered for each variant. */
export const EDITOR_THEME_NAME: Readonly<Record<EditorThemeVariant, string>> = {
  dark: "keiko-editor-dark",
  light: "keiko-editor-light",
  "high-contrast": "keiko-editor-high-contrast",
};

/**
 * Monaco built-in base theme each variant inherits before applying Keiko colours.
 * @internal Not part of the package public API (consumed by the builder + tests).
 */
export const MONACO_BASE_THEME: Readonly<Record<EditorThemeVariant, monaco.editor.BuiltinTheme>> = {
  dark: "vs-dark",
  light: "vs",
  "high-contrast": "hc-black",
};

/**
 * Syntax token (`--ed-syn-*`) -> Monaco `rules` token scopes.
 *
 * Scopes follow `editor-theme.html` §06 (TextMate intent) and additionally include the Monarch
 * token names monaco-editor's bundled TS/JS/JSON grammars actually emit, so colours apply in
 * practice as well as matching the design contract. No colours appear here — only token names.
 */
export const SYNTAX_TOKEN_SCOPES: Readonly<Record<string, readonly string[]>> = {
  "--ed-syn-keyword": ["keyword", "keyword.control", "storage.type", "storage.modifier"],
  "--ed-syn-string": ["string", "string.template", "string.value.json"],
  "--ed-syn-comment": ["comment", "punctuation.definition.comment"],
  "--ed-syn-type": ["type", "type.identifier", "entity.name.type", "support.class", "support.type"],
  "--ed-syn-function": ["entity.name.function", "support.function", "meta.function-call"],
  "--ed-syn-property": [
    "variable.other.property",
    "meta.object-literal.key",
    "key",
    "string.key.json",
  ],
  "--ed-syn-number": ["number", "constant.numeric"],
  "--ed-syn-constant": ["constant.language", "constant.language.boolean", "keyword.constant"],
  "--ed-syn-variable": ["variable", "identifier", "variable.other", "variable.parameter"],
  "--ed-syn-operator": ["operator", "keyword.operator"],
  "--ed-syn-punct": ["delimiter", "delimiter.bracket", "delimiter.parenthesis", "punctuation"],
  "--ed-syn-regexp": ["regexp", "string.regexp", "constant.character.escape"],
};

/** Syntax tokens rendered italic, mirroring the design source (comments are italic in #1212). */
const ITALIC_SYNTAX_TOKENS: ReadonlySet<string> = new Set(["--ed-syn-comment"]);

/**
 * Editor chrome token (`--ed-*`) -> Monaco `colors` dictionary id(s).
 *
 * A token may drive more than one Monaco colour id (per `editor-theme.html` §06, e.g. the focus
 * ring covers `focusBorder`, `editorWidget.border`, and `editor.findMatchBorder`). Only tokens that
 * map onto real standalone-Monaco colour ids are included; the editor-card chrome tokens
 * (`--ed-tab-*`, `--ed-statusbar-*`) style the keiko-ui React card via CSS — explicitly **not**
 * Monaco theme keys per the §06 boundary note — so they are wired in the component, not here.
 * Likewise, the `--ed-diff-chg-*` middle-state tokens have no Monaco 0.55.1 diff colour id and
 * are reserved for the Keiko diff surface.
 */
export const CHROME_TOKEN_COLOR_IDS: Readonly<Record<string, readonly string[]>> = {
  "--ed-bg": ["editor.background"],
  "--ed-fg": ["editor.foreground"],
  "--ed-bg-gutter": ["editorGutter.background"],
  "--ed-gutter-fg": ["editorLineNumber.foreground"],
  "--ed-gutter-fg-active": ["editorLineNumber.activeForeground"],
  "--ed-line-active": ["editor.lineHighlightBackground"],
  "--ed-cursor": ["editorCursor.foreground"],
  "--ed-selection": ["editor.selectionBackground"],
  "--ed-selection-blur": ["editor.inactiveSelectionBackground"],
  "--ed-find-match": ["editor.findMatchHighlightBackground"],
  "--ed-find-match-active": ["editor.findMatchBackground"],
  "--ed-focus": ["focusBorder", "editorWidget.border", "editor.findMatchBorder"],
  "--ed-bracket-match": ["editorBracketMatch.border"],
  "--ed-indent-guide": ["editorIndentGuide.background1"],
  "--ed-indent-guide-active": ["editorIndentGuide.activeBackground1"],
  "--ed-whitespace": ["editorWhitespace.foreground"],
  "--ed-diff-ins-line": ["diffEditor.insertedLineBackground"],
  "--ed-diff-ins-text": ["diffEditor.insertedTextBackground"],
  "--ed-diff-rem-line": ["diffEditor.removedLineBackground"],
  "--ed-diff-rem-text": ["diffEditor.removedTextBackground"],
  // NOTE: the diff-gutter tokens (--ed-diff-ins-gutter / -rem-gutter / -chg-gutter) are deliberately
  // NOT mapped here. Their natural Monaco targets (editorGutter.added/deleted/modifiedBackground,
  // editorOverviewRuler.modifiedForeground — the §06 design target for --ed-diff-chg-gutter) are VS
  // Code workbench SCM colours that monaco-editor 0.55.1 standalone does not register, so a theme
  // mapping would be stored but never painted (a silent no-op). The diff editor (#1195) renders gutter
  // indicators with decorations driven by these tokens directly, not via the Monaco theme. The tokens
  // remain surfaced in the keiko-ui runtime (globals.css) for that consumer; see EDITOR_THEME_DEAD_COLOR_IDS.
  "--ed-error": ["editorError.foreground"],
  "--ed-warn": ["editorWarning.foreground"],
  "--ed-info": ["editorInfo.foreground"],
  "--ed-hint": ["editorHint.foreground"],
  "--ed-ghost": ["editorGhostText.foreground"],
  "--ed-suggest-bg": ["editorSuggestWidget.background"],
  "--ed-suggest-sel": ["editorSuggestWidget.selectedBackground"],
  "--ed-suggest-match": ["editorSuggestWidget.highlightForeground"],
  "--ed-minimap-bg": ["minimap.background"],
  "--ed-minimap-slider": ["minimapSlider.background"],
};

/**
 * Every `--ed-*` / `--ed-syn-*` token name the Monaco theme consumes — the contract the runtime
 * resolver must supply. Derived from the mapping tables so the two never drift.
 */
export const EDITOR_THEME_TOKEN_NAMES: readonly string[] = [
  ...Object.keys(SYNTAX_TOKEN_SCOPES),
  ...Object.keys(CHROME_TOKEN_COLOR_IDS),
];

/**
 * Monaco colour ids the editor must NOT emit: VS Code workbench SCM gutter/overview-ruler colours
 * that monaco-editor 0.55.1 standalone does not register, so a theme mapping would be an inert
 * no-op. Pinned by a test so a future mapping cannot silently re-introduce them.
 * @internal
 */
export const EDITOR_THEME_DEAD_COLOR_IDS: readonly string[] = [
  "editorGutter.addedBackground",
  "editorGutter.deletedBackground",
  "editorGutter.modifiedBackground",
  "editorOverviewRuler.modifiedForeground",
];

/**
 * Concrete colours for every {@link EDITOR_THEME_TOKEN_NAMES} entry, resolved to the hex strings
 * Monaco requires (`#rrggbb` or `#rrggbbaa`). Produced by the runtime resolver for the active
 * variant; consumed by {@link buildKeikoEditorMonacoTheme}.
 */
export type ResolvedEditorThemeTokens = Readonly<Record<string, string>>;

/** Minimal structural view of `monaco.editor` the theme registrar needs (injectable for tests). */
export interface MonacoThemeRegistrar {
  defineTheme(themeName: string, themeData: monaco.editor.IStandaloneThemeData): void;
}

function requireResolvedColor(tokens: ResolvedEditorThemeTokens, tokenName: string): string {
  const value = tokens[tokenName];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Keiko editor theme: missing resolved colour for design token "${tokenName}". ` +
        "All --ed-* / --ed-syn-* tokens must be resolved before building the Monaco theme.",
    );
  }
  return value.trim();
}

/** Monaco `rules` foreground colours are hex WITHOUT a leading "#". */
function toRuleForeground(hex: string): string {
  return hex.startsWith("#") ? hex.slice(1) : hex;
}

/** Monaco `colors` values are hex WITH a leading "#". */
function toColorValue(hex: string): string {
  return hex.startsWith("#") ? hex : `#${hex}`;
}

/**
 * Build the Monaco theme for one variant by mapping the resolved #1212 design tokens.
 *
 * Throws (actionable, naming the missing token) if any required token is absent, so a partial token
 * set fails loudly rather than rendering an un-themed editor.
 */
export function buildKeikoEditorMonacoTheme(
  variant: EditorThemeVariant,
  tokens: ResolvedEditorThemeTokens,
): monaco.editor.IStandaloneThemeData {
  const rules: monaco.editor.ITokenThemeRule[] = [];
  for (const [tokenName, scopes] of Object.entries(SYNTAX_TOKEN_SCOPES)) {
    const foreground = toRuleForeground(requireResolvedColor(tokens, tokenName));
    const italic = ITALIC_SYNTAX_TOKENS.has(tokenName);
    for (const scope of scopes) {
      rules.push(
        italic ? { token: scope, foreground, fontStyle: "italic" } : { token: scope, foreground },
      );
    }
  }

  const colors: Record<string, string> = {};
  for (const [tokenName, colorIds] of Object.entries(CHROME_TOKEN_COLOR_IDS)) {
    const value = toColorValue(requireResolvedColor(tokens, tokenName));
    for (const colorId of colorIds) {
      colors[colorId] = value;
    }
  }

  return {
    base: MONACO_BASE_THEME[variant],
    inherit: true,
    rules,
    colors,
  };
}

/**
 * Register one Keiko editor theme on an injected Monaco editor namespace and return its theme name.
 *
 * The caller supplies `monaco.editor` (or any object with `defineTheme`) and the tokens resolved for
 * the active variant; re-call on theme/contrast switch with freshly resolved tokens.
 */
export function registerKeikoEditorTheme(
  registrar: MonacoThemeRegistrar,
  variant: EditorThemeVariant,
  tokens: ResolvedEditorThemeTokens,
): string {
  const themeName = EDITOR_THEME_NAME[variant];
  registrar.defineTheme(themeName, buildKeikoEditorMonacoTheme(variant, tokens));
  return themeName;
}
