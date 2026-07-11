import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { EditorGitHunkPeek } from "./EditorGitHunkPeek";

const PEEK = {
  layer: "unstaged" as const,
  hunk: {
    header: "@@ -1,1 +1,1 @@",
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    lines: [{ kind: "add" as const, text: "const value = 1;", oldLine: null, newLine: 1 }],
    truncated: false,
  },
};

const LABELS = {
  close: "Close change preview",
  staged: "Staged change",
  unstaged: "Unstaged change",
  title: "Change preview",
  truncated: "This hunk was truncated.",
  hunkHeader: "Hunk header",
  addedLine: "Added line",
  deletedLine: "Deleted line",
  contextLine: "Context line",
  metadataLine: "Diff metadata",
};

describe("EditorGitHunkPeek accessibility", () => {
  it("is axe-clean, focuses its dismiss control, and dismisses with Escape", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <EditorGitHunkPeek path="src/a.ts" peek={PEEK} labels={LABELS} onClose={onClose} />,
    );

    const close = screen.getByRole("button", { name: LABELS.close });
    expect(close).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Change preview: src/a.ts, Unstaged change",
    );
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
