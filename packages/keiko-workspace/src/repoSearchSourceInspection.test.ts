import { describe, expect, it } from "vitest";
import {
  requestedSourceInspectionExtensions,
  sourceInspectionPathMatches,
} from "./repoSearchSourceInspection.js";

describe("explicit source inspection grammar", () => {
  it.each([
    ["Untersuche die C#-Quelldateien im verbundenen Ordner", ["cs"]],
    ["Inspect C# source files and suggest equivalent TypeScript code", ["cs"]],
    ["Read the source files written in C#", ["cs"]],
    ["Examine Python source code", ["py", "pyi"]],
    ["Show Java source files", ["java"]],
    ["Read TypeScript source files", ["ts", "tsx", "mts", "cts"]],
  ])("derives registered source extensions from %s", (text, extensions) => {
    expect(requestedSourceInspectionExtensions(text)).toEqual(extensions);
  });

  it.each([
    "Write a C# function and a Vitest test.",
    "Create C# source files.",
    "Which Java version is used?",
    "Inspect C# target framework and TypeScript version.",
    "Inspect source files and write a C# function.",
    "Inspect C# source files".padEnd(4097, "a"),
  ])("does not invent existing source requests from %s", (text) => {
    expect(requestedSourceInspectionExtensions(text)).toEqual([]);
  });

  it("matches exact basename extensions rather than manifest names or path text", () => {
    expect(sourceInspectionPathMatches("src/Calculator.CS", ["cs"])).toBe(true);
    for (const path of [
      "App.csproj",
      "docs/cs/manual.md",
      "src/Calculator.cs.png",
      "src/test.ts",
    ]) {
      expect(sourceInspectionPathMatches(path, ["cs"])).toBe(false);
    }
  });
});
