// Behavioural unit tests for the GitClientWindow shell (Issue #1574, Epic #1571).
// Uses a makeClient(overrides) factory returning a GitClientSeam with vi.fn() stubs so
// no module-level vi.mock() is needed (the client prop is the DI seam).
//
// Coverage targets (EV2/EV4):
//   - Repository selector lists multiple repos; selecting calls updateCfg/onSelect
//   - Add-repository dialog: clone → cloneRepository; open-local → registerRepository
//   - Toolbar: Open in Editor / Open Files call callbacks with current root; Sync renders
//   - Changes/History tabs: role=tab, aria-selected toggles, keyboard Left/Right/Home/End
//   - Empty state (no repo), loading state, error state all render finished states
//   - Changed-files list renders from status with glyphs; selecting a change triggers diff
//   - Visible words: Git, Repository, Changes, History, Branch, Commit, Sync, Pull Request, Merge
//   - Absent words: Governance, Governed Git, Delivery path

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitChangedFile, ProjectWithAvailability } from "@/lib/types";
import type { GitBranchListResponse, GitDeliveryCommitPreviewResponse } from "@/lib/api";
import type { GitRepositoryStatusResponse } from "@/lib/types";
import type { GitClientSeam } from "./git-client-seam";
import { GitClientWindow } from "./GitClientWindow";

// ─── ResizeObserver stub (no global shim in vitest.setup.ts) ──────────────────

if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
}

// ─── Fixture helpers ───────────────────────────────────────────────────────────

function makeRepo(
  path: string,
  name: string,
  extra?: Partial<ProjectWithAvailability>,
): ProjectWithAvailability {
  return {
    path,
    name,
    favorite: false,
    createdAt: 0,
    lastOpenedAt: 0,
    available: true,
    ...extra,
  };
}

const REPO_A = makeRepo("/repos/alpha", "alpha");
const REPO_B = makeRepo("/repos/beta", "beta");

function makeBranchList(overrides: Partial<GitBranchListResponse> = {}): GitBranchListResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    available: true,
    state: "available",
    branches: [
      { name: "main", headRefHash: "aaa", current: true },
      { name: "feat/x", headRefHash: "bbb", current: false },
    ],
    truncated: false,
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<GitRepositoryStatusResponse> = {},
): GitRepositoryStatusResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    detached: false,
    clean: true,
    branch: "main",
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [],
    truncated: false,
    maxChanges: 50,
    ...overrides,
  };
}

function change(path: string, flags: Partial<GitChangedFile> = {}): GitChangedFile {
  return {
    path,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    ...flags,
  };
}

// A repository whose working tree exercises every changed-file state #1575 must represent.
function makeStatusRich(): GitRepositoryStatusResponse {
  return makeStatus({
    clean: false,
    stagedCount: 2,
    unstagedCount: 2,
    untrackedCount: 1,
    conflictedCount: 1,
    changes: [
      change("src/index.ts", { indexStatus: "M", staged: true }),
      change("README.md", { worktreeStatus: "M", unstaged: true }),
      change("notes.txt", { indexStatus: "?", worktreeStatus: "?", untracked: true }),
      change("merge.ts", { indexStatus: "U", worktreeStatus: "U", conflicted: true }),
      change("partial.ts", { indexStatus: "M", worktreeStatus: "M", staged: true, unstaged: true }),
    ],
  });
}

