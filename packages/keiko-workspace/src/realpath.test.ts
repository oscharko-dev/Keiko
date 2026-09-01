import { describe, expect, it } from "vitest";

import { PathEscapeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import {
  containedRealPathInfo,
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
  realRootIsDeniedViaSymlink,
} from "./realpath.js";

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
        "src\\file.ts",
      ),
    ).toBe(true);
  });

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
