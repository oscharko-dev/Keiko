import { describe, expect, it, vi } from "vitest";

import { wireDiffEditorOnMount, type MountDiffEditor, type MountDiffMonaco } from "./diff-mount.js";

function fakeEditor(goToDiff: (target: "next" | "previous") => void): MountDiffEditor {
  return {
    getContainerDomNode: (): HTMLElement => document.createElement("div"),
    goToDiff,
  };
}

const fakeMonaco: MountDiffMonaco = { editor: { defineTheme: vi.fn() } };

describe("wireDiffEditorOnMount", () => {
  it("navigates to the next hunk via Monaco's goToDiff", () => {
    const goToDiff = vi.fn();
    const controller = wireDiffEditorOnMount({
      editor: fakeEditor(goToDiff),
      monaco: fakeMonaco,
      themeVariant: "dark",
    });
    controller.goToNextDiff();
    expect(goToDiff).toHaveBeenCalledWith("next");
  });

  it("navigates to the previous hunk via Monaco's goToDiff", () => {
    const goToDiff = vi.fn();
    const controller = wireDiffEditorOnMount({
      editor: fakeEditor(goToDiff),
      monaco: fakeMonaco,
      themeVariant: "dark",
    });
    controller.goToPreviousDiff();
    expect(goToDiff).toHaveBeenCalledWith("previous");
  });

  it("reports a theme-registration failure through onThemeError but still returns a controller", () => {
    // jsdom exposes no --ed-* design tokens, so resolveEditorThemeTokensFromDom throws; the mount
    // must surface that as a non-fatal error and keep working (Monaco's base theme renders).
    const onThemeError = vi.fn();
    const controller = wireDiffEditorOnMount({
      editor: fakeEditor(vi.fn()),
      monaco: fakeMonaco,
      themeVariant: "dark",
      onThemeError,
    });
    expect(onThemeError).toHaveBeenCalled();
    expect(typeof controller.goToNextDiff).toBe("function");
  });
});
