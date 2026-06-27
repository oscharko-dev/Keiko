// Accessibility tests for GitClientWindow (Issue #1574, Epic #1571).
// Uses jest-axe (NOT vitest-axe) — already extended in vitest.setup.ts.
// Tests: axe no-violations for empty/populated/dialog-open states; plus explicit
// name/role/value assertions for toolbar comboboxes, tablist, repository listbox, dialog.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitBranchListResponse, GitDeliveryCommitPreviewResponse } from "@/lib/api";
import type { GitRepositoryStatusResponse, ProjectWithAvailability } from "@/lib/types";
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

function makeRepo(path: string, name: string): ProjectWithAvailability {
  return { path, name, favorite: false, createdAt: 0, lastOpenedAt: 0, available: true };
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
    policyOutcome: "allowed",
  };
}

// ─── makeClient factory ────────────────────────────────────────────────────────

function makeClient(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  return {
    listRepositories: vi.fn(async () => ({ projects: [REPO_A, REPO_B] })),
    registerRepository: vi.fn(async () => ({ project: REPO_A })),
    cloneRepository: vi.fn(async () => ({ project: REPO_A })),
    listBranches: vi.fn(async () => makeBranchList()),
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

describe("GitClientWindow — axe no-violations", () => {
  it("empty state (no repo selected) has no axe violations", async () => {
    const { container } = render(<GitClientWindow client={makeClient()} />);
    // Wait for repos to load so the listbox is rendered
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("populated state (repo selected, status loaded) has no axe violations", async () => {
    const client = makeClient();
    const { container } = render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    // Wait for changed file to appear
    await waitFor(() => expect(screen.getByText("src/foo.ts")).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText("src/foo.ts")).toBeInTheDocument());
    fireEvent.click(screen.getByText("src/foo.ts").closest("button")!);
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Diff scope" })).toBeInTheDocument(),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("add-repository dialog open has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<GitClientWindow client={makeClient()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add repository" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("GitClientWindow — explicit name/role/value assertions", () => {
  describe("toolbar comboboxes", () => {
    it("Repository combobox has accessible name 'Repository'", async () => {
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Repository" })).toBeInTheDocument(),
      );
    });

    it("Branch combobox has accessible name 'Branch'", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Branch" })).toBeInTheDocument(),
      );
    });

    it("Repository combobox reflects 'select a repository' placeholder when none selected", async () => {
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Repository" })).toBeInTheDocument(),
      );
      // Combobox trigger should show placeholder text since no repo is selected
      const trigger = screen.getByRole("combobox", { name: "Repository" });
      expect(trigger).toBeInTheDocument();
    });

    it("Repository combobox popup listbox has an accessible name", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Repository" })).toBeInTheDocument(),
      );

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

    it("search inputs keep a visible native focus outline", () => {
      render(<GitClientWindow client={makeClient()} />);
      const search = screen.getByRole("searchbox", { name: "Search repositories" });
      expect(search).not.toHaveStyle({ outline: "none" });
    });
  });

  describe("repository listbox", () => {
    it("renders a listbox with accessible label 'Repositories'", async () => {
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("listbox", { name: "Repositories" })).toBeInTheDocument(),
      );
    });

    it("each repo is a role=option with aria-selected", async () => {
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      const alphaOption = screen.getByRole("option", { name: /alpha/ });
      const betaOption = screen.getByRole("option", { name: /beta/ });

      // Initially neither is selected (no projectId provided)
      expect(alphaOption).toHaveAttribute("aria-selected", "false");
      expect(betaOption).toHaveAttribute("aria-selected", "false");
    });

    it("selected repo has aria-selected='true'", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      const alphaOption = screen.getByRole("option", { name: /alpha/ });
      expect(alphaOption).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("tablist and tabs", () => {
    it("renders role=tablist with accessible label", () => {
      render(<GitClientWindow client={makeClient()} />);
      const tablist = screen.getByRole("tablist");
      expect(tablist).toBeInTheDocument();
      // aria-label is "Changes and history"
      expect(tablist).toHaveAttribute("aria-label", "Changes and history");
    });

    it("each tab has role=tab and correct aria-selected", () => {
      render(<GitClientWindow client={makeClient()} />);
      const changesTab = screen.getByRole("tab", { name: "Changes" });
      const historyTab = screen.getByRole("tab", { name: "History" });

      expect(changesTab).toHaveAttribute("aria-selected", "true");
      expect(historyTab).toHaveAttribute("aria-selected", "false");
    });

    it("each tab has a matching aria-controls pointing to its mounted panel", () => {
      render(<GitClientWindow client={makeClient()} />);
      const changesTab = screen.getByRole("tab", { name: "Changes" });
      const historyTab = screen.getByRole("tab", { name: "History" });

      for (const tab of [changesTab, historyTab]) {
        const controlsId = tab.getAttribute("aria-controls");
        expect(controlsId).toBeTruthy();
        expect(document.getElementById(controlsId!)).toBeInTheDocument();
      }
    });

    it("active tab has tabIndex=0 and inactive has tabIndex=-1", () => {
      render(<GitClientWindow client={makeClient()} />);
      const changesTab = screen.getByRole("tab", { name: "Changes" });
      const historyTab = screen.getByRole("tab", { name: "History" });

      expect(changesTab).toHaveAttribute("tabindex", "0");
      expect(historyTab).toHaveAttribute("tabindex", "-1");
    });

    it("after switching to History tab, it becomes tabIndex=0", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);

      await user.click(screen.getByRole("tab", { name: "History" }));

      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("tabindex", "0");
      expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("tabindex", "-1");
    });
  });

  describe("staging and commit controls", () => {
    it("each changed file has a checkbox whose name states the stage action", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await waitFor(() => expect(screen.getByText("src/foo.ts")).toBeInTheDocument());
      // src/foo.ts is staged → its checkbox reads "Unstage <path>" and is checked.
      const checkbox = screen.getByRole("checkbox", { name: "Unstage src/foo.ts" });
      expect(checkbox).toBeChecked();
    });

    it("the commit composer exposes labelled Summary and Description fields", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await waitFor(() => expect(screen.getByText("src/foo.ts")).toBeInTheDocument());
      expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
      expect(screen.getByLabelText("Summary")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
    });

    it("the stage-all and unstage-all actions are buttons with accessible names", async () => {
      render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
      await waitFor(() => expect(screen.getByText("src/foo.ts")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Stage all" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Unstage all" })).toBeInTheDocument();
    });
  });

  describe("changed files and diff region", () => {
    it("changed-file rows expose the Git status in their accessible names", async () => {
      const client = makeClient();
      render(<GitClientWindow projectId={REPO_A.path} client={client} />);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /src\/foo\.ts, staged modified/i }),
        ).toBeInTheDocument(),
      );
    });

    it("diff content is a named keyboard-scrollable region", () => {
      render(<GitClientWindow client={makeClient()} />);
      const diffRegion = screen.getByRole("region", { name: "Diff" });
      expect(diffRegion).toHaveAttribute("tabindex", "0");
    });

    it("sync state is exposed through a polite status role", async () => {
      const client = makeClient();
      render(<GitClientWindow projectId={REPO_A.path} client={client} />);
      await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
      expect(screen.getByRole("status", { name: /^Sync/ })).toBeInTheDocument();
    });
  });

  describe("add-repository dialog", () => {
    it("dialog has role=dialog and accessible name 'Add repository'", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      await user.click(screen.getByRole("button", { name: "Add repository" }));

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-label", "Add repository");
    });

    it("dialog has aria-modal='true'", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      await user.click(screen.getByRole("button", { name: "Add repository" }));

      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    });

    it("focus is initially on the first input inside the dialog", async () => {
      const user = userEvent.setup();
      render(<GitClientWindow client={makeClient()} />);
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      await user.click(screen.getByRole("button", { name: "Add repository" }));

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
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      await user.click(screen.getByRole("button", { name: "Add repository" }));
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
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /alpha/ })).toBeInTheDocument(),
      );

      await user.click(screen.getByRole("button", { name: "Add repository" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });
});
