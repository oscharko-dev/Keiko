// #4068 W14: a repository search resolved its workspace root's realpath again for every file it
// read (four times per file), so its cost grew with the repository instead of once per search. On
// Windows each native realpath opens a handle: a no-match search of a 9,923-file repository took
// 22.5 s in the Workbench. One search now admits its root once and every read reuses that identity.
// The fixture is a real directory read through the production port, so the proof holds on every
// host the suite runs on.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import {
  DEFAULT_SEARCH_LIMITS,
  searchText,
  type SearchLimits,
  type SearchScope,
} from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "root-identity",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function repository(fileCount: number): {
  readonly root: string;
  readonly fs: WorkspaceFs;
  readonly rootResolutions: () => number;
} {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "keiko-root-identity-")));
  roots.push(root);
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(
      join(root, `module-${String(index)}.ts`),
      `export const v${String(index)} = 1;\n`,
    );
  }
  let resolutions = 0;
  return {
    root,
    fs: {
      ...nodeWorkspaceFs,
      realPath: (path): string => {
        if (path === root) resolutions += 1;
        return nodeWorkspaceFs.realPath(path);
      },
    },
    rootResolutions: () => resolutions,
  };
}

const query: RetrievalQuery = {
  kind: "exact-symbol",
  text: "zzqqNoSuchToken",
  caseSensitive: false,
  maxResults: 50,
  emittedAtMs: 0,
};

const STREAMED_LIMITS: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null };

async function rootResolutionsFor(fileCount: number, limits: SearchLimits): Promise<number> {
  const { root, fs, rootResolutions } = repository(fileCount);
  const scope: SearchScope = {
    workspace: workspace(root),
    scopeId: "root-identity",
    relativePaths: [],
  };
  const result = await searchText(scope, query, limits, {
    fs,
    contentLane: "editor",
    queryInterpretation: { kind: "literal" },
  });
  expect(result.atoms).toEqual([]);
  expect(result.coverage.filesScanned).toBe(fileCount);
  return rootResolutions();
}

describe("repository search root identity (#4068 W14)", () => {
  it.each([
    ["streamed", STREAMED_LIMITS],
    ["bounded", DEFAULT_SEARCH_LIMITS],
  ] as const)("resolves the root a fixed number of times, not per file (%s)", async (_, limits) => {
    const small = await rootResolutionsFor(4, limits);
    const large = await rootResolutionsFor(48, limits);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(4);
  });
});
