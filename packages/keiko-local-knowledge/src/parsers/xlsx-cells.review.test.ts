// A boolean cell stores xsd:boolean, whose lexical forms are 1, 0, true and false (#4235).

import { describe, expect, it } from "vitest";

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
