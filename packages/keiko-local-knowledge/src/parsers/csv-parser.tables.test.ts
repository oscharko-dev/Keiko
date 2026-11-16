// CSV / TSV dialects and table structure (#4235).

import { describe, expect, it } from "vitest";

import { csvParser } from "./csv-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

interface Parsed {
  readonly lines: readonly string[];
  readonly rowIndexes: readonly number[];
  readonly codes: readonly string[];
  readonly messages: readonly string[];
}

function parse(text: string, extension = "csv", maxUnitsPerDocument?: number): Parsed {
  const result = csvParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({
      now: () => 0,
      ...(maxUnitsPerDocument === undefined ? {} : { maxUnitsPerDocument }),
    }),
  );
  const normalized = (result as { readonly normalizedText?: string }).normalizedText ?? "";
  return {
    lines: normalized.split("\n").filter((line) => line.length > 0),
    rowIndexes: result.units.map((unit) => (unit.kind === "csv-row" ? unit.rowIndex : -1)),
    codes: result.diagnostics.map((entry) => entry.code),
    messages: result.diagnostics.map((entry) => entry.message),
  };
}

describe("csv delimiter detection", () => {
  it("splits a semicolon file, the default of German spreadsheet exports", () => {
    const parsed = parse("ID;Titel;Beschreibung\nFR-1;Login;Der Nutzer meldet sich an.\n");
    expect(parsed.lines).toEqual([
      "csv!2: ID=FR-1 | Titel=Login | Beschreibung=Der Nutzer meldet sich an.",
    ]);
  });

  it("keeps a decimal comma inside a semicolon file", () => {
    expect(parse("Name;Preis\nA;1,5\nB;2,25\n").lines).toEqual([
      "csv!2: Name=A | Preis=1,5",
      "csv!3: Name=B | Preis=2,25",
    ]);
  });

  it("splits a pipe file and a tab file named .csv", () => {
    expect(parse("ID|Titel\nFR-1|Login\n").lines).toEqual(["csv!2: ID=FR-1 | Titel=Login"]);
    expect(parse("ID\tTitel\nFR-1\tLogin\n").lines).toEqual(["csv!2: ID=FR-1 | Titel=Login"]);
  });

  it("keeps a comma file whose quoted text contains semicolons", () => {
    const parsed = parse('ID,Text\nFR-1,"a; b; c"\nFR-2,"d; e"\n');
    expect(parsed.lines).toEqual(["csv!2: ID=FR-1 | Text=a; b; c", "csv!3: ID=FR-2 | Text=d; e"]);
  });

  it("does not let delimiters inside quotes decide the delimiter", () => {
    expect(parse('"a;b","c;d"\n"1;2","3;4"\n').lines).toEqual(["csv!2: a;b=1;2 | c;d=3;4"]);
  });

  it("falls back to a comma for a single-column file", () => {
    expect(parse("Anforderung\nDer Nutzer muss sich anmelden.\n").lines).toEqual([
      "csv!2: Anforderung=Der Nutzer muss sich anmelden.",
    ]);
  });

  it("treats a .tsv file as tab separated even when the text holds semicolons", () => {
    const parsed = parse("ID\tText\nFR-1\ta; b\n", "tsv");
    expect(parsed.lines).toEqual(["tsv!2: ID=FR-1 | Text=a; b"]);
  });
});

describe("csv quoting", () => {
  it("reads a quoted field after a space as one field", () => {
    const parsed = parse('ID,Titel,Text\nFR-1, "x, y",z\n');
    expect(parsed.lines).toEqual(["csv!2: ID=FR-1 | Titel=x, y | Text=z"]);
  });

  it("ignores spaces between a closing quote and the delimiter", () => {
    const parsed = parse('ID,Titel,Text\nFR-1,"x"  ,z\n');
    expect(parsed.lines).toEqual(["csv!2: ID=FR-1 | Titel=x | Text=z"]);
  });

  it("reads an unterminated quote as a literal and keeps the following records", () => {
    const parsed = parse('ID,Titel\nFR-1,"offen\nFR-2,Logout\n');
    expect(parsed.lines).toEqual([
      'csv!2: ID=FR-1 | Titel="offen',
      "csv!3: ID=FR-2 | Titel=Logout",
    ]);
    expect(parsed.codes).toEqual(["TABLE_QUOTE_UNTERMINATED"]);
    expect(parsed.messages).toEqual(["unterminated quote read as literal: 1"]);
  });

  it("survives a file made only of quotes", () => {
    expect(() => parse('"""""""""\n""""\n"')).not.toThrow();
    expect(parse('"').lines).toEqual(['csv!1: Column 1="']);
  });
});

