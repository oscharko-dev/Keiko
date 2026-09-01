import { describe, expect, it } from "vitest";

import { PathDeniedError, PathEscapeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { memFs } from "./_memfs.js";
import {
  containedRealPathInfo,
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
  realRootIsDeniedViaSymlink,
  resolveExistingAllowedWorkspaceRealRoot,
} from "./realpath.js";

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

  it("reuses the request-scoped canonical root identity", () => {
    const baseFs = memFs("/work", {});
    let canonicalCalls = 0;
    let realPathCalls = 0;
    const fs: WorkspaceFs = {
      ...baseFs,
      canonicalWorkspaceRoot: (): string => {
        canonicalCalls += 1;
        return "/safe/project";
      },
      realPath: (): string => {
        realPathCalls += 1;
        return "/unexpected";
      },
    };

    expect(resolveExistingAllowedWorkspaceRealRoot(fs, "/work/project")).toBe("/safe/project");
    expect(canonicalCalls).toBe(1);
    expect(realPathCalls).toBe(0);
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

function containmentFs(target: string): {
  readonly fs: WorkspaceFs;
  readonly canonicalCalls: () => number;
  readonly targetCalls: () => number;
} {
  let canonicalCalls = 0;
  let targetCalls = 0;
  const unsupported = (): never => {
    throw new Error("filesystem operation is not used by this fixture");
  };
  return {
    fs: {
      readFileUtf8: unsupported,
      stat: unsupported,
      readDir: unsupported,
      realPath: (): string => {
        targetCalls += 1;
        return target;
      },
      canonicalWorkspaceRoot: (): string => {
        canonicalCalls += 1;
        return "/real/workspace";
      },
      exists: (): boolean => true,
    },
    canonicalCalls: () => canonicalCalls,
    targetCalls: () => targetCalls,
  };
}

describe("containedRealPathInfo", () => {
  it("uses the canonical-root seam only for the base and still resolves every target", () => {
    const measured = containmentFs("/real/workspace/src/file.ts");

    expect(containedRealPathInfo(measured.fs, "/workspace", "/workspace/src/file.ts")).toEqual({
      path: "/real/workspace/src/file.ts",
      realRelative: "src/file.ts",
      realBase: "/real/workspace",
    });
    expect(measured.canonicalCalls()).toBe(1);
    expect(measured.targetCalls()).toBe(1);
  });

  it("rejects an escaping target even when the canonical root is request-cached", () => {
    const measured = containmentFs("/outside/private.txt");

    expect(() =>
      containedRealPathInfo(measured.fs, "/workspace", "/workspace/private.txt"),
    ).toThrow(PathEscapeError);
    expect(measured.canonicalCalls()).toBe(1);
    expect(measured.targetCalls()).toBe(1);
  });
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

describe("isCanonicalAllowedContainedPath", () => {
  it("accepts the canonical root and exact canonical descendants", () => {
    expect(
      isCanonicalAllowedContainedPath(
        { path: "/workspace", realRelative: "", realBase: "/workspace" },
        "/workspace",
        "",
      ),
    ).toBe(true);
    expect(
      isCanonicalAllowedContainedPath(
        {
          path: "/workspace/src/file.ts",
          realRelative: "src/file.ts",
          realBase: "/workspace",
        },
        "/workspace",
        process.platform === "win32" ? "src\\file.ts" : "src/file.ts",
      ),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a literal POSIX backslash distinct from a directory separator",
    () => {
      expect(
        isCanonicalAllowedContainedPath(
          {
            path: "/workspace/src/file.ts",
            realRelative: "src/file.ts",
            realBase: "/workspace",
          },
          "/workspace",
          "src\\file.ts",
        ),
      ).toBe(false);
    },
  );

  it("rejects aliases, denied descendants, and a denied root alias", () => {
    expect(
      isCanonicalAllowedContainedPath(
        {
          path: "/workspace/other.ts",
          realRelative: "other.ts",
          realBase: "/workspace",
        },
        "/workspace",
        "selected.ts",
      ),
    ).toBe(false);
    expect(
      isCanonicalAllowedContainedPath(
        { path: "/workspace/.env", realRelative: ".env", realBase: "/workspace" },
        "/workspace",
        ".env",
      ),
    ).toBe(false);
    expect(
      isCanonicalAllowedContainedPath(
        { path: "/safe/.aws/file", realRelative: "file", realBase: "/safe/.aws" },
        "/safe/docs",
        "file",
      ),
    ).toBe(false);
  });
});

describe("isAllowedContainedPathParent", () => {
  it("allows only a deny-clean canonical ancestor of a missing target", () => {
    const parent = { path: "/workspace/src/missing", realRelative: "src", realBase: "/workspace" };

    expect(isAllowedContainedPathParent(parent, "/workspace", "src/missing/file.ts")).toBe(true);
    expect(isAllowedContainedPathParent(parent, "/workspace", "src-other/file.ts")).toBe(false);
    expect(isAllowedContainedPathParent(parent, "/workspace", "src/.env")).toBe(false);
    expect(
      isAllowedContainedPathParent(
        { ...parent, realBase: "/workspace/.aws" },
        "/workspace/docs",
        "src/missing/file.ts",
      ),
    ).toBe(false);
  });
});
