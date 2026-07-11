import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesContentResponse, LanguageServiceCapabilities } from "../../../../../lib/types";
import {
  fetchEditorLanguageCapabilities,
  fetchFilesContent,
  fetchGitStatus,
  fetchGitStructuredDiff,
  fetchGitBlame,
  postEditorAgentSessionSnapshot,
  saveFilesContent,
} from "../../../../../lib/api";
import type { EditorSurfaceProps } from "./EditorSurface";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import EditorRuntimeWidget from "./EditorRuntimeWidget";
import { WORKSPACE_FILE_MUTATED_EVENT } from "./workspace-file-events";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchEditorLanguageCapabilities: vi.fn(),
    fetchFilesContent: vi.fn(),
    fetchGitStatus: vi.fn(),
    fetchGitStructuredDiff: vi.fn(),
    fetchGitBlame: vi.fn(),
    postEditorAgentSessionSnapshot: vi.fn(),
    saveFilesContent: vi.fn(),
  };
});

vi.mock("./editorHotExitStore", () => ({
  readEditorHotExitSnapshot: vi.fn(() => Promise.resolve(null)),
  writeEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
  deleteEditorHotExitSnapshot: vi.fn(() => Promise.resolve()),
}));

const surface: { props: EditorSurfaceProps | null } = { props: null };

vi.mock("next/dynamic", () => {
  let index = 0;
  return {
    default: () => {
      if (index++ > 0) {
        return function EditorDiffSurfaceProbe(_props: EditorDiffSurfaceProps): ReactElement {
          return <div data-testid="editor-diff-surface" />;
        };
      }
      return function EditorSurfaceProbe(props: EditorSurfaceProps): ReactElement {
        surface.props = props;
        return <div data-testid="editor-surface" />;
      };
    },
  };
});

const VERSION = { sizeBytes: 17, modifiedAt: 1, contentHash: "a".repeat(64) };
const CAPABILITIES: LanguageServiceCapabilities = { schemaVersion: "1", providers: [] };

function fileResponse(
  content = "const value = 1;\n",
  root = "/repo",
  path = "src/app.ts",
): FilesContentResponse {
  return {
    root,
    path,
    name: path.split("/").at(-1) ?? path,
    sizeBytes: content.length,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    content,
    maxBytes: 1_000_000,
    session: { schemaVersion: "1", version: VERSION },
  };
}

const HUNK = {
  header: "@@ -1,1 +1,1 @@",
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  lines: [{ kind: "add" as const, text: "const value = 1;", oldLine: null, newLine: 1 }],
  truncated: false,
};

function diff(scope: "staged" | "unstaged") {
  return {
    schemaVersion: "1" as const,
    scope,
    files: [
      {
        path: "src/app.ts",
        layer: scope === "staged" ? ("staged" as const) : ("worktree" as const),
        status: "modified" as const,
        binary: false,
        hunks: [HUNK],
        addedLines: 1,
        removedLines: 0,
        truncated: false,
      },
    ],
    truncated: false,
    totalFiles: 1,
    totalBytes: 10,
    maxBytes: 524288 as const,
    maxFiles: 400 as const,
  };
}

async function renderEditor(content?: string): Promise<ReturnType<typeof render>> {
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse(content));
  const rendered = render(
    <EditorRuntimeWidget windowId="git-gutter" root="/repo" file="src/app.ts" />,
  );
  await screen.findByTestId("editor-surface");
  return rendered;
}

async function renderEditorWithBlame(onOpenGitCommit = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
  render(
    <EditorRuntimeWidget
      windowId="blame"
      root="/repo"
      file="src/app.ts"
      onOpenGitCommit={onOpenGitCommit}
    />,
  );
  await screen.findByTestId("editor-surface");
  return onOpenGitCommit;
}

