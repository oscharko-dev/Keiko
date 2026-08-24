// Accessibility tests for GitClientWindow (Issue #1574, Epic #1571).
// Uses jest-axe (NOT vitest-axe) — already extended in vitest.setup.ts.
// Tests: axe no-violations for empty/populated/dialog-open states; plus explicit
// name/role/value assertions for toolbar repository combobox and branch menu, tablist, repository listbox, dialog.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitBranchListResponse, GitDeliveryCommitPreviewResponse } from "@/lib/api";
import {
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
} from "@/lib/i18n";
import type {
  GitHistoryResponse,
  GitRepositoryStatusResponse,
  GitRepositorySummary,
  ProjectWithAvailability,
} from "@/lib/types";
import type { GitClientSeam } from "./git-client-seam";
import { SIDEBAR_STYLE, TOOLBAR_STYLE, WORKSPACE_STYLE } from "./git-client-styles";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
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

function makeRepo(path: string, name: string): ProjectWithAvailability {
  return {
    path,
    name,
    favorite: false,
    createdAt: 0,
    lastOpenedAt: 0,
    available: true,
    workspaceAvailable: true,
  };
}

const REPO_A = makeRepo("/repos/alpha", "alpha");
const REPO_B = makeRepo("/repos/beta", "beta");

function makeBranchList(): GitBranchListResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    available: true,
    state: "available",
    branches: [
      { name: "main", headRefHash: "aaa", current: true },
      { name: "feat/a11y", headRefHash: "bbb", current: false },
    ],
    truncated: false,
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
    clean: false,
    branch: "main",
    stagedCount: 1,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [
      {
        path: "src/foo.ts",
        indexStatus: "M",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
    ],
    truncated: false,
    maxChanges: 50,
    ...overrides,
  };
}

function makeCommitPreview(): GitDeliveryCommitPreviewResponse {
  return {
    schemaVersion: "1",
    summary: { stagedFileCount: 1, areaCount: 1, areas: ["src"], touchesTests: false },
    intent: { warnings: [], mixedScope: false, isWip: false },
    messageValidation: { ok: true },
    preflightFindingCodes: [],
    signatureRequirement: "not-required",
    policyOutcome: "allowed",
  };
}

function makeSummary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    stagedCount: 1,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    remotes: [{ name: "origin" }],
    truncated: false,
    ...overrides,
  };
}

function makeHistory(overrides: Partial<GitHistoryResponse> = {}): GitHistoryResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    entries: [
      {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortSha: "aaaaaaa",
        subject: "feat: history detail",
        author: "Ada",
        date: "2026-06-27T10:00:00Z",
        refs: ["HEAD -> main"],
        parentCount: 1,
        changedFileCount: 2,
      },
    ],
    limit: 50,
    skip: 0,
    truncated: false,
    ...overrides,
  };
}

// ─── makeClient factory ────────────────────────────────────────────────────────

