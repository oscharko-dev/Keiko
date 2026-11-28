import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { WorkspaceStorageScopeContext } from "../hooks/workspace-storage";
import { describe, expect, it } from "vitest";
import type { AppWindow } from "./types";
import { frontmostGitRoot, useRememberedGitRoot } from "./useRememberedGitRoot";

function gitWindow(projectPath: string | undefined, z: number): AppWindow {
  return {
    id: `git-${String(z)}`,
    type: "governedGit",
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    z,
    cfg: projectPath === undefined ? {} : { projectPath },
    max: false,
    zoom: 1,
  };
}

describe("frontmostGitRoot", () => {
  it("names the repository of the frontmost Git window that has one", () => {
    expect(frontmostGitRoot([gitWindow("/a", 1), gitWindow("/b", 2)])).toBe("/b");
    expect(frontmostGitRoot([gitWindow("/a", 1), gitWindow(undefined, 2)])).toBe("/a");
  });

  it("never names a managed task worktree a hand-off put in the Git window", () => {
    const worktree = "/r/.keiko/dev/ui/task-workspaces/r/ws-1";
    expect(frontmostGitRoot([gitWindow(worktree, 1)])).toBeUndefined();
    expect(frontmostGitRoot([gitWindow("/a", 1), gitWindow(worktree, 2)])).toBe("/a");
  });

  it("names nothing without a Git window or a layout", () => {
    expect(frontmostGitRoot(null)).toBeUndefined();
    expect(frontmostGitRoot([])).toBeUndefined();
  });
});

describe("useRememberedGitRoot", () => {
  it("keeps the last chosen repository after the Git window closes", () => {
    const { result, rerender } = renderHook(
      ({ wins }: { wins: readonly AppWindow[] }) => useRememberedGitRoot(wins),
      { initialProps: { wins: [gitWindow("/a", 1)] } },
    );
    expect(result.current.current).toBe("/a");
    rerender({ wins: [gitWindow("/b", 1)] });
    expect(result.current.current).toBe("/b");
    rerender({ wins: [] });
    expect(result.current.current).toBe("/b");
  });

  it("starts empty when the installation storage identity changes", () => {
    let scope = "scope-a";
    const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
      createElement(WorkspaceStorageScopeContext, { value: scope }, children);
    const { result, rerender } = renderHook(
      ({ wins }: { wins: readonly AppWindow[] }) => useRememberedGitRoot(wins),
      { initialProps: { wins: [gitWindow("/a", 1)] }, wrapper },
    );
    expect(result.current.current).toBe("/a");
    scope = "scope-b";
    rerender({ wins: [] });
    expect(result.current.current).toBeUndefined();
  });
});
