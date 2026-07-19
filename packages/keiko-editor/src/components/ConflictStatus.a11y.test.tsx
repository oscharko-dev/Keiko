// @vitest-environment jsdom
import "../../vitest.setup";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EditorStatusBar } from "./EditorStatusBar.js";
import { deriveEditorStatusBar } from "./status-bar.js";

describe("merge-conflict accessibility", () => {
  it("exposes the conflict count through the polite status region without conflating save state", () => {
    const view = deriveEditorStatusBar({
      languageId: "typescript",
      cursor: null,
      saveStatus: "saved",
      dirty: false,
      completionsEnabled: false,
      diagnostics: null,
      mergeConflicts: {
        count: 2,
        truncated: false,
        label: "2 conflicts",
        ariaLabel: "2 merge conflicts",
      },
    });
    const rendered = render(<EditorStatusBar viewModel={view} />);
    const live = rendered.getByTestId("editor-status-bar-live");
    const alert = rendered.getByTestId("editor-status-bar-alert");

    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("aria-atomic", "true");
    expect(live).toHaveTextContent("2 merge conflicts");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toBeEmptyDOMElement();
  });
});
