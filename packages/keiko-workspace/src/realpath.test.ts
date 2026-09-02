import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PathDeniedError, PathEscapeError } from "./errors.js";
import { nodeWorkspaceFs } from "./fs.js";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "./fs.js";
import { workspaceFsWithOwnedRootAuthority } from "./ownedRootMint.js";
import { preserveOwnedRootAuthority } from "./ownedRootPreserve.js";
import { memFs } from "./_memfs.js";
import {
  containedRealPathInfo,
  containedRealPathInfoWithinOwnedRoot,
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
  realRootIsDeniedViaSymlink,
  resolveExistingAllowedWorkspaceRealRoot,
} from "./realpath.js";

class PrototypeWorkspaceFs implements WorkspaceFs {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = root;
  }

  public readFileUtf8(_absolutePath: string): string {
    return this.#root;
  }

  public stat(_absolutePath: string): WorkspaceStat {
    return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
  }

  public readDir(_absolutePath: string): readonly WorkspaceDirEntry[] {
    return [];
  }

  public realPath(_absolutePath: string): string {
    return this.#root;
  }

  public exists(_absolutePath: string): boolean {
    return true;
  }
}

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

  it.each([
    "/home/user/.aws",
    "/home/user/.ssh/project",
    "/home/user/.codex",
    "/home/user/.codex/worktrees",
    "/home/user/.codex/worktrees/project/.aws",
    "/home/user/.keiko",
    "/home/user/.keiko/task-workspaces",
    "/home/user/.keiko/task-workspaces/repo_invalid/ws_invalid",
    "/home/user/.keiko/task-workspaces/repo_aaaaaaaaaaaaaaaa/ws_bbbbbbbbbbbbbbbbbbbbbbbb/.aws",
  ])("rejects a directly selected denied root %s", (root) => {
    const baseFs = memFs("/home/user", {});
    let realPathCalls = 0;
    const fs: WorkspaceFs = {
      ...baseFs,
      realPath: (): string => {
        realPathCalls += 1;
        return root;
      },
    };

    expect(() => resolveExistingAllowedWorkspaceRealRoot(fs, root)).toThrow(PathDeniedError);
    expect(realPathCalls).toBe(0);
  });

  it("admits a canonical Codex worktree below its internal state root", () => {
    const root = "/home/user/.codex/worktrees/task/project";
    const baseFs = memFs("/home/user", {});
    const fs: WorkspaceFs = { ...baseFs, realPath: (): string => root };

    expect(resolveExistingAllowedWorkspaceRealRoot(fs, root)).toBe(root);
  });

  it("admits only the exact canonical root pre-authorized by its owning layer", () => {
    const root = "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_b";
    const baseFs = memFs("/home/user", {});
    const fs = workspaceFsWithOwnedRootAuthority(
      { ...baseFs, realPath: (path): string => path },
      root,
    );

    expect(resolveExistingAllowedWorkspaceRealRoot(fs, root)).toBe(root);
    expect(() => resolveExistingAllowedWorkspaceRealRoot(fs, `${root}/nested`)).toThrow(
      PathDeniedError,
    );
    expect(() => resolveExistingAllowedWorkspaceRealRoot(fs, `${root}/../ws_b`)).toThrow(
      PathDeniedError,
    );
    expect(() =>
      resolveExistingAllowedWorkspaceRealRoot(fs, "/home/user/.keiko/dev/ui/task-workspaces"),
    ).toThrow(PathDeniedError);
  });

  it("rejects a pre-authorized root whose current canonical identity changed", () => {
    const root = "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_b";
    const relocated = "/home/user/.keiko/dev/ui/task-workspaces/repo_c/ws_d";
    const baseFs = memFs("/home/user", {});
    const fs = workspaceFsWithOwnedRootAuthority(
      { ...baseFs, realPath: (): string => relocated },
      root,
    );

    expect(() => resolveExistingAllowedWorkspaceRealRoot(fs, root)).toThrow(PathDeniedError);
  });

  it("does not treat a copied plain filesystem port as owned authority", () => {
    const root = "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_b";
    const baseFs = memFs("/home/user", {});
    const plain: WorkspaceFs = { ...baseFs, realPath: (path): string => path };

    expect(() => resolveExistingAllowedWorkspaceRealRoot(plain, root)).toThrow(PathDeniedError);
  });

  it("preserves prototype methods without exposing a copyable authority marker", () => {
    const root = "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_b";
    const authorized = workspaceFsWithOwnedRootAuthority(new PrototypeWorkspaceFs(root), root);
    const requestWrapper: WorkspaceFs = { ...authorized };
    const preservedWrapper = preserveOwnedRootAuthority(authorized, requestWrapper);

    expect(Reflect.ownKeys(authorized).filter((key) => typeof key === "symbol")).toEqual([]);
    expect(Object.values(authorized)).not.toContain(root);
    expect(requestWrapper.readFileUtf8(root)).toBe(root);
    expect(requestWrapper.stat(root).isDirectory).toBe(true);
    const copiedWrapper: WorkspaceFs = { ...authorized };
    expect(() => resolveExistingAllowedWorkspaceRealRoot(copiedWrapper, root)).toThrow(
      PathDeniedError,
    );
    expect(resolveExistingAllowedWorkspaceRealRoot(preservedWrapper, root)).toBe(root);
    expect(() =>
      resolveExistingAllowedWorkspaceRealRoot(
        preservedWrapper,
        "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_c",
      ),
    ).toThrow(PathDeniedError);
  });

  it("cannot mint authority by reflecting, copying, or preserving from an unauthorized port", () => {
    const root = "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_b";
    const sibling = "/home/user/.keiko/dev/ui/task-workspaces/repo_a/ws_c";
    const baseFs = memFs("/home/user", {});
    const authorized = workspaceFsWithOwnedRootAuthority(
      { ...baseFs, realPath: (path): string => path },
      root,
    );
    const reflectedCopy = Object.assign(
      { ...baseFs, realPath: (path: string): string => path },
      Object.fromEntries(
        Object.getOwnPropertySymbols(authorized).map((symbol) => [
          symbol,
          Reflect.get(authorized, symbol),
        ]),
      ),
    );
    const unauthorizedSource: WorkspaceFs = { ...authorized };

    expect(Object.getOwnPropertySymbols(authorized)).toEqual([]);
    expect(() => resolveExistingAllowedWorkspaceRealRoot(reflectedCopy, sibling)).toThrow(
      PathDeniedError,
    );
    expect(() =>
      resolveExistingAllowedWorkspaceRealRoot(
        preserveOwnedRootAuthority(unauthorizedSource, reflectedCopy),
        sibling,
      ),
    ).toThrow(PathDeniedError);
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

  it("contains a child below an already-owned internal state root", () => {
    const root = "/home/user/.keiko/task-workspaces";
    const target = `${root}/task-1`;
    const baseFs = memFs(root, {});
    const fs: WorkspaceFs = {
      ...baseFs,
      canonicalWorkspaceRoot: (): string => root,
      realPath: (absolutePath): string => absolutePath,
    };

    expect(() => containedRealPathInfo(fs, root, target)).toThrow(PathDeniedError);
    expect(containedRealPathInfoWithinOwnedRoot(fs, root, target)).toEqual({
      path: target,
      realRelative: "task-1",
      realBase: root,
    });
  });
});

