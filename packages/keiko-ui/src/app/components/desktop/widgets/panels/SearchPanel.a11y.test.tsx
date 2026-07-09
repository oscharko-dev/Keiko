import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWorkspaceSearch } from "@/lib/api";
import { SearchPanel } from "./SearchPanel";

vi.mock("@/lib/api", () => ({
  applyWorkspaceReplace: vi.fn(),
  fetchFilesContent: vi.fn(),
  fetchWorkspaceReplacePreview: vi.fn(),
  fetchWorkspaceSearch: vi.fn(),
  fetchWorkspaceSymbols: vi.fn(),
}));

vi.mock("../cards/EditorDiffSurface", () => ({
  buildWorkspaceReplacePatchModel: (response: {
    readonly files: readonly { readonly path: string }[];
    readonly fileCount: number;
    readonly omittedFileCount: number;
    readonly truncated: boolean;
  }) => ({
    patchId: "workspace-replace-preview",
    status: "previewed",
    provenance: { origin: "applied-patch" },
    files: response.files.map((file) => ({
      uri: file.path,
      displayPath: file.path,
      status: "modified",
      diffable: true,
      original: "before",
      modified: "after",
      language: "typescript",
      hasChanges: true,
      truncated: false,
    })),
    fileCount: response.files.length,
    totalFileCount: response.fileCount + response.omittedFileCount,
    omittedFileCount: response.omittedFileCount,
    createdCount: 0,
    modifiedCount: response.files.length,
    deletedCount: 0,
    binaryCount: 0,
    unsupportedCount: 0,
    truncated: response.truncated,
  }),
  default: () => <div data-testid="replace-diff" />,
}));

describe("SearchPanel a11y", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkspaceSearch).mockResolvedValue({
      results: [
        {
          path: "src/app.ts",
          lineRange: { startLine: 3, endLine: 3 },
          snippet: "const needle = true;",
          score: 0.9,
        },
        {
          path: "test/app.test.ts",
          lineRange: { startLine: 7, endLine: 8 },
          snippet: "expect(needle).toBe(true);",
          score: 0.8,
        },
      ],
      truncated: false,
      filesScanned: 2,
      elapsedMs: 4,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has no axe violations in the empty initial state", async () => {
    const { container } = render(<SearchPanel root="/repo" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations with populated multi-file results", async () => {
    const { container } = render(<SearchPanel root="/repo" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search files and symbols" }), {
      target: { value: "needle" },
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 260)));
    await screen.findByText("test/app.test.ts");

    expect(await axe(container)).toHaveNoViolations();
  });
});