function makeClient(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  return {
    listRepositories: vi.fn(async () => ({ projects: [REPO_A, REPO_B] })),
    registerRepository: vi.fn(async ({ path }) => ({
      project: path === REPO_B.path ? REPO_B : REPO_A,
    })),
    reconnectRepository: vi.fn(async (path) => ({
      project: path === REPO_B.path ? REPO_B : REPO_A,
    })),
    cloneRepository: vi.fn(async () => ({ project: REPO_A })),
    listBranches: vi.fn(async () => makeBranchList()),
    getSummary: vi.fn(async () => makeSummary()),
    getHistory: vi.fn(async () => makeHistory({ entries: [] })),
    getRemotes: vi.fn(async () => ({
      schemaVersion: "1" as const,
      root: "/repos/alpha",
      state: "available" as const,
      available: true,
      remotes: [{ name: "origin" }],
      truncated: false,
    })),
    getStatus: vi.fn(async () => makeStatus()),
    getDiff: vi.fn(async () => ({
      schemaVersion: "1" as const,
      root: "/repos/alpha",
      state: "available" as const,
      available: true,
      scope: "all" as const,
      diff: "",
      truncated: false,
      maxBytes: 131072,
    })),
    getStructuredDiff: vi.fn(async () => ({
      schemaVersion: "1" as const,
      scope: "unstaged" as const,
      files: [],
      truncated: false,
      totalFiles: 0,
      totalBytes: 0,
      maxBytes: 524288 as const,
      maxFiles: 400 as const,
    })),
    // Carry-forward mutation stubs — not exercised by the shell; typed against the real seam
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
    syncPreview: vi.fn<GitClientSeam["syncPreview"]>(),
    syncExecute: vi.fn<GitClientSeam["syncExecute"]>(),
    pushPreview: vi.fn<GitClientSeam["pushPreview"]>(),
    pushExecute: vi.fn<GitClientSeam["pushExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "push",
    })),
    prPreview: vi.fn<GitClientSeam["prPreview"]>(),
    prExecute: vi.fn<GitClientSeam["prExecute"]>(),
    mergePreview: vi.fn<GitClientSeam["mergePreview"]>(),
    mergeApprove: vi.fn<GitClientSeam["mergeApprove"]>(),
    mergeExecute: vi.fn<GitClientSeam["mergeExecute"]>(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
  resetLoadedMessageCatalogs();
});

