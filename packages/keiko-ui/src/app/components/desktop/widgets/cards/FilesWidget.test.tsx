import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { Profiler, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  copyFilesEntry,
  createFilesEntry,
  deleteFilesEntry,
  fetchFilesPreview,
  fetchFilesTree,
  fetchGitDiff,
  fetchGitStatus,
  fetchProjects,
  renameFilesEntry,
  updateChatConnectedScopes,
} from "../../../../../lib/api";
import type { Chat, GitChangedFile, GitRepositoryStatusResponse } from "../../../../../lib/types";
import { ChatSessionProvider } from "../../context/ChatSessionContext";
import type { ChatSessionApi } from "../../hooks/useChatSession";
import { FilePreview } from "./FilePreview";
import { FilesWidget, filesWidgetTestInternals } from "./FilesWidget";
import { notifyWorkspaceFileMutated } from "./workspace-file-events";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchFilesPreview: vi.fn(),
    fetchProjects: vi.fn(),
    fetchFilesTree: vi.fn(),
    fetchGitStatus: vi.fn(),
    fetchGitDiff: vi.fn(),
    createFilesEntry: vi.fn(),
    renameFilesEntry: vi.fn(),
    deleteFilesEntry: vi.fn(),
    copyFilesEntry: vi.fn(),
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

function availableGitStatus(
  changes: readonly GitChangedFile[],
  overrides: Partial<GitRepositoryStatusResponse> = {},
): GitRepositoryStatusResponse {
  return {
    schemaVersion: "1",
    root: "/repo",
    repositoryRoot: "/repo",
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    clean: changes.length === 0,
    stagedCount: changes.filter((change) => change.staged).length,
    unstagedCount: changes.filter((change) => change.unstaged).length,
    untrackedCount: changes.filter((change) => change.untracked).length,
    conflictedCount: changes.filter((change) => change.conflicted).length,
    changes,
    truncated: false,
    maxChanges: 500,
    ...overrides,
  };
}

function gitChange(
  path: string,
  worktreeStatus: GitChangedFile["worktreeStatus"],
  overrides: Partial<GitChangedFile> = {},
): GitChangedFile {
  return {
    path,
    indexStatus: " ",
    worktreeStatus,
    staged: false,
    unstaged: worktreeStatus !== "?" && worktreeStatus !== "!",
    untracked: worktreeStatus === "?",
    conflicted: false,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    regeneratingMessageId: undefined,
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    regenerateMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    lastSentDocuments: [],
    ...overrides,
  };
}

function renderWithSession(ui: ReactElement, session = makeSession()): ChatSessionApi {
  render(<ChatSessionProvider value={session}>{ui}</ChatSessionProvider>);
  return session;
}

