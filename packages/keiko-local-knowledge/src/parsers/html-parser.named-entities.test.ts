import { describe, expect, it } from "vitest";
import { htmlParser } from "./html-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { InternalParserResult } from "./types.js";

function textFor(html: string): string {
  const parsed = htmlParser.parse(
    selectionFromText(html, { extension: "html" }),
    buildParserOptions({ now: () => 0 }),
  ) as InternalParserResult;
  expect(parsed.diagnostics).toEqual([]);
  return parsed.normalizedText ?? "";
}

describe("standard HTML character references in the existing parser", () => {
  it.each([
    ["&Uuml;berhitzungsschutz", "Überhitzungsschutz"],
    ["M&auml;ngel&nbsp;Beseitigung", "Mängel\u00a0Beseitigung"],
    ["caf&eacute;", "café"],
  ])("decodes %s through the shared HTML producer", (encoded, expected) => {
    const text = textFor(`<html><body><p>${encoded} specifies 61.2 C.</p></body></html>`);
    expect(text).toContain(expected);
    expect(text).not.toContain(encoded);
  });

  it("does not recursively decode escaped references or execute decoded markup", () => {
    const text = textFor("<p>&amp;Uuml;berhitzungsschutz &lt;script&gt;payload&lt;/script&gt;</p>");
    expect(text).toContain("&Uuml;berhitzungsschutz");
    expect(text).not.toContain("Überhitzungsschutz");
  });

  it("retains unknown named references without guessing a human word", () => {
    expect(textFor("<p>&zzz; manual</p>")).toContain("&zzz; manual");
  });
});
