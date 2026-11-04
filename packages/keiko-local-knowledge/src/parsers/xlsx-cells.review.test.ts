// A boolean cell stores xsd:boolean, whose lexical forms are 1, 0, true and false (#4235).

import { describe, expect, it } from "vitest";

import { selectionFromBytes } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import { xlsxParser } from "./xlsx-parser.js";
import {
  buildWorkbook,
  inlineCell,
  parseWorkbook,
  rowXml,
  sheetXml,
} from "./xlsx-workbook-fixtures.js";

async function render(stored: string): Promise<string> {
  const sheet = sheetXml(
    rowXml(1, inlineCell("A1", "Name") + inlineCell("B1", "Wert")) +
      rowXml(2, inlineCell("A2", "x") + `<c r="B2" t="b"><v>${stored}</v></c>`),
  );
  const parsed = await parseWorkbook(buildWorkbook({ sheets: [{ name: "S", xml: sheet }] }));
  return parsed.lines.join("\n");
}

describe("a shared string table larger than the unit limit", () => {
  it("resolves every string, the table is a lookup and no unit", async () => {
    const count = 60_000;
    const strings = Array.from(
      { length: count },
      (_, index) => `<si><t>Text ${String(index)}</t></si>`,
    );
    const rows =
      rowXml(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>') +
      rowXml(
        2,
        `<c r="A2" t="s"><v>${String(count - 2)}</v></c><c r="B2" t="s"><v>${String(count - 1)}</v></c>`,
      );
    const parsed = await parseWorkbook(
      buildWorkbook({
        sheets: [{ name: "S", xml: sheetXml(rows) }],
        sharedStrings: `<sst>${strings.join("")}</sst>`,
      }),
    );
    expect(parsed.lines).toEqual(["S!2: Text 0=Text 59998 | Text 1=Text 59999"]);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("a sheet with more rows than a call can take as arguments", () => {
  it("projects 300,000 rows instead of failing the whole workbook", async () => {
    const rows = Array.from(
      { length: 300_000 },
      (_, row) => `<row r="${String(row + 1)}"><c><v>${String(row)}</v></c></row>`,
    ).join("");
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(buildWorkbook({ sheets: [{ name: "S", xml: sheetXml(rows) }] }), {
        extension: "xlsx",
      }),
      buildParserOptions({ now: () => 0, maxUnitsPerDocument: 400_000 }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.units).toHaveLength(300_000);
  });
});

describe("a package of many large parts", () => {
  it("is refused when its parts together inflate past the ceiling", async () => {
    // Three sheets of about 1.8 MB each (370 KB deflated in all): every part is within the ceiling
    // of one part (4 MB for an input limit of 400 KB), the package is not within the ceiling of
    // all parts together.
    const filler = (seed: number): string =>
      Array.from(
        { length: 50_000 },
        (_, row) => `<row r="${String(row + 1)}"><c><v>${String(seed)}</v></c></row>`,
      ).join("");
    const bytes = buildWorkbook({
      sheets: [1, 2, 3].map((seed) => ({ name: `S${String(seed)}`, xml: sheetXml(filler(seed)) })),
    });
    const parseWith = async (maxBytes: number): Promise<readonly string[]> => {
      const result = await xlsxParser.parseAsync(
        selectionFromBytes(bytes, { extension: "xlsx" }),
        buildParserOptions({ now: () => 0, maxBytes, maxUnitsPerDocument: 1_000_000 }),
      );
      return result.diagnostics.map((entry) => entry.code);
    };
    // The control: with a larger input limit the same package is read.
    expect(await parseWith(800_000)).toEqual([]);
    expect(await parseWith(400_000)).toEqual(["MALFORMED_INPUT"]);
  });
});

describe("number formats of conditional formatting", () => {
  it("do not replace the number format a cell style refers to", async () => {
    // A differential style (conditional formatting) carries a number format of its own, with an id
    // that may equal one of the workbook's: the cell style's id means the workbook's format.
    const styles =
      '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
      '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>' +
      '<dxfs count="1"><dxf><numFmt numFmtId="164" formatCode="0.0%"/></dxf></dxfs></styleSheet>';
    const sheet = sheetXml(
      rowXml(1, inlineCell("A1", "Name") + inlineCell("B1", "Datum")) +
        rowXml(2, inlineCell("A2", "x") + '<c r="B2" s="1"><v>45292</v></c>'),
    );
    const parsed = await parseWorkbook(
      buildWorkbook({ sheets: [{ name: "S", xml: sheet }], styles }),
    );
    expect(parsed.lines).toEqual(["S!2: Name=x | Datum=2024-01-01"]);
  });
});

describe("boolean cells", () => {
  it.each([
    ["1", "TRUE"],
    ["0", "FALSE"],
    ["true", "TRUE"],
    ["false", "FALSE"],
    ["FALSE", "FALSE"],
    [" 0 ", "FALSE"],
  ] as const)("reads %s as %s", async (stored, shown) => {
    expect(await render(stored)).toBe(`S!2: Name=x | Wert=${shown}`);
  });
});
