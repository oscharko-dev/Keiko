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

  it("substitutes every wildcard occurrence in tsconfig alias targets", async () => {
    const { scope, fs } = makeScope({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*/bar/*"] } },
      }),
      "src/a.ts": 'import { lib } from "@app/lib";',
      "src/lib/bar/lib.ts": "export const lib = 1;",
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.edges[0]).toMatchObject({
      specifier: "@app/lib",
      targetPath: "src/lib/bar/lib.ts",
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

  it("resolves exact aliases, package entry variants, fallbacks, and unresolved edges", async () => {
    const { scope, fs } = makeScope({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@exact": ["src/exact"],
            "@missing": ["src/missing"],
          },
        },
      }),
      "src/app.ts": [
        'import { exact } from "@exact";',
        'import "@missing";',
        'import { root } from "@demo/string-root";',
        'import { feature } from "@demo/conditional/feature";',
        'import { rootObject } from "@demo/object-root";',
        'import { nested } from "@demo/fallback/nested";',
        'import { main } from "@demo/main";',
        'import "unknown-package";',
      ].join("\n"),
      "src/exact.ts": "export const exact = 1;",
      "packages/string-root/package.json": JSON.stringify({
        name: "@demo/string-root",
        exports: "./src/index.ts",
      }),
      "packages/string-root/src/index.ts": "export const root = 1;",
      "packages/conditional/package.json": JSON.stringify({
        name: "@demo/conditional",
        exports: { "./feature": { default: "./src/feature.ts" } },
      }),
      "packages/conditional/src/feature.ts": "export const feature = 1;",
      "packages/object-root/package.json": JSON.stringify({
        name: "@demo/object-root",
        exports: { import: "./src/index.ts" },
      }),
      "packages/object-root/src/index.ts": "export const rootObject = 1;",
      "packages/fallback/package.json": JSON.stringify({
        name: "@demo/fallback",
      }),
      "packages/fallback/nested.ts": "export const nested = 1;",
      "packages/main/package.json": JSON.stringify({
        name: "@demo/main",
        module: "./src/module.ts",
        main: "./src/main.ts",
      }),
      "packages/main/src/module.ts": "export const main = 1;",
      "packages/main/src/main.ts": "export const ignored = 1;",
    });

    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    const bySpecifier = new Map(graph.edges.map((edge) => [edge.specifier, edge]));

    expect(bySpecifier.get("@exact")).toMatchObject({
      targetPath: "src/exact.ts",
      resolutionKind: "tsconfig-path",
      confidence: 0.92,
    });
    expect(bySpecifier.get("@missing")).toMatchObject({
      targetPath: undefined,
      resolutionKind: "unresolved",
      confidence: 0.25,
      distance: 0,
    });
    expect(bySpecifier.get("@demo/string-root")).toMatchObject({
      targetPath: "packages/string-root/src/index.ts",
      resolutionKind: "package-export",
    });
    expect(bySpecifier.get("@demo/conditional/feature")).toMatchObject({
      targetPath: "packages/conditional/src/feature.ts",
      resolutionKind: "package-export",
    });
    expect(bySpecifier.get("@demo/object-root")).toMatchObject({
      targetPath: "packages/object-root/src/index.ts",
      resolutionKind: "package-export",
    });
    expect(bySpecifier.get("@demo/fallback/nested")).toMatchObject({
      targetPath: "packages/fallback/nested.ts",
      resolutionKind: "package-fallback",
      confidence: 0.74,
    });
    expect(bySpecifier.get("@demo/main")).toMatchObject({
      targetPath: "packages/main/src/module.ts",
      resolutionKind: "package-fallback",
    });
    expect(graph.unresolved.map((edge) => edge.specifier).sort()).toEqual([
      "@missing",
      "unknown-package",
    ]);
    expect(importersForTarget(graph, "unknown-package")).toEqual([]);
  });

  it("skips binary and hard-linked import sources before emitting graph edges", async () => {
    const base = memFs(MEM_ROOT, {
      "src/good.ts": 'import { target } from "./target";',
      "src/target.ts": "export const target = 1;",
      "src/hard.ts": 'import "./target";',
      "src/binary.ts": '\0\0import "./target";',
    });
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath) => {
        const stat = base.stat(absolutePath);
        return absolutePath.endsWith("/src/hard.ts") ? { ...stat, hardLinkCount: 2 } : stat;
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

    expect(graph.edges).toEqual([
      expect.objectContaining({
        importerPath: "src/good.ts",
        targetPath: "src/target.ts",
      }),
    ]);
  });

  it("keeps transitive traversal bounded when import relationships cycle", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": 'import { b } from "./b";',
      "src/b.ts": 'import { a } from "./a";',
    });
    const graph = await buildImportGraph(scope, DEFAULT_SEARCH_LIMITS, fs);

    expect(importsFromSource(graph, "src/a.ts", { transitive: true })).toEqual([
      expect.objectContaining({ importerPath: "src/a.ts", targetPath: "src/b.ts" }),
      expect.objectContaining({ importerPath: "src/b.ts", targetPath: "src/a.ts" }),
    ]);
    expect(importersForTarget(graph, "src/a.ts", { transitive: true })).toEqual([
      expect.objectContaining({ importerPath: "src/b.ts", targetPath: "src/a.ts" }),
      expect.objectContaining({ importerPath: "src/a.ts", targetPath: "src/b.ts" }),
    ]);
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
