import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import {
  MARKDOWN_DOC,
  TEXT_PLAIN,
  encode,
  selectionFromBytes,
  selectionFromText,
} from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import { textParser } from "./text-parser.js";

function frozenAt(t: number): ReturnType<typeof buildParserOptions> {
  return buildParserOptions({ now: () => t });
}

function asSection(unit: ParsedUnit | undefined): {
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
} {
  if (unit?.kind !== "section")
    throw new Error(`expected section unit, got ${unit?.kind ?? "undefined"}`);
  return {
    sectionPath: unit.sectionPath,
    characterStart: unit.characterStart,
    characterEnd: unit.characterEnd,
  };
}

describe("textParser", () => {
  it("matches text-like extensions and media types", () => {
    expect(textParser.capability.matches(selectionFromText("hi", { extension: "txt" }))).toBe(true);
    expect(textParser.capability.matches(selectionFromText("hi", { extension: "py" }))).toBe(true);
    expect(textParser.capability.matches(selectionFromText("hi", { extension: "yaml" }))).toBe(
      true,
    );
    expect(
      textParser.capability.matches(
        selectionFromText("hi", { extension: "", mediaType: "text/plain" }),
      ),
    ).toBe(true);
    expect(
      textParser.capability.matches(
        selectionFromText("hi", { extension: "exe", mediaType: "application/octet-stream" }),
      ),
    ).toBe(false);
  });

  it("emits a single section for plain text covering the whole document", () => {
    const result = textParser.parse(selectionFromText(TEXT_PLAIN), frozenAt(0));
    expect(result.units).toHaveLength(1);
    const section = asSection(result.units[0]);
    expect(section.sectionPath).toEqual([]);
    expect(section.characterStart).toBe(0);
    expect(section.characterEnd).toBe(TEXT_PLAIN.length);
    expect(result.diagnostics).toEqual([]);
  });

  it("emits hierarchical sections for markdown headings", () => {
    const result = textParser.parse(
      selectionFromText(MARKDOWN_DOC, { extension: "md", mediaType: "text/markdown" }),
      frozenAt(0),
    );
    expect(result.diagnostics).toEqual([]);
    const paths = result.units.map((unit) => asSection(unit).sectionPath);
    expect(paths).toEqual([
      ["Title"],
      ["Title", "Subhead A"],
      ["Title", "Subhead A", "Deep heading"],
      ["Title", "Subhead B"],
    ]);
  });

  it("preserves a pre-heading preamble as a path-less section", () => {
    const doc = "Intro line\n\n# Heading\n\nBody.\n";
    const result = textParser.parse(
      selectionFromText(doc, { extension: "md", mediaType: "text/markdown" }),
      frozenAt(0),
    );
    const paths = result.units.map((unit) => asSection(unit).sectionPath);
    expect(paths).toEqual([[], ["Heading"]]);
  });

  it("treats markdown without any headings as plain text", () => {
    const result = textParser.parse(
      selectionFromText("no headings here", { extension: "md", mediaType: "text/markdown" }),
      frozenAt(0),
    );
    expect(result.units).toHaveLength(1);
    expect(asSection(result.units[0]).sectionPath).toEqual([]);
  });

  it("trims trailing ATX closing markers", () => {
    const result = textParser.parse(
      selectionFromText("## Hello ##\n\nBody.\n", { extension: "md" }),
      frozenAt(0),
    );
    expect(asSection(result.units[0]).sectionPath).toEqual(["Hello"]);
  });

  it("refuses oversize files with OVERSIZED_FILE diagnostic and zero units", () => {
    const big = encode("x".repeat(100));
    const result = textParser.parse(selectionFromBytes(big, { extension: "txt" }), {
      ...frozenAt(0),
      maxBytes: 10,
    });
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
  });

  it("emits PARSER_TIMEOUT diagnostic when the deadline has already passed", () => {
    let tick = 0;
    const result = textParser.parse(
      selectionFromText(MARKDOWN_DOC, { extension: "md" }),
      buildParserOptions({
        timeoutMs: 1,
        now: () => {
          tick += 100;
          return tick;
        },
      }),
    );
    // After at least one heading we expect the deadline to trip; the diagnostic must be info
    // severity and tagged with the timeout code.
    expect(result.diagnostics.some((d) => d.code === "PARSER_TIMEOUT")).toBe(true);
  });

  it("emits PARSER_CANCELLED when the abort signal fires", () => {
    const ac = new AbortController();
    ac.abort();
    const result = textParser.parse(
      selectionFromText(MARKDOWN_DOC, { extension: "md" }),
      buildParserOptions({ now: () => 0, signal: ac.signal }),
    );
    expect(result.diagnostics.some((d) => d.code === "PARSER_CANCELLED")).toBe(true);
  });

  it("emits UNIT_LIMIT_REACHED when maxUnitsPerDocument is exceeded", () => {
    const result = textParser.parse(
      selectionFromText(MARKDOWN_DOC, { extension: "md" }),
      buildParserOptions({ now: () => 0, maxUnitsPerDocument: 2 }),
    );
    expect(result.diagnostics.some((d) => d.code === "UNIT_LIMIT_REACHED")).toBe(true);
    expect(result.units.length).toBeLessThanOrEqual(2);
  });

  it("strips a UTF-8 BOM before scanning", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("# Title\n\nBody.\n")]);
    const result = textParser.parse(
      selectionFromBytes(bytes, { extension: "md", mediaType: "text/markdown" }),
      frozenAt(0),
    );
    expect(asSection(result.units[0]).sectionPath).toEqual(["Title"]);
  });
});