describe("csv table structure", () => {
  it("does not take a title line above the header for the header", () => {
    const parsed = parse("Anforderungskatalog\nID,Titel\nFR-1,Login\n");
    expect(parsed.lines).toEqual(["csv!1: Anforderungskatalog", "csv!3: ID=FR-1 | Titel=Login"]);
  });

  it("recognises a header written in another script", () => {
    expect(parse("Требование,Описание\nВход,Текст\n").lines).toEqual([
      "csv!2: Требование=Вход | Описание=Текст",
    ]);
  });

  it("omits empty cells and skips blank lines, numbering rows by record", () => {
    const parsed = parse("ID,Titel,Prio\n\nFR-1,,Muss\n");
    expect(parsed.lines).toEqual(["csv!3: ID=FR-1 | Prio=Muss"]);
    expect(parsed.rowIndexes).toEqual([2]);
  });

  it("emits a header-only file as a plain line", () => {
    const parsed = parse("ID,Titel,Prio\n");
    expect(parsed.lines).toEqual(["csv!1: ID | Titel | Prio"]);
    expect(parsed.rowIndexes).toEqual([0]);
  });

  it("labels extra cells of a ragged row by position", () => {
    expect(parse("ID,Titel\nFR-1,Login,extra\n").lines).toEqual([
      "csv!2: ID=FR-1 | Titel=Login | Column 3=extra",
    ]);
  });

  it("gives a second table its own labels", () => {
    const parsed = parse("ID,Titel\nFR-1,Login\n\nBegriff,Definition\nKonto,Ein Konto ist ...\n");
    expect(parsed.lines).toEqual([
      "csv!2: ID=FR-1 | Titel=Login",
      "csv!5: Begriff=Konto | Definition=Ein Konto ist ...",
    ]);
  });

  it("cannot be made to forge a cell by a value that contains the separator", () => {
    const parsed = parse("ID,Text\nFR-1,x | Priorität=Kann\n");
    expect(parsed.lines).toEqual(["csv!2: ID=FR-1 | Text=x ¦ Priorität=Kann"]);
  });

  it("strips a byte order mark and reads CRLF records", () => {
    expect(parse("﻿ID,Titel\r\nFR-1,Login\r\n").lines).toEqual(["csv!2: ID=FR-1 | Titel=Login"]);
  });

  it("returns nothing for an empty file", () => {
    expect(parse("").lines).toEqual([]);
    expect(parse("\n\n,,\n").lines).toEqual([]);
  });

  it("reports a truncated unit stream", () => {
    const parsed = parse("ID,Titel\nFR-1,a\nFR-2,b\nFR-3,c\n", "csv", 2);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.codes).toContain("UNIT_LIMIT_REACHED");
  });
});

describe("csv scale", () => {
  it("parses 60,000 records in linear time", () => {
    const rows = ["ID;Titel;Text"];
    for (let n = 1; n <= 60_000; n += 1)
      rows.push(`FR-${String(n)};Titel ${String(n)};"Text, mit Komma"`);
    const started = Date.now();
    const parsed = parse(rows.join("\n"), "csv", 100_000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(parsed.lines).toHaveLength(60_000);
    expect(parsed.lines[59_999]).toBe(
      "csv!60001: ID=FR-60000 | Titel=Titel 60000 | Text=Text, mit Komma",
    );
  });

  it("stays linear when every record opens an unterminated quote", () => {
    const rows = ["ID,Text"];
    for (let n = 1; n <= 20_000; n += 1) rows.push(`FR-${String(n)},"offen ${String(n)}`);
    const started = Date.now();
    const parsed = parse(rows.join("\n"), "csv", 100_000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(parsed.lines.length).toBeGreaterThan(0);
  });
});
