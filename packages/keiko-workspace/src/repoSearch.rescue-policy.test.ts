import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import type { WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, findFiles, searchText, type SearchScope } from "./repoSearch.js";

function fixture(files: Readonly<Record<string, string>>): {
  scope: SearchScope;
  fs: WorkspaceFs;
  rootWalks: () => number;
} {
  const root = "/rescue-policy";
  const base = memFs(root, { ".git": "gitdir: managed-git-directory", ...files });
  let rootWalks = 0;
  return {
    scope: {
      scopeId: "rescue-policy",
      relativePaths: [],
      workspace: {
        root,
        selectedRoot: root,
        name: "rescue-policy",
        version: "1",
        sourceDirs: [],
        testDirs: [],
        testFramework: "unknown",
        languages: [],
        ignoreLines: [],
      },
    },
    fs: {
      ...base,
      readDir: (path, cap): ReturnType<WorkspaceFs["readDir"]> => {
        if (path === root) rootWalks += 1;
        return base.readDir(path, cap);
      },
    },
    rootWalks: () => rootWalks,
  };
}

function query(kind: RetrievalQuery["kind"] = "exact-symbol"): RetrievalQuery {
  return { kind, text: "RescuePolicyProbe", caseSensitive: true, maxResults: 50, emittedAtMs: 0 };
}

describe("streamed low-value rescue policy", () => {
  it("does not repeat a complete miss when the primary skipped no low-value evidence", async () => {
    const sample = fixture({ "src/source.ts": "export const unrelated = 1;" });
    const result = await searchText(sample.scope, query(), DEFAULT_SEARCH_LIMITS, {
      fs: sample.fs,
    });
    expect(result.atoms).toEqual([]);
    expect(result.coverage.incomplete).toBe(false);
    expect(sample.rootWalks()).toBe(1);
    expect(result.diagnostics?.lowValueRescueFilesScanned).toBeUndefined();
  });

  it.each(["repository-overview", "project-metadata"] as const)(
    "does not rescue generated evidence for %s",
    async (retrievalIntent) => {
      const sample = fixture({ "dist/generated.ts": "RescuePolicyProbe" });
      const result = await searchText(
        sample.scope,
        query("natural-language"),
        DEFAULT_SEARCH_LIMITS,
        {
          fs: sample.fs,
          searchHints: { retrievalIntent },
        },
      );
      expect(result.atoms).toEqual([]);
      expect(sample.rootWalks()).toBe(1);
    },
  );

  it("keeps regex source searches on the primary policy", async () => {
    const sample = fixture({ "dist/generated.ts": "RescuePolicyProbe" });
    const result = await searchText(sample.scope, query("regex"), DEFAULT_SEARCH_LIMITS, {
      fs: sample.fs,
    });
    expect(result.atoms).toEqual([]);
    expect(sample.rootWalks()).toBe(1);
  });

  it("rescues a targeted generated hit without adding it to broad scope enrichment", async () => {
    const sample = fixture({
      "src/source.ts": "export const unrelated = 1;",
      "dist/generated.ts": "export const RescuePolicyProbe = 9;",
    });
    const observed: string[] = [];
    const result = await searchText(sample.scope, query(), DEFAULT_SEARCH_LIMITS, {
      fs: sample.fs,
      onEligibleTextFile: (file): boolean => {
        observed.push(file.scopePath);
        return true;
      },
    });
    expect(result.atoms.map((atom) => atom.scopePath)).toContain("dist/generated.ts");
    expect(result.diagnostics?.lowValueRescueFilesScanned).toBe(1);
    expect(sample.rootWalks()).toBe(2);
    expect(observed).toEqual(["src/source.ts"]);
  });

  it("preserves an explicit generated filename lookup", async () => {
    const sample = fixture({ "dist/generated.ts": "export const generated = 9;" });
    const result = await findFiles(
      sample.scope,
      { ...query("file-pattern"), text: "**/generated.ts" },
      DEFAULT_SEARCH_LIMITS,
      { fs: sample.fs },
    );
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["dist/generated.ts"]);
  });
});