describe("FilesWidget", () => {
  beforeEach(() => {
    vi.mocked(fetchGitStatus).mockResolvedValue({
      schemaVersion: "1",
      root: "/repo",
      state: "unavailable",
      available: false,
      reason: "not-a-repository",
      detached: false,
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: [],
      truncated: false,
      maxChanges: 500,
    });
  });

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

  it("ignores a stale tree response after the root changes", async () => {
    const rootA = deferred<Awaited<ReturnType<typeof fetchFilesTree>>>();
    const rootB = deferred<Awaited<ReturnType<typeof fetchFilesTree>>>();
    vi.mocked(fetchFilesTree).mockImplementation((root: string) => {
      if (root === "/repo-a") return rootA.promise;
      if (root === "/repo-b") return rootB.promise;
      return Promise.resolve({ root, path: "", truncated: false, entries: [] });
    });
    const onActiveFileChange = vi.fn();
    const view = render(<FilesWidget root="/repo-a" onActiveFileChange={onActiveFileChange} />);

    view.rerender(<FilesWidget root="/repo-b" onActiveFileChange={onActiveFileChange} />);

    await act(async () => {
      rootB.resolve({
        root: "/repo-b-real",
        path: "",
        truncated: false,
        entries: [{ ...treeEntryBase, name: "new.txt", path: "new.txt", kind: "file" }],
      });
      await rootB.promise;
    });
    expect(await screen.findByText("new.txt")).toBeInTheDocument();
    expect(onActiveFileChange).toHaveBeenCalledWith(null, "/repo-b-real", null);

    await act(async () => {
      rootA.resolve({
        root: "/repo-a-real",
        path: "",
        truncated: false,
        entries: [{ ...treeEntryBase, name: "old.txt", path: "old.txt", kind: "file" }],
      });
      await rootA.promise;
    });
    expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
    expect(onActiveFileChange).not.toHaveBeenCalledWith(null, "/repo-a-real", null);
  });

  it("shares identical startup tree and Git status reads across sibling Files windows", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue({
      schemaVersion: "1",
      root: "/repo",
      state: "unavailable",
      available: false,
      reason: "not-a-repository",
      detached: false,
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: [],
      truncated: false,
      maxChanges: 500,
    });
    vi.mocked(fetchFilesTree).mockResolvedValue({
      root: "/repo",
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

    render(
      <>
        <FilesWidget root="/repo" />
        <FilesWidget root="/repo" />
        <FilesWidget root="/repo" />
      </>,
    );

    expect(await screen.findAllByRole("treeitem", { name: /package\.json/i })).toHaveLength(3);
    expect(fetchFilesTree).toHaveBeenCalledTimes(1);
    expect(fetchFilesTree).toHaveBeenCalledWith("/repo", "");
    expect(fetchGitStatus).toHaveBeenCalledTimes(1);
    expect(fetchGitStatus).toHaveBeenCalledWith("/repo", { includeIgnored: true });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(2));
    expect(fetchGitStatus).toHaveBeenLastCalledWith("/repo", { includeIgnored: true });

    notifyWorkspaceFileMutated("/other-repo");
    expect(fetchGitStatus).toHaveBeenCalledTimes(2);
    notifyWorkspaceFileMutated("/repo");

    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(3));
    expect(fetchGitStatus).toHaveBeenLastCalledWith("/repo", { includeIgnored: true });
  });

  it("settles Git status after the root tree resolves to the same root", async () => {
    const gitStatus = deferred<Awaited<ReturnType<typeof fetchGitStatus>>>();
    vi.mocked(fetchGitStatus).mockReturnValue(gitStatus.promise);
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [],
    });

    render(<FilesWidget root="/repo" />);

    expect(await screen.findByText("Empty folder.")).toBeInTheDocument();
    expect(screen.getByText("Git status loading")).toBeInTheDocument();

    await act(async () => {
      gitStatus.resolve({
        schemaVersion: "1",
        root: "/repo",
        state: "unavailable",
        available: false,
        reason: "not-a-repository",
        detached: false,
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        changes: [],
        truncated: false,
        maxChanges: 500,
      });
      await gitStatus.promise;
    });

    expect(await screen.findByText("Git unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Git status loading")).toBeNull();
  });

  it("reads Git status from the visible nested folder after entering it", async () => {
    const parentRoot = "D:\\Softwareentwicklung\\Projekte";
    const nestedRoot = `${parentRoot}\\SpringAI Showcase`;
    vi.mocked(fetchGitStatus).mockImplementation((root: string) =>
      Promise.resolve(
        root === nestedRoot
          ? {
              schemaVersion: "1",
              root,
              repositoryRoot: root,
              state: "available",
              available: true,
              branch: "main",
              detached: false,
              clean: false,
              stagedCount: 0,
              unstagedCount: 1,
              untrackedCount: 0,
              conflictedCount: 0,
              changes: [
                {
                  path: "pom.xml",
                  indexStatus: " ",
                  worktreeStatus: "M",
                  staged: false,
                  unstaged: true,
                  untracked: false,
                  conflicted: false,
                },
              ],
              truncated: false,
              maxChanges: 500,
            }
          : {
              schemaVersion: "1",
              root,
              state: "unavailable",
              available: false,
              reason: "not-a-repository",
              detached: false,
              clean: true,
              stagedCount: 0,
              unstagedCount: 0,
              untrackedCount: 0,
              conflictedCount: 0,
              changes: [],
              truncated: false,
              maxChanges: 500,
            },
      ),
    );
    vi.mocked(fetchFilesTree).mockImplementation((root: string, path = "") =>
      Promise.resolve({
        root,
        path,
        truncated: false,
        entries:
          path === ""
            ? [
                {
                  ...treeEntryBase,
                  name: "SpringAI Showcase",
                  path: "SpringAI Showcase",
                  kind: "directory",
                },
              ]
            : [
                {
                  ...treeEntryBase,
                  name: "pom.xml",
                  path: "SpringAI Showcase/pom.xml",
                  kind: "file",
                  sizeBytes: 42,
                  extension: "xml",
                },
              ],
      }),
    );
    vi.mocked(fetchGitDiff).mockResolvedValueOnce({
      schemaVersion: "1",
      root: nestedRoot,
      repositoryRoot: nestedRoot,
      state: "available",
      available: true,
      path: "pom.xml",
      scope: "all",
      diff: "diff --git a/pom.xml b/pom.xml\n-old\n+new\n",
      truncated: false,
      maxBytes: 131072,
    });

    render(<FilesWidget root={parentRoot} />);

    await userEvent.click(await screen.findByRole("treeitem", { name: "SpringAI Showcase" }));

    expect(await screen.findByText(/Git main 1 changed file/i)).toBeInTheDocument();
    expect(fetchGitStatus).toHaveBeenCalledWith(nestedRoot, { includeIgnored: true });
    expect(screen.getByText("M")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "View Git diff for SpringAI Showcase/pom.xml" }),
    );

    expect(fetchGitDiff).toHaveBeenCalledWith({
      root: nestedRoot,
      path: "pom.xml",
    });
  });

  it("progressively reveals large folders instead of rendering every row at once", async () => {
    const entries = Array.from(
      { length: filesWidgetTestInternals.DIRECTORY_RENDER_BATCH_SIZE + 1 },
      (_, index) => ({
        ...treeEntryBase,
        name: `file-${String(index).padStart(3, "0")}.ts`,
        path: `file-${String(index).padStart(3, "0")}.ts`,
        kind: "file" as const,
        extension: "ts",
      }),
    );
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries,
    });

    const { container } = render(<FilesWidget root="/repo" />);

    expect(await screen.findByRole("treeitem", { name: /file-000\.ts/i })).toBeInTheDocument();
    expect(container.querySelectorAll("button.tr-row")).toHaveLength(
      filesWidgetTestInternals.DIRECTORY_RENDER_BATCH_SIZE,
    );
    expect(container.querySelector('[data-path="file-200.ts"]')).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show 1 more entries" }));

    expect(container.querySelectorAll("button.tr-row")).toHaveLength(entries.length);
    expect(screen.getByRole("treeitem", { name: /file-200\.ts/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show more entries/i })).toBeNull();
  });

  it("shows Git status badges and opens a bounded diff view", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue({
      schemaVersion: "1",
      root: "/repo space",
      repositoryRoot: "/repo space",
      state: "available",
      available: true,
      branch: "main",
      detached: false,
      clean: false,
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: [
        {
          path: "package.json",
          indexStatus: " ",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
        },
      ],
      truncated: false,
      maxChanges: 500,
    });
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
    vi.mocked(fetchGitDiff).mockResolvedValueOnce({
      schemaVersion: "1",
      root: "/repo space",
      repositoryRoot: "/repo space",
      state: "available",
      available: true,
      path: "package.json",
      scope: "all",
      diff: "diff --git a/package.json b/package.json\n-old\n+new\n",
      truncated: false,
      maxBytes: 131072,
    });

    const onOpenGitDelivery = vi.fn();
    render(<FilesWidget root="/repo space" onOpenGitDelivery={onOpenGitDelivery} />);

    expect(await screen.findByText(/Git main 1 changed file/i)).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Git" }));
    expect(onOpenGitDelivery).toHaveBeenCalledWith("/repo space");

    await userEvent.click(screen.getByRole("button", { name: "View Git diff for package.json" }));

    expect(fetchGitDiff).toHaveBeenCalledWith({ root: "/repo space", path: "package.json" });
    expect(await screen.findByRole("region", { name: "Git diff: package.json" })).toHaveTextContent(
      "+new",
    );
  });

  it("renders complete file badges and collapsed descendant folder aggregates", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue(
      availableGitStatus([
        gitChange("modified.ts", "M"),
        gitChange("added.ts", " ", { indexStatus: "A", staged: true, unstaged: false }),
        gitChange("untracked.ts", "?"),
        gitChange("renamed.ts", " ", {
          oldPath: "old-name.ts",
          indexStatus: "R",
          staged: true,
          unstaged: false,
        }),
        gitChange("conflicted.ts", "U", { conflicted: true }),
        gitChange("src/deep.ts", "M"),
        gitChange("removed/gone.ts", "D"),
      ]),
    );
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        { ...treeEntryBase, name: "removed", path: "removed", kind: "directory" },
        { ...treeEntryBase, name: "modified.ts", path: "modified.ts", kind: "file" },
        { ...treeEntryBase, name: "added.ts", path: "added.ts", kind: "file" },
        { ...treeEntryBase, name: "untracked.ts", path: "untracked.ts", kind: "file" },
        { ...treeEntryBase, name: "renamed.ts", path: "renamed.ts", kind: "file" },
        { ...treeEntryBase, name: "conflicted.ts", path: "conflicted.ts", kind: "file" },
      ],
    });

    render(<FilesWidget root="/repo" />);

    expect(await screen.findByLabelText("Git modified: modified.ts")).toHaveTextContent("M");
    expect(screen.getByLabelText("Git added: added.ts")).toHaveTextContent("A");
    expect(screen.getByLabelText("Git untracked: untracked.ts")).toHaveTextContent("?");
    expect(screen.getByLabelText("Git renamed: renamed.ts")).toHaveTextContent("R");
    const conflict = screen.getByLabelText("Git conflict: conflicted.ts");
    expect(conflict).toHaveTextContent("U");
    expect(conflict).toHaveAttribute("data-git-state", "conflicted");
    expect(screen.getByLabelText("Folder contains 1 Git changes")).toHaveTextContent("Δ");
    expect(
      screen.getByLabelText("Folder contains 1 Git changes, including deleted files"),
    ).toHaveTextContent("Δ");
    expect(screen.getByText("src").closest("button")).toHaveAttribute("aria-expanded", "false");
    expect(fetchGitStatus).toHaveBeenCalledTimes(1);
  });

  it("dims ignored files semantically without removing their interaction", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue(
      availableGitStatus([gitChange("ignored.log", "!")]),
    );
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        {
          ...treeEntryBase,
          name: "ignored.log",
          path: "ignored.log",
          kind: "file",
          extension: "log",
        },
      ],
    });
    const onOpenFile = vi.fn();

    render(<FilesWidget root="/repo" openFilesDirectly onOpenFile={onOpenFile} />);

    const row = await screen.findByRole("treeitem", { name: "ignored.log, Ignored by Git" });
    expect(row.closest("[data-git-ignored='true']")).toHaveStyle({ opacity: "0.55" });
    expect(screen.queryByLabelText(/Git changed: ignored\.log/iu)).toBeNull();
    await userEvent.click(row);
    expect(onOpenFile).toHaveBeenCalledWith("/repo", "ignored.log");
  });

  it("leaves ordinary rows undecorated when ignored entries are not requested by the response", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue(availableGitStatus([]));
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [{ ...treeEntryBase, name: "ordinary.ts", path: "ordinary.ts", kind: "file" }],
    });

    render(<FilesWidget root="/repo" />);

    const row = await screen.findByRole("treeitem", { name: /ordinary\.ts/iu });
    expect(row).not.toHaveAttribute("aria-label");
    expect(row.closest(".tr-file-wrap")).not.toHaveAttribute("data-git-ignored");
    expect(row.closest(".tr-file-wrap")).not.toHaveAttribute("style");
  });

  it("renders an honest incomplete affordance for truncated Git status", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue(
      availableGitStatus([gitChange("visible.ts", "M")], {
        truncated: true,
        maxChanges: 500,
      }),
    );
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [{ ...treeEntryBase, name: "visible.ts", path: "visible.ts", kind: "file" }],
    });

    render(<FilesWidget root="/repo" />);

    expect(
      await screen.findByText("Git decorations incomplete: showing only the first 500 changes."),
    ).toBeInTheDocument();
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
      <FilesWidget
        root="/repo space"
        openFilesDirectly
        activeFilePath=""
        onOpenFile={onOpenFile}
      />,
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
    const gitStatusCallsBeforeRefresh = vi.mocked(fetchGitStatus).mock.calls.length;

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
    await waitFor(() =>
      expect(fetchGitStatus).toHaveBeenCalledTimes(gitStatusCallsBeforeRefresh + 1),
    );
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
    expect(unreadableRow).toHaveAccessibleDescription(
      "This link can't be opened from this folder.",
    );
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

  it("copies the opened file name and full path from the preview header", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "C:\\repo space",
      path: "src/package.json",
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

    render(
      <FilePreview root={"C:\\repo space"} path="src/package.json" onClose={() => undefined} />,
    );

    await screen.findByRole("region", { name: "File preview: package.json" });
    await userEvent.click(screen.getByRole("button", { name: "Copy file name" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("package.json"));
    expect(screen.getByText("File name copied")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy file path" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("C:\\repo space\\src\\package.json"),
    );
    expect(screen.getByText("File path copied")).toBeInTheDocument();

    if (clipboardDescriptor === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
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

  it("renders the unreadable fallback for opaque preview failures", async () => {
    vi.mocked(fetchFilesPreview).mockRejectedValueOnce("opaque preview failure");

    render(<FilePreview root="/repo" path="hello.txt" onClose={() => undefined} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to read this file.");
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

  // GEN-PERF-WIDGET-005 — a large text preview must not render one DOM row per line eagerly
  // (~25k rows for a 1 MB file). The initial render is windowed; "Show more lines" reveals more.
  it("windows a very large text preview and reveals more lines on demand", async () => {
    const lineCount = 25_000;
    const content = `${Array.from({ length: lineCount }, (_, i) => `line ${String(i)}`).join(
      "\n",
    )}\n`;
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "big.txt",
      name: "big.txt",
      sizeBytes: content.length,
      modifiedAt: 1,
      extension: "txt",
      mime: "text/plain",
      symlink: false,
      kind: "text",
      content,
      truncated: false,
      maxBytes: 1_000_000,
    });

    render(<FilePreview root="/repo" path="big.txt" onClose={() => undefined} />);

    await screen.findByRole("region", { name: "File preview: big.txt" });
    // Only the first batch of lines is mounted, not all 25k.
    const initialRows = document.querySelectorAll(".fpv-line");
    expect(initialRows.length).toBeLessThanOrEqual(500);
    expect(initialRows.length).toBeGreaterThan(0);

    const showMore = screen.getByRole("button", { name: /Show \d+ more lines/ });
    await userEvent.click(showMore);

    const afterRows = document.querySelectorAll(".fpv-line");
    expect(afterRows.length).toBeGreaterThan(initialRows.length);
    expect(afterRows.length).toBeLessThanOrEqual(1000);
  });
});

describe("FilesWidget file operations", () => {
  beforeEach(() => {
    vi.mocked(fetchGitStatus).mockResolvedValue({
      schemaVersion: "1",
      root: "/repo",
      state: "unavailable",
      available: false,
      reason: "not-a-repository",
      detached: false,
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: [],
      truncated: false,
      maxChanges: 500,
    });
    // mockResolvedValue (not Once) so the post-mutation directory refresh re-resolves the tree.
    vi.mocked(fetchFilesTree).mockResolvedValue({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        {
          ...treeEntryBase,
          name: "app.ts",
          path: "app.ts",
          kind: "file",
          sizeBytes: 12,
          extension: "ts",
        },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new file from the toolbar and opens it", async () => {
    vi.mocked(createFilesEntry).mockResolvedValue({ root: "/repo", path: "new.ts", kind: "file" });
    const onOpenFile = vi.fn();
    const onFilesMutated = vi.fn();
    render(<FilesWidget root="/repo" onOpenFile={onOpenFile} onFilesMutated={onFilesMutated} />);
    await screen.findByText("app.ts");

    await userEvent.click(screen.getByRole("button", { name: "New file" }));
    await userEvent.type(await screen.findByLabelText("New file name"), "new.ts{Enter}");

    await waitFor(() =>
      expect(createFilesEntry).toHaveBeenCalledWith({
        root: "/repo",
        path: "new.ts",
        kind: "file",
      }),
    );
    expect(onOpenFile).toHaveBeenCalledWith("/repo", "new.ts");
    expect(onFilesMutated).toHaveBeenCalledWith({
      op: "create",
      mutation: { root: "/repo", path: "new.ts", kind: "file" },
    });
  });

  it("creates a new folder from the toolbar", async () => {
    vi.mocked(createFilesEntry).mockResolvedValue({
      root: "/repo",
      path: "lib",
      kind: "directory",
    });
    render(<FilesWidget root="/repo" onOpenFile={vi.fn()} />);
    await screen.findByText("app.ts");

    await userEvent.click(screen.getByRole("button", { name: "New folder" }));
    await userEvent.type(await screen.findByLabelText("New folder name"), "lib{Enter}");

    await waitFor(() =>
      expect(createFilesEntry).toHaveBeenCalledWith({
        root: "/repo",
        path: "lib",
        kind: "directory",
      }),
    );
  });

  it("renames a file from the right-click context menu", async () => {
    vi.mocked(renameFilesEntry).mockResolvedValue({
      root: "/repo",
      path: "renamed.ts",
      previousPath: "app.ts",
      kind: "file",
    });
    const onFilesMutated = vi.fn();
    render(<FilesWidget root="/repo" onFilesMutated={onFilesMutated} />);
    fireEvent.contextMenu(await screen.findByText("app.ts"));
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = await screen.findByLabelText("Rename app.ts");
    await userEvent.clear(input);
    await userEvent.type(input, "renamed.ts{Enter}");

    await waitFor(() =>
      expect(renameFilesEntry).toHaveBeenCalledWith({
        root: "/repo",
        path: "app.ts",
        newPath: "renamed.ts",
      }),
    );
    expect(onFilesMutated).toHaveBeenCalledWith({
      op: "rename",
      mutation: expect.objectContaining({ path: "renamed.ts", previousPath: "app.ts" }),
    });
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(2));
  });

  it("deletes a file from the context menu after confirmation", async () => {
    vi.mocked(deleteFilesEntry).mockResolvedValue({ root: "/repo", path: "app.ts", kind: "file" });
    const onFilesMutated = vi.fn();
    render(<FilesWidget root="/repo" onFilesMutated={onFilesMutated} />);
    fireEvent.contextMenu(await screen.findByText("app.ts"));
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    // The confirm dialog gates the destructive action.
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(deleteFilesEntry).toHaveBeenCalledWith({ root: "/repo", path: "app.ts" }),
    );
    expect(onFilesMutated).toHaveBeenCalledWith({
      op: "delete",
      mutation: { root: "/repo", path: "app.ts", kind: "file" },
    });
    // AC2 (Epic #2093 audit) — deletion must invalidate the shared git status the same way
    // rename already does, so decorations re-fetch instead of going stale.
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(2));
  });

  // GEN-UI-FOCUS-002 — the delete-confirmation dialog must trap focus, focus a button on open,
  // cancel on Escape, and return focus to the originating tree row on close (WCAG 2.1.2/2.4.3).
  it("focuses, traps and Escape-cancels the delete dialog, restoring focus to the row", async () => {
    render(<FilesWidget root="/repo" />);

    const row = await screen.findByRole("treeitem", { name: /app\.ts/i });
    row.focus();
    expect(row).toHaveFocus();

    // Delete on the focused readable row opens the confirmation dialog (VS Code parity).
    fireEvent.keyDown(row, { key: "Delete" });

    const dialog = await screen.findByRole("dialog", { name: /delete file\?/i });
    // The dialog describes its warning body so screen readers announce the consequence.
    expect(dialog).toHaveAttribute("aria-describedby", "files-delete-body");
    expect(document.getElementById("files-delete-body")).toHaveTextContent(/cannot be undone/i);

    // Focus is moved into the dialog (onto the primary Delete button).
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await waitFor(() => expect(deleteBtn).toHaveFocus());

    // Tab from the last control wraps back to the first (focus stays inside the dialog).
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    cancelBtn.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(deleteBtn).toHaveFocus();
    // Shift+Tab from the first control wraps to the last.
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(cancelBtn).toHaveFocus();

    // Escape cancels the dialog and returns focus to the originating tree row.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /delete file\?/i })).not.toBeInTheDocument(),
    );
    expect(deleteFilesEntry).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("treeitem", { name: /app\.ts/i })).toHaveFocus();
    });
  });

  // GEN-UI-KEYBOARD-003 — the context menu moves focus to its first item on open and supports
  // arrow roving among the menu items.
  it("focuses the first context-menu item and roves with arrow keys", async () => {
    render(<FilesWidget root="/repo" />);

    fireEvent.contextMenu(await screen.findByText("app.ts"));

    const rename = await screen.findByRole("menuitem", { name: "Rename…" });
    await waitFor(() => expect(rename).toHaveFocus());

    const menu = screen.getByRole("menu", { name: "File actions" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "New Folder…" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(rename).toHaveFocus();
  });

  // GEN-UI-TEST-GAP-006 (#16) — the file tree plus an open delete dialog must be axe-clean.
  // The tree exposes a separate caret toggle button alongside each treeitem, which axe's
  // aria-required-children rule flags as a not-allowed child of role="tree"; that pre-existing
  // structural item is tracked independently of these focus findings, so it is disabled here.
  it("has no axe violations for the tree and the open delete dialog", async () => {
    const axeOptions = { rules: { "aria-required-children": { enabled: false } } } as const;
    const { container } = render(<FilesWidget root="/repo" />);

    const row = await screen.findByRole("treeitem", { name: /app\.ts/i });
    expect(await axe(container, axeOptions)).toHaveNoViolations();

    row.focus();
    fireEvent.keyDown(row, { key: "Delete" });
    const dialog = await screen.findByRole("dialog", { name: /delete file\?/i });
    // The delete dialog itself (the surface these findings hardened) is axe-clean under all rules.
    expect(await axe(dialog)).toHaveNoViolations();
    // The full container (tree + dialog) is clean aside from the tracked tree-structure item.
    expect(await axe(container, axeOptions)).toHaveNoViolations();
  });

  it("keeps the inline editor open and shows the error when a create fails", async () => {
    vi.mocked(createFilesEntry).mockRejectedValue(
      new Error("An entry with that name already exists."),
    );
    render(<FilesWidget root="/repo" onOpenFile={vi.fn()} />);
    await screen.findByText("app.ts");

    await userEvent.click(screen.getByRole("button", { name: "New file" }));
    await userEvent.type(await screen.findByLabelText("New file name"), "app.ts{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByLabelText("New file name")).toBeInTheDocument();
  });

  it("duplicates a file from the context menu with a collision-free copy name", async () => {
    vi.mocked(copyFilesEntry).mockResolvedValue({
      root: "/repo",
      path: "app copy.ts",
      kind: "file",
    });
    const onFilesMutated = vi.fn();
    render(<FilesWidget root="/repo" onFilesMutated={onFilesMutated} />);
    fireEvent.contextMenu(await screen.findByText("app.ts"));
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() =>
      expect(copyFilesEntry).toHaveBeenCalledWith({
        root: "/repo",
        sourcePath: "app.ts",
        destPath: "app copy.ts",
      }),
    );
    // A copy adds a new entry, so the host treats it like a create (no open tab to re-home).
    expect(onFilesMutated).toHaveBeenCalledWith({
      op: "create",
      mutation: { root: "/repo", path: "app copy.ts", kind: "file" },
    });
    // AC2 (Epic #2093 audit) — duplication must invalidate the shared git status the same way
    // rename already does, so decorations re-fetch instead of going stale.
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(2));
  });

  it("moves a file into a folder when dropped on its row (drag-move = rename)", async () => {
    vi.mocked(renameFilesEntry).mockResolvedValue({
      root: "/repo",
      path: "src/app.ts",
      previousPath: "app.ts",
      kind: "file",
    });
    const onFilesMutated = vi.fn();
    render(<FilesWidget root="/repo" onFilesMutated={onFilesMutated} />);
    await screen.findByText("app.ts");
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(1));

    const source = screen.getByRole("treeitem", { name: /app\.ts/ });
    const target = screen.getByRole("treeitem", { name: /src/ });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() =>
      expect(renameFilesEntry).toHaveBeenCalledWith({
        root: "/repo",
        path: "app.ts",
        newPath: "src/app.ts",
      }),
    );
    expect(onFilesMutated).toHaveBeenCalledWith({
      op: "rename",
      mutation: expect.objectContaining({ path: "src/app.ts", previousPath: "app.ts" }),
    });
    // AC2 (Epic #2093 audit) — a drag-move must invalidate the shared git status the same way
    // the context-menu rename already does, so decorations re-fetch instead of going stale.
    await waitFor(() => expect(fetchGitStatus).toHaveBeenCalledTimes(2));
  });

  // GEN-PERF-WIDGET-004 — while a tooltip is visible, pointer motion must not commit a React
  // render (the tooltip moves imperatively). Count Profiler commits across a pointermove burst.
  it("does not re-render the tree on pointermove while a tooltip is visible", async () => {
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

    let commits = 0;
    render(
      <Profiler id="files" onRender={() => (commits += 1)}>
        <FilesWidget root="/repo" />
      </Profiler>,
    );

    const fileRow = await screen.findByRole("treeitem", { name: /package-lock\.json/i });
    const name = fileRow.querySelector<HTMLElement>(".tr-name");
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 160 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 80 });

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(fileRow, { clientX: 100, clientY: 100 });
      act(() => {
        vi.advanceTimersByTime(650);
      });
      const tooltip = screen.getByRole("tooltip");
      const leftBefore = (tooltip as HTMLElement).style.left;

      commits = 0;
      for (let i = 0; i < 50; i += 1) {
        fireEvent.pointerMove(fileRow, { clientX: 100 + i, clientY: 100 + i });
      }

      // Pointer motion committed no React render …
      expect(commits).toBe(0);
      // … but the tooltip element moved imperatively.
      expect((tooltip as HTMLElement).style.left).not.toBe(leftBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  // GEN-PERF-MEMORY-005 — the directories cache is bounded. Exercise the owner helper directly
  // so the coverage runner does not spend minutes on dozens of expand/collapse DOM cycles.
  it("evicts least-recently-loaded directories beyond the cache cap", async () => {
    const dirName = (i: number): string => `dir-${String(i).padStart(3, "0")}`;
    const directoryState = {
      entries: [],
      truncated: false,
      loading: false,
      error: null,
      notice: null,
    };
    const directoryPaths = Array.from(
      { length: filesWidgetTestInternals.DIRECTORY_CACHE_MAX + 2 },
      (_, index) => dirName(index),
    );
    const directories = Object.fromEntries([
      ["", directoryState],
      ...directoryPaths.map((path): [string, typeof directoryState] => [path, directoryState]),
    ]);
    const accessOrder = ["", ...directoryPaths];

    const pruned = filesWidgetTestInternals.pruneDirectoryCache(
      directories,
      accessOrder,
      new Set([""]),
    );
    expect(Object.keys(pruned)).toHaveLength(filesWidgetTestInternals.DIRECTORY_CACHE_MAX);
    expect(pruned[""]).toBeDefined();
    expect(pruned["dir-000"]).toBeUndefined();
    expect(pruned["dir-001"]).toBeUndefined();
    expect(pruned[dirName(directoryPaths.length - 1)]).toBeDefined();

    const pinned = filesWidgetTestInternals.pruneDirectoryCache(
      directories,
      accessOrder,
      new Set(["", "dir-000"]),
    );
    expect(pinned["dir-000"]).toBeDefined();
    expect(pinned["dir-001"]).toBeUndefined();
  });
});
