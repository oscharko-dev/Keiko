import { describe, expect, it } from "vitest";
import {
  isRootRelativeFileIdentifier,
  resolveWorkspaceFileIdentifier,
  selectWorkspaceFileTarget,
} from "./editor-workspace-path.js";

const NUL = String.fromCharCode(0);

describe("isRootRelativeFileIdentifier", () => {
  it("accepts contained root-relative POSIX identifiers", () => {
    expect(isRootRelativeFileIdentifier("src/a.ts")).toBe(true);
    expect(isRootRelativeFileIdentifier("packages/keiko-cli/src/run.ts")).toBe(true);
    expect(isRootRelativeFileIdentifier("README.md")).toBe(true);
    expect(isRootRelativeFileIdentifier("my docs/notes file.md")).toBe(true);
  });

  it("rejects empty, absolute, drive-prefixed, traversal and NUL identifiers", () => {
    expect(isRootRelativeFileIdentifier("")).toBe(false);
    expect(isRootRelativeFileIdentifier("/etc/passwd")).toBe(false);
    expect(isRootRelativeFileIdentifier("C:/Windows/System32")).toBe(false);
    expect(isRootRelativeFileIdentifier("../secret")).toBe(false);
    expect(isRootRelativeFileIdentifier("src/../../escape")).toBe(false);
    expect(isRootRelativeFileIdentifier(`a${NUL}b`)).toBe(false);
  });
});

describe("resolveWorkspaceFileIdentifier", () => {
  it("returns empty for a missing or blank candidate", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", undefined)).toEqual({ kind: "empty" });
    expect(resolveWorkspaceFileIdentifier("/repo", "   ")).toEqual({ kind: "empty" });
  });

  it("strips the root prefix from an absolute path inside the root (AC1)", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "/repo/src/a.ts")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
  });

  it("treats the root itself as a non-file selection", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "/repo")).toEqual({ kind: "root" });
    expect(resolveWorkspaceFileIdentifier("/repo/", "/repo")).toEqual({ kind: "root" });
  });

  it("keeps an already-root-relative candidate (AC2)", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "src/a.ts")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    expect(resolveWorkspaceFileIdentifier("/repo", "./src/a.ts")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
  });

  it("normalizes backslash separators to POSIX", () => {
    expect(resolveWorkspaceFileIdentifier("C:\\repo", "C:\\repo\\src\\a.ts")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    expect(resolveWorkspaceFileIdentifier("/repo", "src\\a.ts")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
  });

  it("collapses repeated slashes without polynomial backtracking on adversarial input", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "/repo//src///a.ts")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    // A long run of leading slashes must normalize linearly (regression guard for the ReDoS fix).
    const adversarial = `${"/".repeat(50_000)}x`;
    expect(resolveWorkspaceFileIdentifier("/repo", adversarial)).toEqual({
      kind: "outside-root",
      candidate: "/x",
    });
  });

  it("matches the root prefix case-insensitively but preserves candidate casing", () => {
    expect(resolveWorkspaceFileIdentifier("/Repo", "/repo/Src/A.ts")).toEqual({
      kind: "relative",
      path: "Src/A.ts",
    });
  });

  it("flags an absolute path outside the root as outside-root (no leak to the BFF)", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "/other/x.ts")).toEqual({
      kind: "outside-root",
      candidate: "/other/x.ts",
    });
  });

  it("does not treat a sibling root with a shared prefix as contained", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "/repo-sibling/x.ts")).toEqual({
      kind: "outside-root",
      candidate: "/repo-sibling/x.ts",
    });
  });

  it("flags a traversal-escaping relative candidate as outside-root", () => {
    expect(resolveWorkspaceFileIdentifier("/repo", "../escape.ts")).toEqual({
      kind: "outside-root",
      candidate: "../escape.ts",
    });
    expect(resolveWorkspaceFileIdentifier("/repo", "src/../../escape.ts")).toEqual({
      kind: "outside-root",
      candidate: "src/../../escape.ts",
    });
  });

  it("rejects a NUL-bearing candidate without resolving it", () => {
    const result = resolveWorkspaceFileIdentifier("/repo", `/repo/a${NUL}b.ts`);
    expect(result.kind).toBe("outside-root");
  });

  it("flags any absolute path when no root is selected", () => {
    expect(resolveWorkspaceFileIdentifier("", "/repo/src/a.ts")).toEqual({
      kind: "outside-root",
      candidate: "/repo/src/a.ts",
    });
  });
});

describe("selectWorkspaceFileTarget", () => {
  it("keeps the supplied root for a root-relative candidate (AC2)", () => {
    expect(selectWorkspaceFileTarget("/repo", "src/a.ts")).toEqual({
      root: "/repo",
      file: "src/a.ts",
    });
  });

  it("keeps the supplied root and strips the prefix for an absolute-inside candidate (AC1)", () => {
    expect(selectWorkspaceFileTarget("/repo", "/repo/src/a.ts")).toEqual({
      root: "/repo",
      file: "src/a.ts",
    });
  });

  it("selects the containing directory as the root for a single absolute file (AC3)", () => {
    expect(selectWorkspaceFileTarget("/repo", "/other/project/main.py")).toEqual({
      root: "/other/project",
      file: "main.py",
    });
  });

  it("selects a containing root for an absolute file when no root is configured (AC3)", () => {
    expect(selectWorkspaceFileTarget("", "/lonely/file.ts")).toEqual({
      root: "/lonely",
      file: "file.ts",
    });
  });

  it("returns an empty file selection for the root itself", () => {
    expect(selectWorkspaceFileTarget("/repo", "/repo")).toEqual({ root: "/repo", file: "" });
    expect(selectWorkspaceFileTarget("/repo", undefined)).toEqual({ root: "/repo", file: "" });
  });

  it("yields null (clear non-blocking state) for an unresolvable candidate", () => {
    expect(selectWorkspaceFileTarget("", "src/a.ts")).toBeNull();
    expect(selectWorkspaceFileTarget("/repo", "../escape.ts")).toBeNull();
    expect(selectWorkspaceFileTarget("", undefined)).toBeNull();
  });

  it("does not derive a root from an absolute path that has no parent directory", () => {
    expect(selectWorkspaceFileTarget("", "/")).toBeNull();
  });
});