// Real symlinks: an in-memory port cannot produce a leaf that `lstat` resolves and `realPath` does
// not, which is exactly the state this class of defect lives in.
function withDiskRoot(run: (root: string, outside: string) => void): void {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-realpath-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    run(root, outside);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe("containedRealPathInfo — unresolvable symlink leaf (#3347)", () => {
  it.skipIf(process.platform === "win32")(
    "refuses a dangling final symlink instead of reporting an allowed missing target",
    () => {
      withDiskRoot((root, outside) => {
        // The owner's reproduction: `root/link -> outside/new` with `outside/new` absent. `realPath`
        // fails exactly as it does for a missing leaf, so the create-target fallback used to hand
        // back an empty `realRelative` — an allowed missing target — for a name that is a symlink
        // pointing out of the root.
        symlinkSync(join(outside, "new"), join(root, "link"));
        // Same class through a link cycle: `realPath` fails with ELOOP, `lstat` still sees a link.
        symlinkSync(join(root, "cycle"), join(root, "cycle"));
        // And a dangling link whose target would land inside the root: the effect would still write
        // to a name other than the one containment classified.
        symlinkSync(join(root, "inner-new"), join(root, "inner"));

        for (const name of ["link", "cycle", "inner"]) {
          expect(() => containedRealPathInfo(nodeWorkspaceFs, root, join(root, name))).toThrow(
            PathEscapeError,
          );
          expect(() =>
            containedRealPathInfoWithinOwnedRoot(nodeWorkspaceFs, root, join(root, name)),
          ).toThrow(PathEscapeError);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "still admits a genuinely missing leaf as a contained create target",
    () => {
      withDiskRoot((root) => {
        const missing = containedRealPathInfo(nodeWorkspaceFs, root, join(root, "new.ts"));

        expect(missing).toEqual({ path: join(root, "new.ts"), realRelative: "", realBase: root });
        expect(isAllowedContainedPathParent(missing, root, "new.ts")).toBe(true);
      });
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
