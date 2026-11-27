import { describe, expect, it } from "vitest";
import { workspaceRootsNameSameFolder } from "./workspace-contract-primitives.js";

describe("workspaceRootsNameSameFolder", () => {
  it("folds case, separators and a trailing separator where the filesystem ignores case", () => {
    expect(workspaceRootsNameSameFolder("C:\\Work\\App", "c:/work/app/", true)).toBe(true);
    expect(workspaceRootsNameSameFolder("/Users/a/repo", "/users/a/repo", true)).toBe(true);
    expect(workspaceRootsNameSameFolder("/", "/", true)).toBe(true);
    expect(workspaceRootsNameSameFolder("/work/repo-a", "/work/repo-b", true)).toBe(false);
    expect(workspaceRootsNameSameFolder("/work/repo", "/work/repo/sub", true)).toBe(false);
    expect(workspaceRootsNameSameFolder("", "", true)).toBe(false);
  });

  it("keeps case exact where the filesystem is case-sensitive, and still folds separators", () => {
    expect(workspaceRootsNameSameFolder("/Users/a/repo", "/users/a/repo", false)).toBe(false);
    expect(workspaceRootsNameSameFolder("/Users/a/repo", "/Users/a/repo/", false)).toBe(true);
    expect(workspaceRootsNameSameFolder("C:\\Work\\App", "C:/Work/App", false)).toBe(true);
    expect(workspaceRootsNameSameFolder("", "", false)).toBe(false);
  });
});
