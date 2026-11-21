import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, WorkspaceDescriptorReadError, type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { DIRECTORY_LINK_TYPE } from "./_memfs.js";

let root: string;

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "concurrent-membership",
    relativePaths: [],
  };
}

function query(): Parameters<typeof searchText>[1] {
  return {
    kind: "exact-symbol",
    text: "ConcurrentMembershipProbe",
    caseSensitive: true,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

function putFiles(): void {
  mkdirSync(join(root, "changing"));
  mkdirSync(join(root, "stable"));
  for (let index = 0; index < 64; index += 1)
    writeFileSync(
      join(root, "changing", `${String(index)}.txt`),
      "ConcurrentMembershipProbe observed",
    );
  writeFileSync(join(root, "stable", "sibling.txt"), "ConcurrentMembershipProbe sibling");
}

describe("recursive search under concurrent directory membership changes", () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-membership-")));
    putFiles();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("retains observed hits and siblings when an enumerated directory is removed", async () => {
    let removed = false;
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, {
      onEligibleTextFile: (file): boolean => {
        if (!removed && file.scopePath.startsWith("changing/")) {
          removed = true;
          rmSync(join(root, "changing"), { recursive: true });
        }
        return true;
      },
    });
    expect(removed).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath.startsWith("changing/"))).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath === "stable/sibling.txt")).toBe(true);
    expect(result.coverage).toMatchObject({ incomplete: true, reasons: ["io-error"] });
  });

  it("retains siblings when the native closing directory check observes removal", async () => {
    for (let index = 1; index < 64; index += 1)
      unlinkSync(join(root, "changing", `${String(index)}.txt`));
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new Error("fixture streaming directory port missing");
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        for await (const entry of iterate(path)) {
          yield entry;
          if (path === join(root, "changing")) rmSync(path, { recursive: true });
        }
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms.some((atom) => atom.scopePath === "stable/sibling.txt")).toBe(true);
    expect(result.coverage).toMatchObject({ incomplete: true, reasons: ["io-error"] });
  });

  it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "ESTALE"])(
    "retains siblings and discloses %s from a child directory stream",
    async (code) => {
      const iterate = nodeWorkspaceFs.iterateDirectory;
      if (iterate === undefined) throw new Error("fixture streaming directory port missing");
      const failure = Object.assign(new Error("unavailable fixture directory"), { code });
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        iterateDirectory: async function* (path) {
          if (path === join(root, "changing")) throw failure;
          yield* iterate(path);
        },
      };
      const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
      expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["stable/sibling.txt"]);
      expect(result.coverage).toMatchObject({ incomplete: true, reasons: ["io-error"] });
    },
  );

  it.each(["ENOENT", "EACCES"])(
    "still rejects %s when the connected root cannot be enumerated",
    async (code) => {
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        iterateDirectory: async function* (path) {
          if (path === root) throw Object.assign(new Error("unavailable fixture root"), { code });
          const iterate = nodeWorkspaceFs.iterateDirectory;
          if (iterate === undefined) throw new Error("fixture streaming directory port missing");
          yield* iterate(path);
        },
      };
      await expect(searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs })).rejects.toThrow();
    },
  );

  it("retains safely read hits and visits stable siblings after a directory gains an entry", async () => {
    let changed = false;
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, {
      onEligibleTextFile: (file): boolean => {
        if (!changed && file.scopePath.startsWith("changing/")) {
          changed = true;
          writeFileSync(join(root, "changing", "added.txt"), "ConcurrentMembershipProbe added");
        }
        return true;
      },
    });
    expect(changed).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath.startsWith("changing/"))).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath === "stable/sibling.txt")).toBe(true);
    // #4435: the gained entry is benign membership churn. The directory is re-read once, so the
    // added file is found and every observed entry is visited exactly once; churn that persists
    // through that retry stays an io-error (pinned in repoSearch.entry-availability.test.ts).
    expect(result.atoms.some((atom) => atom.scopePath === "changing/added.txt")).toBe(true);
    const paths = result.atoms.map((atom) => atom.scopePath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(result.coverage.membershipRetriesByDiscovery).toBe(1);
    expect(result.coverage.incomplete).toBe(false);
  });

  it("keeps other observed sources when a listed entry disappears before admission", async () => {
    const stat = nodeWorkspaceFs.stat;
    let removed = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      stat: (path) => {
        if (!removed && path.endsWith(join(sep, "changing", "63.txt"))) {
          removed = true;
          unlinkSync(path);
        }
        return stat(path);
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(removed).toBe(true);
    expect(result.atoms.some((atom) => atom.scopePath === "stable/sibling.txt")).toBe(true);
    expect(result.coverage.incomplete).toBe(true);
    expect(result.coverage.reasons).toContain("io-error");
    // #4435: the removed entry is counted and never reported as a hit.
    expect(result.atoms.some((atom) => atom.scopePath === "changing/63.txt")).toBe(false);
    expect(result.coverage.vanishedEntriesByDiscovery).toBe(1);
  });

  it("keeps root failures hard even when first observed while recovering a child", async () => {
    let rootUnavailable = false;
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new Error("fixture streaming directory port missing");
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (path) => {
        if (rootUnavailable && path === root)
          throw Object.assign(new Error("removed root"), { code: "ENOENT" });
        return nodeWorkspaceFs.realPath(path);
      },
      iterateDirectory: async function* (path) {
        if (path === join(root, "changing")) {
          rootUnavailable = true;
          throw Object.assign(new Error("removed child"), { code: "ENOENT" });
        }
        yield* iterate(path);
      },
    };
    await expect(searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs })).rejects.toMatchObject(
      {
        code: "WORKSPACE_PATH_DENIED",
      },
    );
  });

  it.each([
    new TypeError("invalid port"),
    new WorkspaceDescriptorReadError("changed"),
    Object.assign(new Error("descriptor exhaustion"), { code: "EMFILE" }),
    Object.assign(new Error("system descriptor exhaustion"), { code: "ENFILE" }),
  ])(
    "does not downgrade programming, identity or process-wide resource failures: %s",
    async (failure) => {
      const iterate = nodeWorkspaceFs.iterateDirectory;
      if (iterate === undefined) throw new Error("fixture streaming directory port missing");
      const fs: WorkspaceFs = {
        ...nodeWorkspaceFs,
        iterateDirectory: async function* (path) {
          if (path === join(root, "changing")) throw failure;
          yield* iterate(path);
        },
      };
      await expect(
        searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs }),
      ).rejects.toMatchObject({
        cause: failure,
      });
    },
  );

  it.each(["directory", "symlink"])(
    "still rejects a streamed directory replaced by another %s",
    async (replacement) => {
      const directory = join(root, "changing");
      const iterate = nodeWorkspaceFs.iterateDirectory;
      if (iterate === undefined) throw new Error("fixture streaming directory port missing");
      const consume = async (): Promise<void> => {
        let replaced = false;
        for await (const _entry of iterate(directory)) {
          if (replaced) continue;
          replaced = true;
          renameSync(directory, join(root, "original"));
          if (replacement === "directory") mkdirSync(directory);
          else symlinkSync(join(root, "stable"), directory, DIRECTORY_LINK_TYPE);
        }
      };
      await expect(consume()).rejects.toBeInstanceOf(WorkspaceDescriptorReadError);
    },
  );
});
