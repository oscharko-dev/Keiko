import { renderHook } from "@testing-library/react";
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
});
