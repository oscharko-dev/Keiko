import { describe, expect, it } from "vitest";
import { isManagedTaskWorktreePath } from "./managedTaskWorktreePath";

describe("isManagedTaskWorktreePath", () => {
  it("recognizes POSIX and Windows managed worktree paths", () => {
    expect(isManagedTaskWorktreePath("/r/.keiko/dev/ui/task-workspaces/r/ws")).toBe(true);
    expect(isManagedTaskWorktreePath("C:\\r\\.keiko\\x\\task-workspaces\\ws")).toBe(true);
  });

  it("rejects ordinary, empty and non-string roots", () => {
    expect(isManagedTaskWorktreePath("/r/task-workspaces")).toBe(false);
    expect(isManagedTaskWorktreePath("")).toBe(false);
    expect(isManagedTaskWorktreePath(undefined)).toBe(false);
    expect(isManagedTaskWorktreePath(42)).toBe(false);
  });
});