function makeStatusWithChanges(): GitRepositoryStatusResponse {
  return makeStatus({
    clean: false,
    stagedCount: 1,
    unstagedCount: 1,
    changes: [
      {
        path: "src/index.ts",
        indexStatus: "M",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
      {
        path: "README.md",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        untracked: false,
        conflicted: false,
      },
    ],
  });
}

function makeProjectResponse(repo: ProjectWithAvailability) {
  return { project: repo };
}

function makeDiffResponse(diff: string, overrides: { readonly truncated?: boolean } = {}) {
  return {
    schemaVersion: "1" as const,
    root: "/repos/alpha",
    state: "available" as const,
    available: true,
    scope: "all" as const,
    diff,
    truncated: overrides.truncated ?? false,
    maxBytes: 131072,
  };
}

function makeCommitPreview(
  overrides: Partial<GitDeliveryCommitPreviewResponse> = {},
): GitDeliveryCommitPreviewResponse {
  return {
    schemaVersion: "1",
    summary: { stagedFileCount: 1, areaCount: 1, areas: ["src"], touchesTests: false },
    intent: { warnings: [], mixedScope: false, isWip: false },
    messageValidation: { ok: true },
    preflightFindingCodes: [],
    policyOutcome: "allowed",
    ...overrides,
  };
}

// ─── makeClient factory ────────────────────────────────────────────────────────

function makeClient(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  return {
    listRepositories: vi.fn(async () => ({ projects: [REPO_A, REPO_B] })),
    registerRepository: vi.fn(async () => makeProjectResponse(REPO_A)),
    cloneRepository: vi.fn(async () => makeProjectResponse(REPO_A)),
    listBranches: vi.fn(async () => makeBranchList()),
    getStatus: vi.fn(async () => makeStatus()),
    getDiff: vi.fn(async () => makeDiffResponse("")),
    // Carry-forward mutation refs — not called by the shell; typed against the real seam
    // method signatures so the stubs satisfy TS without `any`.
    branchCreate: vi.fn<GitClientSeam["branchCreate"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "branch-create",
    })),
    branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "branch-switch",
    })),
    stage: vi.fn<GitClientSeam["stage"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "stage",
    })),
    unstage: vi.fn<GitClientSeam["unstage"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "unstage",
    })),
    commitPreview: vi.fn<GitClientSeam["commitPreview"]>(async () => makeCommitPreview()),
    commitExecute: vi.fn<GitClientSeam["commitExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "commit",
    })),
    pushPreview: vi.fn<GitClientSeam["pushPreview"]>(),
    pushExecute: vi.fn<GitClientSeam["pushExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "push",
    })),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks();
});

