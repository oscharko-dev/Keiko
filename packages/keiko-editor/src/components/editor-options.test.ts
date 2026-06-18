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
