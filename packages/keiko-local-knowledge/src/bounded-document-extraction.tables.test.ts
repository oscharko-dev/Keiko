// Bounded extraction of tables and honest truncation (#4235).

import { describe, expect, it } from "vitest";

import {
  extractBoundedDocumentText,
  type BoundedDocumentExtractionOptions,
} from "./bounded-document-extraction.js";
import { encode } from "./parsers/parser-test-fixtures.js";

function options(
  overrides: Partial<BoundedDocumentExtractionOptions> = {},
): BoundedDocumentExtractionOptions {
  return {
    maxInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 32 * 1024,
    maxUnits: 5_000,
    timeoutMs: 5_000,
    now: () => 0,
    ...overrides,
  };
}

function csvRows(count: number): string {
  const rows = ["ID;Titel;Beschreibung"];
  for (let n = 1; n <= count; n += 1) rows.push(`FR-${String(n)};Titel ${String(n)};Beschreibung`);
  return rows.join("\n");
}

describe("CSV binding", () => {
  it("extracts a semicolon CSV by extension", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(2)), extension: "csv" },
      options(),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.format).toBe("csv");
    expect(result.text).toBe(
      "csv!2: ID=FR-1 | Titel=Titel 1 | Beschreibung=Beschreibung\ncsv!3: ID=FR-2 | Titel=Titel 2 | Beschreibung=Beschreibung\n",
    );
    expect(result.truncated).toBe(false);
  });

  it("extracts a CSV identified only by a parameterized media type", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(1)), extension: "", mediaType: "text/csv; charset=utf-8" },
      options(),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.format).toBe("csv");
    expect(result.text).toContain("ID=FR-1");
  });

  it("extracts a TSV", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode("ID\tTitel\nFR-1\tLogin\n"), extension: "tsv" },
      options(),
    );
    expect(result.text).toBe("tsv!2: ID=FR-1 | Titel=Login\n");
  });

  it("reports an empty CSV as empty", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode("\n,,\n"), extension: "csv" },
      options(),
    );
    expect(result.outcome).toBe("empty");
  });
});

describe("truncation is reported whenever content was dropped", () => {
  it("reports a unit limit of an HTML page", async () => {
    const page = `<html><body>${Array.from({ length: 50 }, (_v, n) => `<h2>Abschnitt ${String(n)}</h2><p>Text ${String(n)}</p>`).join("")}</body></html>`;
    const result = await extractBoundedDocumentText(
      { bytes: encode(page), extension: "html" },
      options({ maxUnits: 5 }),
    );
    expect(result.outcome).toBe("extracted");
    expect(result.diagnostics.some((entry) => entry.code === "UNIT_LIMIT_REACHED")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("reports a unit limit of a CSV", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(50)), extension: "csv" },
      options({ maxUnits: 5 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.text.split("\n").filter((line) => line.length > 0)).toHaveLength(5);
  });

  it("does not report truncation when the rows exactly fill the unit limit", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(5)), extension: "csv" },
      options({ maxUnits: 5 }),
    );
    expect(result.truncated).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports the output byte cap", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(50)), extension: "csv" },
      options({ maxOutputBytes: 200 }),
    );
    expect(result.truncated).toBe(true);
  });
});

describe("the output cap cuts at a row boundary", () => {
  it("ends the text with the last complete row", async () => {
    const full = await extractBoundedDocumentText(
      { bytes: encode(csvRows(50)), extension: "csv" },
      options(),
    );
    const rows = full.text.split("\n").filter((line) => line.length > 0);
    const cap = new TextEncoder().encode(`${rows.slice(0, 3).join("\n")}\n`).length + 10;
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(50)), extension: "csv" },
      options({ maxOutputBytes: cap }),
    );
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${rows.slice(0, 3).join("\n")}\n`);
    expect(result.extractedBytes).toBeLessThanOrEqual(cap);
  });

  it("falls back to the byte cut when the first row alone exceeds the cap", async () => {
    const result = await extractBoundedDocumentText(
      { bytes: encode(csvRows(3)), extension: "csv" },
      options({ maxOutputBytes: 20 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("csv!2: ID=FR-1 | Tit");
  });

  it("keeps a multi-line cell whole with its row", async () => {
    const bytes = encode('ID,Kriterien\nFR-1,"a\nb"\nFR-2,"c\nd"\n');
    const result = await extractBoundedDocumentText(
      { bytes, extension: "csv" },
      options({ maxOutputBytes: 32 }),
    );
    expect(result.text).toBe("csv!2: ID=FR-1 | Kriterien=a\nb\n");
    expect(result.truncated).toBe(true);
  });
});
