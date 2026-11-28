import { describe, expect, it } from "vitest";
import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  decideGitReopen,
  startingProjectPaths,
  startingProjectRoot,
  startingProjects,
} from "./startingProjectRoot";

function project(overrides: Partial<ProjectWithAvailability>): ProjectWithAvailability {
  return {
    path: "/work/repo",
    name: "repo",
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 1,
    available: true,
    ...overrides,
  };
}

describe("startingProjectRoot", () => {
  it("offers an available, readable project", () => {
    expect(startingProjectRoot(project({ readable: true }))).toBe("/work/repo");
  });

  it("reads an absent flag as readable", () => {
    expect(startingProjectRoot(project({}))).toBe("/work/repo");
  });

  it("never offers a project the read surface refuses", () => {
    expect(startingProjectRoot(project({ readable: false }))).toBeNull();
  });

  it("offers nothing for a missing or unavailable project", () => {
    expect(startingProjectRoot(null)).toBeNull();
    expect(startingProjectRoot(project({ available: false }))).toBeNull();
  });
});

describe("startingProjectPaths", () => {
  it("keeps the order and leaves out an unavailable or refused project", () => {
    expect(
      startingProjectPaths([
        project({ path: "/refused", readable: false }),
        project({ path: "/offline", available: false }),
        project({ path: "/first" }),
        project({ path: "/second", readable: true }),
      ]),
    ).toEqual(["/first", "/second"]);
  });
});

describe("startingProjects", () => {
  it("keeps whole projects, in order, without an unavailable or refused one", () => {
    const first = project({ path: "/first", name: "first" });
    expect(
      startingProjects([
        project({ path: "/refused", readable: false }),
        first,
        project({ path: "/offline", available: false }),
      ]),
    ).toEqual([first]);
  });
});

describe("decideGitReopen", () => {
  const listed = [project({ path: "/a" }), project({ path: "/b" })];
  const worktree = "/a/.keiko/dev/ui/task-workspaces/a/ws-1";

  it("returns to the repository last chosen in the Git window, not the starting project", () => {
    expect(decideGitReopen("/b", listed, "/a")).toEqual({ root: "/b" });
  });

  it("falls back to the starting project when none was chosen, without a reason", () => {
    expect(decideGitReopen(undefined, listed, "/a")).toEqual({ root: "/a" });
    expect(decideGitReopen(undefined, listed, undefined)).toEqual({ root: undefined });
  });

  it("never returns a chosen repository the list marks gone or refused, and says why", () => {
    const gone = [project({ path: "/a" }), project({ path: "/b", available: false })];
    const refused = [project({ path: "/a" }), project({ path: "/b", readable: false })];
    expect(decideGitReopen("/b", gone, "/a")).toEqual({
      root: "/a",
      fallbackReason: "remembered-unavailable",
    });
    expect(decideGitReopen("/b", refused, "/a")).toEqual({
      root: "/a",
      fallbackReason: "remembered-unreadable",
    });
  });

  it("never returns a managed task worktree, even one the list carries", () => {
    const withWorktree = [...listed, project({ path: worktree })];
    expect(decideGitReopen(worktree, withWorktree, "/a")).toEqual({
      root: "/a",
      fallbackReason: "remembered-managed-worktree",
    });
  });

  it("keeps a chosen repository the shell list does not carry yet", () => {
    expect(decideGitReopen("/new", listed, "/a")).toEqual({ root: "/new" });
  });
});
