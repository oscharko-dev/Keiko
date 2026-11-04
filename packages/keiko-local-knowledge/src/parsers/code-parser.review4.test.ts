// Findings of the fourth independent review of the code parser (#4235). Synthetic sources only.

import { describe, expect, it } from "vitest";

import { codeParser } from "./code-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

function sections(
  text: string,
  extension: string,
): readonly { readonly label: string | undefined; readonly slice: string }[] {
  const result = codeParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0 }),
  );
  return result.units.flatMap((unit) =>
    unit.kind === "section"
      ? [{ label: unit.sectionPath[0], slice: text.slice(unit.characterStart, unit.characterEnd) }]
      : [],
  );
}

describe("source with lone carriage returns as line ends", () => {
  const source = "def first():\r    return 1\rdef second():\r    return 2\r";

  it("anchors every declaration", () => {
    expect(sections(source, "py").map((section) => section.label)).toEqual([
      "function first",
      "function second",
    ]);
  });

  it("cuts the sections at the declarations and loses no text", () => {
    const parts = sections(source, "py").map((section) => section.slice);
    expect(parts).toEqual(["def first():\r    return 1\r", "def second():\r    return 2\r"]);
    expect(parts.join("")).toBe(source);
  });
});

describe("source with mixed line endings", () => {
  it("anchors declarations after each kind of line end", () => {
    const source = "def a():\n    pass\r\ndef b():\r    pass\ndef c():\n    pass";
    expect(sections(source, "py").map((section) => section.label)).toEqual([
      "function a",
      "function b",
      "function c",
    ]);
  });
});
