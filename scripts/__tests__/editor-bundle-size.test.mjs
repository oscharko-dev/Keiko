import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateOwnCodeBudget,
  extractInitialScriptSrcs,
  extractValueImportSpecifiers,
  findForbiddenStaticExportMarkers,
  findUnexpectedFirstLoadRuntimeImporters,
  findUnexpectedMonacoImporters,
  gzipSizeBytes,
  isEditorFirstLoadForbiddenSpecifier,
  isMonacoSpecifier,
  runEditorBundleSizeCheck,
} from "../editor-bundle-size.mjs";

describe("gzipSizeBytes", () => {
  it("returns a deterministic, positive compressed size", () => {
    const a = gzipSizeBytes("a".repeat(1000));
    const b = gzipSizeBytes("a".repeat(1000));
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1000);
  });
});

describe("evaluateOwnCodeBudget", () => {
  it("passes when the total is at or under the ceiling", () => {
    const result = evaluateOwnCodeBudget({
      files: [
        { path: "a.js", gzipBytes: 40 },
        { path: "b.js", gzipBytes: 60 },
      ],
      ceilingBytes: 100,
    });
    expect(result).toEqual({ fileCount: 2, totalGzipBytes: 100, ceilingBytes: 100, ok: true });
  });

  it("fails when the total exceeds the ceiling", () => {
    const result = evaluateOwnCodeBudget({
      files: [{ path: "a.js", gzipBytes: 101 }],
      ceilingBytes: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.totalGzipBytes).toBe(101);
  });
});

describe("isMonacoSpecifier", () => {
  it("matches the monaco-editor package and its subpaths", () => {
    expect(isMonacoSpecifier("monaco-editor")).toBe(true);
    expect(isMonacoSpecifier("monaco-editor/esm/vs/editor/editor.api")).toBe(true);
    expect(isMonacoSpecifier("@monaco-editor/react")).toBe(true);
    expect(isMonacoSpecifier("@monaco-editor/react/dist/index.js")).toBe(true);
  });

  it("does not match unrelated specifiers", () => {
    expect(isMonacoSpecifier("@oscharko-dev/keiko-editor")).toBe(false);
    expect(isMonacoSpecifier("react")).toBe(false);
    expect(isMonacoSpecifier("not-monaco-editor-clone")).toBe(false);
  });
});

describe("isEditorFirstLoadForbiddenSpecifier", () => {
  it("matches Monaco and the Keiko editor runtime package root", () => {
    expect(isEditorFirstLoadForbiddenSpecifier("monaco-editor")).toBe(true);
    expect(isEditorFirstLoadForbiddenSpecifier("@monaco-editor/react")).toBe(true);
    expect(isEditorFirstLoadForbiddenSpecifier("@oscharko-dev/keiko-editor")).toBe(true);
    expect(isEditorFirstLoadForbiddenSpecifier("@oscharko-dev/keiko-editor/subpath")).toBe(true);
  });

  it("does not match type-support or unrelated packages", () => {
    expect(isEditorFirstLoadForbiddenSpecifier("@oscharko-dev/keiko-contracts")).toBe(false);
    expect(isEditorFirstLoadForbiddenSpecifier("react")).toBe(false);
  });
});

describe("extractValueImportSpecifiers", () => {
  it("extracts static, dynamic, side-effect, and require value imports", () => {
    const source = [
      'import * as monaco from "monaco-editor";',
      'import { loader } from "@monaco-editor/react";',
      'const x = await import("monaco-editor/esm/vs/editor/editor.api");',
      'import "./side-effect.js";',
      'const y = require("node:zlib");',
    ].join("\n");
    const specifiers = extractValueImportSpecifiers(source);
    expect(specifiers).toContain("monaco-editor");
    expect(specifiers).toContain("@monaco-editor/react");
    expect(specifiers).toContain("monaco-editor/esm/vs/editor/editor.api");
    expect(specifiers).toContain("./side-effect.js");
    expect(specifiers).toContain("node:zlib");
  });

  it("ignores type-only imports so they never count as runtime value imports", () => {
    const source = [
      'import type * as monaco from "monaco-editor";',
      'export type { Foo } from "monaco-editor";',
      'import { type Bar, baz } from "@oscharko-dev/keiko-editor";',
    ].join("\n");
    const specifiers = extractValueImportSpecifiers(source);
    expect(specifiers).not.toContain("monaco-editor");
    // The mixed (value + inline-type) import is still a value import of the package.
    expect(specifiers).toContain("@oscharko-dev/keiko-editor");
  });

  it("does not treat a comment mentioning monaco-editor as an import", () => {
    const source = "// monaco-editor is bundled into a browser-only chunk\nconst a = 1;";
    expect(extractValueImportSpecifiers(source)).toEqual([]);
  });

  it("catches value re-exports (`export * from` / `export { x } from`)", () => {
    const source = [
      'export * from "monaco-editor";',
      'export { loader } from "@monaco-editor/react";',
    ].join("\n");
    const specifiers = extractValueImportSpecifiers(source);
    expect(specifiers).toContain("monaco-editor");
    expect(specifiers).toContain("@monaco-editor/react");
  });

  it("catches a multi-line value import statement", () => {
    const source = 'import {\n  Editor,\n  DiffEditor,\n} from "@monaco-editor/react";';
    expect(extractValueImportSpecifiers(source)).toContain("@monaco-editor/react");
  });
});

describe("findUnexpectedFirstLoadRuntimeImporters", () => {
  const allowlist = ["packages/keiko-ui/.../editorMonacoRuntime.ts"];

  it("returns nothing when only allow-listed modules import editor runtime packages", () => {
    const sources = [
      { path: allowlist[0], specifiers: ["monaco-editor", "@monaco-editor/react"] },
      {
        path: "packages/keiko-ui/.../Shell.tsx",
        specifiers: ["@oscharko-dev/keiko-contracts"],
      },
    ];
    expect(findUnexpectedFirstLoadRuntimeImporters({ sources, allowlist })).toEqual([]);
  });

  it("flags non-allow-listed modules that value-import Monaco or the editor root", () => {
    const sources = [
      { path: "packages/keiko-ui/.../SomeRoute.tsx", specifiers: ["monaco-editor"] },
      {
        path: "packages/keiko-ui/.../EditorShell.tsx",
        specifiers: ["@oscharko-dev/keiko-editor"],
      },
    ];
    expect(findUnexpectedFirstLoadRuntimeImporters({ sources, allowlist })).toEqual([
      "packages/keiko-ui/.../SomeRoute.tsx",
      "packages/keiko-ui/.../EditorShell.tsx",
    ]);
  });
});

describe("findUnexpectedMonacoImporters", () => {
  const allowlist = ["packages/keiko-ui/.../editorMonacoRuntime.ts"];

  it("flags a non-allow-listed module that value-imports Monaco", () => {
    const sources = [
      { path: "packages/keiko-ui/.../SomeRoute.tsx", specifiers: ["monaco-editor"] },
    ];
    expect(findUnexpectedMonacoImporters({ sources, allowlist })).toEqual([
      "packages/keiko-ui/.../SomeRoute.tsx",
    ]);
  });
});

describe("static export first-load helpers", () => {
  it("extracts initial script sources from static export HTML", () => {
    const html = [
      '<script src="/_next/static/chunks/webpack.js" defer></script>',
      '<script defer src="/_next/static/chunks/app/page.js?build=1"></script>',
      "<script>window.__NEXT_DATA__ = {};</script>",
    ].join("\n");
    expect(extractInitialScriptSrcs(html)).toEqual([
      "/_next/static/chunks/webpack.js",
      "/_next/static/chunks/app/page.js?build=1",
    ]);
  });

  it("finds Monaco/editor runtime markers in first-load JavaScript content", () => {
    const findings = findForbiddenStaticExportMarkers({
      files: [
        { path: "a.js", content: "const ok = true;" },
        { path: "b.js", content: "globalThis.MonacoEnvironment = {};" },
      ],
    });
    expect(findings).toEqual([
      { path: "b.js", label: "Monaco environment marker", marker: "MonacoEnvironment" },
    ]);
  });
});

describe("runEditorBundleSizeCheck (integration against the real repo state)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const committedBudget = JSON.parse(
    readFileSync(resolve(repoRoot, "scripts", "editor-bundle-size.budget.json"), "utf8"),
  );
  const run = (budget) => {
    const failures = [];
    const result = runEditorBundleSizeCheck({
      repoRoot,
      budget,
      fail: (message) => failures.push(message),
      log: () => undefined,
    });
    return { failures, result };
  };

  it("passes for the committed editor dist, Monaco pin, and first-load isolation", () => {
    const { failures, result } = run(undefined);
    expect(failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.totalGzipBytes).toBeGreaterThan(0);
  });

  it("fails when the editor own-code gzip ceiling is exceeded", () => {
    const { failures } = run({ ...committedBudget, editorOwnCodeGzipBytesCeiling: 1 });
    expect(failures.some((m) => m.includes("exceeds the ceiling"))).toBe(true);
  });

  it("fails when the Monaco version pin drifts from package.json", () => {
    const { failures } = run({
      ...committedBudget,
      monacoEditorPinnedVersion: "0.0.0-not-installed",
    });
    expect(failures.some((m) => m.includes("monaco-editor is pinned at"))).toBe(true);
  });

  it("fails when an allow-listed Monaco importer no longer imports Monaco (stale allow-list)", () => {
    const { failures } = run({
      ...committedBudget,
      firstLoadRuntimeValueImporters: ["packages/keiko-ui/src/lib/api.ts"],
    });
    expect(failures.some((m) => m.includes("no longer imports an editor runtime package"))).toBe(
      true,
    );
  });

  it("fails when a module value-imports editor runtime packages outside the allow-list", () => {
    // With an empty allow-list, the real runtime modules become unexpected first-load importers.
    const { failures } = run({ ...committedBudget, firstLoadRuntimeValueImporters: [] });
    expect(failures.some((m) => m.includes("value-imported outside the allow-listed"))).toBe(true);
  });

  it("requires a built static export when the static-export scan is requested", () => {
    const failures = [];
    runEditorBundleSizeCheck({
      repoRoot,
      budget: committedBudget,
      requireStaticExport: true,
      fail: (message) => failures.push(message),
      log: () => undefined,
    });
    expect(
      failures.length === 0 ||
        failures.some((m) => m.includes("packages/keiko-ui/out/index.html does not exist")),
    ).toBe(true);
  });
});
