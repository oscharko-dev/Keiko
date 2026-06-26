import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchFilesPreview,
  fetchFilesTree,
  fetchProjects,
  updateChatConnectedScopes,
} from "../../../../../lib/api";
import type { Chat } from "../../../../../lib/types";
import { ChatSessionProvider } from "../../context/ChatSessionContext";
import type { ChatSessionApi } from "../../hooks/useChatSession";
import { FilePreview } from "./FilePreview";
import { FilesWidget } from "./FilesWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchFilesPreview: vi.fn(),
    fetchProjects: vi.fn(),
    fetchFilesTree: vi.fn(),
    updateChatConnectedScopes: vi.fn(),
  };
});

const treeEntryBase = {
  sizeBytes: 0,
  modifiedAt: 1,
  extension: null,
  symlink: false,
  readable: true,
};

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: makeChat(),
    selectedModel: "example-chat-model",
    noEligibleModels: false,
    draft: "",
    loading: false,
    sending: false,
    sendStatus: "idle",
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    budget: undefined,
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    clearHistory: vi.fn(),
    lastSentDocuments: [],
    ...overrides,
  };
}

function renderWithSession(ui: ReactElement, session = makeSession()): ChatSessionApi {
  render(<ChatSessionProvider value={session}>{ui}</ChatSessionProvider>);
  return session;
}

