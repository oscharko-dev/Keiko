// Behavioural unit tests for the DiffPane (Issue #1575, Epic #1571).
// Covers the staged/worktree scope toggle and the empty / loading / error / truncated / binary /
// no-diff states the issue requires the diff surface to represent clearly.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitEditorDiffFile, GitEditorDiffResponse } from "@oscharko-dev/keiko-contracts";
import type { GitDiffScope } from "@/lib/types";
import type { GitClientSeam } from "./git-client-seam";
import { DiffPane } from "./DiffPane";

function makeDiffFile(overrides: Partial<GitEditorDiffFile> = {}): GitEditorDiffFile {
  return {
    path: "src/index.ts",
    layer: "worktree",
    status: "modified",
    binary: false,
    hunks: [
      {
        header: "@@ -7,1 +7,1 @@",
        oldStart: 7,
        oldCount: 1,
        newStart: 7,
        newCount: 1,
        lines: [
          { kind: "del", oldLine: 7, newLine: null, text: "const a = 1;" },
          { kind: "add", oldLine: null, newLine: 7, text: "const a = 2;" },
        ],
        truncated: false,
      },
    ],
    addedLines: 1,
    removedLines: 1,
    truncated: false,
    ...overrides,
  };
}

function makeDiffResponse(
  files: readonly GitEditorDiffFile[] = [],
  overrides: Partial<GitEditorDiffResponse> = {},
): GitEditorDiffResponse {
  return {
    schemaVersion: "1",
    scope: "unstaged",
    files,
    truncated: false,
    totalFiles: files.length,
    totalBytes: 256,
    maxBytes: 524288,
    maxFiles: 400,
    ...overrides,
  };
}

function makeSeam(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  const ok = { schemaVersion: "1" as const, status: "succeeded" as const, actionKind: "x" };
  return {
    listRepositories: vi.fn(async () => ({ projects: [] })),
    registerRepository: vi.fn<GitClientSeam["registerRepository"]>(),
    cloneRepository: vi.fn<GitClientSeam["cloneRepository"]>(),
    listBranches: vi.fn<GitClientSeam["listBranches"]>(),
    getSummary: vi.fn<GitClientSeam["getSummary"]>(),
    getHistory: vi.fn<GitClientSeam["getHistory"]>(),
    getRemotes: vi.fn<GitClientSeam["getRemotes"]>(),
    getStatus: vi.fn<GitClientSeam["getStatus"]>(),
    getDiff: vi.fn<GitClientSeam["getDiff"]>(),
    getStructuredDiff: vi.fn(async () => makeDiffResponse()),
    branchCreate: vi.fn<GitClientSeam["branchCreate"]>(async () => ok),
    branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ok),
    stage: vi.fn<GitClientSeam["stage"]>(async () => ok),
    unstage: vi.fn<GitClientSeam["unstage"]>(async () => ok),
    commitPreview: vi.fn<GitClientSeam["commitPreview"]>(),
    commitExecute: vi.fn<GitClientSeam["commitExecute"]>(async () => ok),
    syncPreview: vi.fn<GitClientSeam["syncPreview"]>(),
    syncExecute: vi.fn<GitClientSeam["syncExecute"]>(),
    pushPreview: vi.fn<GitClientSeam["pushPreview"]>(),
    pushExecute: vi.fn<GitClientSeam["pushExecute"]>(async () => ok),
    prPreview: vi.fn<GitClientSeam["prPreview"]>(),
    prExecute: vi.fn<GitClientSeam["prExecute"]>(),
    mergePreview: vi.fn<GitClientSeam["mergePreview"]>(),
    mergeExecute: vi.fn<GitClientSeam["mergeExecute"]>(),
    ...overrides,
  };
}

