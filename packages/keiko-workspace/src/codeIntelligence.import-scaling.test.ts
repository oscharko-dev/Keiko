import { describe, expect, it } from "vitest";
import { resolvedImportEdgesForFile, type CodeImportEdge } from "./codeIntelligence.js";

function edge(importerPath: string, targetPath?: string): CodeImportEdge {
  return {
    importerPath,
    importerLine: 1,
    specifier: "./dependency",
    kind: "import",
    language: "typescript",
    parser: "typescript-compiler-ast",
    confidence: targetPath === undefined ? "heuristic" : "resolved",
    ...(targetPath === undefined ? {} : { targetPath }),
  };
}

describe("per-file structural import projection", () => {
  it("does not rescan the full immutable edge inventory for each file", () => {
    let importerReads = 0;
    const imports = Array.from({ length: 1_000 }, (_, index): CodeImportEdge => ({
      ...edge("", "dependency.ts"),
      get importerPath(): string {
        importerReads += 1;
        return `file${String(index)}.ts`;
      },
    }));
    for (let index = 0; index < 100; index += 1) {
      expect(resolvedImportEdgesForFile(`file${String(index)}.ts`, imports)).toHaveLength(1);
    }
    expect(importerReads).toBeLessThan(2_000);
  });

  it("preserves resolved import/export ordering and excludes other files and unresolved targets", () => {
    const imports = [
      edge("one.ts", "first.ts"),
      edge("two.ts", "other.ts"),
      edge("one.ts"),
      { ...edge("one.ts", "barrel.ts"), kind: "export" as const },
      edge("one.ts", "last.ts"),
    ];
    expect(resolvedImportEdgesForFile("one.ts", imports)).toEqual([
      imports[0],
      imports[3],
      imports[4],
    ]);
    expect(resolvedImportEdgesForFile("missing.ts", imports)).toEqual([]);
  });

  it("keeps a later inventory independent even for the same file and specifier", () => {
    expect(resolvedImportEdgesForFile("one.ts", [edge("one.ts", "old.ts")])).toEqual([
      edge("one.ts", "old.ts"),
    ]);
    expect(resolvedImportEdgesForFile("one.ts", [edge("one.ts")])).toEqual([]);
    expect(resolvedImportEdgesForFile("one.ts", [edge("one.ts", "new.ts")])).toEqual([
      edge("one.ts", "new.ts"),
    ]);
  });
});
