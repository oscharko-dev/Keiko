import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import { ApiError } from "@/lib/api";

import {
  branchOptions,
  CodingWorkbenchRepositorySelector,
} from "./CodingWorkbenchRepositorySelector";
import { RECONNECT_TIMEOUT_MS, useRepositoryReconnect } from "./useRepositoryReconnect";

const selectableRepositories = vi.hoisted(() => vi.fn());
vi.mock("./codingWorkbenchRepositories", () => ({ selectableRepositories }));

const listBranches = vi.hoisted(() => vi.fn());
const reconnectRepository = vi.hoisted(() => vi.fn());
vi.mock("../cards/git-client/git-client-seam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/git-client/git-client-seam")>();
  return {
    ...actual,
    DEFAULT_GIT_CLIENT: { ...actual.DEFAULT_GIT_CLIENT, listBranches, reconnectRepository },
  };
});

const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic,
}));

function project(path: string, available = true): ProjectWithAvailability {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 1,
    available,
    workspaceAvailable: available,
  };
}

function branchList(names: readonly string[], current = names[0]): unknown {
  return {
    schemaVersion: "1",
    root: "/repos/plain-folder",
    state: "available",
    available: true,
    branches: names.map((name) => ({
      name,
      headRefHash: "a".repeat(40),
      current: name === current,
    })),
    truncated: false,
  };
}

function renderSelector(
  overrides: Partial<Parameters<typeof CodingWorkbenchRepositorySelector>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <CodingWorkbenchRepositorySelector
      root="/repos/plain-folder"
      branch={null}
      location="local"
      locked={false}
      onSelect={vi.fn()}
      onSelectBranch={vi.fn()}
      onSelectLocation={vi.fn()}
      onOpenGit={vi.fn()}
      placement="setup"
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("branchOptions (#I)", () => {
  it("leaves an ordinary current branch selectable", () => {
    const options = branchOptions("main", [{ name: "main" }, { name: "dev" }], true, "unavailable");
    expect(options[0]).toEqual({ value: "main", label: "main" });
  });

  it("does not flag the stored branch while the branch list has not finished loading", () => {
    const options = branchOptions("release", [], false, "unavailable");
    expect(options[0]).toEqual({ value: "release", label: "release" });
  });

  // #I: a stored branch chosen before it was deleted (or chosen for a different repository, #E)
  // must not appear as an ordinary selectable option once the definitive list has loaded and does
  // not contain it — it is marked the same way an unregistered root already is.
  it("marks a stored branch missing from the loaded list as disabled with the unavailable badge", () => {
    const options = branchOptions("release", [{ name: "main" }], true, "unavailable");
    expect(options[0]).toEqual({
      value: "release",
      label: "release",
      disabled: true,
      badge: "unavailable",
    });
    expect(options[1]).toEqual({ value: "main", label: "main" });
  });
});

// #3873 live review: the Workbench's listboxes exposed nameless options in the accessibility tree.
// The repository, branch and "Work in" selectors share the same select, so each is checked here.
describe("CodingWorkbenchRepositorySelector option names", () => {
  const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

  async function expectNamedOptions(names: readonly string[]): Promise<void> {
    for (const name of names) {
      expect(screen.getByRole("option", { name })).toHaveAttribute("aria-label", name);
    }
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  }

  it("names every repository, branch and Work in option by its visible text", async () => {
    const user = userEvent.setup();
    selectableRepositories.mockResolvedValue([
      project("/repos/plain-folder"),
      project("/repos/archive", false),
    ]);
    listBranches.mockResolvedValue(branchList(["main", "feature/long-branch-name"]));
    renderSelector({ placement: "composer" });

    const repository = screen.getByRole("combobox", { name: "Choose coding repository" });
    await waitFor(() => expect(repository).toBeEnabled());
    await user.click(repository);
    await expectNamedOptions([
      "plain-folder, /repos/plain-folder",
      "archive, /repos/archive, unavailable",
    ]);
    await user.keyboard("{Escape}");

    const branch = screen.getByRole("combobox", { name: "Choose coding branch" });
    await waitFor(() => expect(branch).toBeEnabled());
    await user.click(branch);
    await expectNamedOptions(["main", "feature/long-branch-name"]);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "Work in" }));
    await expectNamedOptions(["Local", "New local worktree"]);
  });
});

