import { describe, expect, it } from "vitest";
import { projectReadable } from "./workspace-root-membership.js";
import type { Project } from "./store/index.js";

function project(path: string): Project {
  return { path, name: path, favorite: false, createdAt: 1, lastOpenedAt: 1 };
}

// #4371 F21: a project the Files and Git routes refuse stays listed; it is only marked, so the shell
// never offers it as the starting project.
describe("projectReadable", () => {
  it("marks a folder inside a tool's own state area as not readable", () => {
    expect(projectReadable(project("/work/tool/.claude/worktrees/keiko"))).toBe(false);
    expect(projectReadable(project("/home/me/.config/repo"))).toBe(false);
  });

  it("keeps an ordinary folder readable", () => {
    expect(projectReadable(project("/work/customer-repo"))).toBe(true);
  });
});
