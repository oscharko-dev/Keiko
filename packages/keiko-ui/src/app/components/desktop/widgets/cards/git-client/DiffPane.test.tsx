// Behavioural unit tests for the DiffPane (Issue #1575, Epic #1571).
// Covers the staged/worktree scope toggle and the empty / loading / error / truncated / binary /
// no-diff states the issue requires the diff surface to represent clearly.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitDiffScope } from "@/lib/types";
import type { GitClientSeam } from "./git-client-seam";
import { DiffPane } from "./DiffPane";

function makeDiffResponse(diff: string, overrides: { readonly truncated?: boolean } = {}) {
  return {
    schemaVersion: "1" as const,
    root: "/repos/alpha",
    state: "available" as const,
    available: true,
    scope: "worktree" as const,
    diff,
    truncated: overrides.truncated ?? false,
    maxBytes: 131072,
  };
}

function makeSeam(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  const ok = { schemaVersion: "1" as const, status: "succeeded" as const, actionKind: "x" };
  return {
    listRepositories: vi.fn(async () => ({ projects: [] })),
    registerRepository: vi.fn<GitClientSeam["registerRepository"]>(),
    cloneRepository: vi.fn<GitClientSeam["cloneRepository"]>(),
    listBranches: vi.fn<GitClientSeam["listBranches"]>(),
    getStatus: vi.fn<GitClientSeam["getStatus"]>(),
    getDiff: vi.fn(async () => makeDiffResponse("")),
    branchCreate: vi.fn<GitClientSeam["branchCreate"]>(async () => ok),
    branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ok),
    stage: vi.fn<GitClientSeam["stage"]>(async () => ok),
    unstage: vi.fn<GitClientSeam["unstage"]>(async () => ok),
    commitPreview: vi.fn<GitClientSeam["commitPreview"]>(),
    commitExecute: vi.fn<GitClientSeam["commitExecute"]>(async () => ok),
    pushPreview: vi.fn<GitClientSeam["pushPreview"]>(),
    pushExecute: vi.fn<GitClientSeam["pushExecute"]>(async () => ok),
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
      scope="worktree"
      onScopeChange={onScopeChange}
      revision={0}
      {...props}
    />,
  );
  return { client, onScopeChange };
}

const REAL_DIFF = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,1 +1,1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
});

describe("DiffPane — states", () => {
  it("shows the empty prompt when no change is selected", () => {
    renderPane({ selectedChangePath: null });
    expect(screen.getByText("Select a change to view its diff.")).toBeInTheDocument();
  });

  it("shows a loading state while the diff is in flight", async () => {
    let resolve!: (v: ReturnType<typeof makeDiffResponse>) => void;
    const pending = new Promise<ReturnType<typeof makeDiffResponse>>((res) => {
      resolve = res;
    });
    renderPane({ client: makeSeam({ getDiff: vi.fn(() => pending) }) });

    expect(await screen.findByText("Loading diff…")).toBeInTheDocument();
    act(() => resolve(makeDiffResponse("")));
  });

  it("shows an error state when the diff request rejects", async () => {
    renderPane({
      client: makeSeam({
        getDiff: vi.fn(async () => {
          throw new Error("diff failed");
        }),
      }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("diff failed");
  });

  it("shows the no-diff state for an empty diff", async () => {
    renderPane({ client: makeSeam({ getDiff: vi.fn(async () => makeDiffResponse("")) }) });
    expect(await screen.findByText("No diff content for this change.")).toBeInTheDocument();
  });

  it("shows a binary-file notice instead of attempting to render a hunk", async () => {
    renderPane({
      client: makeSeam({
        getDiff: vi.fn(async () =>
          makeDiffResponse(
            "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n",
          ),
        ),
      }),
    });
    expect(await screen.findByText("Binary file — no text diff to display.")).toBeInTheDocument();
  });

  it("surfaces a truncated diff with a clear notice", async () => {
    renderPane({
      client: makeSeam({
        getDiff: vi.fn(async () => makeDiffResponse(REAL_DIFF, { truncated: true })),
      }),
    });
    expect(
      await screen.findByText("This diff is large and has been truncated."),
    ).toBeInTheDocument();
  });
});

describe("DiffPane — scope controls", () => {
  it("fetches the diff with the active scope", async () => {
    const { client } = renderPane({ scope: "staged" });
    await waitFor(() =>
      expect(client.getDiff).toHaveBeenCalledWith({
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
