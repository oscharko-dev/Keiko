import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EditorStatusBar } from "./EditorStatusBar.js";
import { deriveEditorStatusBar, type EditorStatusBarInput } from "./status-bar.js";

function renderBar(overrides: Partial<EditorStatusBarInput> = {}): HTMLElement {
  const viewModel = deriveEditorStatusBar({
    languageId: "typescript",
    cursor: { line: 0, column: 0 },
    saveStatus: "idle",
    dirty: false,
    completionsEnabled: true,
    diagnostics: { errors: 0, warnings: 0, infos: 0 },
    ...overrides,
  });
  render(<EditorStatusBar viewModel={viewModel} />);
  return screen.getByTestId("editor-status-bar");
}

describe("EditorStatusBar", () => {
  it("is a labelled group of status fields", () => {
    const bar = renderBar();
    expect(bar).toHaveAttribute("role", "group");
    expect(bar).toHaveAttribute("aria-label", "Editor status");
    expect(within(bar).getByLabelText("Language: TypeScript")).toBeInTheDocument();
  });

  it("renders a single polite live region carrying only meaningful state", () => {
    renderBar({ dirty: true, diagnostics: { errors: 1, warnings: 0, infos: 0 } });
    const live = screen.getByTestId("editor-status-bar-live");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Unsaved changes");
    expect(live).toHaveTextContent("Problems: 1 error");
    // The cursor position must never reach the announced live region (it changes per keystroke).
    expect(live).not.toHaveTextContent("Line 1");
  });

  it("labels the cursor field for on-demand reading without a live region", () => {
    const bar = renderBar({ cursor: { line: 4, column: 2 } });
    const cursor = within(bar).getByLabelText("Line 5, column 3");
    expect(cursor).toHaveAttribute("data-field", "cursor");
    expect(cursor.closest("[aria-live]")).toBeNull();
  });

  it("applies a tone class to error-level fields", () => {
    const bar = renderBar({ diagnostics: { errors: 3, warnings: 0, infos: 0 } });
    const problems = within(bar).getByLabelText("Problems: 3 errors");
    expect(problems).toHaveClass("ed-sb-error");
  });

  it("announces a save conflict in the assertive alert region, not the polite one", () => {
    renderBar({ saveStatus: "conflict" });
    const alert = screen.getByTestId("editor-status-bar-alert");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("Save conflict");
    // The polite region must not also carry the critical conflict (no double announcement).
    expect(screen.getByTestId("editor-status-bar-live")).not.toHaveTextContent("Save conflict");
  });

  it("keeps the alert region empty for a clean save", () => {
    renderBar();
    expect(screen.getByTestId("editor-status-bar-alert")).toBeEmptyDOMElement();
  });
});
