import { describe, expect, it } from "vitest";

import { buildEditorOptions } from "./editor-options.js";

describe("buildEditorOptions", () => {
  const options = buildEditorOptions({ readOnly: false, ariaPath: "src/app.ts" });

  it("enables automatic layout (no manual resize wiring needed)", () => {
    expect(options.automaticLayout).toBe(true);
  });

  it("sets a stable monospace font family and size", () => {
    expect(typeof options.fontFamily).toBe("string");
    expect(options.fontFamily).toContain("monospace");
    expect(options.fontSize).toBe(13);
  });

  it("enables bracket-pair colorization and always-on bracket matching", () => {
    expect(options.bracketPairColorization).toEqual({ enabled: true });
    expect(options.matchBrackets).toBe("always");
  });

  it("turns line numbers on", () => {
    expect(options.lineNumbers).toBe("on");
    expect(options.glyphMargin).toBe(true);
  });

  it("enables auto folding", () => {
    expect(options.folding).toBe(true);
    expect(options.foldingStrategy).toBe("auto");
  });

  it("configures find/replace to seed from selection without extra top space", () => {
    expect(options.find).toEqual({
      addExtraSpaceOnTop: false,
      seedSearchStringFromSelection: "always",
    });
  });

  it("disables Monaco hover, ambient suggestions, and markdown-capable helper surfaces", () => {
    expect(options.hover).toEqual({ enabled: false, above: false });
    expect(options.quickSuggestions).toBe(false);
    expect(options.quickSuggestionsDelay).toBe(0);
    expect(options.suggestOnTriggerCharacters).toBe(true);
    expect(options.parameterHints).toEqual({ enabled: false });
    expect(options.wordBasedSuggestions).toBe("off");
    expect(options.inlineSuggest).toEqual({
      enabled: false,
      showToolbar: "never",
      syntaxHighlightingEnabled: false,
      suppressSuggestions: true,
    });
    expect(options.suggest).toMatchObject({
      showStatusBar: false,
      preview: false,
      showInlineDetails: false,
      showIcons: true,
      showMethods: true,
      showFunctions: true,
      showKeywords: true,
      showWords: false,
      showSnippets: true,
    });
    expect(options.links).toBe(false);
    expect(options.colorDecorators).toBe(false);
    expect(options.codeLens).toBe(false);
    expect(options.lightbulb).toEqual({ enabled: "off" });
    expect(options.inlayHints).toEqual({ enabled: "off" });
  });

  it("keeps inline suggest disabled by default and when explicitly false (#1200)", () => {
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", inlineCompletionEnabled: false })
        .inlineSuggest,
    ).toEqual({
      enabled: false,
      showToolbar: "never",
      syntaxHighlightingEnabled: false,
      suppressSuggestions: true,
    });
  });

  it("enables inline suggest with no toolbar/markdown sink when a provider is wired (#1200)", () => {
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", inlineCompletionEnabled: true })
        .inlineSuggest,
    ).toEqual({
      enabled: true,
      showToolbar: "never",
      syntaxHighlightingEnabled: false,
      suppressSuggestions: false,
    });
  });

  it("keeps hover disabled by default and when explicitly false (#1201)", () => {
    expect(buildEditorOptions({ readOnly: false, ariaPath: "a.ts" }).hover).toEqual({
      enabled: false,
      above: false,
    });
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", hoverEnabled: false }).hover,
    ).toEqual({ enabled: false, above: false });
  });

  it("enables the hover widget when a hover provider is wired (#1201)", () => {
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", hoverEnabled: true }).hover,
    ).toEqual({ enabled: true, above: false });
  });

  it("keeps code actions and signature help disabled unless their providers are wired (#2104)", () => {
    expect(buildEditorOptions({ readOnly: false, ariaPath: "a.ts" }).lightbulb).toEqual({
      enabled: "off",
    });
    expect(buildEditorOptions({ readOnly: false, ariaPath: "a.ts" }).parameterHints).toEqual({
      enabled: false,
    });
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", codeActionsEnabled: false })
        .lightbulb,
    ).toEqual({ enabled: "off" });
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", signatureHelpEnabled: false })
        .parameterHints,
    ).toEqual({ enabled: false });
  });

  it("enables the lightbulb and parameter hints only for wired providers (#2104)", () => {
    const options = buildEditorOptions({
      readOnly: false,
      ariaPath: "a.ts",
      codeActionsEnabled: true,
      signatureHelpEnabled: true,
    });
    expect(options.lightbulb).toEqual({ enabled: "on" });
    expect(options.parameterHints).toEqual({ enabled: true });
    expect(options.codeLens).toBe(false);
    expect(options.minimap).toEqual({ enabled: false });
  });

  it("enables Monaco inlay-hint rendering only when the governed provider is wired", () => {
    expect(buildEditorOptions({ readOnly: false, ariaPath: "a.ts" }).inlayHints).toEqual({
      enabled: "off",
    });
    expect(
      buildEditorOptions({ readOnly: false, ariaPath: "a.ts", inlayHintsEnabled: true }).inlayHints,
    ).toEqual({ enabled: "on" });
  });

  it("keeps every other markdown-capable helper surface off even when hover is enabled (#1201)", () => {
    const withHover = buildEditorOptions({
      readOnly: false,
      ariaPath: "a.ts",
      hoverEnabled: true,
    });
    // Hover is the only markdown-rendering sink enabled; the rest stay off (ADR-0042 D3.7).
    expect(withHover.parameterHints).toEqual({ enabled: false });
    expect(withHover.links).toBe(false);
    expect(withHover.codeLens).toBe(false);
    expect(withHover.lightbulb).toEqual({ enabled: "off" });
    expect(withHover.inlayHints).toEqual({ enabled: "off" });
  });

  it("uses alt as the multi-cursor modifier", () => {
    expect(options.multiCursorModifier).toBe("alt");
  });

  it("disables the minimap (dense tool surface policy)", () => {
    expect(options.minimap).toEqual({ enabled: false });
  });

  it("keeps Monaco scrollbar gutters as narrow as the visible slider", () => {
    expect(options.scrollbar).toEqual({
      verticalScrollbarSize: 8,
      verticalSliderSize: 8,
      horizontalScrollbarSize: 8,
      horizontalSliderSize: 8,
      useShadows: false,
    });
  });

  it("disables Monaco's square diagnostic overview ruler for the rounded Keiko overlay", () => {
    expect(options.overviewRulerLanes).toBe(0);
    expect(options.overviewRulerBorder).toBe(false);
    expect(options.hideCursorInOverviewRuler).toBe(true);
    expect(options.renderValidationDecorations).toBe("on");
  });

  it("reflects the effective read-only flag", () => {
    expect(options.readOnly).toBe(false);
    expect(buildEditorOptions({ readOnly: true, ariaPath: "x" }).readOnly).toBe(true);
  });

  it("keeps domReadOnly false so selection/copy work even when read-only", () => {
    expect(options.domReadOnly).toBe(false);
    expect(buildEditorOptions({ readOnly: true, ariaPath: "x" }).domReadOnly).toBe(false);
  });

  it("derives an accessible aria label from the path", () => {
    expect(options.ariaLabel).toBe("Editor: src/app.ts");
  });

  it("uses a host-provided accessible aria label when supplied", () => {
    expect(
      buildEditorOptions({
        readOnly: false,
        ariaPath: "src/app.ts",
        ariaLabel: "Editor: src/app.ts in /repo",
      }).ariaLabel,
    ).toBe("Editor: src/app.ts in /repo");
  });

  it("sets accessibility support to auto", () => {
    expect(options.accessibilitySupport).toBe("auto");
  });

  it("renders whitespace only inside the selection", () => {
    expect(options.renderWhitespace).toBe("selection");
  });

  it("disables scroll beyond the last line", () => {
    expect(options.scrollBeyondLastLine).toBe(false);
  });

  it("uses a 2-space tab and word-wrap off", () => {
    expect(options.tabSize).toBe(2);
    expect(options.wordWrap).toBe("off");
  });

  it("applies server-resolved M7 preferences live through Monaco options", () => {
    const customized = buildEditorOptions({
      readOnly: false,
      ariaPath: "src/app.ts",
      preferences: {
        fontSize: 16,
        tabSize: 4,
        insertSpaces: false,
        wordWrap: "on",
        renderWhitespace: "all",
        minimap: true,
      },
    });
    expect(customized.fontSize).toBe(16);
    expect(customized.tabSize).toBe(4);
    expect(customized.insertSpaces).toBe(false);
    expect(customized.wordWrap).toBe("on");
    expect(customized.renderWhitespace).toBe("all");
    expect(customized.minimap).toEqual({ enabled: true });
  });

  it("engages Monaco large-file optimizations explicitly (ADR-0042 D3.6)", () => {
    expect(options.largeFileOptimizations).toBe(true);
  });
});

