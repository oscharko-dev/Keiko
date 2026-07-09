import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WorkspaceSearchResponse } from "@oscharko-dev/keiko-contracts";
import {
  applyWorkspaceReplace,
  fetchFilesContent,
  fetchWorkspaceReplacePreview,
  fetchWorkspaceSearch,
  fetchWorkspaceSymbols,
} from "@/lib/api";
import { SearchPanel } from "./SearchPanel";
import {
  useRegisterWorkspaceReplaceBuffer,
  WorkspaceReplaceBufferProvider,
  type WorkspaceReplaceOpenBufferApply,
} from "../../WorkspaceReplaceBufferContext";

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
  default: ({ onApply }: { readonly onApply?: (() => void) | undefined }) => (
    <div data-testid="replace-diff">
      <button type="button" onClick={onApply}>
        Diff apply
      </button>
    </div>
  ),
}));

const applyWorkspaceReplaceMock = vi.mocked(applyWorkspaceReplace);
const fetchFilesContentMock = vi.mocked(fetchFilesContent);
const fetchWorkspaceReplacePreviewMock = vi.mocked(fetchWorkspaceReplacePreview);
const fetchWorkspaceSearchMock = vi.mocked(fetchWorkspaceSearch);
const fetchWorkspaceSymbolsMock = vi.mocked(fetchWorkspaceSymbols);

const populatedResponse: WorkspaceSearchResponse = {
  results: [
    {
      path: "src/app.ts",
      lineRange: { startLine: 4, endLine: 4 },
      snippet: "const needle = true;",
      score: 0.98,
    },
    {
      path: "src/app.ts",
      lineRange: { startLine: 8, endLine: 8 },
      snippet: "return needle;",
      score: 0.92,
    },
    {
      path: "test/app.test.ts",
      lineRange: { startLine: 12, endLine: 13 },
      snippet: "expect(needle).toBe(true);",
      score: 0.86,
    },
  ],
  truncated: true,
  filesScanned: 6,
  elapsedMs: 14,
};

function renderPanel(openEditorFile = vi.fn()): ReturnType<typeof render> {
  return render(<SearchPanel root="/repo" openEditorFile={openEditorFile} />);
}

function FakeOpenBuffer({ apply }: { readonly apply: WorkspaceReplaceOpenBufferApply }): ReactNode {
  useRegisterWorkspaceReplaceBuffer("/repo", "src/app.ts", apply);
  return null;
}

async function searchFor(query: string): Promise<void> {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search files and symbols" }), {
    target: { value: query },
  });
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 260)));
}