describe("GitClientWindow — repository list", () => {
  it("lists multiple repos in the sidebar after load", async () => {
    render(<GitClientWindow client={makeClient()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /beta/ })).toBeInTheDocument();
  });

  it("selecting a repo from the sidebar calls updateCfg with the repo path", async () => {
    const updateCfg = vi.fn();
    const client = makeClient();
    render(<GitClientWindow client={client} updateCfg={updateCfg} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("option", { name: /alpha/ }));

    expect(updateCfg).toHaveBeenCalledWith({ projectPath: REPO_A.path });
  });

  it("selecting a repo triggers a branch and status load for the chosen path", async () => {
    const client = makeClient();
    render(<GitClientWindow client={client} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("option", { name: /alpha/ }));

    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));
    expect(client.getStatus).toHaveBeenCalledWith(REPO_A.path);
  });

  it("hides stale changed-file rows while a newly selected repository is loading", async () => {
    let resolveBetaStatus!: (value: GitRepositoryStatusResponse) => void;
    const betaStatus = new Promise<GitRepositoryStatusResponse>((res) => {
      resolveBetaStatus = res;
    });
    const client = makeClient({
      getStatus: vi.fn((path: string) =>
        path === REPO_A.path ? Promise.resolve(makeStatusRich()) : betaStatus,
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("option", { name: /beta/ }));

    await waitFor(() => expect(client.getStatus).toHaveBeenCalledWith(REPO_B.path));
    expect(screen.queryByLabelText("Stage README.md")).not.toBeInTheDocument();
    expect(screen.getByText("Loading changes…")).toBeInTheDocument();

    act(() => resolveBetaStatus(makeStatus()));
  });

  it("renders a loading state while repos are being fetched", async () => {
    let resolve!: (v: { projects: readonly ProjectWithAvailability[] }) => void;
    const pending = new Promise<{ projects: readonly ProjectWithAvailability[] }>((res) => {
      resolve = res;
    });
    const client = makeClient({ listRepositories: vi.fn(() => pending) });
    render(<GitClientWindow client={client} />);

    expect(screen.getByText("Loading repositories…")).toBeInTheDocument();

    // Resolve to avoid async leak in test runner
    act(() => resolve({ projects: [] }));
  });

  it("shows the error message when listRepositories rejects", async () => {
    const client = makeClient({
      listRepositories: vi.fn(async () => {
        throw new Error("Network failure");
      }),
    });
    render(<GitClientWindow client={client} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Network failure");
  });

  it("renders search input with accessible label", async () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.getByRole("searchbox", { name: "Search repositories" })).toBeInTheDocument();
  });

  it("supports Arrow, Home, and End keyboard movement between repositories", async () => {
    render(<GitClientWindow client={makeClient()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    const alpha = screen.getByRole("option", { name: /alpha/ });
    const beta = screen.getByRole("option", { name: /beta/ });
    alpha.focus();

    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(beta).toHaveFocus();

    fireEvent.keyDown(beta, { key: "Home" });
    expect(alpha).toHaveFocus();

    fireEvent.keyDown(alpha, { key: "End" });
    expect(beta).toHaveFocus();
  });
});

describe("GitClientWindow — repository selector combobox (toolbar)", () => {
  it("renders the Repository combobox trigger in the toolbar", async () => {
    render(<GitClientWindow client={makeClient()} />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Repository" })).toBeInTheDocument(),
    );
  });
});

describe("GitClientWindow — add-repository dialog", () => {
  it("opens the dialog when the add-repository button is clicked", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add repository" }));

    expect(screen.getByRole("dialog", { name: "Add repository" })).toBeInTheDocument();
  });

  it("Clone mode calls cloneRepository with {repositoryUrl, destinationPath}", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow client={client} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = screen.getByRole("dialog");

    // Clone mode is default
    await user.type(
      within(dialog).getByLabelText("Repository URL"),
      "https://github.com/org/repo.git",
    );
    await user.type(within(dialog).getByLabelText("Clone to folder"), "/tmp/repo");
    // Two buttons are named "Clone repository": the mode-toggle and the submit.
    // Target the submit button (last in the dialog).
    const cloneBtns = within(dialog).getAllByRole("button", { name: "Clone repository" });
    await user.click(cloneBtns[cloneBtns.length - 1]!);

    await waitFor(() =>
      expect(client.cloneRepository).toHaveBeenCalledWith({
        repositoryUrl: "https://github.com/org/repo.git",
        destinationPath: "/tmp/repo",
      }),
    );
  });

  it("Open local mode calls registerRepository with {path}", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow client={client} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = screen.getByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Open local repository" }));
    await user.type(
      within(dialog).getByLabelText("Local repository path"),
      "/home/me/existing-repo",
    );
    await user.click(within(dialog).getByRole("button", { name: "Open repository" }));

    await waitFor(() =>
      expect(client.registerRepository).toHaveBeenCalledWith({ path: "/home/me/existing-repo" }),
    );
  });

  it("closes the dialog on Escape", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add repository" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("GitClientWindow — toolbar actions", () => {
  it("Open in Editor calls onOpenEditor with the selected repository path", async () => {
    const onOpenEditor = vi.fn();
    const client = makeClient();
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        onOpenEditor={onOpenEditor}
        onOpenFiles={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.listBranches).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Open in Editor/ }));
    expect(onOpenEditor).toHaveBeenCalledWith(REPO_A.path);
  });

  it("Open Files calls onOpenFiles with the selected repository path", async () => {
    const onOpenFiles = vi.fn();
    const client = makeClient();
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        onOpenEditor={vi.fn()}
        onOpenFiles={onOpenFiles}
      />,
    );
    await waitFor(() => expect(client.listBranches).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Open Files/ }));
    expect(onOpenFiles).toHaveBeenCalledWith(REPO_A.path);
  });

  it("Open in Editor and Open Files are absent when callbacks are not provided", () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.queryByRole("button", { name: /Open in Editor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open Files/ })).not.toBeInTheDocument();
  });

  it("Sync status renders with a text label", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ clean: true })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());

    const pill = await screen.findByRole("status", { name: /^Sync/ });
    expect(pill).toBeInTheDocument();
  });

  it("Create Pull Request opens the reused PR window with the selected repository", async () => {
    const openWindow = vi.fn();
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} openWindow={openWindow} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Create Pull Request/ }));

    expect(openWindow).toHaveBeenCalledWith("governedPullRequest", {
      projectPath: REPO_A.path,
    });
  });

  it("Merge opens the reused merge window with the selected repository", async () => {
    const openWindow = vi.fn();
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} openWindow={openWindow} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Merge/ }));

    expect(openWindow).toHaveBeenCalledWith("governedMerge", {
      projectPath: REPO_A.path,
    });
  });
});