function renderPane(props: Partial<Parameters<typeof DiffPane>[0]> = {}) {
  const onScopeChange = vi.fn<(scope: GitDiffScope) => void>();
  const client = props.client ?? makeSeam();
  render(
    <DiffPane
      client={client}
      repositoryRoot="/repos/alpha"
      selectedChangePath="src/index.ts"
      selectedCommit={null}
      scope="worktree"
      onScopeChange={onScopeChange}
      revision={0}
      {...props}
    />,
  );
  return { client, onScopeChange };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DiffPane — states", () => {
  it("shows the empty prompt when no change is selected", () => {
    renderPane({ selectedChangePath: null });
    expect(screen.getByText("Select a change to view its diff.")).toBeInTheDocument();
  });

  it("shows a loading state while the diff is in flight", async () => {
    let resolve!: (v: GitEditorDiffResponse) => void;
    const pending = new Promise<GitEditorDiffResponse>((res) => {
      resolve = res;
    });
    renderPane({ client: makeSeam({ getStructuredDiff: vi.fn(() => pending) }) });

    expect(await screen.findByText("Loading diff…")).toBeInTheDocument();
    act(() => resolve(makeDiffResponse()));
  });

  it("shows an error state when the diff request rejects", async () => {
    renderPane({
      client: makeSeam({
        getStructuredDiff: vi.fn(async () => {
          throw new Error("diff failed");
        }),
      }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("diff failed");
  });

  it("shows the no-diff state for an empty diff", async () => {
    renderPane({ client: makeSeam({ getStructuredDiff: vi.fn(async () => makeDiffResponse()) }) });
    expect(await screen.findByText("No diff content for this change.")).toBeInTheDocument();
  });

  it("shows a binary-file notice instead of attempting to render a hunk", async () => {
    renderPane({
      client: makeSeam({
        getStructuredDiff: vi.fn(async () =>
          makeDiffResponse([makeDiffFile({ path: "img.png", binary: true, hunks: [] })]),
        ),
      }),
    });
    expect(await screen.findByText("Binary file — no text diff to display.")).toBeInTheDocument();
  });

  it("surfaces a truncated diff with a clear notice", async () => {
    renderPane({
      client: makeSeam({
        getStructuredDiff: vi.fn(async () =>
          makeDiffResponse([makeDiffFile({ truncated: true })], { truncated: true }),
        ),
      }),
    });
    expect(
      await screen.findByText(/This diff is large and has been truncated at 524,288 bytes/u),
    ).toBeInTheDocument();
  });
});

describe("DiffPane — scope controls", () => {
  it("fetches the diff with the active scope", async () => {
    const { client } = renderPane({ scope: "staged" });
    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: "/repos/alpha",
        path: "src/index.ts",
        scope: "staged",
      }),
    );
  });

  it("renders a Worktree/Staged toggle reflecting the active scope", () => {
    renderPane({ scope: "worktree" });
    const group = screen.getByRole("group", { name: "Diff scope" });
    expect(within(group).getByRole("button", { name: "Worktree" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Staged" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("reports a scope change when the Staged tab is pressed", () => {
    const { onScopeChange } = renderPane({ scope: "worktree" });
    fireEvent.click(screen.getByRole("button", { name: "Staged" }));
    expect(onScopeChange).toHaveBeenCalledWith("staged");
  });
});

describe("DiffPane — structured navigation", () => {
  it("reveals the selected file at the first added line from the matching structured hunk", async () => {
    const onRevealFile = vi.fn();
    renderPane({
      client: makeSeam({
        getStructuredDiff: vi.fn(async () => makeDiffResponse([makeDiffFile()])),
      }),
      revealRequestId: 1,
      onRevealFile,
    });

    await waitFor(() => expect(onRevealFile).toHaveBeenCalledWith("src/index.ts", 7));
  });

  it("drops a late response after the selected path changes", async () => {
    let resolveOld!: (value: GitEditorDiffResponse) => void;
    const oldResponse = new Promise<GitEditorDiffResponse>((resolve) => {
      resolveOld = resolve;
    });
    const getStructuredDiff = vi
      .fn<GitClientSeam["getStructuredDiff"]>()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(makeDiffResponse([makeDiffFile({ path: "src/new.ts" })]));
    const onRevealFile = vi.fn();
    const { rerender } = render(
      <DiffPane
        client={makeSeam({ getStructuredDiff })}
        repositoryRoot="/repos/alpha"
        selectedChangePath="src/old.ts"
        selectedCommit={null}
        scope="worktree"
        onScopeChange={vi.fn()}
        revealRequestId={1}
        onRevealFile={onRevealFile}
        revision={0}
      />,
    );

    rerender(
      <DiffPane
        client={makeSeam({ getStructuredDiff })}
        repositoryRoot="/repos/alpha"
        selectedChangePath="src/new.ts"
        selectedCommit={null}
        scope="worktree"
        onScopeChange={vi.fn()}
        revealRequestId={2}
        onRevealFile={onRevealFile}
        revision={0}
      />,
    );
    await waitFor(() => expect(onRevealFile).toHaveBeenCalledWith("src/new.ts", 7));
    act(() => resolveOld(makeDiffResponse([makeDiffFile({ path: "src/old.ts" })])));

    expect(onRevealFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the structured binary and truncation surface axe-clean", async () => {
    const { container } = render(
      <DiffPane
        client={makeSeam({
          getStructuredDiff: vi.fn(async () =>
            makeDiffResponse(
              [makeDiffFile({ path: "asset.bin", binary: true, hunks: [], truncated: true })],
              { truncated: true },
            ),
          ),
        })}
        repositoryRoot="/repos/alpha"
        selectedChangePath="asset.bin"
        selectedCommit={null}
        scope="worktree"
        onScopeChange={vi.fn()}
        revision={0}
      />,
    );
    await screen.findByText("Binary file — no text diff to display.");

    expect(await axe(container)).toHaveNoViolations();
  });
});
