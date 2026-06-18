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

  it("disables Monaco hover, suggest, and markdown-capable helper surfaces", () => {
    expect(options.hover).toEqual({ enabled: false });
    expect(options.quickSuggestions).toBe(false);
    expect(options.quickSuggestionsDelay).toBe(0);
    expect(options.suggestOnTriggerCharacters).toBe(false);
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
      showIcons: false,
      showMethods: false,
      showFunctions: false,
      showKeywords: false,
      showWords: false,
      showSnippets: false,
    });
    expect(options.links).toBe(false);
    expect(options.colorDecorators).toBe(false);
    expect(options.codeLens).toBe(false);
    expect(options.lightbulb).toEqual({ enabled: "off" });
    expect(options.inlayHints).toEqual({ enabled: "off" });
  });

  it("uses alt as the multi-cursor modifier", () => {
    expect(options.multiCursorModifier).toBe("alt");
  });

  it("disables the minimap (dense tool surface policy)", () => {
    expect(options.minimap).toEqual({ enabled: false });
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
});