describe("GitClientWindow — Changes/History tabs", () => {
  it("renders a tablist with Changes and History tabs, Changes aria-selected initially", async () => {
    render(<GitClientWindow client={makeClient()} />);
    const tablist = screen.getByRole("tablist");
    expect(tablist).toBeInTheDocument();

    const changesTab = within(tablist).getByRole("tab", { name: "Changes" });
    const historyTab = within(tablist).getByRole("tab", { name: "History" });

    expect(changesTab).toHaveAttribute("aria-selected", "true");
    expect(historyTab).toHaveAttribute("aria-selected", "false");
  });

  it("clicking History tab makes it aria-selected and deselects Changes", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);
    const tablist = screen.getByRole("tablist");

    await user.click(within(tablist).getByRole("tab", { name: "History" }));

    expect(within(tablist).getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(tablist).getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("ArrowRight on Changes tab moves focus and selection to History", async () => {
    render(<GitClientWindow client={makeClient()} />);
    const changesTab = screen.getByRole("tab", { name: "Changes" });
    changesTab.focus();
    fireEvent.keyDown(changesTab, { key: "ArrowRight" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("ArrowLeft on History tab wraps back to Changes", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);

    // Navigate to History first
    await user.click(screen.getByRole("tab", { name: "History" }));
    const historyTab = screen.getByRole("tab", { name: "History" });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: "ArrowLeft" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("Home key on History tab moves to Changes", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);

    await user.click(screen.getByRole("tab", { name: "History" }));
    const historyTab = screen.getByRole("tab", { name: "History" });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: "Home" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("End key on Changes tab moves to History", async () => {
    render(<GitClientWindow client={makeClient()} />);
    const changesTab = screen.getByRole("tab", { name: "Changes" });
    changesTab.focus();
    fireEvent.keyDown(changesTab, { key: "End" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"),
    );
  });
});

describe("GitClientWindow — empty / loading / error states", () => {
  it("shows empty state when no repo is selected (no status, no changes)", () => {
    render(<GitClientWindow client={makeClient()} />);
    // Before any selection the changes pane shows a prompt
    expect(screen.getByText(/Select a repository to view its changes/i)).toBeInTheDocument();
  });

  it("shows a loading state while status is pending after repo selection", async () => {
    let resolveStatus!: (v: GitRepositoryStatusResponse) => void;
    const pendingStatus = new Promise<GitRepositoryStatusResponse>((res) => {
      resolveStatus = res;
    });
    const client = makeClient({ getStatus: vi.fn(() => pendingStatus) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    // listBranches resolves quickly; status is still pending
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    expect(screen.getByText(/Loading changes/i)).toBeInTheDocument();

    act(() => resolveStatus(makeStatus()));
  });

  it("shows an error state when getStatus rejects", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => {
        throw new Error("Status fetch failed");
      }),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Status fetch failed");
  });

  it("shows no-changes empty state when status is clean", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ clean: true })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await waitFor(() => expect(screen.getByText("No changes")).toBeInTheDocument());
  });
});

describe("GitClientWindow — changed-files list and diff selection", () => {
  it("renders changed files with single-char glyphs from status", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    // "M" glyph for staged file, "M" for worktree-only file
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("selecting a changed file triggers getDiff with root and path", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
      getDiff: vi.fn(async () => makeDiffResponse("")),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());
    fireEvent.click(screen.getByText("src/index.ts").closest("button")!);

    // src/index.ts is staged-only, so the pane defaults its scope to "staged".
    await waitFor(() =>
      expect(client.getDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "src/index.ts",
        scope: "staged",
      }),
    );
  });

  it("renders every file section of a multi-file diff (no silent truncation)", async () => {
    // A single diff payload can describe more than one file. The pane must render all of
    // them, not just the first — otherwise additional files are silently dropped.
    const multiFileDiff = [
      "diff --git a/src/first.ts b/src/first.ts",
      "--- a/src/first.ts",
      "+++ b/src/first.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/src/second.ts b/src/second.ts",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      "@@ -1,1 +1,1 @@",
      "-const b = 1;",
      "+const b = 2;",
      "",
    ].join("\n");
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
      getDiff: vi.fn(async () => makeDiffResponse(multiFileDiff)),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());
    fireEvent.click(screen.getByText("src/index.ts").closest("button")!);

    // Both file headings from the diff must be present — the second file is the regression guard.
    await waitFor(() => expect(screen.getByText("src/first.ts")).toBeInTheDocument());
    expect(screen.getByText("src/second.ts")).toBeInTheDocument();
  });
});

