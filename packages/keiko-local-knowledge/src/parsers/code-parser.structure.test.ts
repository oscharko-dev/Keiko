// Regression pins for #4235: a section is a top-level or class-level declaration with its leading
// documentation, never a local variable or a nested helper. Synthetic source only.

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { codeParser, codeSymbolLabel } from "./code-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

type Section = Extract<ParsedUnit, { kind: "section" }>;

function sectionsFor(text: string, extension: string): readonly Section[] {
  const result = codeParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0 }),
  );
  return result.units.filter((unit): unit is Section => unit.kind === "section");
}

function labels(text: string, extension: string): readonly string[] {
  return sectionsFor(text, extension).map((section) => section.sectionPath.join("/"));
}

function bodies(text: string, extension: string): readonly string[] {
  return sectionsFor(text, extension).map((section) =>
    text.slice(section.characterStart, section.characterEnd),
  );
}

describe("code sections: top-level and class-level only (#4235 F8)", () => {
  it("does not split a function at its local variables", () => {
    const text = [
      "export function validateAmount(input: number): number {",
      "  const limit = 100;",
      "  let total = input;",
      "  var legacy = 0;",
      "  return total + limit + legacy;",
      "}",
      "",
      "export const DEFAULT_LIMIT = 5;",
      "",
    ].join("\n");
    expect(labels(text, "ts")).toEqual(["function validateAmount", "constant DEFAULT_LIMIT"]);
  });

  it("does not turn constants inside a describe wrapper into sections", () => {
    const text = [
      'describe("suite", () => {',
      "  const fixture = 1;",
      '  it("works", () => {',
      "    const local = 2;",
      "  });",
      "});",
      "",
    ].join("\n");
    expect(labels(text, "ts")).toEqual(["typescript module"]);
  });

  it("keeps the methods of a class and ignores helpers nested in a method", () => {
    const text = [
      "export class Store {",
      "  public load(id: string): string {",
      "    function normalize(value: string): string {",
      "      return value;",
      "    }",
      "    return normalize(id);",
      "  }",
      "",
      "  public save(id: string): string {",
      "    const written = id;",
      "  }",
      "}",
      "",
      "export function after(): void {}",
      "",
    ].join("\n");
    expect(labels(text, "ts")).toEqual([
      "type Store",
      "function load",
      "function save",
      "function after",
    ]);
  });

  it("keeps Python methods and ignores a nested def", () => {
    const text = [
      "class Repo:",
      "    def fetch(self, key):",
      "        def helper(value):",
      "            return value",
      "        return helper(key)",
      "",
      "    def store(self, key):",
      "        return key",
      "",
      "def top():",
      "    return 1",
      "",
    ].join("\n");
    expect(labels(text, "py")).toEqual([
      "type Repo",
      "function fetch",
      "function store",
      "function top",
    ]);
  });

  it("does not take an indented const for a definition line", () => {
    expect(codeSymbolLabel("  const x = 1;")).toBeUndefined();
    expect(codeSymbolLabel("\tlet y = 2;")).toBeUndefined();
    expect(codeSymbolLabel("export const x = 1;")).toBe("constant x");
    expect(codeSymbolLabel("const x = 1;")).toBe("constant x");
  });
});

describe("code sections: documentation belongs to the following symbol (#4235 F8)", () => {
  it("attaches a JSDoc block, line comments and decorators to the symbol they precede", () => {
    const text = [
      "export function first(): void {}",
      "",
      "/**",
      " * Second does a thing.",
      " */",
      "// note",
      "@trace",
      "export function second(): void {}",
      "",
    ].join("\n");
    const parts = bodies(text, "ts");
    expect(parts[0]).toBe("export function first(): void {}\n\n");
    expect(parts[1]?.startsWith("/**\n * Second does a thing.")).toBe(true);
    expect(parts[1]).toContain("export function second");
  });

  it("keeps a floating comment (a blank line before the symbol) with the previous section", () => {
    const text = [
      "export function a(): void {}",
      "// floating",
      "",
      "export function b(): void {}",
    ].join("\n");
    expect(bodies(text, "ts")[0]).toContain("// floating");
  });

  it("attaches the comment of a class member to that member", () => {
    const text = [
      "export class A {",
      "  public one(): string {",
      "  }",
      "  /** Two. */",
      "  public two(): string {",
      "  }",
      "}",
    ].join("\n");
    const parts = bodies(text, "ts");
    expect(parts[1]).not.toContain("Two.");
    expect(parts[2]?.trimStart().startsWith("/** Two. */")).toBe(true);
  });

  it("keeps a file header comment in the module section ahead of the first symbol", () => {
    const text = ["// module documentation", "export interface Request {}", ""].join("\n");
    expect(labels(text, "ts")).toEqual(["typescript module", "type Request"]);
  });

  it("does not read a C preprocessor line as a comment", () => {
    const text = [
      "int a(void) {",
      "  return 1;",
      "}",
      "#define X 1",
      "int b(void) {",
      "  return 2;",
      "}",
    ].join("\n");
    expect(bodies(text, "c")[0]).toContain("#define X 1");
  });
});
