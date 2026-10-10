import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import type { WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, findFiles, searchText, type SearchScope } from "./repoSearch.js";
import { createRequestLocalSearchTextSessionPool } from "./repoSearch.js";
import { createWorkspaceIndex } from "./workspaceIndex.js";

const EXCLUDED = ["src/exclude*.ts", "src/exclude?.ts", "src/exclude[0].ts"];
const ALLOWED = ["src/exclude0.ts", "src/exclude1.ts", "src/visible.ts"];
const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "needle",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};

function fixture(
  files: Readonly<Record<string, string>> = Object.fromEntries(
    [...EXCLUDED, ...ALLOWED].map((path) => [path, "needle\n"]),
  ),
  relativePaths: readonly string[] = ["src"],
): { readonly scope: SearchScope; readonly fs: WorkspaceFs; reads: string[] } {
  const base = memFs("/ws", files);
  const reads: string[] = [];
  const fs = { ...base };
  for (const key of ["readFileUtf8", "readFileUtf8SameDescriptor", "readFileBytes"] as const) {
    const port = base[key];
    if (port === undefined) throw new Error("The fixture requires descriptor and byte reads.");
    Object.defineProperty(fs, key, {
      value: (...args: unknown[]): unknown => {
        reads.push(String(args[0]));
        return Reflect.apply(port, base, args);
      },
      enumerable: true,
    });
  }
  return {
    fs,
    reads,
    scope: {
      scopeId: "literal-exclusions",
      relativePaths,
      workspace: {
        root: "/ws",
        selectedRoot: "/ws",
        name: "ordinary-folder",
        version: "0.0.0",
        testFramework: "unknown",
        sourceDirs: ["src"],
        testDirs: [],
        languages: ["typescript"],
        ignoreLines: [],
      },
    },
  };
}

function options(
  fs: WorkspaceFs,
  excludeLiteralPaths: readonly string[],
): {
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly candidatePathGlobs: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly excludeLiteralPaths: readonly string[];
  };
} {
  return {
    fs,
    nowMs: (): number => 0,
    candidatePathGlobs: { include: ["src/**"], exclude: [], excludeLiteralPaths },
  };
}

function expectEligible(result: Awaited<ReturnType<typeof searchText>>, reads: string[]): void {
  expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual(ALLOWED);
  expect(reads.some((path) => EXCLUDED.some((excluded) => path === `/ws/${excluded}`))).toBe(false);
}

describe("exact candidate exclusions on the existing search policy", () => {
  it.each([null, 20])(
    "excludes literal metacharacters before body reads at cap=%s",
    async (cap) => {
      const { scope, fs, reads } = fixture();
      const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: cap };
      const result = await searchText(scope, QUERY, limits, options(fs, EXCLUDED));
      expectEligible(result, reads);
      expect(result.filesScanned).toBe(ALLOWED.length);
    },
  );

  it.each([null, 20])("excludes filename fallback candidates at cap=%s", async (cap) => {
    const { scope, fs, reads } = fixture();
    const result = await findFiles(
      scope,
      { ...QUERY, kind: "file-pattern", text: "**/*.ts" },
      { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: cap },
      options(fs, EXCLUDED),
    );
    expectEligible(result, reads);
  });

  it.each([null, 20])("isolates changed persistent policies at cap=%s", async (cap) => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: cap };
    await searchText(scope, QUERY, limits, { ...options(fs, []), workspaceIndex });
    reads.length = 0;
    const result = await searchText(scope, QUERY, limits, {
      ...options(fs, EXCLUDED),
      workspaceIndex,
    });
    expectEligible(result, reads);
    const reopened = await searchText(scope, QUERY, limits, {
      ...options(fs, []),
      workspaceIndex,
    });
    expect(reopened.atoms.map((atom) => atom.scopePath).sort()).toEqual(
      [...EXCLUDED, ...ALLOWED].sort(),
    );
  });

  it("isolates changed policy in the existing request-local indexed session", async () => {
    const { scope, fs, reads } = fixture();
    const session = createRequestLocalSearchTextSessionPool();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 20 };
    await session.searchText(scope, QUERY, limits, options(fs, []));
    reads.length = 0;
    expectEligible(await session.searchText(scope, QUERY, limits, options(fs, EXCLUDED)), reads);
  });

  it.each([null, 20])("retains literal exclusions in filename rescue at cap=%s", async (cap) => {
    const excluded = "dist/exclude*.ts";
    const allowed = "dist/exclude0.ts";
    const { scope, fs, reads } = fixture(
      { [excluded]: "needle\n", [allowed]: "needle\n", "src/miss.ts": "other\n" },
      [],
    );
    const result = await findFiles(
      scope,
      { ...QUERY, kind: "file-pattern", text: "**/exclude*.ts" },
      { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: cap },
      {
        ...options(fs, [excluded]),
        candidatePathGlobs: { include: [], exclude: [], excludeLiteralPaths: [excluded] },
        searchHints: { hasGitMetadata: true },
      },
    );
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual([allowed]);
    expect(reads).not.toContain(`/ws/${excluded}`);
  });
});