describe("GitClientWindow — axe no-violations", () => {
  it("empty state (no repo selected) has no axe violations", async () => {
    const { container } = render(<GitClientWindow client={makeClient()} />);
    // Wait for repos to load so the connect panel's recent list is rendered
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("populated state (repo selected, status loaded) has no axe violations", async () => {
    const client = makeClient();
    const { container } = render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    // Wait for changed file to appear
    expect(await screen.findByText("foo.ts")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("populated state with a selected diff and staging controls has no axe violations", async () => {
    const client = makeClient({
      getDiff: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/repos/alpha",
        state: "available" as const,
        available: true,
        scope: "staged" as const,
        diff: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
        truncated: false,
        maxBytes: 131072,
      })),
    });
    const { container } = render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("foo.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByText("foo.ts").closest("button")!);
    expect(await screen.findByRole("group", { name: "Diff scope" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("add-repository dialog open has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<GitClientWindow client={makeClient()} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clone from URL" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("GitClientWindow — explicit name/role/value assertions", () => {
  describe("toolbar repository combobox and branch menu", () => {
    it("Repository combobox has accessible name 'Repository'", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByRole("combobox", { name: "Repository" })).toBeInTheDocument();
    });

    it("Branch menu trigger has accessible name 'Branch'", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByRole("button", { name: "Branch: main" })).toBeInTheDocument();
    });

    it("Repository combobox is absent until a repository is connected", async () => {
      render(<GitClientWindow client={makeClient()} />);
      // Before any selection the body shows the Connect panel rather than the toolbar combobox.
      expect(await screen.findByText("No repository connected")).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Repository" })).not.toBeInTheDocument();
    });

    it("Repository combobox popup listbox has an accessible name", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByRole("combobox", { name: "Repository" })).toBeInTheDocument();

      const trigger = screen.getByRole("combobox", { name: "Repository" });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        bottom: 90,
        height: 36,
        left: 120,
        right: 320,
        top: 54,
        width: 200,
        x: 120,
        y: 54,
        toJSON: () => ({}),
      });
      await user.click(trigger);

      expect(screen.getByRole("listbox", { name: "Repository" })).toBeInTheDocument();
    });

    it("branch search input keeps a visible native focus outline", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await user.click(await screen.findByRole("button", { name: "Branch: main" }));
      const search = screen.getByRole("searchbox", { name: "Search branches" });
      expect(search).not.toHaveStyle({ outline: "none" });
    });
  });

  describe("connect panel repository list", () => {
    it("lists recent repositories as buttons in the connect panel", async () => {
      render(<GitClientWindow client={makeClient()} />);
      expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /beta/ })).toBeInTheDocument();
    });

    it("exposes the toolbar repository options with aria-selected when connected", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const trigger = await screen.findByRole("combobox", { name: "Repository" });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        bottom: 90,
        height: 36,
        left: 120,
        right: 320,
        top: 54,
        width: 200,
        x: 120,
        y: 54,
        toJSON: () => ({}),
      });
      await user.click(trigger);

      expect(screen.getByRole("option", { name: /alpha/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByRole("option", { name: /beta/ })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    });
  });

  describe("tablist and tabs", () => {
    it("renders role=tablist with accessible label", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const tablist = await screen.findByRole("tablist");
      expect(tablist).toBeInTheDocument();
      // aria-label is "Changes and history"
      expect(tablist).toHaveAttribute("aria-label", "Changes and history");
    });

    it("each tab has role=tab and correct aria-selected", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const changesTab = await screen.findByRole("tab", { name: "Changes" });
      const historyTab = screen.getByRole("tab", { name: "History" });

      expect(changesTab).toHaveAttribute("aria-selected", "true");
      expect(historyTab).toHaveAttribute("aria-selected", "false");
    });

    it("each tab has a matching aria-controls pointing to its mounted panel", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const changesTab = await screen.findByRole("tab", { name: "Changes" });
      const historyTab = screen.getByRole("tab", { name: "History" });

      for (const tab of [changesTab, historyTab]) {
        const controlsId = tab.getAttribute("aria-controls");
        expect(controlsId).toBeTruthy();
        expect(document.getElementById(controlsId!)).toBeInTheDocument();
      }
    });

    it("active tab has tabIndex=0 and inactive has tabIndex=-1", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const changesTab = await screen.findByRole("tab", { name: "Changes" });
      const historyTab = screen.getByRole("tab", { name: "History" });

      expect(changesTab).toHaveAttribute("tabindex", "0");
      expect(historyTab).toHaveAttribute("tabindex", "-1");
    });

    it("after switching to History tab, it becomes tabIndex=0", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);

      await user.click(await screen.findByRole("tab", { name: "History" }));

      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("tabindex", "-1");
    });
  });

  describe("staging and commit controls", () => {
    it("each changed file has a checkbox whose name states the stage action", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByText("foo.ts")).toBeInTheDocument();
      // src/foo.ts is staged → its checkbox reads "Unstage <path>" and is checked.
      const checkbox = screen.getByRole("checkbox", { name: "Unstage src/foo.ts" });
      expect(checkbox).toBeChecked();
    });

    it("the commit composer exposes labelled Summary and Description fields", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByText("foo.ts")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
      expect(screen.getByLabelText("Summary")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
    });

    it("the stage-all and unstage-all actions are buttons with accessible names", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByText("foo.ts")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stage all" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Unstage all" })).toBeInTheDocument();
    });

    it("explains that the selected staged files define the commit draft", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByText("foo.ts")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Select files with the checkboxes. Keiko uses only staged files for the commit draft.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe("changed files and diff region", () => {
    it("changed-file rows expose the Git status in their accessible names", async () => {
      const client = makeClient();
      render(<GitClientWindow projectId={REPO_A.path} client={client} />);
      expect(
        await screen.findByRole("button", { name: /src\/foo\.ts, staged modified/i }),
      ).toBeInTheDocument();
    });

    it("names the keyboard-scrollable primary region for both commit and diff work", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);

      const commitRegion = await screen.findByRole("region", { name: "Commit draft" });
      expect(commitRegion).toHaveAttribute("tabindex", "0");
      expect(screen.getAllByRole("region", { name: "Commit draft" })).toHaveLength(1);

      const changedFile = await screen.findByRole("button", {
        name: /src\/foo\.ts, staged modified/i,
      });
      await user.click(changedFile);
      const diffRegion = await screen.findByRole("region", { name: "Diff" });
      expect(diffRegion).toHaveAttribute("tabindex", "0");
    });

    it("sync state is exposed through a polite status region carrying its visible text", async () => {
      const client = makeClient();
      render(<GitClientWindow projectId={REPO_A.path} client={client} />);
      // GEN-UI-A11Y-017: the live region no longer duplicates its text in an aria-label. A
      // role=status region takes its announcement from its own content, so the visible copy is now
      // the single source of truth — assert the text renders inside a polite status region with no
      // competing aria-label.
      const text = await screen.findByText(/Up to date with origin\/main/);
      const status = text.closest('[role="status"]');
      expect(status).not.toBeNull();
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).not.toHaveAttribute("aria-label");
    });

    it("branch selector exposes searchable menu controls", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByRole("button", { name: "Branch: main" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Branch: main" }));

      expect(screen.getByRole("searchbox", { name: "Search branches" })).toBeInTheDocument();
      expect(screen.getByRole("menu", { name: "Branches" })).toBeInTheDocument();
      expect(screen.getByRole("menuitemradio", { name: /main/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("branch popup restores focus and exposes the selected branch value", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const trigger = await screen.findByRole("button", { name: "Branch: main" });

      await user.click(trigger);
      fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search branches" }), {
        key: "ArrowDown",
      });
      expect(screen.getByRole("menuitemradio", { name: /main/ })).toHaveFocus();

      fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /main/ }), { key: "Escape" });
      await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("branch popup dismisses on an outside pointerdown (GEN-UI-INTERACTION-002)", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const trigger = await screen.findByRole("button", { name: "Branch: main" });

      await user.click(trigger);
      expect(screen.getByRole("menu", { name: "Branches" })).toBeInTheDocument();

      // A pointerdown anywhere outside the selector wrapper closes the popup (mirrors KeikoSelect).
      fireEvent.pointerDown(document.body);
      await waitFor(() =>
        expect(screen.queryByRole("menu", { name: "Branches" })).not.toBeInTheDocument(),
      );
    });

    it("branch popup dismisses when Tab leaves the search input (GEN-UI-INTERACTION-002)", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const trigger = await screen.findByRole("button", { name: "Branch: main" });

      await user.click(trigger);
      const search = screen.getByRole("searchbox", { name: "Search branches" });
      fireEvent.keyDown(search, { key: "Tab" });

      await waitFor(() =>
        expect(screen.queryByRole("menu", { name: "Branches" })).not.toBeInTheDocument(),
      );
    });

    it("staging checkbox focus toggles a visible focus ring on the aria-hidden box (GEN-UI-FOCUS-007)", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      const checkbox = await screen.findByRole("checkbox", { name: "Unstage src/foo.ts" });
      // The visual box is the checkbox input's aria-hidden sibling inside the shared <label>.
      const label = checkbox.closest("label");
      expect(label).not.toBeNull();
      const box = label!.querySelector<HTMLElement>('[aria-hidden="true"]');
      expect(box).not.toBeNull();

      expect(box!.getAttribute("data-focus-visible")).toBeNull();
      fireEvent.focus(checkbox);
      expect(box!.getAttribute("data-focus-visible")).toBe("true");
      // The ring is rendered on the visible box, not the invisible input.
      expect(box!.style.boxShadow).toContain("var(--focus-ring)");

      fireEvent.blur(checkbox);
      expect(box!.getAttribute("data-focus-visible")).toBeNull();
    });

    it("narrow layout preserves a single toolbar row and keeps a diff-pane floor (GEN-UI-LAYOUT-003)", async () => {
      // jsdom has no layout, so assert the style contract that preserves the working order of the
      // toolbar with horizontal reachability and keeps a usable diff pane beside the sidebar.
      expect(TOOLBAR_STYLE.flexWrap).toBe("nowrap");
      expect(TOOLBAR_STYLE.overflowX).toBe("auto");
      expect(String(SIDEBAR_STYLE.width)).toMatch(/min\(/);
      expect(WORKSPACE_STYLE.height).toBe("100%");
      expect(WORKSPACE_STYLE.overflow).toBe("hidden");

      // Sanity: with a repository connected, the toolbar controls and primary work region are all
      // present and reachable regardless of width. Selecting a file replaces the commit workspace
      // with the diff workspace without changing the layout contract.
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      expect(await screen.findByRole("combobox", { name: "Repository" })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Branch: main" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Commit draft" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /src\/foo\.ts, staged modified/i }));
      expect(await screen.findByRole("region", { name: "Diff" })).toBeInTheDocument();
    });

    it("new-branch dialog is modal, initially focuses the branch-name input, and traps Tab", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "New branch" })).toBeEnabled());

      await user.click(screen.getByRole("button", { name: "New branch" }));

      const dialog = screen.getByRole("dialog", { name: "New branch" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog.parentElement).toBe(document.body);
      expect(document.documentElement.dataset.keikoModalOpen).toBe("true");
      await waitFor(() => expect(within(dialog).getByLabelText("Branch name")).toHaveFocus());
      within(dialog).getByRole("button", { name: "Cancel" }).focus();
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("branch-switch confirmation is modal, focus-contained, and axe-clean", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await user.click(await screen.findByRole("button", { name: "Branch: main" }));
      await user.click(screen.getByRole("menuitemradio", { name: /feat\/a11y/ }));

      const dialog = screen.getByRole("alertdialog", { name: "Confirm branch switch" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      // KEIKO-0228: the dialog must use the div+role="alertdialog" pattern the three siblings ship,
      // NOT a native <dialog> that advertises aria-modal="true" without any of the modality
      // machinery showModal() promises (jsdom does not implement showModal at all).
      expect(dialog.tagName).not.toBe("DIALOG");
      expect(dialog).toHaveAttribute("role", "alertdialog");
      expect(document.documentElement.dataset.keikoModalOpen).toBe("true");
      await waitFor(() => expect(dialog).toHaveFocus());
      within(dialog).getByRole("button", { name: "Switch branch" }).focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(await axe(dialog)).toHaveNoViolations();
    });

    it("localizes the branch-switch confirmation in German", async () => {
      await loadLocaleMessages("de");
      window.localStorage.setItem(I18N_STORAGE_KEY, "de");
      const user = userEvent.setup();
      render(
        <I18nProvider>
          <GitClientWindow projectId={REPO_A.path} client={makeClient()} />
        </I18nProvider>,
      );
      await user.click(await screen.findByRole("button", { name: "Branch: main" }));
      await user.click(screen.getByRole("menuitemradio", { name: /feat\/a11y/ }));

      const dialog = screen.getByRole("alertdialog", { name: "Branchwechsel bestätigen" });
      expect(within(dialog).getByRole("button", { name: "Branch wechseln" })).toBeEnabled();
      expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toBeEnabled();
      expect(await axe(dialog)).toHaveNoViolations();
    });

    it("history list and selected commit details expose name, role, and current value", async () => {
      const user = userEvent.setup();
      const client = makeClient({ getHistory: vi.fn(async () => makeHistory()) });
      render(<GitClientWindow projectId={REPO_A.path} client={client} />);
      await user.click(await screen.findByRole("tab", { name: "History" }));

      const list = await screen.findByRole("list", { name: "Commit history" });
      expect(list).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /feat: history detail/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
      expect(screen.getByRole("region", { name: "Commit details" })).toBeInTheDocument();
    });

    it("history pagination exposes an accessible action and remains axe-clean", async () => {
      const user = userEvent.setup();
      const client = makeClient({
        getHistory: vi.fn(async () => makeHistory({ truncated: true })),
      });
      const { container } = render(<GitClientWindow projectId={REPO_A.path} client={client} />);
      await user.click(await screen.findByRole("tab", { name: "History" }));

      expect(await screen.findByRole("button", { name: "Load more commits" })).toBeEnabled();
      expect(await axe(container)).toHaveNoViolations();
    });

    it("localizes the accessible pagination action in German", async () => {
      await loadLocaleMessages("de");
      window.localStorage.setItem(I18N_STORAGE_KEY, "de");
      const user = userEvent.setup();
      const client = makeClient({
        getHistory: vi.fn(async () => makeHistory({ truncated: true })),
      });
      const { container } = render(
        <I18nProvider>
          <GitClientWindow projectId={REPO_A.path} client={client} />
        </I18nProvider>,
      );
      await user.click(await screen.findByRole("tab", { name: "History" }));

      expect(await screen.findByRole("button", { name: "Weitere Commits laden" })).toBeEnabled();
      expect(await axe(container)).toHaveNoViolations();
    });

    it("detached and conflicted states expose alert guidance and disabled sync actions", async () => {
      const detachedClient = makeClient({
        getStatus: vi.fn(async () => makeStatus({ detached: true, branch: undefined })),
        getSummary: vi.fn(async () => makeSummary({ detached: true, branch: undefined })),
      });
      const { rerender } = render(
        <GitClientWindow projectId={REPO_A.path} client={detachedClient} />,
      );

      expect(await screen.findByRole("alert")).toHaveTextContent("Detached HEAD");
      expect(screen.getByRole("button", { name: "Run sync: Detached HEAD" })).toBeDisabled();

      const conflictedClient = makeClient({
        getStatus: vi.fn(async () => makeStatus({ conflictedCount: 1, clean: false })),
        getSummary: vi.fn(async () => makeSummary({ conflictedCount: 1, clean: false })),
      });
      rerender(<GitClientWindow projectId={REPO_A.path} client={conflictedClient} />);

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Resolve conflicted files"),
      );
      expect(screen.getByRole("button", { name: "Run sync: Resolve conflicts" })).toBeDisabled();
    });
  });

  describe("add-repository dialog", () => {
    it("localizes every dialog control in German", async () => {
      await loadLocaleMessages("de");
      window.localStorage.setItem(I18N_STORAGE_KEY, "de");
      render(
        <I18nProvider>
          <AddRepositoryDialog client={makeClient()} onAdded={vi.fn()} onClose={vi.fn()} />
        </I18nProvider>,
      );

      const dialog = screen.getByRole("dialog", { name: "Repository hinzufügen" });
      expect(within(dialog).getAllByRole("button", { name: "Repository klonen" })).toHaveLength(2);
      expect(
        within(dialog).getByRole("button", { name: "Lokales Repository öffnen" }),
      ).toBeEnabled();
      expect(within(dialog).getByRole("textbox", { name: "Repository-URL" })).toBeEnabled();
      expect(within(dialog).getByRole("textbox", { name: "In Ordner klonen" })).toBeEnabled();
      expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toBeEnabled();
      expect(await axe(dialog)).toHaveNoViolations();
    });

    it("dialog has role=dialog and accessible name 'Add repository'", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clone from URL" }));

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-label", "Add repository");
    });

    it("dialog has aria-modal='true'", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clone from URL" }));

      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    });

    it("focus is initially on the first input inside the dialog", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clone from URL" }));

      // requestAnimationFrame is used; run pending timers via act
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const dialog = screen.getByRole("dialog");
      const inputs = within(dialog).getAllByRole("textbox");
      // First visible input (Repository URL) should receive focus
      expect(inputs[0]).toHaveFocus();
    });

    it("Tab key wraps focus within the dialog (focus trap)", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clone from URL" }));
      const dialog = screen.getByRole("dialog");

      // Manually focus the last focusable element then Tab
      const buttons = within(dialog).getAllByRole("button");
      const lastBtn = buttons[buttons.length - 1]!;
      lastBtn.focus();
      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: false });

      // Focus should have wrapped — the active element stays inside the dialog
      const active = document.activeElement;
      expect(dialog.contains(active)).toBe(true);
    });

    it("Escape key closes the dialog", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clone from URL" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });
});
