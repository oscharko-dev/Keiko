import { describe, expect, it } from "vitest";
import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";
import { startingProjectRoot } from "./startingProjectRoot";

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