// ADR-0121 D9: a folder package and a desktop installation run inside their program folder, which
// only keeps the Chats of a person who has chosen no folder. The server lists it `readable: false`;
// it stays visible and is never offered for a coding run, like Keiko's own state area (#4371).
describe("CodingWorkbenchRepositorySelector folders the read surface refuses", () => {
  it("lists a refused folder as unavailable and does not let it be chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    selectableRepositories.mockResolvedValue([
      { ...project("/opt/Keiko"), readable: false },
      { ...project("/work/app"), readable: true },
    ]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector({ placement: "composer", root: "/work/app", onSelect });

    const repository = screen.getByRole("combobox", { name: "Choose coding repository" });
    await waitFor(() => expect(repository).toBeEnabled());
    await user.click(repository);

    const refused = screen.getByRole("option", { name: "Keiko, /opt/Keiko, unavailable" });
    expect(refused).toBeDisabled();
    expect(screen.getByRole("option", { name: "app, /work/app" })).toBeEnabled();
    await user.click(refused);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// Walk of 1.5.3: two registered folders with the same name were two identical options. Each option
// now shows its path under the name, like the Git window's repository picker, and keeps a unique
// accessible name.
describe("CodingWorkbenchRepositorySelector folders that share a name", () => {
  it("tells two same-named folders apart by their path in the options", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    selectableRepositories.mockResolvedValue([
      { ...project("/work/app"), name: "app" },
      { ...project("/home/me/app"), name: "app" },
    ]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector({ placement: "composer", root: "/work/app", onSelect });

    const repository = screen.getByRole("combobox", { name: "Choose coding repository" });
    await waitFor(() => expect(repository).toBeEnabled());
    await user.click(repository);

    const names = screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"));
    expect(names).toEqual(["app, /work/app", "app, /home/me/app"]);
    expect(new Set(names).size).toBe(names.length);

    await user.click(screen.getByRole("option", { name: "app, /home/me/app" }));
    expect(onSelect).toHaveBeenCalledWith("/home/me/app");
  });
});

describe("CodingWorkbenchRepositorySelector recovery notices", () => {
  it("#B shows the Git-unavailable notice and Open Git once a registered root's branch read fails", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockRejectedValue(new Error("redacted: not a git repository"));
    const onOpenGit = vi.fn();
    renderSelector({ onOpenGit });

    expect(await screen.findByRole("alert")).toHaveTextContent("Git status could not be read");
    expect(screen.getByRole("button", { name: "Open Git" })).toBeInTheDocument();
  });

  // Owner decision 2026-10-30: the Workbench works in any folder. An ordinary folder still answers
  // the branch read with HTTP 200 and `available: false` (PR #3625 review), but that is no longer a
  // failure: it is folder mode, with a non-blocking hint, no alert, no Open Git escape and a Local
  // location that cannot be changed. A rejected read (above) keeps its Git-unavailable notice.
  it("treats an ordinary folder as folder mode: a hint, no alert and no Open Git", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue({
      ...(branchList([]) as object),
      available: false,
      state: "unavailable",
      reason: "not-a-repository",
    });
    renderSelector();

    expect(await screen.findByTestId("coding-workbench-folder-hint")).toHaveTextContent(
      "Not a Git repository",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Git" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Choose coding branch" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Work in" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Work in" })).toHaveTextContent("Local");
    expect(
      await axe(document.body, { rules: { region: { enabled: false } } }),
    ).toHaveNoViolations();
  });

  // #4068: the Windows broker confines only a new worktree, so readiness offers that location alone.
  // The Work in control then shows it, offers nothing else, and an ordinary folder says it cannot
  // run here instead of promising to work in place.
  it("offers only the worktree location the runtime can confine", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector({ location: "worktree", offeredLocations: ["worktree"] });

    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    const location = screen.getByRole("combobox", { name: "Work in" });
    expect(location).toHaveTextContent("New local worktree");
    expect(location).toBeDisabled();
    expect(screen.queryByTestId("coding-workbench-folder-unsupported")).not.toBeInTheDocument();
  });

  it("says an ordinary folder cannot run where only a worktree is confined", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue({
      ...(branchList([]) as object),
      available: false,
      state: "unavailable",
      reason: "not-a-repository",
    });
    renderSelector({ offeredLocations: ["worktree"] });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Keiko runs a coding task only in a new worktree of a Git repository",
    );
    expect(screen.queryByTestId("coding-workbench-folder-hint")).not.toBeInTheDocument();
  });

  it("does not show the Git-unavailable notice once the branch read succeeds", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector();

    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // #3873 F1 (live Gemma qualification): a repository below a denied read-surface path — a worktree
  // under a tool's state directory such as `.claude/` — read "may not be a Git repository" although
  // the Git window named the server's `DENIED` refusal. The notice names that policy decision, and
  // like every notice here it echoes no part of the path.
  it("names a read-surface refusal as a policy decision, not a missing Git repository", async () => {
    const root = "/repos/tooling/.claude/worktrees/task";
    selectableRepositories.mockResolvedValue([project(root)]);
    listBranches.mockRejectedValue(
      new ApiError("DENIED", "The requested path is excluded from the read surface.", 403),
    );
    renderSelector({ root });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/excluded from the read surface/iu);
    expect(notice).toHaveTextContent(/policy decision, not a missing Git repository/iu);
    expect(notice).not.toHaveTextContent(/may not be a Git repository/iu);
    for (const segment of ["/repos", "tooling", ".claude", "worktrees", "task"]) {
      expect(notice).not.toHaveTextContent(segment);
    }
    expect(screen.getByRole("button", { name: "Open Git" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Choose coding branch" })).toBeDisabled();
  });

  // #4371 F21: with no project chosen the Workbench says so once and leads to choosing a folder.
  it("says no project is chosen yet and offers one button that leads to choosing a folder", async () => {
    selectableRepositories.mockResolvedValue([]);
    const onOpenGit = vi.fn();
    renderSelector({ root: null, onOpenGit });

    expect(await screen.findByTestId("coding-workbench-no-project")).toHaveTextContent(
      "No project chosen yet: choose a folder.",
    );
    expect(screen.queryByRole("button", { name: "Open Git" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(onOpenGit).toHaveBeenCalledTimes(1);
  });

  it("does not say it once a project is chosen", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector();

    await screen.findByRole("combobox", { name: "Choose coding branch" });
    expect(screen.queryByTestId("coding-workbench-no-project")).not.toBeInTheDocument();
  });

  it("#C reports a catalog failure with closed errorKind, correlationId and error evidence", async () => {
    const failure = new ApiError("SERVICE_UNAVAILABLE", "redacted", 503);
    failure.correlationId = "corr-repo-1";
    selectableRepositories.mockRejectedValueOnce(failure);
    renderSelector();

    await waitFor(() => expect(reportClientDiagnostic).toHaveBeenCalled());
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "[keiko] coding workbench repository catalog unavailable",
      expect.objectContaining({
        kind: "other",
        errorKind: "unavailable",
        correlationId: "corr-repo-1",
        errorEvidence: expect.objectContaining({ errorClass: "ApiError" }),
      }),
    );
  });

  it("#C classifies a transport TypeError as unavailable with no correlation id", async () => {
    selectableRepositories.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderSelector();

    await waitFor(() => expect(reportClientDiagnostic).toHaveBeenCalled());
    const [, meta] = reportClientDiagnostic.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.errorKind).toBe("unavailable");
    expect(meta.correlationId).toBeUndefined();
  });

  it("#D offers a reachable retry that recovers the catalog in the composer placement", async () => {
    const user = userEvent.setup();
    selectableRepositories.mockRejectedValueOnce(new Error("redacted transport failure"));
    selectableRepositories.mockResolvedValueOnce([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector({ placement: "composer" });

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    const retryButton = screen.getByRole("button", { name: "Retry" });

    await user.click(retryButton);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(selectableRepositories).toHaveBeenCalledTimes(2);
  });
});

// #4491: a repository cloned again at the same path reads as unavailable until it is reconnected in
// Git; once the Workbench learns the folder's workspace is back, the catalog is read again so the
// notice clears without reopening the window.
describe("CodingWorkbenchRepositorySelector after a folder's workspace came back", () => {
  it("reads the catalog again when the refresh key changes", async () => {
    selectableRepositories
      .mockResolvedValueOnce([{ ...project("/repos/plain-folder"), workspaceAvailable: false }])
      .mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue(branchList(["main"]));
    const view = renderSelector({ catalogRefreshKey: "unbound" });
    expect(
      await screen.findByText(/This repository is no longer available in Git/u),
    ).toBeInTheDocument();

    view.rerender(
      <CodingWorkbenchRepositorySelector
        root="/repos/plain-folder"
        branch={null}
        location="local"
        locked={false}
        onSelect={vi.fn()}
        onSelectBranch={vi.fn()}
        onSelectLocation={vi.fn()}
        onOpenGit={vi.fn()}
        placement="setup"
        catalogRefreshKey="bound"
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText(/This repository is no longer available in Git/u)).toBeNull(),
    );
    expect(selectableRepositories).toHaveBeenCalledTimes(2);
  });
});

// U-16: a folder deleted and cloned again at the same path is refused by the server on purpose. It
// stays an enabled option with its reason, and choosing it is the explicit act that reconnects it.
describe("CodingWorkbenchRepositorySelector reconnect of a changed folder (U-16)", () => {
  function interactions(): unknown[] {
    return reportClientDiagnostic.mock.calls
      .map(
        ([, evidence]) =>
          (evidence as { codingWorkbenchInteraction?: unknown }).codingWorkbenchInteraction,
      )
      .filter((entry) => entry !== undefined);
  }

  const drifted = { ...project("/work/cloned"), workspaceAvailable: false };

  async function openPicker(
    overrides: Partial<Parameters<typeof renderSelector>[0]> = {},
  ): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector({ placement: "composer", root: "/work/app", ...overrides });
    const repository = screen.getByRole("combobox", { name: "Choose coding repository" });
    await waitFor(() => expect(repository).toBeEnabled());
    await user.click(repository);
    return user;
  }

  it("offers a changed folder as an enabled option with its reason and no call on mount", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    await openPicker();
    const option = screen.getByRole("option", { name: /cloned, Changed since it was added/u });
    expect(option).toBeEnabled();
    expect(reconnectRepository).not.toHaveBeenCalled();
  });

  it("keeps a missing folder disabled as unavailable, without a reconnect", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), project("/work/gone", false)]);
    const user = await openPicker();
    const option = screen.getByRole("option", { name: "gone, /work/gone, unavailable" });
    expect(option).toBeDisabled();
    await user.click(option);
    expect(reconnectRepository).not.toHaveBeenCalled();
  });

  it("reconnects once on choosing it, then reloads the catalog, then selects it", async () => {
    const order: string[] = [];
    selectableRepositories.mockImplementation(() => {
      order.push("catalog");
      return Promise.resolve([project("/work/app"), drifted]);
    });
    reconnectRepository.mockImplementation(() => {
      order.push("reconnect");
      return Promise.resolve({ project: project("/work/cloned") });
    });
    const onSelect = vi.fn(() => order.push("select"));
    const user = await openPicker({ onSelect });
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("/work/cloned"));
    expect(reconnectRepository).toHaveBeenCalledTimes(1);
    expect(reconnectRepository).toHaveBeenCalledWith("/work/cloned");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(order.slice(order.indexOf("reconnect"))).toEqual(["reconnect", "catalog", "select"]);
  });

  // U-44: typing the name and pressing Enter reconnected the folder but left the previous
  // repository selected; the person had to choose it a second time.
  it("selects the changed folder chosen with Enter in the search, with one reconnect", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    reconnectRepository.mockResolvedValue({ project: project("/work/cloned") });
    const onSelect = vi.fn();
    const user = await openPicker({ onSelect });
    await user.type(screen.getByPlaceholderText(/search/iu), "cloned{Enter}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("/work/cloned"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(reconnectRepository).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalledWith("/work/app");
    expect(interactions()).toEqual([
      { interaction: "repository-reconnected", outcome: "selected" },
    ]);
  });

  it("records that a reconnect finished after the selector was gone, without selecting", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    let finish: (value: unknown) => void = () => undefined;
    reconnectRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onSelect = vi.fn();
    const user = await openPicker({ onSelect });
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    cleanup();
    finish({ project: project("/work/cloned") });
    await waitFor(() =>
      expect(interactions()).toEqual([
        { interaction: "repository-reconnected", outcome: "selector-gone" },
      ]),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("locks the field with a label while a folder reconnects, then selects it and unlocks", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    let finish: (value: unknown) => void = () => undefined;
    reconnectRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onSelect = vi.fn();
    const user = await openPicker({ onSelect });
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Choose coding repository" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Choose coding repository" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(onSelect).not.toHaveBeenCalled();
    finish({ project: project("/work/cloned") });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("/work/cloned"));
    await waitFor(() => expect(screen.queryByText("Reconnecting…")).toBeNull());
    expect(screen.getByRole("combobox", { name: "Choose coding repository" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("lets a real later choice win over the reconnecting folder and still reads the catalog", async () => {
    let finish: (value: unknown) => void = () => undefined;
    reconnectRepository.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onSelect = vi.fn();
    const reload = vi.fn();
    const { result } = renderHook(() =>
      useRepositoryReconnect(
        [project("/work/app"), drifted, project("/work/other")],
        reload,
        onSelect,
      ),
    );
    act(() => result.current.choose("/work/cloned"));
    act(() => result.current.choose("/work/other"));
    expect(onSelect).toHaveBeenCalledWith("/work/other");
    await act(async () => finish({ project: project("/work/cloned") }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(interactions()).toEqual([
      { interaction: "repository-reconnected", outcome: "superseded" },
    ]);
  });

  it("ends a hung reconnect as a timeout failure and unlocks", async () => {
    vi.useFakeTimers();
    try {
      reconnectRepository.mockReturnValue(new Promise(() => undefined));
      const onSelect = vi.fn();
      const { result } = renderHook(() =>
        useRepositoryReconnect([project("/work/app"), drifted], vi.fn(), onSelect),
      );
      act(() => result.current.choose("/work/cloned"));
      expect(result.current.reconnecting).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(RECONNECT_TIMEOUT_MS));
      expect(result.current.reconnecting).toBe(false);
      expect(result.current.failed).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();
      expect(reportClientDiagnostic).toHaveBeenCalledWith(
        "[keiko] coding workbench repository reconnect failed",
        expect.objectContaining({ errorKind: "timeout" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the status region mounted and empty until a reconnect runs, and keeps focus", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    reconnectRepository.mockReturnValue(new Promise(() => undefined));
    const user = await openPicker();
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBe(region);
    expect(screen.getByRole("combobox", { name: "Choose coding repository" })).toHaveFocus();
  });

  it("treats a reconnect that leaves the workspace unavailable as a failure", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    reconnectRepository.mockResolvedValue({ project: drifted });
    const onSelect = vi.fn();
    const user = await openPicker({ onSelect });
    const reads = selectableRepositories.mock.calls.length;
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reconnected/u);
    expect(onSelect).not.toHaveBeenCalled();
    expect(selectableRepositories.mock.calls.length).toBe(reads);
    const call = reportClientDiagnostic.mock.calls.find(([message]) =>
      String(message).includes("reconnect failed"),
    );
    const detail = call?.[1] as { errorKind?: string; correlationId?: string } | undefined;
    expect(detail?.errorKind).toBe("conflict");
    expect(detail?.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(call)).not.toContain("/work/cloned");
  });

  it("clears the failure once a healthy folder is chosen", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted, project("/work/ok")]);
    reconnectRepository.mockRejectedValue(new ApiError("SERVICE_UNAVAILABLE", "redacted", 503));
    const user = await openPicker();
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Choose coding repository" }));
    await user.click(screen.getByRole("option", { name: "ok, /work/ok" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  // Both invariants now live at the hook that owns them: the picker is locked during a reconnect,
  // so only a direct `choose` can repeat or overtake a choice.
  it("sends one request for a repeated choice of the same folder", () => {
    reconnectRepository.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() =>
      useRepositoryReconnect([project("/work/app"), drifted], vi.fn(), vi.fn()),
    );
    act(() => result.current.choose("/work/cloned"));
    act(() => result.current.choose("/work/cloned"));
    expect(reconnectRepository).toHaveBeenCalledTimes(1);
  });

  it("lets only the latest choice apply when an earlier reconnect resolves late", async () => {
    const other = { ...project("/work/other"), workspaceAvailable: false };
    const settle: Record<string, (value: unknown) => void> = {};
    reconnectRepository.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          settle[path] = resolve;
        }),
    );
    const onSelect = vi.fn();
    const { result } = renderHook(() =>
      useRepositoryReconnect([project("/work/app"), drifted, other], vi.fn(), onSelect),
    );
    act(() => result.current.choose("/work/cloned"));
    act(() => result.current.choose("/work/other"));
    await act(async () => settle["/work/other"]?.({ project: project("/work/other") }));
    expect(onSelect).toHaveBeenCalledWith("/work/other");
    await act(async () => settle["/work/cloned"]?.({ project: project("/work/cloned") }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("applies nothing when the picker unmounts during the reconnect", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    let settle: (value: unknown) => void = () => undefined;
    reconnectRepository.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onSelect = vi.fn();
    const user = await openPicker({ onSelect });
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    cleanup();
    const reads = selectableRepositories.mock.calls.length;
    settle({ project: project("/work/cloned") });
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
    expect(selectableRepositories.mock.calls.length).toBe(reads);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps a refused folder disabled even when its workspace is not current", async () => {
    selectableRepositories.mockResolvedValue([
      project("/work/app"),
      { ...drifted, path: "/opt/Keiko", name: "Keiko", readable: false },
    ]);
    const user = await openPicker();
    const option = screen.getByRole("option", { name: "Keiko, /opt/Keiko, unavailable" });
    expect(option).toBeDisabled();
    await user.click(option);
    expect(reconnectRepository).not.toHaveBeenCalled();
  });

  it("shows a visible error and a body-free diagnostic when the reconnect fails", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    reconnectRepository.mockRejectedValue(new ApiError("SERVICE_UNAVAILABLE", "redacted", 503));
    const onSelect = vi.fn();
    const user = await openPicker({ onSelect });
    await user.click(screen.getByRole("option", { name: /cloned, Changed since it was added/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be reconnected/u);
    expect(onSelect).not.toHaveBeenCalled();
    const call = reportClientDiagnostic.mock.calls.find(([message]) =>
      String(message).includes("reconnect failed"),
    );
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toContain("/work/cloned");
  });

  it("has no axe violations with a changed folder offered", async () => {
    selectableRepositories.mockResolvedValue([project("/work/app"), drifted]);
    await openPicker();
    expect(
      await axe(document.body, { rules: { region: { enabled: false } } }),
    ).toHaveNoViolations();
  });
});