describe("FilesWidget", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the root tree and opens a text preview on file click", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo space",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        {
          ...treeEntryBase,
          name: "package.json",
          path: "package.json",
          kind: "file",
          sizeBytes: 18,
          extension: "json",
        },
      ],
    });
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo space",
      path: "package.json",
      name: "package.json",
      sizeBytes: 18,
      modifiedAt: 1,
      extension: "json",
      mime: "application/json",
      symlink: false,
      kind: "text",
      content: '{"name":"keiko"}\n',
      truncated: false,
      maxBytes: 1_000_000,
    });

    const onActiveFileChange = vi.fn();
    render(<FilesWidget root="/repo space" onActiveFileChange={onActiveFileChange} />);

    expect(await screen.findByText("package.json")).toBeInTheDocument();
    expect(fetchFilesTree).toHaveBeenCalledWith("/repo space", "");
    expect(onActiveFileChange).toHaveBeenCalledWith(null, "/repo space", null);

    // tree rows expose ARIA tree semantics (role=treeitem) since audit C143
    await userEvent.click(screen.getByRole("treeitem", { name: /package\.json/i }));

    await waitFor(() =>
      expect(fetchFilesPreview).toHaveBeenCalledWith("/repo space", "package.json"),
    );
    expect(onActiveFileChange).toHaveBeenCalledWith("package.json", "/repo space");
    expect(await screen.findByText('"keiko"')).toBeInTheDocument();
  });

  it("opens the previewed file in the editor on demand", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo space",
      path: "",
      truncated: false,
      entries: [
        {
          ...treeEntryBase,
          name: "package.json",
          path: "package.json",
          kind: "file",
          sizeBytes: 18,
          extension: "json",
        },
      ],
    });
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo space",
      path: "package.json",
      name: "package.json",
      sizeBytes: 18,
      modifiedAt: 1,
      extension: "json",
      mime: "application/json",
      symlink: false,
      kind: "text",
      content: '{"name":"keiko"}\n',
      truncated: false,
      maxBytes: 1_000_000,
    });

    const onOpenFile = vi.fn();
    render(<FilesWidget root="/repo space" onOpenFile={onOpenFile} />);

    await userEvent.click(await screen.findByRole("treeitem", { name: /package\.json/i }));
    await screen.findByText('"keiko"');
    await userEvent.click(screen.getByRole("button", { name: "Open in editor" }));

    expect(onOpenFile).toHaveBeenCalledWith("/repo space", "package.json");
  });

  it("opens a file directly when embedded in the editor workspace", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo space",
      path: "",
      truncated: false,
      entries: [
        {
          ...treeEntryBase,
          name: "package.json",
          path: "package.json",
          kind: "file",
          sizeBytes: 18,
          extension: "json",
        },
      ],
    });
    const onOpenFile = vi.fn();

    render(
      <FilesWidget root="/repo space" openFilesDirectly activeFilePath="" onOpenFile={onOpenFile} />,
    );

    await userEvent.click(await screen.findByRole("treeitem", { name: /package\.json/i }));

    expect(fetchFilesPreview).not.toHaveBeenCalled();
    expect(onOpenFile).toHaveBeenCalledWith("/repo space", "package.json");
    expect(screen.queryByText('"keiko"')).toBeNull();
  });

  it("does not offer editor launch for unsupported previews", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo space",
      path: "",
      truncated: false,
      entries: [
        {
          ...treeEntryBase,
          name: "archive.bin",
          path: "archive.bin",
          kind: "file",
          sizeBytes: 6,
          extension: "bin",
        },
      ],
    });
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo space",
      path: "archive.bin",
      name: "archive.bin",
      sizeBytes: 6,
      modifiedAt: 1,
      extension: "bin",
      mime: "application/octet-stream",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    const onOpenFile = vi.fn();
    render(<FilesWidget root="/repo space" onOpenFile={onOpenFile} />);

    await userEvent.click(await screen.findByRole("treeitem", { name: /archive\.bin/i }));
    await screen.findByText(/no safe text or image preview/i);

    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("does not render direct repository scope buttons from the Files window", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/resolved-repo",
      path: "",
      truncated: false,
      entries: [],
    });
    const session = renderWithSession(<FilesWidget root="/configured-repo" />);

    await screen.findByText("Empty folder.");

    expect(screen.queryByRole("button", { name: "Connect repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update connected scope" })).toBeNull();
    expect(updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(session.replaceChat).not.toHaveBeenCalled();
  });

  it("enters a readable folder from the folder name and reports it as the visible scope", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/resolved-repo",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        { ...treeEntryBase, name: "package.json", path: "package.json", kind: "file" },
      ],
    });
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/resolved-repo",
      path: "src",
      truncated: false,
      entries: [{ ...treeEntryBase, name: "inside.ts", path: "src/inside.ts", kind: "file" }],
    });
    const onActiveFileChange = vi.fn();
    const session = renderWithSession(
      <FilesWidget
        root="/configured-repo"
        onRootChange={() => undefined}
        onActiveFileChange={onActiveFileChange}
      />,
    );

    const srcRow = await screen.findByRole("treeitem", { name: /^src$/i });
    expect(screen.queryByRole("button", { name: "Connect folder: src" })).toBeNull();
    await userEvent.click(srcRow);

    await waitFor(() => {
      expect(fetchFilesTree).toHaveBeenCalledWith("/configured-repo", "src");
    });
    expect(await screen.findByRole("treeitem", { name: /inside\.ts/i })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /package\.json/i })).toBeNull();
    expect(screen.getByLabelText("Folder path — open any folder on this machine")).toHaveValue(
      "/resolved-repo/src",
    );
    expect(onActiveFileChange).toHaveBeenCalledWith(null, "/resolved-repo", "src");
    expect(updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(session.replaceChat).not.toHaveBeenCalled();
  });

  it("refreshes the current folder without jumping back to the root", async () => {
    vi.mocked(fetchFilesTree)
      .mockResolvedValueOnce({
        root: "/resolved-repo",
        path: "",
        truncated: false,
        entries: [
          { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
          { ...treeEntryBase, name: "package.json", path: "package.json", kind: "file" },
        ],
      })
      .mockResolvedValueOnce({
        root: "/resolved-repo",
        path: "src",
        truncated: false,
        entries: [{ ...treeEntryBase, name: "inside.ts", path: "src/inside.ts", kind: "file" }],
      })
      .mockResolvedValueOnce({
        root: "/resolved-repo",
        path: "src",
        truncated: false,
        entries: [
          { ...treeEntryBase, name: "inside.ts", path: "src/inside.ts", kind: "file" },
          { ...treeEntryBase, name: "new.ts", path: "src/new.ts", kind: "file" },
        ],
      });
    const onActiveFileChange = vi.fn();
    render(
      <FilesWidget
        root="/configured-repo"
        onRootChange={() => undefined}
        onActiveFileChange={onActiveFileChange}
      />,
    );

    await userEvent.click(await screen.findByRole("treeitem", { name: /^src$/i }));
    expect(await screen.findByRole("treeitem", { name: /inside\.ts/i })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /package\.json/i })).toBeNull();
    onActiveFileChange.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Refresh folder" }));

    await waitFor(() => {
      expect(fetchFilesTree).toHaveBeenLastCalledWith("/configured-repo", "src");
    });
    expect(await screen.findByRole("treeitem", { name: /new\.ts/i })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /package\.json/i })).toBeNull();
    expect(screen.getByLabelText("Folder path — open any folder on this machine")).toHaveValue(
      "/resolved-repo/src",
    );
    expect(onActiveFileChange).not.toHaveBeenCalledWith(null, "/resolved-repo", null);
  });

  it("expands a folder from the caret without changing the chat-visible folder scope", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/resolved-repo",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        { ...treeEntryBase, name: "package.json", path: "package.json", kind: "file" },
      ],
    });
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/resolved-repo",
      path: "src",
      truncated: false,
      entries: [{ ...treeEntryBase, name: "inside.ts", path: "src/inside.ts", kind: "file" }],
    });
    const onActiveFileChange = vi.fn();
    render(<FilesWidget root="/configured-repo" onActiveFileChange={onActiveFileChange} />);

    await screen.findByRole("treeitem", { name: /^src$/i });
    await waitFor(() => {
      expect(onActiveFileChange).toHaveBeenCalledWith(null, "/resolved-repo", null);
    });
    onActiveFileChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Expand folder: src" }));

    expect(await screen.findByRole("treeitem", { name: /inside\.ts/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /package\.json/i })).toBeInTheDocument();
    expect(onActiveFileChange).not.toHaveBeenCalled();
  });

  it("shows the empty-workspace state without a repository connector", async () => {
    vi.mocked(fetchProjects).mockResolvedValueOnce({ projects: [] });

    renderWithSession(<FilesWidget />);

    expect(await screen.findByText("No registered project is available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect repository" })).toBeNull();
    // audit C021: the no-root state is a NOTE, not an error — retrying could never
    // change anything, so no Retry button may render here.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows actionable empty-state copy when the root bar is available", async () => {
    vi.mocked(fetchProjects).mockResolvedValueOnce({ projects: [] });

    render(<FilesWidget onRootChange={() => undefined} />);

    expect(
      await screen.findByText("No folder is open yet. Enter a folder path above and press Open."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps an explicitly restored external root instead of retargeting to the project", async () => {
    vi.mocked(fetchProjects).mockResolvedValueOnce({
      projects: [
        {
          path: "/sandbox",
          name: "sandbox",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 2,
          available: true,
        },
        {
          path: "/old-keiko",
          name: "Keiko",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
          available: true,
        },
      ],
    });
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/old-keiko",
      path: "",
      truncated: false,
      entries: [],
    });
    const onRootChange = vi.fn();

    render(<FilesWidget root="/old-keiko" onRootChange={onRootChange} />);

    await waitFor(() => {
      expect(fetchFilesTree).toHaveBeenCalledWith("/old-keiko", "");
    });
    expect(onRootChange).not.toHaveBeenCalled();
  });

  it("renders tree loading errors", async () => {
    vi.mocked(fetchFilesTree).mockRejectedValueOnce(new Error("access denied"));

    render(<FilesWidget root="/repo" />);

    expect(await screen.findByText("access denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  // WCAG 2.4.3 (audit C031) — opening the preview unmounts the focused tree row and closing
  // re-mounts the whole tree: without explicit focus management both transitions dropped
  // keyboard focus onto <body>.
  it("moves focus into the preview on open and restores the file row on close (incl. Escape)", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        {
          ...treeEntryBase,
          name: "package.json",
          path: "package.json",
          kind: "file",
          extension: "json",
        },
      ],
    });
    vi.mocked(fetchFilesPreview).mockResolvedValue({
      root: "/repo",
      path: "package.json",
      name: "package.json",
      sizeBytes: 18,
      modifiedAt: 1,
      extension: "json",
      mime: "application/json",
      symlink: false,
      kind: "text",
      content: '{"name":"keiko"}\n',
      truncated: false,
      maxBytes: 1_000_000,
    });

    render(<FilesWidget root="/repo" />);

    await userEvent.click(await screen.findByRole("treeitem", { name: /package\.json/i }));

    // Opening: focus lands on the Back button at the top of the preview surface.
    const back = await screen.findByRole("button", { name: "Back to files" });
    expect(back).toHaveFocus();

    // Closing via Back: focus returns to the previewed file's tree row.
    await userEvent.click(back);
    await waitFor(() => {
      expect(screen.getByRole("treeitem", { name: /package\.json/i })).toHaveFocus();
    });

    // Escape inside the preview closes it as well (shortcut for Back/Close).
    await userEvent.click(screen.getByRole("treeitem", { name: /package\.json/i }));
    await screen.findByRole("button", { name: "Back to files" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.getByRole("treeitem", { name: /package\.json/i })).toHaveFocus();
    });
    expect(screen.queryByRole("button", { name: "Back to files" })).not.toBeInTheDocument();
  });

  it("exposes tree semantics, arrow-key navigation and focusable unreadable symlinks", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        {
          ...treeEntryBase,
          name: "broken",
          path: "broken",
          kind: "file",
          symlink: true,
          readable: false,
        },
        { ...treeEntryBase, name: "a.txt", path: "a.txt", kind: "file" },
      ],
    });

    render(<FilesWidget root="/repo" />);

    // ARIA tree semantics (audit C143): container is a tree, rows are level-1 treeitems
    const dirRow = await screen.findByRole("treeitem", { name: /^src$/i });
    expect(screen.getByRole("tree", { name: "Files" })).toBeInTheDocument();
    expect(dirRow).toHaveAttribute("aria-level", "1");

    // Unreadable symlink (audit C196/C349): aria-disabled instead of native disabled —
    // stays focusable, carries a neutral reason, and the click is guarded.
    const brokenRow = screen.getByRole("treeitem", { name: /broken/i });
    expect(brokenRow).not.toBeDisabled();
    expect(brokenRow).toHaveAttribute("aria-disabled", "true");
    expect(brokenRow).toHaveAccessibleDescription("This link can't be opened from this folder.");
    await userEvent.click(brokenRow);
    expect(fetchFilesPreview).not.toHaveBeenCalled();

    // Arrow keys traverse the visible rows (audit C215)
    const fileRow = screen.getByRole("treeitem", { name: /a\.txt/i });
    dirRow.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(brokenRow).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(fileRow).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(dirRow).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(fileRow).toHaveFocus();
  });

  it("removes native browser titles from project-tree rows", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        {
          ...treeEntryBase,
          name: "package-lock.json",
          path: "package-lock.json",
          kind: "file",
          extension: "json",
        },
        {
          ...treeEntryBase,
          name: "linked-secret",
          path: "linked-secret",
          kind: "file",
          symlink: true,
          readable: false,
        },
      ],
    });

    render(<FilesWidget root="/repo" />);

    const folderRow = await screen.findByRole("treeitem", { name: /^src$/i });
    const caret = screen.getByRole("button", { name: "Expand folder: src" });
    const fileRow = screen.getByRole("treeitem", { name: /package-lock\.json/i });
    const unreadableRow = screen.getByRole("treeitem", { name: /linked-secret/i });

    expect(caret).not.toHaveAttribute("title");
    expect(caret).not.toHaveAttribute("data-tip");
    expect(folderRow).not.toHaveAttribute("title");
    expect(folderRow).not.toHaveAttribute("data-tip");
    expect(fileRow).not.toHaveAttribute("title");
    expect(fileRow).not.toHaveAttribute("data-tip");
    expect(unreadableRow).not.toHaveAttribute("title");
    expect(unreadableRow).not.toHaveAttribute("data-tip");
    expect(unreadableRow).toHaveAccessibleDescription("This link can't be opened from this folder.");
  });

  it("shows the Keiko tree tooltip only after delay when a filename is truncated", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        {
          ...treeEntryBase,
          name: "package-lock.json",
          path: "package-lock.json",
          kind: "file",
          extension: "json",
        },
      ],
    });

    render(<FilesWidget root="/repo" />);

    const fileRow = await screen.findByRole("treeitem", { name: /package-lock\.json/i });
    const name = fileRow.querySelector<HTMLElement>(".tr-name");
    expect(name).not.toBeNull();
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 160 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 80 });

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(fileRow, { clientX: 100, clientY: 100 });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(649);
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).toHaveTextContent("package-lock.json");
      expect(tooltip.parentElement).toBe(document.body);

      fireEvent.pointerLeave(fileRow);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      Object.defineProperty(name, "scrollWidth", { configurable: true, value: 80 });
      Object.defineProperty(name, "clientWidth", { configurable: true, value: 160 });
      fireEvent.pointerEnter(fileRow, { clientX: 100, clientY: 100 });
      act(() => {
        vi.advanceTimersByTime(650);
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FilePreview", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders binary preview metadata instead of code", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "archive.bin",
      name: "archive.bin",
      sizeBytes: 6,
      modifiedAt: 1,
      extension: "bin",
      mime: "text/plain",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    render(<FilePreview root="/repo" path="archive.bin" onClose={() => undefined} />);

    expect(
      await screen.findByText("No safe text or image preview is available for this file type."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("archive.bin").length).toBeGreaterThan(0);
  });

  it("explains that DOCX is searchable via bounded extraction with stated limits (Issue #1285)", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "docs/handbook.docx",
      name: "handbook.docx",
      sizeBytes: 16_384,
      modifiedAt: 1,
      extension: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    render(<FilePreview root="/repo" path="docs/handbook.docx" onClose={() => undefined} />);

    expect(
      await screen.findByText(
        /DOCX files up to 2 MB are searchable in Repository Search via bounded text extraction/,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("handbook.docx").length).toBeGreaterThan(0);
  });

  it("explains that XLSX is searchable via bounded extraction (Issue #1285)", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "docs/budget.xlsx",
      name: "budget.xlsx",
      sizeBytes: 20_000,
      modifiedAt: 1,
      extension: "xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    render(<FilePreview root="/repo" path="docs/budget.xlsx" onClose={() => undefined} />);

    expect(
      await screen.findByText(
        /XLSX files up to 2 MB are searchable in Repository Search via bounded text extraction/,
      ),
    ).toBeInTheDocument();
  });

  it("explains that text-layer PDF is searchable via bounded extraction (Issue #1285)", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "docs/manual.pdf",
      name: "manual.pdf",
      sizeBytes: 24_000,
      modifiedAt: 1,
      extension: "pdf",
      mime: "application/pdf",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    render(<FilePreview root="/repo" path="docs/manual.pdf" onClose={() => undefined} />);

    expect(
      await screen.findByText(
        /PDF files up to 2 MB are searchable in Repository Search via bounded text extraction/,
      ),
    ).toBeInTheDocument();
  });

  it("renders a generic safety alert when the BFF returns 403 DENIED", async () => {
    // The BFF message must NOT be rendered verbatim — it is replaced by a
    // generic, non-probing safety message. The matched server-side pattern is
    // never disclosed; the message lists common deny categories as examples
    // only.
    const bffMessage = "secret bff diagnostic that should never reach the user";
    vi.mocked(fetchFilesPreview).mockRejectedValueOnce(new ApiError("DENIED", bffMessage, 403));

    const { container } = render(
      <FilePreview root="/repo" path="some/secret.pem" onClose={() => undefined} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/excluded from the read surface for safety/i);
    expect(alert.textContent ?? "").not.toContain(bffMessage);
    expect(alert.textContent ?? "").not.toContain("some/secret.pem");
    // The requested path must not be visible anywhere in the rendered tree
    // (the header still renders, but with a generic "Hidden file" label so the
    // path is not leaked via the document or any title attribute).
    expect(container.textContent ?? "").not.toContain("some/secret.pem");
    expect(container.innerHTML).not.toContain("some/secret.pem");
  });

  it("does not render the requested path while a denied preview is still loading", async () => {
    let rejectPreview: ((error: unknown) => void) | undefined;
    vi.mocked(fetchFilesPreview).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPreview = reject;
      }),
    );

    const { container } = render(
      <FilePreview root="/repo" path="some/secret.pem" onClose={() => undefined} />,
    );

    expect(container.textContent ?? "").not.toContain("some/secret.pem");
    expect(container.innerHTML).not.toContain("some/secret.pem");

    rejectPreview?.(new ApiError("DENIED", "hidden", 403));
    await screen.findByRole("alert");
  });

  it("renders the raw error message for non-denied errors", async () => {
    vi.mocked(fetchFilesPreview).mockRejectedValueOnce(new Error("boom"));

    render(<FilePreview root="/repo" path="hello.txt" onClose={() => undefined} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    expect(alert.textContent ?? "").not.toMatch(/excluded from the read surface for safety/i);
  });

  it("refreshes the open preview and confirms the updated file content", async () => {
    vi.mocked(fetchFilesPreview)
      .mockResolvedValueOnce({
        root: "/repo",
        path: "hello.txt",
        name: "hello.txt",
        sizeBytes: 10,
        modifiedAt: 1,
        extension: "txt",
        mime: "text/plain",
        symlink: false,
        kind: "text",
        content: "old value\n",
        truncated: false,
        maxBytes: 1_000_000,
      })
      .mockResolvedValueOnce({
        root: "/repo",
        path: "hello.txt",
        name: "hello.txt",
        sizeBytes: 10,
        modifiedAt: 2,
        extension: "txt",
        mime: "text/plain",
        symlink: false,
        kind: "text",
        content: "new value\n",
        truncated: false,
        maxBytes: 1_000_000,
      });

    render(<FilePreview root="/repo" path="hello.txt" onClose={() => undefined} />);

    const previewRegion = await screen.findByRole("region", { name: "File preview: hello.txt" });
    expect(previewRegion).toHaveTextContent("old value");
    await userEvent.click(screen.getByRole("button", { name: "Refresh preview" }));

    await waitFor(() => expect(fetchFilesPreview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(previewRegion).toHaveTextContent("new value"));
    expect(screen.getByRole("status")).toHaveTextContent("Reloaded");
    expect(previewRegion).not.toHaveTextContent("old value");
  });

  it("keeps the last loaded preview visible when a manual refresh fails", async () => {
    vi.mocked(fetchFilesPreview)
      .mockResolvedValueOnce({
        root: "/repo",
        path: "hello.txt",
        name: "hello.txt",
        sizeBytes: 10,
        modifiedAt: 1,
        extension: "txt",
        mime: "text/plain",
        symlink: false,
        kind: "text",
        content: "old value\n",
        truncated: false,
        maxBytes: 1_000_000,
      })
      .mockRejectedValueOnce(new Error("disk read failed"));

    render(<FilePreview root="/repo" path="hello.txt" onClose={() => undefined} />);

    const previewRegion = await screen.findByRole("region", { name: "File preview: hello.txt" });
    expect(previewRegion).toHaveTextContent("old value");
    await userEvent.click(screen.getByRole("button", { name: "Refresh preview" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("disk read failed");
    expect(screen.getByText("Refresh failed")).toBeInTheDocument();
    expect(previewRegion).toHaveTextContent("old value");
    expect(fetchFilesPreview).toHaveBeenCalledTimes(2);
  });

  it("does not render a direct chat connector for the previewed file", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/resolved-repo",
      path: "hello.txt",
      name: "hello.txt",
      sizeBytes: 12,
      modifiedAt: 1,
      extension: "txt",
      mime: "text/plain",
      symlink: false,
      kind: "text",
      content: "hello\n",
      truncated: false,
      maxBytes: 1_000_000,
    });
    const session = renderWithSession(
      <FilePreview root="/resolved-repo" path="hello.txt" onClose={() => undefined} />,
    );

    await screen.findByText("hello.txt");

    expect(screen.queryByRole("button", { name: "Connect to chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update connected scope" })).toBeNull();
    expect(updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(session.replaceChat).not.toHaveBeenCalled();
  });
});
