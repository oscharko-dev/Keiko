import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateOwnCodeBudget,
  extractValueImportSpecifiers,
  findUnexpectedMonacoImporters,
  gzipSizeBytes,
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
});

describe("findUnexpectedMonacoImporters", () => {
  const allowlist = ["packages/keiko-ui/.../editorMonacoRuntime.ts"];

  it("returns nothing when only the allow-listed module imports Monaco", () => {
    const sources = [
      { path: allowlist[0], specifiers: ["monaco-editor", "@monaco-editor/react"] },
      {
        path: "packages/keiko-ui/.../EditorSurface.tsx",
        specifiers: ["@oscharko-dev/keiko-editor"],
      },
    ];
    expect(findUnexpectedMonacoImporters({ sources, allowlist })).toEqual([]);
  });

  it("flags a non-allow-listed module that value-imports Monaco", () => {
    const sources = [
      { path: "packages/keiko-ui/.../SomeRoute.tsx", specifiers: ["monaco-editor"] },
    ];
    expect(findUnexpectedMonacoImporters({ sources, allowlist })).toEqual([
      "packages/keiko-ui/.../SomeRoute.tsx",
    ]);
  });
});

describe("runEditorBundleSizeCheck (integration against the real repo state)", () => {
  it("passes for the committed editor dist, Monaco pin, and first-load isolation", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const failures = [];
    const result = runEditorBundleSizeCheck({
      repoRoot,
      fail: (message) => failures.push(message),
      log: () => undefined,
    });
    expect(failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.totalGzipBytes).toBeGreaterThan(0);
  });
});