describe("GitClientWindow — required visible / absent words", () => {
  // The contract (§7 / EV2/EV4) requires each of these words to appear in visible rendered text
  // or accessible names. We assert them via the most reliable queries available for each word:
  // getByText (exact substring match in rendered node text) or getByRole/getByLabelText where
  // textContent concatenation makes word-boundary regexes unreliable.

  it("renders 'Git' as a visible heading/label in the toolbar", () => {
    render(<GitClientWindow client={makeClient()} />);
    // The word "Git" appears as the standalone header span text in the toolbar
    expect(screen.getByText("Git")).toBeInTheDocument();
  });

  it("renders 'Repository' as the combobox label in the toolbar", async () => {
    render(<GitClientWindow client={makeClient()} />);
    // KeikoSelect renders with aria-label="Repository"
    expect(screen.getByRole("combobox", { name: "Repository" })).toBeInTheDocument();
  });

  it("renders 'Changes' as a visible tab label", () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.getByRole("tab", { name: "Changes" })).toBeInTheDocument();
  });

  it("renders 'History' as a visible tab label", () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.getByRole("tab", { name: "History" })).toBeInTheDocument();
  });

  it("renders 'Branch' as the branch combobox label in the toolbar", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Branch" })).toBeInTheDocument(),
    );
  });

  it("renders 'Sync' in the status pill", async () => {
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    // Sync status pill text always starts with "Sync"
    expect(screen.getByLabelText(/^Sync/)).toBeInTheDocument();
  });

  it("renders 'Pull Request' as a visible button", async () => {
    render(<GitClientWindow client={makeClient()} onOpenEditor={vi.fn()} openWindow={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Pull Request/ })).toBeInTheDocument();
  });

  it("renders 'Merge' as a visible button", async () => {
    render(<GitClientWindow client={makeClient()} onOpenEditor={vi.fn()} openWindow={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Merge/ })).toBeInTheDocument();
  });

  it("renders 'Commit' as visible text in the History tab panel", async () => {
    // "Commit" is required visible vocabulary per contract §7. It appears in the History
    // tab panel's empty state ("Commit history appears here…"). Asserting the rendered word
    // directly — rather than a proxy like "Clone repository" — keeps the requirement
    // mutation-robust: renaming the empty-state copy away from "Commit" fails this test.
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    // The commit composer (which also renders the word "Commit") lives in the always-mounted
    // Changes panel, so target the History panel's own empty-state copy precisely.
    expect(screen.getByText(/Commit history/)).toBeInTheDocument();
  });

  it("never renders forbidden governance / delivery vocabulary in visible text", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
    });
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        onOpenEditor={vi.fn()}
        openWindow={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.listRepositories).toHaveBeenCalled());

    const body = document.body.textContent ?? "";

    expect(body).not.toMatch(/\bGovernance\b/);
    expect(body).not.toMatch(/Governed Git/);
    expect(body).not.toMatch(/Delivery path/);
  });
});

