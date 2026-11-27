import { describe, expect, it } from "vitest";
import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  gitReopenRoot,
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

describe("gitReopenRoot", () => {
  const listed = [project({ path: "/a" }), project({ path: "/b" })];

  it("returns to the repository last chosen in the Git window, not the starting project", () => {
    expect(gitReopenRoot("/b", listed, "/a")).toBe("/b");
  });

  it("falls back to the starting project when none was chosen", () => {
    expect(gitReopenRoot(undefined, listed, "/a")).toBe("/a");
    expect(gitReopenRoot(undefined, listed, undefined)).toBeUndefined();
  });

  it("never returns a chosen repository the list marks gone or refused", () => {
    const gone = [project({ path: "/a" }), project({ path: "/b", available: false })];
    const refused = [project({ path: "/a" }), project({ path: "/b", readable: false })];
    expect(gitReopenRoot("/b", gone, "/a")).toBe("/a");
    expect(gitReopenRoot("/b", refused, "/a")).toBe("/a");
  });

  it("keeps a chosen repository the shell list does not carry yet", () => {
    expect(gitReopenRoot("/new", listed, "/a")).toBe("/new");
  });
});
