import { EditorStatusBar, deriveEditorStatusBar } from "@oscharko-dev/keiko-editor";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

describe("editor conflict status accessibility", () => {
  it("keeps the merge-conflict live regions axe-clean in the UI host", async () => {
    const viewModel = deriveEditorStatusBar({
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
    const { container } = render(<EditorStatusBar viewModel={viewModel} />);

    expect((await axe(container)).violations).toEqual([]);
  });
});
