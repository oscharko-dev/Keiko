import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import type { WorkspaceFs } from "./fs.js";
import {
  buildImportGraph,
  collectImportSpecifiers,
  importsFromSource,
  importersForTarget,
} from "./importGraphEdges.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";

function makeScope(files: Readonly<Record<string, string>>): {
  readonly scope: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
  return {
    scope: { workspace, scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

describe("collectImportSpecifiers", () => {
  it("collects static imports, re-exports, commonjs requires, and dynamic imports", () => {
    const hits = collectImportSpecifiers(
      [
        'import { a } from "./a";',
        'export * from "./b";',
        'const c = require("./c");',
        'const d = await import("./d");',
      ].join("\n"),
    );
    expect(hits.map((hit) => [hit.kind, hit.specifier, hit.line])).toEqual([
      ["static-import", "./a", 1],
      ["re-export", "./b", 2],
      ["commonjs-require", "./c", 3],
      ["dynamic-import", "./d", 4],
    ]);
  });
});

describe("buildImportGraph", () => {
  it("resolves a relative import and indexes reverse dependencies", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": 'import { b } from "./b";',
      "src/b.ts": "export const b = 1;",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    const edge = graph.edges[0];
    expect(edge).toMatchObject({
      importerPath: "src/a.ts",
      specifier: "./b",
      targetPath: "src/b.ts",
      kind: "static-import",
      resolutionKind: "relative",
      confidence: 1,
    });
    expect(graph.forward.get("src/a.ts")).toEqual([edge]);
    expect(importersForTarget(graph, "src/b.ts")).toEqual([edge]);
  });

  it("resolves tsconfig path aliases", async () => {
    const { scope, fs } = makeScope({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      }),
      "src/a.ts": 'import { lib } from "@app/lib";',
      "src/lib.ts": "export const lib = 1;",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.edges[0]).toMatchObject({
      specifier: "@app/lib",
      targetPath: "src/lib.ts",
      resolutionKind: "tsconfig-path",
    });
  });

  it("resolves barrel re-exports", async () => {
    const { scope, fs } = makeScope({
      "src/index.ts": 'export * from "./feature";',
      "src/feature.ts": "export const feature = true;",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.edges[0]).toMatchObject({
      importerPath: "src/index.ts",
      kind: "re-export",
      targetPath: "src/feature.ts",
    });
  });

  it("resolves transitive reachability through barrel re-export chains", async () => {
    const { scope, fs } = makeScope({
      "src/app.ts": 'import { feature } from "./index";',
      "src/index.ts": 'export * from "./feature";',
      "src/feature.ts": "export const feature = true;",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(importersForTarget(graph, "src/feature.ts", { transitive: true })).toEqual([
      expect.objectContaining({ importerPath: "src/index.ts", targetPath: "src/feature.ts" }),
      expect.objectContaining({ importerPath: "src/app.ts", targetPath: "src/index.ts" }),
    ]);
    expect(importsFromSource(graph, "src/app.ts", { transitive: true })).toEqual([
      expect.objectContaining({ importerPath: "src/app.ts", targetPath: "src/index.ts" }),
      expect.objectContaining({ importerPath: "src/index.ts", targetPath: "src/feature.ts" }),
    ]);
  });

  it("resolves dynamic imports", async () => {
    const { scope, fs } = makeScope({
      "src/loader.ts": 'export async function load() { return import("./lazy"); }',
      "src/lazy.ts": "export default 1;",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.edges[0]).toMatchObject({
      importerPath: "src/loader.ts",
      kind: "dynamic-import",
      targetPath: "src/lazy.ts",
    });
  });

  it("resolves workspace package exports across package boundaries", async () => {
    const { scope, fs } = makeScope({
      "packages/consumer/src/app.ts": 'import { feature } from "@demo/pkg/feature";',
      "packages/pkg/package.json": JSON.stringify({
        name: "@demo/pkg",
        exports: { ".": "./src/index.ts", "./feature": "./src/feature.ts" },
      }),
      "packages/pkg/src/feature.ts": "export const feature = 1;",
      "packages/pkg/src/index.ts": "export { feature } from './feature';",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.edges.find((edge) => edge.specifier === "@demo/pkg/feature")).toMatchObject({
      importerPath: "packages/consumer/src/app.ts",
      targetPath: "packages/pkg/src/feature.ts",
      resolutionKind: "package-export",
    });
  });

  it("keeps stable IDs distinct for same-line edges in the same file", async () => {
    const { scope, fs } = makeScope({
      "src/a.js": 'const a = require("./same"); const b = require("./same");',
      "src/same.js": "module.exports = {};",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.line === 1)).toBe(true);
    expect(new Set(graph.edges.map((edge) => edge.stableId)).size).toBe(graph.edges.length);
  });

  it("answers reverse lookups from the built graph without rescanning files", async () => {
    const base = memFs(MEM_ROOT, {
      "src/a.ts": 'import { b } from "./b";',
      "src/b.ts": "export const b = 1;",
    });
    let readDirCalls = 0;
    let readFileCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      readDir: (absolutePath) => {
        readDirCalls += 1;
        return base.readDir(absolutePath);
      },
      readFileUtf8: (absolutePath) => {
        readFileCalls += 1;
        return base.readFileUtf8(absolutePath);
      },
    };
    const workspace: WorkspaceInfo = {
      root: MEM_ROOT,
      name: "demo",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript", "javascript"],
      ignoreLines: [],
    };
    const graph = await buildImportGraph(
      { workspace, scopeId: "scope-1", relativePaths: [] },
      DEFAULT_SEARCH_LIMITS,
      fs,
    );
    const before = { readDirCalls, readFileCalls };
    expect(importersForTarget(graph, "src/b.ts").map((edge) => edge.importerPath)).toEqual([
      "src/a.ts",
    ]);
    expect({ readDirCalls, readFileCalls }).toEqual(before);
  });
});