describe("buildEditorOptions large-file degraded mode (Issue #1207, ADR-0042 D3.6)", () => {
  const normal = buildEditorOptions({ readOnly: false, ariaPath: "src/app.ts" });
  const degraded = buildEditorOptions({ readOnly: false, ariaPath: "src/app.ts", degraded: true });

  it("keeps the rich rendering features on for a normal buffer", () => {
    expect(normal.bracketPairColorization).toEqual({ enabled: true });
    expect(normal.matchBrackets).toBe("always");
    expect(normal.folding).toBe(true);
    expect(normal.occurrencesHighlight).toBe("singleFile");
    expect(normal.renderWhitespace).toBe("selection");
  });

  it("disables the per-render/per-keystroke-expensive features in degraded mode", () => {
    expect(degraded.bracketPairColorization).toEqual({ enabled: false });
    expect(degraded.matchBrackets).toBe("never");
    expect(degraded.folding).toBe(false);
    expect(degraded.occurrencesHighlight).toBe("off");
    expect(degraded.renderWhitespace).toBe("none");
    expect(degraded.glyphMargin).toBe(false);
  });

  it("keeps degraded mode ceilings above user preferences", () => {
    const degradedWithPreferences = buildEditorOptions({
      readOnly: false,
      ariaPath: "src/app.ts",
      degraded: true,
      preferences: {
        fontSize: 16,
        tabSize: 4,
        insertSpaces: true,
        wordWrap: "on",
        renderWhitespace: "all",
        minimap: true,
      },
    });
    expect(degradedWithPreferences.renderWhitespace).toBe("none");
    expect(degradedWithPreferences.minimap).toEqual({ enabled: false });
    expect(degradedWithPreferences.wordWrap).toBe("on");
  });

  it("keeps large-file optimizations and core affordances on in degraded mode", () => {
    expect(degraded.largeFileOptimizations).toBe(true);
    expect(degraded.lineNumbers).toBe("on");
    expect(degraded.automaticLayout).toBe(true);
  });
});
