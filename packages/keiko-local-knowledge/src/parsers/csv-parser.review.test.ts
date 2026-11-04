// Findings of the independent review of the CSV parser (#4235).

import { describe, expect, it } from "vitest";

import { csvParser } from "./csv-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

function parse(
  text: string,
  maxUnitsPerDocument?: number,
): {
  readonly lines: readonly string[];
  readonly codes: readonly string[];
} {
  const result = csvParser.parse(
    selectionFromText(text, { extension: "csv" }),
    buildParserOptions({
      now: () => 0,
      ...(maxUnitsPerDocument === undefined ? {} : { maxUnitsPerDocument }),
    }),
  );
  const normalized = (result as { readonly normalizedText?: string }).normalizedText ?? "";
  return {
    lines: normalized.split("\n").filter((line) => line.length > 0),
    codes: result.diagnostics.map((entry) => entry.code),
  };
}

describe("Excel's sep= directive", () => {
  it("names the delimiter and is not a record", () => {
    const parsed = parse("sep=;\r\nID;Titel;Betrag\r\nFR-1;Login;1,5\r\n");
    expect(parsed.lines).toEqual(["csv!3: ID=FR-1 | Titel=Login | Betrag=1,5"]);
  });

  it("is honoured over the delimiter the records suggest", () => {
    // Every record has two commas and a single semicolon; the directive says semicolon.
    const parsed = parse("sep=;\nID;Text\nFR-1;a, b, c\nFR-2;d, e, f\n");
    expect(parsed.lines).toEqual([
      "csv!3: ID=FR-1 | Text=a, b, c",
      "csv!4: ID=FR-2 | Text=d, e, f",
    ]);
  });

  it("is only a directive on the first line", () => {
    const parsed = parse("ID;Titel\nsep=;\nFR-1;Login\n");
    expect(parsed.lines.join("\n")).toContain("sep=");
  });
});

describe("delimiter detection between a delimiter and a decimal comma", () => {
  it("keeps 1.234,50 whole in a German file without a header", () => {
    const parsed = parse("Miete;1.234,50\nStrom;89,90\nWasser;45,5\nInternet;39,99\n");
    expect(parsed.lines).toEqual([
      "csv!1: Column 1=Miete | Column 2=1.234,50",
      "csv!2: Column 1=Strom | Column 2=89,90",
      "csv!3: Column 1=Wasser | Column 2=45,5",
      "csv!4: Column 1=Internet | Column 2=39,99",
    ]);
  });

  it("keeps 1,5 whole when every record has exactly one", () => {
    const parsed = parse("Kunde A;1,5\nKunde B;3,5\nKunde C;10,5\n");
    expect(parsed.lines[0]).toBe("csv!1: Column 1=Kunde A | Column 2=1,5");
  });

  it("still splits a comma file of numbers at the commas", () => {
    const parsed = parse("1,2,3\n4,5,6\n7,8,9\n");
    expect(parsed.lines[0]).toBe("csv!1: Column 1=1 | Column 2=2 | Column 3=3");
  });

  it("still prefers the delimiter that gives more fields when no number is cut", () => {
    const parsed = parse("ID,Text,Prio\nFR-1,Der Nutzer; der Admin,Muss\nFR-2,x; y,Soll\n");
    expect(parsed.lines[0]).toBe("csv!2: ID=FR-1 | Text=Der Nutzer; der Admin | Prio=Muss");
  });
});

describe("a file with far more records than the unit limit", () => {
  it("stops reading records once the limit is certain to be overrun, and says so", () => {
    const records = "FR-1;Titel;Wert\n".repeat(3_000_000);
    const startedAt = performance.now();
    const parsed = parse(`ID;Titel;Wert\n${records}`, 100);
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(parsed.lines).toHaveLength(100);
    expect(parsed.codes).toEqual(["UNIT_LIMIT_REACHED"]);
  });

  it("reports a cut after blank lines and later headers that produce no line", () => {
    // Header, record, blank, header, record, ...: every second non-empty row is a header.
    const block = "ID;Titel\nFR-1;A\n\n";
    const parsed = parse(block.repeat(200), 20);
    expect(parsed.lines).toHaveLength(20);
    expect(parsed.codes).toEqual(["UNIT_LIMIT_REACHED"]);
  });

  it("keeps the number of a record behind blank lines", () => {
    const parsed = parse("ID;Titel\n\n\nFR-1;Login\n");
    expect(parsed.lines).toEqual(["csv!4: ID=FR-1 | Titel=Login"]);
  });
});
