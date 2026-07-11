// @vitest-environment jsdom
import "../../vitest.setup";

import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { EditorStatusBar } from "./EditorStatusBar.js";
import { deriveEditorStatusBar } from "./status-bar.js";

describe("merge-conflict accessibility", () => {
  it("exposes the conflict count through the polite status region without conflating save state", async () => {
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

    expect(rendered.getByTestId("editor-status-bar-live")).toHaveTextContent("2 merge conflicts");
    expect(rendered.getByTestId("editor-status-bar-alert")).toHaveTextContent("");
    expect((await axe(rendered.container)).violations).toEqual([]);
  });
});
