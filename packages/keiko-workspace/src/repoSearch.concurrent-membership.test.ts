import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, WorkspaceDescriptorReadError, type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";

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
    root = mkdtempSync(join(tmpdir(), "keiko-membership-"));
    putFiles();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

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
    expect(result.coverage.incomplete).toBe(true);
    expect(result.coverage.reasons).toContain("io-error");
  });

  it("keeps other observed sources when a listed entry disappears before admission", async () => {
    const stat = nodeWorkspaceFs.stat;
    let removed = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      stat: (path) => {
        if (!removed && path.endsWith("/changing/63.txt")) {
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
  });

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
          else symlinkSync(join(root, "stable"), directory);
        }
      };
      await expect(consume()).rejects.toBeInstanceOf(WorkspaceDescriptorReadError);
    },
  );
});
