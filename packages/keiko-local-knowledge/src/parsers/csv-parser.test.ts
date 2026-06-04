import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { csvParser } from "./csv-parser.js";
import {
  CSV_QUOTED,
  CSV_SIMPLE,
  TSV_SIMPLE,
  encode,
  selectionFromBytes,
  selectionFromText,
} from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

interface CsvRow {
  readonly tableName: string;
  readonly rowIndex: number;
  readonly span: string;
}

function rows(text: string, units: readonly ParsedUnit[]): readonly CsvRow[] {
  return units.map((unit) => {
    if (unit.kind !== "csv-row") throw new Error(`expected csv-row unit, got ${unit.kind}`);
    return {
      tableName: unit.tableName,
      rowIndex: unit.rowIndex,
      span: text.slice(unit.characterStart, unit.characterEnd),
    };
  });
}

describe("csvParser", () => {
  it("matches CSV by extension and media type", () => {
    expect(csvParser.capability.matches(selectionFromText("a,b", { extension: "csv" }))).toBe(true);
    expect(
      csvParser.capability.matches(
        selectionFromText("a,b", { extension: "", mediaType: "text/csv" }),
      ),
    ).toBe(true);
    expect(csvParser.capability.matches(selectionFromText("a,b", { extension: "tsv" }))).toBe(true);
    expect(csvParser.capability.matches(selectionFromText("a,b", { extension: "txt" }))).toBe(
      false,
    );
  });

  it("emits one unit per data row, skipping the header", () => {
    const result = csvParser.parse(
      selectionFromText(CSV_SIMPLE, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(CSV_SIMPLE, result.units);
    expect(parsed).toEqual([
      { tableName: "csv", rowIndex: 0, span: "1,2,3" },
      { tableName: "csv", rowIndex: 1, span: "4,5,6" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("preserves commas, quote escapes, and newlines inside quoted fields", () => {
    const result = csvParser.parse(
      selectionFromText(CSV_QUOTED, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(CSV_QUOTED, result.units);
    expect(parsed).toHaveLength(1);
    // The entire quoted block forms a single row, including the embedded `\n` inside the
    // third field.
    expect(parsed[0]?.span).toBe('"x,1","y""2","z\n3"');
    expect(parsed[0]?.rowIndex).toBe(0);
  });

  it("does not split on a comma inside a quoted field", () => {
    const text = 'a,b\n"x,y,z",2\n';
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(text, result.units);
    expect(parsed).toEqual([{ tableName: "csv", rowIndex: 0, span: '"x,y,z",2' }]);
  });

  it("handles CRLF row terminators", () => {
    const text = "a,b\r\n1,2\r\n3,4\r\n";
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(text, result.units);
    expect(parsed.map((r) => r.span)).toEqual(["1,2", "3,4"]);
  });

  it("treats a single-line CSV as both header and data row", () => {
    const text = "only,one,line";
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(text, result.units);
    expect(parsed).toEqual([{ tableName: "csv", rowIndex: 0, span: "only,one,line" }]);
  });

  it("emits TSV rows when extension is .tsv", () => {
    const result = csvParser.parse(
      selectionFromText(TSV_SIMPLE, { extension: "tsv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(TSV_SIMPLE, result.units);
    expect(parsed).toEqual([{ tableName: "tsv", rowIndex: 0, span: "1\t2\t3" }]);
  });

  it("does not emit a synthetic empty row for a trailing newline", () => {
    const text = "a,b\n1,2\n";
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(rows(text, result.units)).toHaveLength(1);
  });

  it("tolerates unterminated quoted fields by consuming to EOF", () => {
    const text = 'a,b\n"unterminated,row';
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    // We don't crash; the row span ends at EOF.
    expect(result.units.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses oversize CSV", () => {
    const big = encode("a,b\n" + "1,2\n".repeat(100));
    const result = csvParser.parse(
      selectionFromBytes(big, { extension: "csv" }),
      buildParserOptions({ now: () => 0, maxBytes: 10 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
  });

  it("truncates with UNIT_LIMIT_REACHED when there are more rows than allowed", () => {
    const text = "a,b\n1,2\n3,4\n5,6\n7,8\n";
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0, maxUnitsPerDocument: 2 }),
    );
    expect(result.units.length).toBeLessThanOrEqual(2);
    expect(result.diagnostics.some((d) => d.code === "UNIT_LIMIT_REACHED")).toBe(true);
  });

  it("emits PARSER_CANCELLED when the signal is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const result = csvParser.parse(
      selectionFromText(CSV_SIMPLE, { extension: "csv" }),
      buildParserOptions({ now: () => 0, signal: ac.signal }),
    );
    expect(result.diagnostics.some((d) => d.code === "PARSER_CANCELLED")).toBe(true);
  });

  it("does not double-quote-merge across separate fields", () => {
    // Two separate quoted fields, each containing a comma. The parser must not stitch them.
    const text = 'a,b\n"alpha,one","beta,two"';
    const result = csvParser.parse(
      selectionFromText(text, { extension: "csv" }),
      buildParserOptions({ now: () => 0 }),
    );
    const parsed = rows(text, result.units);
    expect(parsed).toEqual([{ tableName: "csv", rowIndex: 0, span: '"alpha,one","beta,two"' }]);
  });
});
