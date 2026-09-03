// Coverage for managed-root ownership proof + realpath containment (Issue #445, AC2 + SC2). Uses real
// temp dirs and a real symlink to prove out-of-root and symlink-escape targets are rejected.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWorkspaceError } from "./errors.js";
import { MANAGED_ROOT_MARKER_FILENAME } from "./naming.js";
import {
  assertManagedRootOwned,
  assertManagedTargetContained,
  ensureManagedWorktreeParent,
  isManagedRootOwned,
  listManagedRepositoryIds,
  managedTargetExists,
} from "./managed-root.js";

let base: string;
let managedRoot: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mr-")));
  managedRoot = join(base, "task-workspaces");
  outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-outside-")));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("assertManagedRootOwned (SC2)", () => {
  it("creates the root + ownership marker and is idempotent", () => {
    assertManagedRootOwned(managedRoot);
    expect(existsSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME))).toBe(true);
    expect(() => {
      assertManagedRootOwned(managedRoot);
    }).not.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "restores 0600 on the existing marker without replacing it",
    () => {
      assertManagedRootOwned(managedRoot);
      const marker = join(managedRoot, MANAGED_ROOT_MARKER_FILENAME);
      const inode = statSync(marker, { bigint: true }).ino;
      chmodSync(marker, 0o644);

      assertManagedRootOwned(managedRoot);

      const hardened = statSync(marker, { bigint: true });
      expect(hardened.ino).toBe(inode);
      expect(hardened.mode & 0o777n).toBe(0o600n);
    },
  );

  it("rejects an existing marker with the wrong content", () => {
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME), "{}");

    expect(isManagedRootOwned(managedRoot)).toBe(false);
    expect(() => {
      assertManagedRootOwned(managedRoot);
    }).toThrow(TaskWorkspaceError);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a marker symlink even when its target has the expected content",
    () => {
      assertManagedRootOwned(managedRoot);
      const marker = join(managedRoot, MANAGED_ROOT_MARKER_FILENAME);
      const copiedMarker = join(outside, "copied-marker");
      writeFileSync(copiedMarker, readFileSync(marker));
      rmSync(marker);
      symlinkSync(copiedMarker, marker);

      expect(isManagedRootOwned(managedRoot)).toBe(false);
      expect(() => {
        assertManagedRootOwned(managedRoot);
      }).toThrow(TaskWorkspaceError);
    },
  );
});

describe("assertManagedTargetContained (AC2)", () => {
  it("accepts a target inside the managed root", () => {
    assertManagedRootOwned(managedRoot);
    expect(() => {
      assertManagedTargetContained(managedRoot, join(managedRoot, "repo_x", "ws_y"));
    }).not.toThrow();
  });

  it("accepts the production-shaped Keiko-owned state root", () => {
    const keikoManagedRoot = join(base, ".keiko", "task-workspaces");
    assertManagedRootOwned(keikoManagedRoot);

    expect(() => {
      assertManagedTargetContained(keikoManagedRoot, join(keikoManagedRoot, "repo_x", "ws_y"));
    }).not.toThrow();
  });

  it("rejects an out-of-root target", () => {
    assertManagedRootOwned(managedRoot);
    expect(() => {
      assertManagedTargetContained(managedRoot, join(outside, "wt"));
    }).toThrow(TaskWorkspaceError);
  });

  it("rejects a traversal target", () => {
    assertManagedRootOwned(managedRoot);
    expect(() => {
      assertManagedTargetContained(managedRoot, join(managedRoot, "..", "escape"));
    }).toThrow(TaskWorkspaceError);
  });

  it("rejects a target that escapes the root via a symlinked ancestor", () => {
    assertManagedRootOwned(managedRoot);
    symlinkSync(outside, join(managedRoot, "link"), "dir");
    expect(() => {
      assertManagedTargetContained(managedRoot, join(managedRoot, "link", "wt"));
    }).toThrow(TaskWorkspaceError);
  });
});

describe("worktree parent + existence", () => {
  it("creates the worktree parent and reports existence", () => {
    assertManagedRootOwned(managedRoot);
    const target = join(managedRoot, "repo_x", "ws_y");
    expect(managedTargetExists(target)).toBe(false);
    ensureManagedWorktreeParent(target);
    expect(existsSync(join(managedRoot, "repo_x"))).toBe(true);
    expect(managedTargetExists(target)).toBe(false);
  });
});

describe("listManagedRepositoryIds", () => {
  it("lists nothing for a managed root that does not exist yet", () => {
    expect(listManagedRepositoryIds(join(base, "absent"))).toEqual([]);
  });

  it("lists the repository directories and skips loose files", () => {
    mkdirSync(join(managedRoot, "repo-a"), { recursive: true });
    mkdirSync(join(managedRoot, "repo-b"), { recursive: true });
    writeFileSync(join(managedRoot, "stray.txt"), "");
    expect([...listManagedRepositoryIds(managedRoot)].sort()).toEqual(["repo-a", "repo-b"]);
  });

  // A root that exists but cannot be read is not an empty inventory: the health report and the
  // orphan sweep must fail instead of claiming a complete scan they could not take (review of
  // ec04288dc; the previous silent catch reported "no repositories" for an unreadable root).
  it("throws instead of listing nothing when the managed root cannot be read", () => {
    const notADirectory = join(base, "managed-as-file");
    writeFileSync(notADirectory, "");
    expect(() => listManagedRepositoryIds(notADirectory)).toThrow();
  });

  // The same rule for the case an `existsSync` precheck could not see: a root whose PARENT denies
  // traversal. `existsSync` swallows the `EACCES` its own stat raised and answers `false`, so the
  // listing returned `[]` and both global scans read that as "no repositories exist" (PR #3381
  // review). Only `readdirSync`'s own errno may decide, and `EACCES` is not an absence.
  // Skipped as root, where the permission bits are not enforced at all.
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "throws instead of listing nothing when the managed root's parent denies traversal",
    () => {
      const parent = join(base, "denied-parent");
      const denied = join(parent, "task-workspaces");
      mkdirSync(denied, { recursive: true });
      chmodSync(parent, 0o000);
      try {
        // The precondition the precheck got wrong, asserted so this pin cannot pass for the wrong
        // reason: the root IS there and `existsSync` still says it is not.
        expect(existsSync(denied)).toBe(false);
        expect(() => listManagedRepositoryIds(denied)).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );
});
