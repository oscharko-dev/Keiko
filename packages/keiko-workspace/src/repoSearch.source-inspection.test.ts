import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import { createWorkspaceIndex } from "./workspaceIndex.js";

const QUESTION =
  "Untersuche dazu jetzt die C#-Quelldateien im verbundenen Ordner. Welche Rechenfunktion ist implementiert, was liefert sie für 8 und 13, und welchen passenden kopierbaren Vitest-Test mit einer äquivalenten TypeScript-Funktion würdest du vorschlagen? Unterscheide ausdrücklich Bestand und vorgeschlagenen Code; führe nichts aus.";
const SOURCE =
  "namespace Existing;\npublic static class Calculator {\n  public static int Add(int a, int b) => a + b;\n}\n";

function fixture(): { scope: SearchScope; fs: ReturnType<typeof memFs> } {
  return {
    scope: {
      scopeId: "ordinary-csharp-sources",
      relativePaths: [],
      workspace: {
        root: "/ws",
        selectedRoot: "/ws",
        name: "ordinary-source-inspection",
        version: "0.0.0",
        testFramework: "unknown",
        sourceDirs: ["src"],
        testDirs: [],
        languages: ["csharp"],
        ignoreLines: [],
      },
    },
    fs: memFs("/ws", {
      "src/Calculator.cs": SOURCE,
      "project/App.csproj":
        "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>",
      "lateproject/Legacy.csproj":
        "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
      "src/suggested.ts": "export function proposed(): number { return 0; }",
      "docs/manual.txt": "C#-Quelldateien TypeScript Vitest implementiert vorgeschlagenen Code",
    }),
  };
}

function query(text = QUESTION): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 20, emittedAtMs: 0 };
}

describe("explicit language source inspection through repository search", () => {
  it("selects and reads the existing C# computation rather than manifests or proposed TypeScript", async () => {
    const { scope, fs } = fixture();
    const result = await searchText(scope, query(), undefined, {
      fs,
      searchHints: { retrievalIntent: "targeted-code-search", hasGitMetadata: false },
    });
    expect(result.atoms[0]?.scopePath).toBe("src/Calculator.cs");
    expect(result.atoms.some((atom) => atom.scopePath.endsWith(".csproj"))).toBe(false);
    const excerpt = await readExcerpt(
      scope,
      {
        scopePath: "src/Calculator.cs",
        startLine: 1,
        endLine: 4,
        maxBytes: 2048,
      },
      { fs },
    );
    expect(excerpt.content).toContain("public static int Add(int a, int b) => a + b;");
    expect(result.coverage.incomplete).toBe(false);
  });

  it.each([
    "Write a C# function and suggest a Vitest test for equivalent TypeScript code.",
    "Which C# target framework version does this project use?",
  ])(
    "does not treat a draft or version question as current source inspection: %s",
    async (text) => {
      const { scope, fs } = fixture();
      const result = await searchText(scope, query(text), undefined, { fs });
      expect(result.atoms.some((atom) => atom.scopePath === "src/Calculator.cs")).toBe(false);
    },
  );
  it("keeps the language filename request valid after a nonmatching indexed search", async () => {
    const { scope, fs } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, query("unmatchedprobe"), undefined, { fs, workspaceIndex });
    const result = await searchText(scope, query(), undefined, { fs, workspaceIndex });
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/Calculator.cs"]);
  });

  it.each(["exact-symbol", "regex"] as const)(
    "keeps %s searches literal rather than selecting by language",
    async (kind) => {
      const { scope, fs } = fixture();
      const result = await searchText(
        scope,
        { ...query(kind === "exact-symbol" ? "CSharpProbe" : "Inspect C# source files"), kind },
        undefined,
        { fs },
      );
      expect(result.atoms.some((atom) => atom.scopePath === "src/Calculator.cs")).toBe(false);
    },
  );

  it("keeps trusted exact text interpretation separate from filename inspection", async () => {
    const { scope, fs } = fixture();
    const result = await searchText(scope, query("Inspect C# source files"), undefined, {
      fs,
      queryInterpretation: { kind: "literal", terms: ["Inspect C# source files"] },
    });
    expect(result.atoms.some((atom) => atom.scopePath === "src/Calculator.cs")).toBe(false);
  });

  it("preserves admitted content limits and existing path filters", async () => {
    const { scope } = fixture();
    const fs = memFs("/ws", {
      "src/Calculator.cs": SOURCE,
      "src/binary.cs": "header\u0000payload",
      "src/oversize.cs": "x".repeat(2_097_153),
      "src/excluded.cs": SOURCE,
    });
    const result = await searchText(scope, query("Inspect C# source files"), undefined, {
      fs,
      candidatePathGlobs: { include: ["src/**"], exclude: ["**/excluded.cs"] },
    });
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/Calculator.cs"]);
    expect(
      result.candidates.some(
        (candidate) => candidate.scopePath === "src/binary.cs" && candidate.omitted === "binary",
      ),
    ).toBe(true);
    expect(
      result.candidates.some(
        (candidate) =>
          candidate.scopePath === "src/oversize.cs" && candidate.omitted === "size-exceeded",
      ),
    ).toBe(true);
  });
});
