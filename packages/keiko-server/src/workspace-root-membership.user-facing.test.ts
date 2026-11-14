import { describe, expect, it } from "vitest";
import { userFacingProjects } from "./workspace-root-membership.js";
import type { Project } from "./store/index.js";

function project(path: string): Project {
  return { path, name: path, favorite: false, createdAt: 1, lastOpenedAt: 1 };
}

// #4371 F21: a project the Files and Git routes refuse is not offered as a project at all.
describe("userFacingProjects", () => {
  const readable = project("/work/customer-repo");
  const refused = project("/work/tool/.claude/worktrees/keiko");
  const managed = project("/state/task-workspaces/repo/one");

  it("drops a project the read surface refuses", () => {
    expect(userFacingProjects([refused, readable], undefined)).toEqual([readable]);
  });

  it("still drops a managed worktree and keeps the readable project", () => {
    expect(userFacingProjects([managed, refused, readable], "/state/task-workspaces")).toEqual([
      readable,
    ]);
  });

  it("keeps every readable project when nothing is managed", () => {
    expect(userFacingProjects([readable], undefined)).toEqual([readable]);
  });
});
