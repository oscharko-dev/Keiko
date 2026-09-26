import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import { repositorySelectable, selectableRepositories } from "./codingWorkbenchRepositories";

const fetchProjects = vi.hoisted(() => vi.fn());
const fetchGitSummary = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ fetchProjects, fetchGitSummary }));

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

describe("coding workbench Git repository catalog", () => {
  beforeEach(() => {
    fetchProjects.mockReset();
    fetchGitSummary.mockReset();
    fetchProjects.mockResolvedValue({
      projects: [project("/repos/ready"), project("/repos/missing", false)],
    });
  });

  it("lists every repository shown by Git, including temporarily unavailable entries", async () => {
    expect(await selectableRepositories()).toEqual([
      project("/repos/ready"),
      project("/repos/missing", false),
    ]);
    expect(fetchGitSummary).not.toHaveBeenCalled();
  });

  it("refuses a path that is absent from Git's registered project catalog", async () => {
    expect(await repositorySelectable("/repos/unregistered")).toBe(false);
    expect(fetchGitSummary).not.toHaveBeenCalled();
  });

  it("shows but refuses a registered checkout without active workspace membership", async () => {
    expect(await repositorySelectable("/repos/missing")).toBe(false);
    expect(fetchGitSummary).not.toHaveBeenCalled();
  });

  it("rechecks Git availability before binding a registered repository", async () => {
    fetchGitSummary.mockResolvedValue({ available: false, state: "unavailable" });
    expect(await repositorySelectable("/repos/ready")).toBe(false);
    expect(fetchGitSummary).toHaveBeenCalledExactlyOnceWith("/repos/ready");
  });

  // #G: every other case in this file is a refusal — none of them prove the accepting path ever
  // returns `true` at all.
  it("accepts a registered, workspace-available repository once Git confirms it is available", async () => {
    fetchGitSummary.mockResolvedValue({ available: true, state: "available" });
    expect(await repositorySelectable("/repos/ready")).toBe(true);
    expect(fetchGitSummary).toHaveBeenCalledExactlyOnceWith("/repos/ready");
  });
});
