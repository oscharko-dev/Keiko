// Findings of the fourth independent review of the text parser (#4235). Synthetic documents only.

import { describe, expect, it } from "vitest";

import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import { textParser } from "./text-parser.js";
import type { InternalParserResult } from "./types.js";

function parse(text: string, extension = "md"): InternalParserResult {
  return textParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0 }),
  );
}

function sectionPaths(result: InternalParserResult): readonly (readonly string[])[] {
  return result.units.flatMap((unit) => (unit.kind === "section" ? [unit.sectionPath] : []));
}

describe("a Markdown document with lone carriage returns as line ends", () => {
  it("finds every heading and keeps the control character out of the path", () => {
    const result = parse("# Alpha\rtext\r## Beta\rmore\r");
    expect(sectionPaths(result)).toEqual([["Alpha"], ["Alpha", "Beta"]]);
  });

  it("starts each section at the heading that opens it", () => {
    const text = "# Alpha\rtext\r## Beta\rmore\r";
    const result = parse(text);
    const starts = result.units.flatMap((unit) =>
      unit.kind === "section" ? [text.slice(unit.characterStart, unit.characterStart + 4)] : [],
    );
    expect(starts).toEqual(["# Al", "## B"]);
  });
});

describe("a Markdown table with a single column", () => {
  it("emits one row unit per body row", () => {
    const text = "| Anforderung |\n|---|\n| Das System muss X tun. |\n| Das System muss Y tun. |\n";
    const rows = parse(text).units.flatMap((unit) =>
      unit.kind === "csv-row" ? [text.slice(unit.characterStart, unit.characterEnd)] : [],
    );
    expect(rows).toEqual(["| Das System muss X tun. |", "| Das System muss Y tun. |"]);
  });

  it("does not read a bare rule under a line with a pipe as a table", () => {
    const text = "a | b\n---\nweiter\n";
    expect(parse(text).units.some((unit) => unit.kind === "csv-row")).toBe(false);
  });
});