describe("GitClientWindow — staging controls (Issue #1575)", () => {
  it("renders staged / unstaged / untracked / conflicted indicators with checkboxes", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());
    // A staged file's checkbox is checked and reads "Unstage <path>".
    expect(screen.getByLabelText("Unstage src/index.ts")).toBeChecked();
    // An unstaged file's checkbox is unchecked and reads "Stage <path>".
    expect(screen.getByLabelText("Stage README.md")).not.toBeChecked();
    // Indicator badges convey state as words (never colour alone).
    expect(screen.getByText("Untracked")).toBeInTheDocument();
    expect(screen.getByText("Conflict")).toBeInTheDocument();
    expect(screen.getByText("Partially staged")).toBeInTheDocument();
  });

  it("checking an unstaged file stages it through the stage route", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    await waitFor(() =>
      expect(client.stage).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        pathspecs: ["README.md"],
        includeUntracked: false,
      }),
    );
  });

  it("staging an untracked file passes includeUntracked: true", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Stage notes.txt"));

    await waitFor(() =>
      expect(client.stage).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        pathspecs: ["notes.txt"],
        includeUntracked: true,
      }),
    );
  });

  it("unchecking a staged file unstages it through the unstage route", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Unstage src/index.ts"));

    await waitFor(() =>
      expect(client.unstage).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        pathspecs: ["src/index.ts"],
      }),
    );
  });

  it("Stage all stages every unstaged and untracked path with includeUntracked", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));

    await waitFor(() => expect(client.stage).toHaveBeenCalled());
    expect(client.stage).toHaveBeenCalledWith({
      projectId: REPO_A.path,
      pathspecs: ["README.md", "notes.txt", "partial.ts"],
      includeUntracked: true,
    });
  });

  it("Unstage all unstages every staged path", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Unstage all" }));

    await waitFor(() => expect(client.unstage).toHaveBeenCalled());
    expect(client.unstage).toHaveBeenCalledWith({
      projectId: REPO_A.path,
      pathspecs: ["src/index.ts", "partial.ts"],
    });
  });

  it("disables bulk staging when the status response is truncated", async () => {
    const truncatedStatus = { ...makeStatusRich(), truncated: true, maxChanges: 2 };
    const client = makeClient({ getStatus: vi.fn(async () => truncatedStatus) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Stage all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unstage all" })).toBeDisabled();
  });

  it("refreshes the changed-file list after a successful stage", async () => {
    const getStatus = vi.fn(async () => makeStatusRich());
    const client = makeClient({ getStatus });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());
    const callsBefore = getStatus.mock.calls.length;

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    const outcome = await screen.findByTestId("git-staging-outcome");
    expect(outcome).toHaveAttribute("role", "status");
    expect(outcome).toHaveTextContent("Succeeded");
  });

  it("surfaces a blocked staging outcome without refreshing", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      stage: vi.fn<GitClientSeam["stage"]>(async () => ({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "stage",
        blockReason: "policy-denied",
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    const outcome = await screen.findByTestId("git-staging-outcome");
    expect(outcome).toHaveTextContent("Blocked");
    expect(outcome).toHaveTextContent("policy-denied");
  });

  it("does not surface an in-flight staging outcome after switching repositories", async () => {
    // A staging response for repo A that lands after the user has switched to repo B must not
    // write repo A's outcome into the flow now displayed under repo B (stale-flow invalidation).
    let resolveStage!: (v: {
      readonly schemaVersion: "1";
      readonly status: "blocked";
      readonly actionKind: string;
      readonly blockReason: string;
    }) => void;
    const stagePending = new Promise<{
      readonly schemaVersion: "1";
      readonly status: "blocked";
      readonly actionKind: string;
      readonly blockReason: string;
    }>((res) => {
      resolveStage = res;
    });
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      stage: vi.fn<GitClientSeam["stage"]>(() => stagePending),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    // Begin staging in repo A (in flight), then switch to repo B before it resolves.
    fireEvent.click(screen.getByLabelText("Stage README.md"));
    fireEvent.click(screen.getByRole("option", { name: /beta/ }));
    await waitFor(() => expect(client.getStatus).toHaveBeenCalledWith(REPO_B.path));

    await act(async () => {
      resolveStage({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "stage",
        blockReason: "policy-denied",
      });
    });

    // The repo-A outcome was invalidated on switch — no banner appears under repo B.
    expect(screen.queryByTestId("git-staging-outcome")).not.toBeInTheDocument();
  });
});

describe("GitClientWindow — commit composer (Issue #1575)", () => {
  it("commits the composed summary through the commit-execute route", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Summary"), "feat: wire commit composer");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(client.commitExecute).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        message: "feat: wire commit composer",
      }),
    );
  });

  it("joins summary and description into a conventional message body", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Summary"), "feat: subject");
    await user.type(screen.getByLabelText("Description"), "Body line.");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(client.commitExecute).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        message: "feat: subject\n\nBody line.",
      }),
    );
  });

  it("refreshes status and clears the composer after a successful commit", async () => {
    const getStatus = vi.fn(async () => makeStatusRich());
    const client = makeClient({ getStatus });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());
    const callsBefore = getStatus.mock.calls.length;

    await user.type(screen.getByLabelText("Summary"), "feat: done");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveValue(""));
  });

  it("disables Commit when nothing is staged", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatus({ clean: true })) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("No changes")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
  });

  it("does not execute a commit before a matching policy preview returns", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(
        () => new Promise<GitDeliveryCommitPreviewResponse>(() => undefined),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("src/index.ts")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Summary"), "feat: wait for preview");
    const button = screen.getByRole("button", { name: /^Commit/ });

    expect(button).toBeDisabled();
    await user.click(button);
    expect(client.commitExecute).not.toHaveBeenCalled();
  });
});

