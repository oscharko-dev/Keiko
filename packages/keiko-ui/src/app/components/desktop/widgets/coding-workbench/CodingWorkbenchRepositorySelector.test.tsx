import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import { ApiError } from "@/lib/api";

import {
  branchOptions,
  CodingWorkbenchRepositorySelector,
} from "./CodingWorkbenchRepositorySelector";

const selectableRepositories = vi.hoisted(() => vi.fn());
vi.mock("./codingWorkbenchRepositories", () => ({ selectableRepositories }));

const listBranches = vi.hoisted(() => vi.fn());
vi.mock("../cards/git-client/git-client-seam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cards/git-client/git-client-seam")>();
  return { ...actual, DEFAULT_GIT_CLIENT: { ...actual.DEFAULT_GIT_CLIENT, listBranches } };
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
    await expectNamedOptions(["plain-folder", "archive, unavailable"]);
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

describe("CodingWorkbenchRepositorySelector recovery notices", () => {
  it("#B shows the Git-unavailable notice and Open Git once a registered root's branch read fails", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockRejectedValue(new Error("redacted: not a git repository"));
    const onOpenGit = vi.fn();
    renderSelector({ onOpenGit });

    expect(await screen.findByRole("alert")).toHaveTextContent("Git status could not be read");
    expect(screen.getByRole("button", { name: "Open Git" })).toBeInTheDocument();
  });

  // PR #3625 review: an ordinary folder does not make the branch read reject — the route answers
  // HTTP 200 with `available: false` and `reason: "not-a-repository"`, which is the same signal.
  it("#B shows the Git-unavailable notice when the branch read resolves unavailable", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue({
      ...(branchList([]) as object),
      available: false,
      state: "unavailable",
      reason: "not-a-repository",
    });
    renderSelector();

    expect(await screen.findByRole("alert")).toHaveTextContent("Git status could not be read");
    expect(screen.getByRole("button", { name: "Open Git" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Choose coding branch" })).toBeDisabled();
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
