import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      locked={false}
      onSelect={vi.fn()}
      onSelectBranch={vi.fn()}
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

describe("CodingWorkbenchRepositorySelector recovery notices", () => {
  it("#B shows the Git-unavailable notice and Open Git once a registered root's branch read fails", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockRejectedValue(new Error("redacted: not a git repository"));
    const onOpenGit = vi.fn();
    renderSelector({ onOpenGit });

    expect(await screen.findByRole("alert")).toHaveTextContent("Git status could not be read");
    expect(screen.getByRole("button", { name: "Open Git" })).toBeInTheDocument();
  });

  it("does not show the Git-unavailable notice once the branch read succeeds", async () => {
    selectableRepositories.mockResolvedValue([project("/repos/plain-folder")]);
    listBranches.mockResolvedValue(branchList(["main"]));
    renderSelector();

    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
