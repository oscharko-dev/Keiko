import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import { findFiles, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";

const roots: string[] = [];
const MARKER = "SelectedBoundaryProbe";

function put(root: string, path: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${MARKER} VERIFIEDVALUE\n`);
}

function selectedFixture(
  rebasedRoot: boolean,
  gitMetadata: boolean,
): {
  readonly scope: SearchScope;
  readonly expectedPaths: readonly string[];
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-selected-subfolder-"));
  roots.push(root);
  const deep = `${Array.from({ length: 48 }, (_, index) => `level-${String(index)}`).join("/")}/value.html`;
  put(root, "parent.txt");
  put(root, "handbook-extra/sibling.txt");
  put(root, "handbook/top.txt");
  put(root, `handbook/${deep}`);
  const workspaceRoot = rebasedRoot ? join(root, "handbook") : root;
  if (gitMetadata) mkdirSync(join(workspaceRoot, ".git"));
  return {
    scope: {
      workspace: detectWorkspaceAt(workspaceRoot, undefined, {
        scanSourceFilesForLanguages: false,
      }),
      scopeId: "selected-subfolder",
      relativePaths: rebasedRoot ? [] : ["handbook"],
    },
    expectedPaths: ["top.txt", deep]
      .map((path) => (rebasedRoot ? path : `handbook/${path}`))
      .sort(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function expectOutsideScope(scope: SearchScope, rebased: boolean): Promise<void> {
  const outsidePaths = ["parent.txt", "handbook-extra/sibling.txt"];
  for (const path of outsidePaths) {
    await expect(
      readExcerpt(scope, {
        scopePath: rebased ? `../${path}` : path,
        startLine: 1,
        endLine: 1,
        maxBytes: 256,
      }),
    ).rejects.toMatchObject(
      rebased
        ? { name: "RepoSearchInvalidRangeError" }
        : { name: "RepoSearchUnsupportedFileError", reason: "outside-scope" },
    );
  }
}

describe("physical selected subfolder admission", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "recurses only inside its selected boundary (rebased=%s, gitMetadata=%s)",
    async (rebased, git) => {
      const { scope, expectedPaths } = selectedFixture(rebased, git);
      const result = await searchText(scope, {
        kind: "exact-symbol",
        text: MARKER,
        caseSensitive: true,
        maxResults: 8,
        emittedAtMs: 0,
      });
      expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual(expectedPaths);
      expect(result.coverage.filesScanned).toBe(2);
      expect(result.coverage.incomplete).toBe(false);
      const listings = await findFiles(scope, {
        kind: "file-pattern",
        text: "**/*",
        caseSensitive: true,
        maxResults: 8,
        emittedAtMs: 0,
      });
      expect(listings.atoms.map((atom) => atom.scopePath).sort()).toEqual(expectedPaths);
      const deepPath = expectedPaths.find((path) => path.endsWith("value.html"));
      if (deepPath === undefined) throw new Error("missing nested fixture source");
      const excerpt = await readExcerpt(scope, {
        scopePath: deepPath,
        startLine: 1,
        endLine: 1,
        maxBytes: 256,
      });
      expect(excerpt.content).toBe(`${MARKER} VERIFIEDVALUE`);
      await expectOutsideScope(scope, rebased);
    },
  );
});
