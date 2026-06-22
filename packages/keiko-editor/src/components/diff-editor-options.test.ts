import { describe, expect, it } from "vitest";

import { buildDiffEditorOptions } from "./diff-editor-options.js";

describe("buildDiffEditorOptions", () => {
  const options = buildDiffEditorOptions({ ariaLabel: "Diff: src/a.ts" });

  it("is read-only on both sides so a previewed patch cannot be mutated (AC1)", () => {
    expect(options.readOnly).toBe(true);
    expect(options.originalEditable).toBe(false);
  });

  it("renders a side-by-side diff with the overview ruler and no minimap", () => {
    expect(options.renderSideBySide).toBe(true);
    expect(options.renderOverviewRuler).toBe(true);
    expect(options.minimap).toEqual({ enabled: false });
  });

  it("shows whitespace-only changes honestly for review", () => {
    expect(options.ignoreTrimWhitespace).toBe(false);
  });

  it("carries the accessible label and standard editor fundamentals", () => {
    expect(options.ariaLabel).toBe("Diff: src/a.ts");
    expect(options.lineNumbers).toBe("on");
    expect(options.automaticLayout).toBe(true);
  });
});
