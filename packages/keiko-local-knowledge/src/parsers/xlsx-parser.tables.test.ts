// Table structure of a worksheet (#4235): which row is the header, how merged cells read, what a
// second table or a note under the table becomes, and what is reported about hidden content.

import { describe, expect, it } from "vitest";

import {
  buildWorkbook,
  inlineCell,
  parseWorkbook,
  rowXml,
  sheetXml,
  type FixtureSheet,
  type ParsedWorkbook,
} from "./xlsx-workbook-fixtures.js";

const COLUMNS = "ABCDEF";

// Inline-string cells for one row; an empty string is an absent cell.
function cells(rowNumber: number, values: readonly string[]): string {
  return rowXml(
    rowNumber,
    values
      .map((value, index) =>
        value === "" ? "" : inlineCell(`${COLUMNS.charAt(index)}${String(rowNumber)}`, value),
      )
      .join(""),
  );
}

async function linesOf(sheet: FixtureSheet | readonly FixtureSheet[]): Promise<ParsedWorkbook> {
  const sheets = Array.isArray(sheet) ? sheet : [sheet];
  return parseWorkbook(buildWorkbook({ sheets }));
}

const HEADER = ["ID", "Titel", "Beschreibung", "Priorität", "Akzeptanzkriterien"];

describe("worksheet header evidence", () => {
  it("does not take a title row above the header for the header", async () => {
    const xml = sheetXml(
      cells(1, ["Anforderungskatalog Portal v2"]) +
        cells(2, HEADER) +
        cells(3, ["FR-1", "Login", "Der Nutzer meldet sich an.", "Muss", "a"]),
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual([
      "S!1: Anforderungskatalog Portal v2",
      "S!3: ID=FR-1 | Titel=Login | Beschreibung=Der Nutzer meldet sich an. | Priorität=Muss | Akzeptanzkriterien=a",
    ]);
  });

  it("does not take a two-cell metadata row above a wider table for the header", async () => {
    const xml = sheetXml(
      cells(1, ["Projekt", "Portal"]) +
        cells(2, HEADER) +
        cells(3, ["FR-1", "Login", "Text", "Muss", "a"]),
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines[0]).toBe("S!1: Projekt | Portal");
    expect(parsed.lines[1]).toContain("ID=FR-1");
  });

  it("gives a second table on the same sheet its own labels", async () => {
    const xml = sheetXml(
      cells(1, HEADER) +
        cells(2, ["FR-1", "Login", "Text", "Muss", "a"]) +
        cells(5, ["Begriff", "Definition"]) +
        cells(6, ["Konto", "Ein Konto ist ..."]),
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual([
      "S!2: ID=FR-1 | Titel=Login | Beschreibung=Text | Priorität=Muss | Akzeptanzkriterien=a",
      "S!6: Begriff=Konto | Definition=Ein Konto ist ...",
    ]);
  });

  it("emits a header-only sheet as a plain line, never as a data row", async () => {
    const parsed = await linesOf({ name: "S", xml: sheetXml(cells(1, HEADER)) });
    expect(parsed.lines).toEqual([
      "S!1: ID | Titel | Beschreibung | Priorität | Akzeptanzkriterien",
    ]);
    expect(parsed.text).not.toContain("=");
  });

  it("keeps a lone note under a table as a plain line", async () => {
    const xml = sheetXml(
      cells(1, HEADER) +
        cells(2, ["FR-1", "Login", "Text", "Muss", "a"]) +
        cells(5, ["Stand 2026"]),
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines.at(-1)).toBe("S!5: Stand 2026");
  });

  it("labels columns by position when no row looks like a header", async () => {
    const xml = sheetXml(cells(1, ["FR-1", "Login"]) + cells(2, ["FR-2", "Logout"]));
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual([
      "S!1: Column A=FR-1 | Column B=Login",
      "S!2: Column A=FR-2 | Column B=Logout",
    ]);
  });

  it("reads a header with non-Latin letters", async () => {
    const xml = sheetXml(cells(1, ["Требование", "Описание"]) + cells(2, ["Вход", "Текст"]));
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual(["S!2: Требование=Вход | Описание=Текст"]);
  });

  it("joins a header cell broken over lines, including a hyphenated break", async () => {
    const xml = sheetXml(
      cells(1, ["ID", "Akzeptanz-\nkriterien", "Prio\nrität"]) + cells(2, ["FR-1", "a", "Muss"]),
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual(["S!2: ID=FR-1 | Akzeptanzkriterien=a | Prio rität=Muss"]);
  });

  it("neutralises projection syntax in headers and values", async () => {
    const xml = sheetXml(cells(1, ["ID", "A=B | C"]) + cells(2, ["FR-1", "x | Priorität=Kann"]));
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual(["S!2: ID=FR-1 | A B C=x ¦ Priorität=Kann"]);
  });
});

describe("merged cells", () => {
  it("projects the top-left value into the rows a vertical merge covers", async () => {
    const xml = sheetXml(
      cells(1, HEADER) +
        cells(2, ["FR-1", "Login", "Text", "Muss", "AC eins"]) +
        cells(3, ["", "", "", "", "AC zwei"]) +
        cells(4, ["", "", "", "", "AC drei"]) +
        cells(5, ["FR-2", "Logout", "Text", "Soll", "AC x"]),
      {
        after:
          '<mergeCells count="4"><mergeCell ref="A2:A4"/><mergeCell ref="B2:B4"/><mergeCell ref="C2:C4"/><mergeCell ref="D2:D4"/></mergeCells>',
      },
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual([
      "S!2: ID=FR-1 | Titel=Login | Beschreibung=Text | Priorität=Muss | Akzeptanzkriterien=AC eins",
      "S!3: ID=FR-1 | Titel=Login | Beschreibung=Text | Priorität=Muss | Akzeptanzkriterien=AC zwei",
      "S!4: ID=FR-1 | Titel=Login | Beschreibung=Text | Priorität=Muss | Akzeptanzkriterien=AC drei",
      "S!5: ID=FR-2 | Titel=Logout | Beschreibung=Text | Priorität=Soll | Akzeptanzkriterien=AC x",
    ]);
  });

  it("leaves a horizontal banner merge as one cell", async () => {
    const xml = sheetXml(
      cells(1, ["Katalog"]) + cells(2, ["Begriff", "Definition"]) + cells(3, ["Konto", "Text"]),
      { after: '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' },
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual(["S!1: Katalog", "S!3: Begriff=Konto | Definition=Text"]);
  });

  it("ignores malformed and oversized merge refs", async () => {
    const xml = sheetXml(cells(1, ["Begriff", "Definition"]) + cells(2, ["Konto", "Text"]), {
      after: '<mergeCells><mergeCell ref="nonsense"/><mergeCell ref="A1:XFD1048576"/></mergeCells>',
    });
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.lines).toEqual(["S!2: Begriff=Konto | Definition=Text"]);
  });
});

describe("hidden content", () => {
  it("keeps hidden sheets, rows and columns indexed and reports only counts", async () => {
    const visible = sheetXml(
      cells(1, ["ID", "Titel", "Geheim"]) +
        cells(2, ["FR-1", "Login", "s1"]) +
        rowXml(
          3,
          inlineCell("A3", "FR-2") + inlineCell("B3", "Logout") + inlineCell("C3", "s2"),
          'hidden="1"',
        ),
      { before: '<cols><col min="3" max="3" width="9" hidden="1"/></cols>' },
    );
    const hiddenSheet: FixtureSheet = {
      name: "Hidden",
      state: "hidden",
      xml: sheetXml(cells(1, ["ID", "Titel"]) + cells(2, ["FR-9", "Versteckt"])),
    };
    const parsed = await linesOf([{ name: "S", xml: visible }, hiddenSheet]);
    expect(parsed.lines).toEqual([
      "S!2: ID=FR-1 | Titel=Login | Geheim=s1",
      "S!3: ID=FR-2 | Titel=Logout | Geheim=s2",
      "Hidden!2: ID=FR-9 | Titel=Versteckt",
    ]);
    const notice = parsed.diagnostics.find((entry) => entry.code === "TABLE_HIDDEN_CONTENT");
    expect(notice).toMatchObject({
      severity: "info",
      message: "hidden content indexed: sheets=1 rows=1 columns=1",
    });
    expect(notice?.message).not.toMatch(/FR-|Login|Versteckt|Geheim/u);
  });

  it("reports nothing for a workbook without hidden content", async () => {
    const parsed = await linesOf({
      name: "S",
      xml: sheetXml(cells(1, ["ID", "Titel"]) + cells(2, ["FR-1", "Login"])),
    });
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("worksheet unit lineage", () => {
  it("numbers rows by their sheet row, 0-based, and skips blank rows", async () => {
    const xml = sheetXml(
      cells(1, ["ID", "Titel"]) + cells(2, ["FR-1", "a"]) + cells(4, ["FR-2", "b"]),
    );
    const parsed = await linesOf({ name: "S", xml });
    expect(parsed.units.map((unit) => (unit.kind === "csv-row" ? unit.rowIndex : -1))).toEqual([
      1, 3,
    ]);
  });
});

describe("worksheet scale", () => {
  it("projects 60,000 rows in linear time", async () => {
    const rows: string[] = [cells(1, ["ID", "Titel", "Text"])];
    for (let n = 2; n <= 60_001; n += 1)
      rows.push(cells(n, [`FR-${String(n)}`, `Titel ${String(n)}`, "Text"]));
    const bytes = buildWorkbook({ sheets: [{ name: "Big", xml: sheetXml(rows.join("")) }] });
    const started = Date.now();
    const parsed = await parseWorkbook(bytes, { maxUnitsPerDocument: 100_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(parsed.units).toHaveLength(60_000);
    expect(parsed.diagnostics).toEqual([]);
  });
});
