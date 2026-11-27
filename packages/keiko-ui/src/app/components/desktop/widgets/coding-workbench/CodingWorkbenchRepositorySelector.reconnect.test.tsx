import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";

import { CodingWorkbenchRepositorySelector } from "./CodingWorkbenchRepositorySelector";

const selectableRepositories = vi.hoisted(() => vi.fn());
vi.mock("./codingWorkbenchRepositories", () => ({ selectableRepositories }));

const listBranches = vi.hoisted(() => vi.fn());
vi.mock("../cards/git-client/git-client-seam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/git-client/git-client-seam")>();
  return { ...actual, DEFAULT_GIT_CLIENT: { ...actual.DEFAULT_GIT_CLIENT, listBranches } };
});

const reconnectProject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  reconnectProject,
}));

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic,
}));

const ROOT = "/repos/cloned-again";

function project(available: boolean, workspaceAvailable: boolean): ProjectWithAvailability {
  return {
    path: ROOT,
    name: "cloned-again",
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 1,
    available,
    workspaceAvailable,
  };
}

function branchList(): unknown {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: "available",
    available: true,
    branches: [{ name: "main", headRefHash: "a".repeat(40), current: true }],
    truncated: false,
  };
}

function renderSelector(onReconnected?: () => void): ReturnType<typeof render> {
  return render(
    <CodingWorkbenchRepositorySelector
      root={ROOT}
      branch={null}
      location="local"
      locked={false}
      onSelect={vi.fn()}
      onSelectBranch={vi.fn()}
      onSelectLocation={vi.fn()}
      onOpenGit={vi.fn()}
      onReconnected={onReconnected}
      placement="setup"
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

// A repository deleted and cloned again at the same path stays registered but is no longer
// connected to its directory: the hint is there from the first render, without opening the picker,
// and one click reconnects it.
describe("CodingWorkbenchRepositorySelector reconnect action", () => {
  it("shows the hint and a Reconnect action on load, before the picker is opened", async () => {
    selectableRepositories.mockResolvedValue([project(true, false)]);
    listBranches.mockResolvedValue(branchList());
    renderSelector();
    expect(
      await screen.findByText(/This repository is no longer available in Git/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect repository" })).toBeEnabled();
  });

  it("reconnects in one click, reads the catalog again and tells the window", async () => {
    const user = userEvent.setup();
    selectableRepositories
      .mockResolvedValueOnce([project(true, false)])
      .mockResolvedValue([project(true, true)]);
    listBranches.mockResolvedValue(branchList());
    reconnectProject.mockResolvedValue({});
    const onReconnected = vi.fn();
    renderSelector(onReconnected);
    await user.click(await screen.findByRole("button", { name: "Reconnect repository" }));
    expect(reconnectProject).toHaveBeenCalledWith(ROOT);
    await waitFor(() => expect(onReconnected).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reconnect repository" })).toBeNull(),
    );
  });

  it("says in plain words that it could not reconnect, and does not tell the window", async () => {
    const user = userEvent.setup();
    selectableRepositories.mockResolvedValue([project(true, false)]);
    listBranches.mockResolvedValue(branchList());
    reconnectProject.mockRejectedValue(new Error("refused"));
    const onReconnected = vi.fn();
    renderSelector(onReconnected);
    await user.click(await screen.findByRole("button", { name: "Reconnect repository" }));
    expect(await screen.findByText(/could not reconnect this repository/u)).toBeInTheDocument();
    expect(onReconnected).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding workbench repository reconnect failed",
      expect.objectContaining({ kind: "other" }),
    );
  });

  it("offers no Reconnect for a repository that is gone from disk", async () => {
    selectableRepositories.mockResolvedValue([project(false, false)]);
    listBranches.mockResolvedValue(branchList());
    renderSelector();
    await screen.findByText(/This repository is no longer available in Git/u);
    expect(screen.queryByRole("button", { name: "Reconnect repository" })).toBeNull();
  });
});
