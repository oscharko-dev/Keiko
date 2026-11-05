// Excel-native XML forms (#4235): every fixture is written by hand, the way Excel stores it,
// instead of by openpyxl, which normalises away the shapes that broke the parser.

import { describe, expect, it } from "vitest";

import {
  buildWorkbook,
  inlineCell,
  numberCell,
  parseWorkbook,
  rowXml,
  sheetXml,
  stylesWith,
} from "./xlsx-workbook-fixtures.js";

const HEADER = rowXml(1, inlineCell("A1", "Name") + inlineCell("B1", "Wert"));

async function valueOf(
  cellXml: string,
  workbook: { styles?: string; date1904?: boolean } = {},
): Promise<readonly string[]> {
  const sheet = sheetXml(HEADER + rowXml(2, inlineCell("A2", "x") + cellXml));
  const parsed = await parseWorkbook(
    buildWorkbook({ sheets: [{ name: "S", xml: sheet }], ...workbook }),
  );
  return parsed.lines;
}

describe("xlsx XML element iteration", () => {
  it("does not let a self-closing <c/> swallow the next cell", async () => {
    const sharedStrings =
      "<sst><si><t>Name</t></si><si><t>Wert</t></si><si><t>Alpha</t></si><si><t>Gamma</t></si></sst>";
    const sheet = sheetXml(
      rowXml(
        1,
        '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>1</v></c>',
      ) + rowXml(2, '<c r="A2" t="s"><v>2</v></c><c r="B2"/><c r="C2" t="s"><v>3</v></c>'),
    );
    const parsed = await parseWorkbook(
      buildWorkbook({ sheets: [{ name: "S", xml: sheet }], sharedStrings }),
    );
    expect(parsed.lines).toEqual(["S!2: Name=Alpha | Wert 2=Gamma"]);
  });

  it("does not let a self-closing <row/> swallow the next row", async () => {
    const sheet = sheetXml(
      HEADER + '<row r="2"/>' + rowXml(3, inlineCell("A3", "a") + inlineCell("B3", "b")),
    );
    const parsed = await parseWorkbook(buildWorkbook({ sheets: [{ name: "S", xml: sheet }] }));
    expect(parsed.lines).toEqual(["S!3: Name=a | Wert=b"]);
  });

  it("keeps the cached value of a cell that carries a self-closing shared formula", async () => {
    const lines = await valueOf('<c r="B2" t="str"><f t="shared" si="0"/><v>cached</v></c>');
    expect(lines).toEqual(["S!2: Name=x | Wert=cached"]);
  });

  it("does not shift later strings after an empty <si/>", async () => {
    const sharedStrings = "<sst><si><t>Name</t></si><si/><si><t>Wert</t></si></sst>";
    const sheet = sheetXml(
      rowXml(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c>') +
        rowXml(2, '<c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>1</v></c>'),
    );
    const parsed = await parseWorkbook(
      buildWorkbook({ sheets: [{ name: "S", xml: sheet }], sharedStrings }),
    );
    expect(parsed.lines).toEqual(["S!2: Name=Wert"]);
  });

  it("decodes _xHHHH_ escapes and keeps an escaped underscore literal", async () => {
    const lines = await valueOf(inlineCell("B2", "line1_x000D_\nline2 _x005F_x000D_ end"));
    expect(lines).toEqual(["S!2: Name=x | Wert=line1", "line2 _x000D_ end"]);
  });

  it("drops phonetic runs (rPh) from shared-string text", async () => {
    const sharedStrings =
      '<sst><si><t>Name</t></si><si><t>Wert</t></si><si><r><t>Tokyo</t></r><rPh sb="0" eb="1"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si></sst>';
    const sheet = sheetXml(
      rowXml(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>') +
        rowXml(2, '<c r="A2" t="s"><v>2</v></c>'),
    );
    const parsed = await parseWorkbook(
      buildWorkbook({ sheets: [{ name: "S", xml: sheet }], sharedStrings }),
    );
    expect(parsed.lines).toEqual(["S!2: Name=Tokyo"]);
  });
});

describe("xlsx cell values as displayed", () => {
  const styles = stylesWith([0, 14, 9, 10, 2, 20, 164, 22], {
    164: String.raw`#,##0.00\ &quot;€&quot;`,
  });

  it('formats a date even when the cell says t="n" explicitly', async () => {
    const lines = await valueOf('<c r="B2" s="1" t="n"><v>46086</v></c>', { styles });
    expect(lines).toEqual(["S!2: Name=x | Wert=2026-03-05"]);
  });

  it("renders percent, fixed decimals and a currency suffix", async () => {
    expect(await valueOf(numberCell("B2", "0.19", 2), { styles })).toEqual([
      "S!2: Name=x | Wert=19%",
    ]);
    expect(await valueOf(numberCell("B2", "0.1925", 3), { styles })).toEqual([
      "S!2: Name=x | Wert=19.25%",
    ]);
    expect(await valueOf(numberCell("B2", "3", 4), { styles })).toEqual([
      "S!2: Name=x | Wert=3.00",
    ]);
    expect(await valueOf(numberCell("B2", "1234.5", 6), { styles })).toEqual([
      "S!2: Name=x | Wert=1234.50 €",
    ]);
  });

  it("removes binary floating point noise from General numbers", async () => {
    expect(await valueOf(numberCell("B2", "0.30000000000000004"))).toEqual([
      "S!2: Name=x | Wert=0.3",
    ]);
    expect(await valueOf(numberCell("B2", "12"))).toEqual(["S!2: Name=x | Wert=12"]);
  });

  it("renders a time-only format without the 1899 date", async () => {
    expect(await valueOf(numberCell("B2", "0.3541666666666667", 5), { styles })).toEqual([
      "S!2: Name=x | Wert=08:30",
    ]);
  });

  it("renders a date and time format with both parts", async () => {
    expect(await valueOf(numberCell("B2", "46086.5", 7), { styles })).toEqual([
      "S!2: Name=x | Wert=2026-03-05 12:00",
    ]);
  });

  it("honours the 1904 date system", async () => {
    expect(await valueOf(numberCell("B2", "0", 1), { styles, date1904: true })).toEqual([
      "S!2: Name=x | Wert=1904-01-01",
    ]);
  });

  it("renders booleans as TRUE and FALSE", async () => {
    expect(await valueOf('<c r="B2" t="b"><v>1</v></c>')).toEqual(["S!2: Name=x | Wert=TRUE"]);
    expect(await valueOf('<c r="B2" t="b"><v>0</v></c>')).toEqual(["S!2: Name=x | Wert=FALSE"]);
  });

  it("keeps an unparsable numeric payload as written", async () => {
    expect(await valueOf(numberCell("B2", "n/a", 1), { styles })).toEqual([
      "S!2: Name=x | Wert=n/a",
    ]);
  });
});

describe("xlsx formula cells", () => {
  it("does not present formula text as the cell value and counts it body-free", async () => {
    const sheet = sheetXml(HEADER + rowXml(2, inlineCell("A2", "x") + '<c r="B2"><f>1+2</f></c>'));
    const parsed = await parseWorkbook(buildWorkbook({ sheets: [{ name: "S", xml: sheet }] }));
    expect(parsed.text).not.toContain("1+2");
    expect(parsed.lines).toEqual(["S!2: Name=x"]);
    const notice = parsed.diagnostics.find((entry) => entry.code === "TABLE_FORMULA_UNCACHED");
    expect(notice).toMatchObject({
      severity: "info",
      message: "formula cells without cached value: 1",
    });
  });

  it("treats an empty cached result as an empty cell without a notice", async () => {
    const sheet = sheetXml(
      HEADER + rowXml(2, inlineCell("A2", "x") + '<c r="B2" t="str"><f>A2&amp;""</f><v></v></c>'),
    );
    const parsed = await parseWorkbook(buildWorkbook({ sheets: [{ name: "S", xml: sheet }] }));
    expect(parsed.lines).toEqual(["S!2: Name=x"]);
    expect(parsed.diagnostics.some((entry) => entry.code === "TABLE_FORMULA_UNCACHED")).toBe(false);
  });
});
