import { describe, expect, it } from "vitest";

import { PathDeniedError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { memFs } from "./_memfs.js";
import { realRootIsDeniedViaSymlink, resolveExistingAllowedWorkspaceRealRoot } from "./realpath.js";

describe("resolveExistingAllowedWorkspaceRealRoot", () => {
  it("classifies and returns one canonical root identity", () => {
    const baseFs = memFs("/work", {});
    let realPathCalls = 0;
    const fs: WorkspaceFs = {
      ...baseFs,
      realPath: (): string => {
        realPathCalls += 1;
        return realPathCalls === 1 ? "/safe/project" : "/safe/.aws";
      },
    };

    expect(resolveExistingAllowedWorkspaceRealRoot(fs, "/work/project")).toBe("/safe/project");
    expect(realPathCalls).toBe(1);
  });

  it("rejects a denied locus in the canonical root", () => {
    const baseFs = memFs("/work", {});
    const fs: WorkspaceFs = { ...baseFs, realPath: (): string => "/safe/.aws" };

    expect(() => resolveExistingAllowedWorkspaceRealRoot(fs, "/work/project")).toThrow(
      PathDeniedError,
    );
  });

  it.each(["", "relative/project", "/work/project\u0000"])(
    "rejects malformed root %j before filesystem resolution",
    (root) => {
      const baseFs = memFs("/work", {});
      let realPathCalls = 0;
      const fs: WorkspaceFs = {
        ...baseFs,
        realPath: (): string => {
          realPathCalls += 1;
          return "/work/project";
        },
      };

      expect(() => resolveExistingAllowedWorkspaceRealRoot(fs, root)).toThrow(PathDeniedError);
      expect(realPathCalls).toBe(0);
    },
  );
});

describe("realRootIsDeniedViaSymlink", () => {
  it("fails closed for empty or malformed roots", () => {
    expect(realRootIsDeniedViaSymlink("", "/work/project")).toBe(true);
    expect(realRootIsDeniedViaSymlink("/work/project", "")).toBe(true);
    expect(realRootIsDeniedViaSymlink("relative/project", "/work/project")).toBe(true);
    expect(realRootIsDeniedViaSymlink("/work/project", "relative/project")).toBe(true);
    expect(realRootIsDeniedViaSymlink("/work/project\u0000", "/work/project")).toBe(true);
  });

  it("rejects a different denied segment introduced under an already-denied lexical root", () => {
    expect(realRootIsDeniedViaSymlink("/work/.aws/project", "/work/node_modules/project")).toBe(
      true,
    );
  });

  it("rejects relocation between separate loci with the same denied segment", () => {
    expect(
      realRootIsDeniedViaSymlink("/work/other/.codex", "/work/.codex/worktrees/project/docs"),
    ).toBe(true);
    expect(
      realRootIsDeniedViaSymlink(
        "/other/.codex/worktrees/project",
        "/safe/.codex/worktrees/project",
      ),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps canonically equivalent Unicode root names distinct on POSIX-shaped volumes",
    () => {
      expect(
        realRootIsDeniedViaSymlink("/work/.codex/\u00e9/project", "/work/.codex/e\u0301/project"),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps case-distinct roots separate on case-sensitive POSIX-shaped volumes",
    () => {
      expect(realRootIsDeniedViaSymlink("/work/.codex/Foo", "/work/.codex/foo")).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps POSIX backslash names distinct from directory separators",
    () => {
      expect(realRootIsDeniedViaSymlink("/work/.codex/a/b", "/work/.codex/a\\b")).toBe(true);
    },
  );

  it("accepts equivalent roots with repeated trailing separators", () => {
    expect(realRootIsDeniedViaSymlink("/work/.codex", "/work/.codex///")).toBe(false);
  });

  it("accepts equivalent roots with dot segments", () => {
    expect(realRootIsDeniedViaSymlink("/work/safe", "/work/.aws/../safe")).toBe(false);
  });

  it("keeps Windows root identity host-independent", () => {
    expect(
      realRootIsDeniedViaSymlink("C:\\work\\.codex\\project", "C:\\work\\.codex\\project\\\\"),
    ).toBe(false);
    expect(
      realRootIsDeniedViaSymlink("c:\\work\\.codex\\project", "C:\\work\\.codex\\project"),
    ).toBe(false);
    expect(realRootIsDeniedViaSymlink("C:\\work\\.codex\\Foo", "C:\\work\\.codex\\foo")).toBe(true);
    expect(
      realRootIsDeniedViaSymlink(
        "C:\\work\\.codex\\\u00e9\\project",
        "C:\\work\\.codex\\e\u0301\\project",
      ),
    ).toBe(true);
    expect(
      realRootIsDeniedViaSymlink("D:\\other\\.codex\\project", "C:\\work\\.codex\\project"),
    ).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "allows an unchanged denied ancestor across a known macOS platform alias",
    () => {
      expect(
        realRootIsDeniedViaSymlink(
          "/private/var/tmp/.codex/worktrees/project",
          "/var/tmp/.codex/worktrees/project",
        ),
      ).toBe(false);
    },
  );

  it("rejects an arbitrary private-prefix relocation", () => {
    expect(
      realRootIsDeniedViaSymlink(
        "/private/Users/dev/.codex/worktrees/project",
        "/Users/dev/.codex/worktrees/project",
      ),
    ).toBe(true);
  });
});