describe("SearchPanel", () => {
  beforeEach(() => {
    fetchWorkspaceSearchMock.mockResolvedValue({
      results: [],
      truncated: false,
      filesScanned: 0,
      elapsedMs: 1,
    });
    fetchWorkspaceSymbolsMock.mockResolvedValue({
      results: [
        {
          symbol: "parseConfig",
          kind: "function",
          path: "src/app.ts",
          line: 7,
          score: 1,
        },
      ],
      truncated: false,
      filesScanned: 2,
      elapsedMs: 5,
    });
    fetchWorkspaceReplacePreviewMock.mockResolvedValue({
      files: [
        {
          path: "src/app.ts",
          baseContentHash: "a".repeat(64),
          edits: [
            {
              range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 13 },
              originalText: "needle",
              newText: "thread",
            },
          ],
        },
      ],
      fileCount: 1,
      editCount: 1,
      truncated: false,
      omittedFileCount: 0,
    });
    fetchFilesContentMock.mockResolvedValue({
      root: "/repo",
      path: "src/app.ts",
      name: "app.ts",
      mime: "text/typescript",
      symlink: false,
      content: "const needle = true;\n",
      sizeBytes: 21,
      modifiedAt: 1,
      maxBytes: 262_144,
      extension: ".ts",
      session: {
        schemaVersion: "1",
        version: { sizeBytes: 21, modifiedAt: 1, contentHash: "b".repeat(64) },
      },
    });
    applyWorkspaceReplaceMock.mockResolvedValue({
      appliedCount: 1,
      conflictCount: 0,
      conflicts: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders an interactive searchbox instead of the previous placeholder", () => {
    renderPanel();
    expect(screen.getByRole("searchbox", { name: "Search files and symbols" })).toBeEnabled();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it("debounces non-empty queries and posts to the workspace-search route wrapper", async () => {
    renderPanel();
    await searchFor("needle");

    await waitFor(() => expect(fetchWorkspaceSearchMock).toHaveBeenCalledTimes(1));
    expect(fetchWorkspaceSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        query: "needle",
        mode: "literal",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends regex, case, include, and exclude options with the request", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    fireEvent.click(screen.getByLabelText("Case sensitive"));
    fireEvent.change(screen.getByLabelText("Include glob"), { target: { value: "src/**/*.ts" } });
    fireEvent.change(screen.getByLabelText("Exclude glob"), { target: { value: "dist/**" } });

    await searchFor("needle.*");

    await waitFor(() => expect(fetchWorkspaceSearchMock).toHaveBeenCalledTimes(1));
    expect(fetchWorkspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "regex",
        caseSensitive: true,
        includeGlobs: ["src/**/*.ts"],
        excludeGlobs: ["dist/**"],
      }),
      expect.anything(),
    );
  });

  it("clearing glob fields returns to unfiltered requests for the same query", async () => {
    renderPanel();
    const include = screen.getByLabelText("Include glob");
    const exclude = screen.getByLabelText("Exclude glob");
    fireEvent.change(include, { target: { value: "src/**" } });
    fireEvent.change(exclude, { target: { value: "dist/**" } });
    await searchFor("needle");
    fireEvent.change(include, { target: { value: "" } });
    fireEvent.change(exclude, { target: { value: "" } });
    const searchbox = screen.getByRole("searchbox", { name: "Search files and symbols" });
    fireEvent.submit(searchbox.closest("form") as HTMLFormElement);

    await waitFor(() => expect(fetchWorkspaceSearchMock).toHaveBeenCalledTimes(2));
    expect(fetchWorkspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeGlobs: [], excludeGlobs: [] }),
      undefined,
    );
  });

  it("shows a clear inline error for invalid regex without calling the route", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    await searchFor("[");

    expect(screen.getByRole("status")).toHaveTextContent("regular expression is not valid");
    expect(fetchWorkspaceSearchMock).not.toHaveBeenCalled();
  });

  it("renders loading, zero-result, populated, and route-error states", async () => {
    let resolveSearch: ((value: WorkspaceSearchResponse) => void) | undefined;
    fetchWorkspaceSearchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    renderPanel();
    await searchFor("needle");
    expect(screen.getByRole("status")).toHaveTextContent("Searching workspace");

    await act(async () => resolveSearch?.(populatedResponse));
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Results were capped");

    fetchWorkspaceSearchMock.mockResolvedValueOnce({
      results: [],
      truncated: false,
      filesScanned: 2,
      elapsedMs: 3,
    });
    await searchFor("missing");
    await screen.findByText("No matching files found.");

    fetchWorkspaceSearchMock.mockRejectedValueOnce(new Error("Search route unavailable."));
    await searchFor("broken");
    await screen.findByText("Search route unavailable.");
  });

  it("groups results by file and opens matches at the exact line", async () => {
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    fetchWorkspaceSearchMock.mockResolvedValue(populatedResponse);
    renderPanel(openEditorFile);
    await searchFor("needle");

    expect(screen.getAllByText("src/app.ts")).toHaveLength(1);
    fireEvent.click(screen.getByText("return needle;"));

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/app.ts",
      lineStart: 8,
      lineEnd: 8,
    });
  });

  it("supports roving keyboard navigation and Enter-to-open", async () => {
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    fetchWorkspaceSearchMock.mockResolvedValue(populatedResponse);
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    renderPanel(openEditorFile);
    await searchFor("needle");

    const listbox = screen.getByRole("listbox", { name: "Workspace search results" });
    const options = within(listbox).getAllByRole("option");
    options[0]?.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/app.ts",
      lineStart: 8,
      lineEnd: 8,
    });
    rafSpy.mockRestore();
  });

  it("previews replace as a diff before explicit apply", async () => {
    renderPanel();
    await searchFor("needle");
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "thread" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview replace" }));
    await screen.findByTestId("replace-diff");

    expect(fetchWorkspaceReplacePreviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/repo", query: "needle", replacement: "thread" }),
    );
    expect(applyWorkspaceReplaceMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed replace" }));
    await waitFor(() => expect(applyWorkspaceReplaceMock).toHaveBeenCalledTimes(1));
    expect(applyWorkspaceReplaceMock).toHaveBeenCalledWith({
      root: "/repo",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "src/app.ts", baseContentHash: "a".repeat(64) }),
      ]),
    });
  });

  it("surfaces replace preview failures without keeping a stale diff", async () => {
    fetchWorkspaceReplacePreviewMock.mockRejectedValueOnce(new Error("Replace preview denied."));
    renderPanel();
    await searchFor("needle");
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "thread" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview replace" }));

    await screen.findByText("Replace preview denied.");
    expect(screen.queryByTestId("replace-diff")).toBeNull();
  });

  it("surfaces structured replace apply conflicts by file", async () => {
    applyWorkspaceReplaceMock.mockResolvedValueOnce({
      appliedCount: 0,
      conflictCount: 1,
      conflicts: [
        {
          path: "src/app.ts",
          reason: "write-conflict",
          detail: "content changed after preview",
        },
      ],
    });
    renderPanel();
    await searchFor("needle");
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace" }));
    await screen.findByTestId("replace-diff");

    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed replace" }));

    await screen.findByText(
      "0 files applied. 1 files reported conflicts. Conflicts: src/app.ts (write-conflict).",
    );
  });

  it("surfaces replace apply route failures", async () => {
    applyWorkspaceReplaceMock.mockRejectedValueOnce(new Error("Replace apply unavailable."));
    renderPanel();
    await searchFor("needle");
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace" }));
    await screen.findByTestId("replace-diff");

    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed replace" }));

    await screen.findByText("Replace apply unavailable.");
  });

  it("applies reviewed replacements to open buffers before writing closed files", async () => {
    const openApply = vi.fn<WorkspaceReplaceOpenBufferApply>(() => ({
      status: "applied",
      path: "src/app.ts",
    }));
    fetchWorkspaceReplacePreviewMock.mockResolvedValue({
      files: [
        {
          path: "src/app.ts",
          baseContentHash: "a".repeat(64),
          edits: [
            {
              range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 13 },
              originalText: "needle",
              newText: "thread",
            },
          ],
        },
        {
          path: "src/closed.ts",
          baseContentHash: "c".repeat(64),
          edits: [
            {
              range: { startLine: 1, startColumn: 8, endLine: 1, endColumn: 14 },
              originalText: "needle",
              newText: "thread",
            },
          ],
        },
      ],
      fileCount: 2,
      editCount: 2,
      truncated: false,
      omittedFileCount: 0,
    });
    fetchFilesContentMock.mockImplementation((_root, path) =>
      Promise.resolve({
        root: "/repo",
        path,
        name: path.split("/").at(-1) ?? path,
        mime: "text/typescript",
        symlink: false,
        content: "const needle = true;\n",
        sizeBytes: 21,
        modifiedAt: 1,
        maxBytes: 262_144,
        extension: ".ts",
        session: {
          schemaVersion: "1",
          version: { sizeBytes: 21, modifiedAt: 1, contentHash: "b".repeat(64) },
        },
      }),
    );
    applyWorkspaceReplaceMock.mockResolvedValue({
      appliedCount: 1,
      conflictCount: 0,
      conflicts: [],
    });
    render(
      <WorkspaceReplaceBufferProvider>
        <FakeOpenBuffer apply={openApply} />
        <SearchPanel root="/repo" openEditorFile={vi.fn()} />
      </WorkspaceReplaceBufferProvider>,
    );
    await searchFor("needle");
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace" }));
    await screen.findByTestId("replace-diff");

    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed replace" }));

    await waitFor(() => expect(openApply).toHaveBeenCalledTimes(1));
    expect(applyWorkspaceReplaceMock).toHaveBeenCalledWith({
      root: "/repo",
      files: [expect.objectContaining({ path: "src/closed.ts" })],
    });
    await screen.findByText("2 files applied.");
  });

  it("searches workspace symbols and opens declarations through the existing result list", async () => {
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    renderPanel(openEditorFile);
    fireEvent.click(screen.getByRole("button", { name: "Symbols" }));
    await searchFor("parseConfig");
    await screen.findByText("function parseConfig");

    expect(fetchWorkspaceSymbolsMock).toHaveBeenCalledWith(
      { root: "/repo", query: "parseConfig", maxResults: expect.any(Number) },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.click(screen.getByText("function parseConfig"));
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/app.ts",
      lineStart: 7,
      lineEnd: 7,
    });
  });
});
