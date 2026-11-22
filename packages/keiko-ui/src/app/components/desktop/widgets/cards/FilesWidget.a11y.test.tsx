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

// The words axe compares: letters and numbers, case-folded. A screen-reader-only description is
// not visible text.
function nameWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

function visibleText(row: HTMLElement): string {
  const copy = row.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[id$="-git-label"]')) hidden.remove();
  return copy.textContent;
}

// The rows name themselves through aria-label or aria-labelledby; the referenced elements carry
// plain text, so their text is their name.
function accessibleName(row: HTMLElement): string {
  const label = row.getAttribute("aria-label");
  if (label !== null) return label;
  return (row.getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function expectNameStartsWithVisibleText(row: HTMLElement): void {
  const visible = nameWords(visibleText(row));
  const name = nameWords(accessibleName(row));
  expect(name.slice(0, visible.length)).toEqual(visible);
}

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
          extension: null,
          readable: true,
        },
        {
          name: "conflicted.ts",
          path: "conflicted.ts",
          kind: "file",
          sizeBytes: 1,
          modifiedAt: 1,
          extension: "ts",
          readable: true,
        },
        {
          name: "ignored.log",
          path: "ignored.log",
          kind: "file",
          sizeBytes: 1,
          modifiedAt: 1,
          extension: "log",
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

    // WCAG 2.5.3 (axe 4.14 `label-content-name-mismatch`, serious): the accessible name starts
    // with the row's visible text, in reading order; the Git state and visibility follow it.
    const conflicted = await screen.findByRole("treeitem", {
      name: "conflicted.ts U 1 B Git conflict: conflicted.ts",
    });
    expect(screen.getByRole("treeitem", { name: "ignored.log 1 B Ignored by Git" })).toBeEnabled();
    const folder = screen.getByRole("treeitem", { name: "src Δ Folder contains 1 Git changes" });
    for (const row of [conflicted, folder, ...screen.getAllByRole("treeitem")]) {
      expectNameStartsWithVisibleText(row);
    }
    expect(
      screen.getByText("Git decorations incomplete: showing only the first 500 changes."),
    ).toBeInTheDocument();

    const diffButton = screen.getByRole("button", {
      name: "View Git diff for conflicted.ts",
    });
    expect(diffButton.closest('[role="treeitem"]')).not.toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