beforeEach(() => {
  vi.mocked(fetchEditorLanguageCapabilities).mockResolvedValue(CAPABILITIES);
  vi.mocked(postEditorAgentSessionSnapshot).mockResolvedValue({ snapshot: null });
  vi.mocked(fetchGitStatus).mockResolvedValue({
    schemaVersion: "1",
    root: "/repo",
    state: "available",
    available: true,
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
  vi.mocked(fetchGitStructuredDiff).mockImplementation(async ({ scope }) => diff(scope));
  vi.mocked(fetchGitBlame).mockResolvedValue({
    schemaVersion: "1",
    path: "src/app.ts",
    startLine: 1,
    lines: [
      {
        line: 1,
        commitHash: "a".repeat(40),
        author: "Ada",
        authorTime: "2026-06-10T10:00:00Z",
        summary: "Explain line",
      },
    ],
    truncated: false,
    totalLines: 1,
    totalBytes: 80,
    maxBytes: 262_144,
    maxLines: 2_000,
  });
});

afterEach(() => {
  surface.props = null;
  vi.clearAllMocks();
});

describe("EditorRuntimeWidget Git gutter", () => {
  it("opens the active file diff in the root-bound internal Git Client", async () => {
    const onOpenGitDiff = vi.fn();
    vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse());
    render(
      <EditorRuntimeWidget
        windowId="git-diff-navigation"
        root="/repo"
        file="src/app.ts"
        onOpenGitDiff={onOpenGitDiff}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Show this file's diff in Git" }));

    expect(onOpenGitDiff).toHaveBeenCalledWith("/repo", "src/app.ts");
  });

  it("wires live merge-conflict status and an accessible tab badge without saving", async () => {
    const { container } = await renderEditor(
      "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n",
    );
    expect(surface.props?.editorConflicts).toBeDefined();

    act(() => surface.props?.editorConflicts?.onChange(2, false));

    expect(screen.getByRole("tab", { name: "src/app.ts, 2 merge conflicts" })).toHaveAttribute(
      "data-merge-conflicts",
      "2",
    );
    expect(screen.getByTestId("editor-status-bar-live")).toHaveTextContent("2 merge conflicts");
    expect(saveFilesContent).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("reports gitContextSummary on the posted agent snapshot (Issue #2234, ADR-0127)", async () => {
    vi.mocked(fetchGitStatus).mockResolvedValue({
      schemaVersion: "1",
      root: "/repo",
      state: "available",
      available: true,
      detached: false,
      clean: false,
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 0,
      conflictedCount: 1,
      changes: [
        {
          path: "src/app.ts",
          indexStatus: "M",
          worktreeStatus: " ",
          staged: true,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
        {
          path: "src/other.ts",
          indexStatus: " ",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
        },
        {
          path: "src/conflict.ts",
          indexStatus: "U",
          worktreeStatus: "U",
          staged: false,
          unstaged: false,
          untracked: false,
          conflicted: true,
        },
      ],
      truncated: false,
      maxChanges: 500,
    });
    await renderEditor("<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n");

    await waitFor(() => {
      const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
      expect(snapshot?.gitContextSummary).toEqual({
        hasConflictMarkers: false,
        changedFileCount: 3,
        truncated: false,
      });
    });

    act(() => surface.props?.editorConflicts?.onChange(2, false));

    await waitFor(() => {
      const snapshot = vi.mocked(postEditorAgentSessionSnapshot).mock.calls.at(-1)?.[0];
      expect(snapshot?.gitContextSummary).toEqual({
        hasConflictMarkers: true,
        changedFileCount: 3,
        truncated: false,
      });
    });
  });

  it("reads staged and unstaged once per bridge refresh and never from content changes", async () => {
    await renderEditor();
    const gutter = surface.props?.editorGitGutter;
    expect(gutter).toBeDefined();
    await gutter?.resolve();
    expect(fetchGitStructuredDiff).toHaveBeenCalledTimes(2);

    act(() => {
      surface.props?.onContentChange({ text: "typed", sizeBytes: 5 }, "human");
    });
    expect(fetchGitStructuredDiff).toHaveBeenCalledTimes(2);
  });

  it("increments the refresh trigger explicitly and after a successful save", async () => {
    const mutation = vi.fn<(event: Event) => void>();
    window.addEventListener(WORKSPACE_FILE_MUTATED_EVENT, mutation, { once: true });
    vi.mocked(saveFilesContent).mockResolvedValue({
      ...fileResponse("typed"),
      content: "typed",
      sizeBytes: 5,
      session: { schemaVersion: "1", version: { ...VERSION, sizeBytes: 5 } },
    });
    await renderEditor();
    const initial = surface.props?.gitGutterRefreshNonce ?? 0;
    fireEvent.click(screen.getByRole("button", { name: "Refresh editor change indicators" }));
    await waitFor(() => expect(surface.props?.gitGutterRefreshNonce).toBe(initial + 1));

    act(() => {
      surface.props?.onContentChange({ text: "typed", sizeBytes: 5 }, "human");
    });
    const request = {
      identity: surface.props?.fileModel.identity ?? {
        uri: "/repo/src/app.ts",
        language: "typescript" as const,
        version: 0,
      },
      content: {
        relativePath: "src/app.ts",
        text: "typed",
        sizeBytes: 5,
        truncated: false,
      },
      expectedSavedVersion: 0,
    };
    act(() => surface.props?.onSaveRequested(request));
    await waitFor(() => expect(surface.props?.gitGutterRefreshNonce).toBe(initial + 2));
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("opens and dismisses the localized shared hunk peek", async () => {
    await renderEditor();
    act(() => surface.props?.editorGitGutter?.onPeek({ hunk: HUNK, layer: "unstaged" }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(
      "Change preview: src/app.ts, Unstaged change",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close change preview" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not expose gutter work for a degraded large file", async () => {
    await renderEditor("line\n".repeat(10_001));
    expect(surface.props?.editorGitGutter).toBeUndefined();
    expect(fetchGitStructuredDiff).not.toHaveBeenCalled();
  });

  it("keeps blame strictly on demand and links only the selected root and commit", async () => {
    const onOpenGitCommit = await renderEditorWithBlame();
    expect(fetchGitBlame).not.toHaveBeenCalled();
    const blame = surface.props?.editorBlame;
    expect(blame).toBeDefined();
    await blame?.resolve();
    expect(fetchGitBlame).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/app.ts",
      startLine: 1,
      maxLines: 2_000,
    });
    blame?.onCommit("a".repeat(40));
    expect(onOpenGitCommit).toHaveBeenCalledWith("/repo", "a".repeat(40));
  });

  it("does not expose blame in degraded mode", async () => {
    vi.mocked(fetchFilesContent).mockResolvedValue(fileResponse("line\n".repeat(10_001)));
    render(
      <EditorRuntimeWidget
        windowId="blame-degraded"
        root="/repo"
        file="src/app.ts"
        onOpenGitCommit={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-surface");
    expect(surface.props?.editorBlame).toBeUndefined();
    expect(fetchGitBlame).not.toHaveBeenCalled();
  });

  it("keeps the blame-capable editor surface axe-clean", async () => {
    const { container } = render(
      <EditorRuntimeWidget
        windowId="blame-a11y"
        root="/repo"
        file="src/app.ts"
        onOpenGitCommit={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-surface");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("drops a blame response after the active root and file change", async () => {
    let finish = (_response: Awaited<ReturnType<typeof fetchGitBlame>>): void => undefined;
    vi.mocked(fetchGitBlame).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(fetchFilesContent).mockImplementation(async (root, path) =>
      fileResponse("const value = 1;\n", root, path),
    );
    const view = render(
      <EditorRuntimeWidget
        windowId="blame-stale"
        root="/repo"
        file="src/app.ts"
        onOpenGitCommit={vi.fn()}
      />,
    );
    await screen.findByTestId("editor-surface");
    const pending = surface.props?.editorBlame?.resolve();
    view.rerender(
      <EditorRuntimeWidget
        windowId="blame-stale"
        root="/other"
        file="src/other.ts"
        onOpenGitCommit={vi.fn()}
      />,
    );
    finish({
      schemaVersion: "1",
      path: "src/app.ts",
      startLine: 1,
      lines: [],
      truncated: false,
      totalLines: 0,
      totalBytes: 0,
      maxBytes: 262_144,
      maxLines: 2_000,
    });
    await expect(pending).resolves.toBeNull();
  });
});
