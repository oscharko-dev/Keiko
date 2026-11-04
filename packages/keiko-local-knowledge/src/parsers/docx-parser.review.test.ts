// Independent-review pins for the docx parser (#4235): findings from reading real Word and
// LibreOffice output against python-docx. Each case fails on the reader it was written against.

import { describe, expect, it } from "vitest";

import {
  abstractNumXml,
  cellXml,
  documentXml,
  levelXml,
  linesOf,
  numberingXml,
  numXml,
  parseDocx,
  plainTable,
  rowXml,
  tableXml,
  textCell,
  textPara,
} from "./docx-test-fixtures.js";

describe("docx table header evidence", () => {
  it("does not take the first row of a key-value table for a header", async () => {
    const document = documentXml(
      plainTable([
        ["Autor", "Max Mustermann"],
        ["Datum", "12.03.2024"],
      ]),
    );
    expect(linesOf(await parseDocx({ document }))).toEqual([
      "Table row 1: Column 1=Autor | Column 2=Max Mustermann",
      "Table row 2: Column 1=Datum | Column 2=12.03.2024",
    ]);
  });

  it("does not let one uniform value column turn a key into a column label", async () => {
    const document = documentXml(
      plainTable([
        ["Autor", "Max Mustermann"],
        ["Datum", "12.03.2024"],
        ["Stand", "13.03.2024"],
      ]),
    );
    expect(linesOf(await parseDocx({ document }))[0]).toBe(
      "Table row 1: Column 1=Autor | Column 2=Max Mustermann",
    );
  });

  it("does not infer a header from a single data row", async () => {
    const document = documentXml(
      plainTable([
        ["ID", "Titel"],
        ["REQ-001", "Login"],
      ]),
    );
    expect(linesOf(await parseDocx({ document }))[0]).toBe(
      "Table row 1: Column 1=ID | Column 2=Titel",
    );
  });
});

describe("docx table projection syntax", () => {
  it("keeps a pipe inside a cell from reading as the next cell", async () => {
    const document = documentXml(
      plainTable(
        [
          ["Regel", "Formel"],
          ["R1", "a | b"],
          ["R2", "x=y"],
        ],
        true,
      ),
    );
    expect(linesOf(await parseDocx({ document }))).toEqual([
      "Table row 1: Regel=R1 | Formel=a ¦ b",
      "Table row 2: Regel=R2 | Formel=x=y",
    ]);
  });

  it("keeps projection syntax out of a column label", async () => {
    const document = documentXml(
      plainTable(
        [
          ["Soll = Ist", "Wert | Einheit"],
          ["1", "2"],
        ],
        true,
      ),
    );
    expect(linesOf(await parseDocx({ document }))).toEqual([
      "Table row 1: Soll Ist=1 | Wert Einheit=2",
    ]);
  });

  it("neutralises a pipe in a nested table row line too", async () => {
    const inner = plainTable([["p | q", "r"]]);
    const outer = tableXml(rowXml([cellXml(inner), textCell("x")]));
    const lines = linesOf(await parseDocx({ document: documentXml(outer) }));
    expect(lines.join("\n")).toContain("Column 1=p ¦ q | Column 2=r");
  });
});

describe("docx lists inside table cells", () => {
  const numbering = numberingXml(
    abstractNumXml("0", [levelXml(0, { format: "decimal", text: "%1." })]),
    abstractNumXml("1", [levelXml(0, { format: "bullet", text: "" })]),
    numXml("1", "0"),
    numXml("2", "1"),
  );
  const item = (text: string, numId: string): string => textPara(text, { numId, ilvl: 0 });

  it("shows the marker of a list paragraph in a cell", async () => {
    const cell = cellXml(item("eins", "1") + item("zwei", "1"));
    const document = documentXml(tableXml(rowXml([cell, textCell("x")])));
    expect(linesOf(await parseDocx({ document, numbering }))).toEqual([
      "Table row 1: Column 1=1. eins 2. zwei | Column 2=x",
    ]);
  });

  it("counts cell items and body items of one list together, in document order", async () => {
    const cell = cellXml(item("in der Zelle", "1"));
    const document = documentXml(
      item("davor", "1"),
      tableXml(rowXml([cell, textCell("x")])),
      item("danach", "1"),
    );
    expect(linesOf(await parseDocx({ document, numbering }))).toEqual([
      "1. davor",
      "Table row 1: Column 1=2. in der Zelle | Column 2=x",
      "3. danach",
    ]);
  });

  it("shows a bullet for a bullet item in a cell", async () => {
    const cell = cellXml(item("Punkt", "2"));
    const document = documentXml(tableXml(rowXml([cell, textCell("x")])));
    expect(linesOf(await parseDocx({ document, numbering }))[0]).toBe(
      "Table row 1: Column 1=- Punkt | Column 2=x",
    );
  });

  it("counts a list in a nested table once", async () => {
    const inner = tableXml(rowXml([cellXml(item("innen", "1")), textCell("y")]));
    const outer = tableXml(rowXml([cellXml(inner), textCell("x")]));
    const lines = linesOf(
      await parseDocx({ document: documentXml(outer, item("außen", "1")), numbering }),
    );
    expect(lines.join("\n")).toContain("Column 1=1. innen");
    expect(lines.at(-1)).toBe("2. außen");
  });
});