describe("GitClientWindow — diff scope (Issue #1575)", () => {
  it("toggling to the Staged scope refetches the diff with scope: staged", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      getDiff: vi.fn(async () => makeDiffResponse("")),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    // README.md is unstaged-only, so the pane opens in the Worktree scope.
    fireEvent.click(screen.getByText("README.md").closest("button")!);
    await waitFor(() =>
      expect(client.getDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "worktree",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Staged" }));

    await waitFor(() =>
      expect(client.getDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "staged",
      }),
    );
  });

  it("normalizes the selected diff scope after staging changes the file state", async () => {
    const before = makeStatus({
      clean: false,
      stagedCount: 0,
      unstagedCount: 1,
      changes: [change("README.md", { worktreeStatus: "M", unstaged: true })],
    });
    const after = makeStatus({
      clean: false,
      stagedCount: 1,
      unstagedCount: 0,
      changes: [change("README.md", { indexStatus: "M", staged: true })],
    });
    const getStatus = vi.fn<GitClientSeam["getStatus"]>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const client = makeClient({
      getStatus,
      getDiff: vi.fn(async () => makeDiffResponse("")),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());

    fireEvent.click(screen.getByText("README.md").closest("button")!);
    await waitFor(() =>
      expect(client.getDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "worktree",
      }),
    );

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    await waitFor(() =>
      expect(client.getDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "staged",
      }),
    );
  });
});
