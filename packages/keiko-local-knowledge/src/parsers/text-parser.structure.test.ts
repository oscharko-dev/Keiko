// Regression pins for #4235: Markdown, reStructuredText and AsciiDoc section structure. Synthetic
// documents only.

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

function sectionTexts(result: InternalParserResult): readonly string[] {
  const text = result.normalizedText ?? "";
  return result.units.flatMap((unit) =>
    unit.kind === "section" ? [text.slice(unit.characterStart, unit.characterEnd)] : [],
  );
}

describe("markdown headings (#4235 F10)", () => {
  it("keeps carriage returns out of section paths and strips a closing ## run", () => {
    const result = parse("# Alpha\r\ntext\r\n## Beta ##\r\nmore\r\n");
    expect(sectionPaths(result)).toEqual([["Alpha"], ["Alpha", "Beta"]]);
    expect(JSON.stringify(sectionPaths(result))).not.toContain("\\r");
  });

  it("strips a closing run only when a space precedes it", () => {
    expect(sectionPaths(parse("# C#\ntext\n# Titel ##\n"))).toEqual([["C#"], ["Titel"]]);
    expect(sectionPaths(parse("## Titel   ##   \n"))).toEqual([["Titel"]]);
  });

  it("accepts a heading indented by up to three spaces and not by four", () => {
    expect(sectionPaths(parse("   ## Eingerückt\ntext\n"))).toEqual([["Eingerückt"]]);
    expect(sectionPaths(parse("    ## Code\ntext\n"))).toEqual([[]]);
  });

  it("does not turn a list item, table row or front-matter key into a setext heading", () => {
    expect(sectionPaths(parse("- Punkt\n---\nrest\n"))).toEqual([[]]);
    expect(sectionPaths(parse("| a | b |\n| 1 | 2 |\n---\nrest\n"))).toEqual([[]]);
    const front = parse("---\nstatus: draft\n---\n# Titel\ntext\n");
    expect(sectionPaths(front)).toEqual([[], ["Titel"]]);
  });

  it("still reads a real setext heading", () => {
    expect(sectionPaths(parse("Titel\n=====\ntext\n\nUnter\n---\nmehr\n"))).toEqual([
      ["Titel"],
      ["Titel", "Unter"],
    ]);
  });

  it("tracks fences by character and length", () => {
    expect(sectionPaths(parse("```\n~~~\n# kein\n```\n# Echt\n"))).toEqual([[], ["Echt"]]);
    expect(sectionPaths(parse("~~~\n```\n# kein\n~~~\n# Echt\n"))).toEqual([[], ["Echt"]]);
    expect(sectionPaths(parse("````\n```\n# kein\n```\n````\n# Echt\n"))).toEqual([[], ["Echt"]]);
  });

  it("ignores headings inside an HTML comment", () => {
    expect(sectionPaths(parse("<!-- ## x -->\n# Echt\n"))).toEqual([[], ["Echt"]]);
    expect(sectionPaths(parse("<!--\n# versteckt\n-->\n# Echt\n"))).toEqual([[], ["Echt"]]);
  });

  it("keeps a heading section whole: its text starts at the heading line", () => {
    const result = parse("# Alpha\ntext\n# Beta\nmore");
    expect(sectionTexts(result)).toEqual(["# Alpha\ntext\n", "# Beta\nmore"]);
  });

  it("names the tables of one document apart", () => {
    const result = parse(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c | d |\n|---|---|\n| 3 | 4 |\n",
    );
    const tables = result.units.flatMap((unit) =>
      unit.kind === "csv-row" ? [unit.tableName] : [],
    );
    expect(tables).toEqual(["markdown-table", "markdown-table-2"]);
  });

  it("does not read a table inside a fence", () => {
    const result = parse("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n");
    expect(result.units.some((unit) => unit.kind === "csv-row")).toBe(false);
  });
});

describe("reStructuredText and AsciiDoc headings (#4235 F10)", () => {
  it("reads underlined RST titles, level by order of first use", () => {
    const rst = "Titel\n=====\n\ntext\n\nUnter\n-----\n\nmehr\n\nNoch einer\n==========\n";
    expect(sectionPaths(parse(rst, "rst"))).toEqual([
      ["Titel"],
      ["Titel", "Unter"],
      ["Noch einer"],
    ]);
  });

  it("reads over- and underlined RST titles as a style of their own", () => {
    const rst = "=====\nTitel\n=====\n\ntext\n\nTitel zwei\n==========\n\nmehr\n";
    expect(sectionPaths(parse(rst, "rst"))).toEqual([["Titel"], ["Titel", "Titel zwei"]]);
  });

  it("does not take a short underline or a list for an RST title", () => {
    expect(sectionPaths(parse("Ein langer Satz\n--\ntext\n", "rst"))).toEqual([[]]);
    expect(sectionPaths(parse("text\n\n----\n\nmore\n", "rst"))).toEqual([[]]);
  });

  it("reads AsciiDoc = headings and skips listing blocks", () => {
    const adoc = "= Dokument\n\n== Abschnitt\ntext\n----\n== kein Titel\n----\n=== Unter\nmehr\n";
    expect(sectionPaths(parse(adoc, "adoc"))).toEqual([
      ["Dokument"],
      ["Dokument", "Abschnitt"],
      ["Dokument", "Abschnitt", "Unter"],
    ]);
  });

  it("keeps plain text one section and does not read Markdown headings in it", () => {
    expect(sectionPaths(parse("# kein Titel\ntext\n", "txt"))).toEqual([[]]);
  });
});
