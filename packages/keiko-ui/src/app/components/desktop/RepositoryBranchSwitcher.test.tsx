import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type {
  GitBranchListResponse,
  GitRepositoryInitializeInput,
  GitRepositoryInitializeResponse,
} from "@/lib/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listBranches: vi.fn<(root: string) => Promise<GitBranchListResponse>>(),
  clearActive: vi.fn<() => Promise<boolean>>(),
  activeProject: { name: "Keiko", path: "/repo", available: true },
  initializeRepository:
    vi.fn<(input: GitRepositoryInitializeInput) => Promise<GitRepositoryInitializeResponse>>(),
  reportDiagnostic: vi.fn(),
  activeInstance: {
    repositoryRoot: "/repo",
    baseBranch: "dev",
    taskBranch: "keiko/task/coding-workbench-dev",
    lock: null,
  } as {
    readonly repositoryRoot: string;
    readonly baseBranch: string;
    readonly taskBranch: string;
    readonly lock: object | null;
  } | null,
  reset: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  initializeGitRepository: mocks.initializeRepository,
}));
vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: mocks.reportDiagnostic,
}));

vi.mock("./context/ChatSessionContext", () => ({
  useOptionalChatSessionCatalog: (): { activeProject: typeof mocks.activeProject } => ({
    activeProject: mocks.activeProject,
  }),
}));
vi.mock("./context/ActiveWorkspaceContext", () => ({
  useActiveWorkspace: (): {
    activeInstance: typeof mocks.activeInstance;
    clearActive: typeof mocks.clearActive;
  } => ({
    activeInstance: mocks.activeInstance,
    clearActive: mocks.clearActive,
  }),
}));
vi.mock("./widgets/cards/git-client/git-client-seam", () => ({
  DEFAULT_GIT_CLIENT: {
    listBranches: mocks.listBranches,
    branchCreate: vi.fn(),
    branchSwitch: vi.fn(),
  },
  formatGitError: (): string => "Git request failed.",
  useGitActions: (): {
    flow: { busy: boolean; outcome: null; error: null };
    reset: typeof mocks.reset;
    runMutation: ReturnType<typeof vi.fn>;
  } => ({
    flow: { busy: false, outcome: null, error: null },
    reset: mocks.reset,
    runMutation: vi.fn(),
  }),
}));
vi.mock("./widgets/cards/git-client/BranchSelector", () => ({
  BranchSelector: (props: {
    readonly currentBranch: string;
    readonly onSwitchBranch: (branchName: string) => void;
  }): ReactElement => (
    <button type="button" onClick={() => props.onSwitchBranch("dev")}>
      Repository branch: {props.currentBranch}
    </button>
  ),
}));
vi.mock("./widgets/cards/git-client/NewBranchDialog", () => ({
  NewBranchDialog: (): null => null,
}));
vi.mock("./widgets/cards/git-client/WorktreeMutationConfirmDialog", () => ({
  WorktreeMutationConfirmDialog: (): null => null,
}));

import { RepositoryBranchSwitcher } from "./RepositoryBranchSwitcher";

function branches(response: Partial<GitBranchListResponse> = {}): GitBranchListResponse {
  return {
    schemaVersion: "1",
    root: "/repo",
    repositoryRoot: "/repo",
    available: true,
    state: "available",
    branches: [
      { name: "dev", headRefHash: "dev-hash", current: false },
      { name: "codex/fix-model-readiness-startup", headRefHash: "head-hash", current: true },
    ],
    truncated: false,
    ...response,
  };
}

beforeEach(() => {
  mocks.listBranches.mockReset();
  mocks.clearActive.mockReset();
  mocks.initializeRepository.mockReset();
  mocks.reportDiagnostic.mockReset();
  mocks.reset.mockReset();
  mocks.activeProject.name = "Keiko";
  mocks.activeProject.path = "/repo";
  mocks.activeProject.available = true;
  mocks.activeInstance = {
    repositoryRoot: "/repo",
    baseBranch: "dev",
    taskBranch: "keiko/task/coding-workbench-dev",
    lock: null,
  };
});

describe("RepositoryBranchSwitcher", () => {
  it("shows the checked-out repository branch, never the target or task-workspace branch", async () => {
    mocks.listBranches.mockResolvedValue(branches());

    render(<RepositoryBranchSwitcher />);

    expect(
      await screen.findByRole("button", {
        name: "Repository branch: codex/fix-model-readiness-startup",
      }),
    ).toBeVisible();
    expect(screen.queryByText("keiko/task/coding-workbench-dev")).not.toBeInTheDocument();
  });

  it("offers bounded local Git setup only for a confirmed non-repository", async () => {
    mocks.listBranches.mockResolvedValue(
      branches({
        available: false,
        state: "unavailable",
        reason: "not-a-repository",
        branches: [],
      }),
    );

    render(<RepositoryBranchSwitcher />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Set up Git" })).toBeVisible());
  });

  it("keeps a task-binding denial visible until the repository changes", async () => {
    mocks.listBranches.mockResolvedValue(branches());
    mocks.activeInstance = {
      repositoryRoot: "/repo",
      baseBranch: "dev",
      taskBranch: "keiko/task/coding-workbench-dev",
      lock: {},
    };

    render(<RepositoryBranchSwitcher />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Repository branch: codex/fix-model-readiness-startup",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Branch changes are unavailable while a coding run holds this repository.",
    );
  });

  it("ignores a late initialization failure after the selected repository changes", async () => {
    let rejectInitialization: (reason: unknown) => void = (): void => undefined;
    mocks.initializeRepository.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectInitialization = reject;
      }),
    );
    mocks.listBranches.mockResolvedValue(
      branches({
        available: false,
        state: "unavailable",
        reason: "not-a-repository",
        branches: [],
      }),
    );
    const view = render(<RepositoryBranchSwitcher />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up Git" }));
    fireEvent.click(screen.getByRole("button", { name: "Initialize repository" }));

    mocks.activeProject.path = "/next";
    view.rerender(<RepositoryBranchSwitcher />);
    await act(async () => rejectInitialization(new Error("old repository failed")));

    expect(screen.queryByText("Git request failed.")).not.toBeInTheDocument();
    expect(mocks.reportDiagnostic).not.toHaveBeenCalled();
  });
});
