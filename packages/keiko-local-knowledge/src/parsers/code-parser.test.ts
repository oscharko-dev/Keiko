import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { codeParser, codeSymbolLabel } from "./code-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { createDefaultParserRegistry } from "./index.js";
import { buildParserOptions } from "./registry.js";

function sectionsFor(
  text: string,
  extension: string,
): readonly Extract<ParsedUnit, { kind: "section" }>[] {
  const result = codeParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0 }),
  );
  return result.units.filter(
    (unit): unit is Extract<ParsedUnit, { kind: "section" }> => unit.kind === "section",
  );
}

describe("codeParser", () => {
  it("precedes the permissive text adapter in the shipped registry", () => {
    const resolution = createDefaultParserRegistry().resolve(
      selectionFromText("export const value = 1;", { extension: "ts" }),
    );
    expect(resolution).toMatchObject({
      kind: "matched",
      adapter: { capability: { parserId: "code-text" } },
    });
  });

  it.each([
    ["ts", "export function load(): void {}", "function load"],
    ["py", "def load():\n    return None", "function load"],
    ["go", "func Load() {}", "function Load"],
    ["rs", "pub fn load() {}", "function load"],
    ["kt", "data class Record(val id: String)", "type Record"],
    ["java", "public final class Record {}", "type Record"],
  ])("emits a symbol-anchored section for %s", (extension, text, label) => {
    const sections = sectionsFor(text, extension);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.sectionPath).toEqual([label]);
    expect(sections[0]?.characterStart).toBe(0);
    expect(sections[0]?.characterEnd).toBe(text.length);
  });

  it("preserves a module preamble and splits subsequent symbols at their line starts", () => {
    const text = [
      "// module documentation",
      "export interface Request {}",
      "",
      "export async function execute(): Promise<void> {}",
      "",
    ].join("\n");
    const sections = sectionsFor(text, "ts");
    expect(sections.map((section) => section.sectionPath)).toEqual([
      ["typescript module"],
      ["type Request"],
      ["function execute"],
    ]);
    expect(sections.map((section) => section.characterStart)).toEqual([
      0,
      text.indexOf("export interface"),
      text.indexOf("export async function"),
    ]);
  });

  it("emits one module section for empty, symbol-free, BOM, and hostile long-line inputs", () => {
    expect(sectionsFor("", "py")[0]?.sectionPath).toEqual(["python module"]);
    expect(sectionsFor("value = call()\r\n", "py")[0]?.sectionPath).toEqual(["python module"]);
    expect(sectionsFor(`\uFEFF${"x".repeat(20_000)}`, "ts")[0]?.characterStart).toBe(0);
  });

  it("uses only the seeded definition vocabulary", () => {
    expect(codeSymbolLabel("if (ready) {")).toBeUndefined();
    expect(codeSymbolLabel("const refresh = async () => true;")).toBe("constant refresh");
    expect(codeSymbolLabel("private Result refresh(Input input) {")).toBe("function refresh");
  });
});
