import { describe, expect, it } from "vitest";
import { workspaceRootsNameSameFolder } from "./workspace-contract-primitives.js";

describe("workspaceRootsNameSameFolder", () => {
  it("folds case, separators and a trailing separator, and nothing more", () => {
    expect(workspaceRootsNameSameFolder("C:\\Work\\App", "c:/work/app/")).toBe(true);
    expect(workspaceRootsNameSameFolder("/Users/a/repo", "/users/a/repo")).toBe(true);
    expect(workspaceRootsNameSameFolder("/", "/")).toBe(true);
    expect(workspaceRootsNameSameFolder("/work/repo-a", "/work/repo-b")).toBe(false);
    expect(workspaceRootsNameSameFolder("/work/repo", "/work/repo/sub")).toBe(false);
    expect(workspaceRootsNameSameFolder("", "")).toBe(false);
  });
});
