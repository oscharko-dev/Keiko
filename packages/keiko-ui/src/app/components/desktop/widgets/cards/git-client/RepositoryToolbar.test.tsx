// Issue #3400 (epic #3384) — regression coverage for the "Connect to Chat" toolbar action.
//
// Before this change RepositoryToolbar had no way to reach Chat at all: `onConnectToChat` did not
// exist on its props, so no click could ever open the connect surface (git-chat-ui-mount item).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { GitBranchListEntry } from "@/lib/api";
import type { GitRepositoryStatusResponse, ProjectWithAvailability } from "@/lib/types";
import { RepositoryToolbar, type RepositoryToolbarProps } from "./RepositoryToolbar";
import { deriveSyncView } from "./SyncControl";

const REPO: ProjectWithAvailability = {
  path: "/repos/alpha",
  name: "alpha",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
  workspaceAvailable: true,
};

const BRANCHES: readonly GitBranchListEntry[] = [
  { name: "main", headRefHash: "aaa", current: true },
];

const STATUS: GitRepositoryStatusResponse = {
  schemaVersion: "1",
  root: REPO.path,
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
};

const SYNC_VIEW = deriveSyncView(null, false);

function baseProps(): Omit<
  RepositoryToolbarProps,
  "onOpenEditor" | "onOpenFiles" | "onConnectToChat"
> {
  return {
    repositories: [REPO],
    selectedPath: REPO.path,
    branches: BRANCHES,
    branchesLoading: false,
    status: STATUS,
    branchBusy: false,
    syncView: SYNC_VIEW,
    syncBusy: false,
    syncOutcome: null,
    syncError: null,
    onSelectRepository: vi.fn(),
    onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(),
    onRunSync: vi.fn(),
  };
}

describe("RepositoryToolbar — Connect to Chat", () => {
  it("renders no Connect to Chat button when the callback is not supplied", () => {
    render(<RepositoryToolbar {...baseProps()} />);
    expect(screen.queryByRole("button", { name: "Connect to Chat" })).not.toBeInTheDocument();
  });

  it("renders a Connect to Chat button and invokes the callback on click", () => {
    const onConnectToChat = vi.fn();
    render(<RepositoryToolbar {...baseProps()} onConnectToChat={onConnectToChat} />);
    const button = screen.getByRole("button", { name: "Connect to Chat" });
    button.click();
    expect(onConnectToChat).toHaveBeenCalledTimes(1);
  });

  it("never renders Connect to Chat before a repository is selected", () => {
    render(<RepositoryToolbar {...baseProps()} selectedPath={null} onConnectToChat={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Connect to Chat" })).not.toBeInTheDocument();
  });

  // #3390: with one repository connected, the toolbar was the operator's only surface and it had
  // no way to add another local checkout -- the connect panel (and with it the Add repository
  // dialog) only renders while nothing is bound. The Repository menu now carries that action.
  it("offers Add repository in the Repository menu and reports it without selecting a path", async () => {
    const user = userEvent.setup();
    const onAddRepository = vi.fn();
    const props = baseProps();
    render(<RepositoryToolbar {...props} onAddRepository={onAddRepository} />);
    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(await screen.findByRole("option", { name: "Add repository" }));
    expect(onAddRepository).toHaveBeenCalledTimes(1);
    expect(props.onSelectRepository).not.toHaveBeenCalled();
  });

  it("lists only repositories in the menu when the toolbar cannot add one", async () => {
    const user = userEvent.setup();
    render(<RepositoryToolbar {...baseProps()} />);
    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    expect(await screen.findByRole("option", { name: /alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Add repository" })).not.toBeInTheDocument();
  });

  it("jest-axe: no violations with Connect to Chat, Open in Editor and Open Files all present", async () => {
    const { container } = render(
      <RepositoryToolbar
        {...baseProps()}
        onConnectToChat={vi.fn()}
        onOpenEditor={vi.fn()}
        onOpenFiles={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
