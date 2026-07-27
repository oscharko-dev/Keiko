import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchFilesTree, fetchGitStatus } from "../../../../../lib/api";
import { FilesWidget } from "./FilesWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchFilesTree: vi.fn(),
    fetchGitStatus: vi.fn(),
  };
});

describe("FilesWidget Git decoration accessibility", () => {
  afterEach(() => vi.clearAllMocks());

  it("is axe-clean with conflict, folder, ignored, and incomplete affordances", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValue({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        {
          name: "src",
          path: "src",
          kind: "directory",
          sizeBytes: 0,
          modifiedAt: 1,
          extension: null,
          symlink: false,
          readable: true,
        },
        {
          name: "conflicted.ts",
          path: "conflicted.ts",
          kind: "file",
          sizeBytes: 1,
          modifiedAt: 1,
          extension: "ts",
          symlink: false,
          readable: true,
        },
        {
          name: "ignored.log",
          path: "ignored.log",
          kind: "file",
          sizeBytes: 1,
          modifiedAt: 1,
          extension: "log",
          symlink: false,
          readable: true,
        },
      ],
    });
    vi.mocked(fetchGitStatus).mockResolvedValue({
      schemaVersion: "1",
      root: "/repo",
      repositoryRoot: "/repo",
      state: "available",
      available: true,
      branch: "main",
      detached: false,
      clean: false,
      stagedCount: 0,
      unstagedCount: 2,
      untrackedCount: 0,
      conflictedCount: 1,
      changes: [
        {
          path: "conflicted.ts",
          indexStatus: "U",
          worktreeStatus: "U",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: true,
        },
        {
          path: "src/deep.ts",
          indexStatus: " ",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
        },
        {
          path: "ignored.log",
          indexStatus: "!",
          worktreeStatus: "!",
          staged: false,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
      ],
      truncated: true,
      maxChanges: 500,
    });

    const { container } = render(<FilesWidget root="/repo" openFilesDirectly />);

    await screen.findByLabelText("Git conflict: conflicted.ts");
    expect(screen.getByRole("treeitem", { name: "ignored.log, Ignored by Git" })).toBeEnabled();
    expect(screen.getByLabelText("Folder contains 1 Git changes")).toBeInTheDocument();
    expect(
      screen.getByText("Git decorations incomplete: showing only the first 500 changes."),
    ).toBeInTheDocument();

    // This scan is the ONE place aria-required-children stays disabled, and only for what this
    // fixture adds: a git-decorated row renders `button.tr-git-diff` as a SIBLING of its treeitem,
    // and role="tree" may own only treeitem and group. #2605 covered the caret and the root-level
    // chrome, both fixed and now asserted with the rule enabled in FilesWidget.test.tsx and
    // MultiRootFilesWidget.a11y.test.tsx. Moving a per-row control inside its treeitem means
    // relocating role="treeitem" from `button.tr-row` onto the row wrapper, which changes the
    // accessible name and focus target of ~107 locators across 17 unit and e2e files; that is a
    // separate structural change, not this fixture's. Narrow the disable to the rule, never widen.
    const options = { rules: { "aria-required-children": { enabled: false } } } as const;
    expect(await axe(container, options)).toHaveNoViolations();
  });
});
