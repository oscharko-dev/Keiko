import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { buildParserOptions } from "./registry.js";
import { selectionFromBytes, selectionFromText, XLSX_SIMPLE } from "./parser-test-fixtures.js";
import {
  columnIndexFromName,
  parseSharedStrings,
  readSheetRows,
  xlsxParser,
  type XlsxStyles,
} from "./xlsx-parser.js";

const EMPTY_STYLES: XlsxStyles = { cellFormatNumFmtIds: [], customNumFmts: new Map() };

interface ZipEntryFixture {
  readonly name: string;
  readonly content: string;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(entries: readonly ZipEntryFixture[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const filename = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(raw.byteLength, 22);
    localHeader.writeUInt16LE(filename.byteLength, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(raw.byteLength, 24);
    centralHeader.writeUInt16LE(filename.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, filename, compressed);
    centralParts.push(centralHeader, filename);
    localOffset += localHeader.byteLength + filename.byteLength + compressed.byteLength;
  }

  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Uint8Array.from(Buffer.concat([...localParts, ...centralParts, end]));
}

function workbookZip(extraEntries: readonly ZipEntryFixture[] = []): Uint8Array {
  return zipEntries([
    {
      name: "xl/workbook.xml",
      content:
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Controls" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: "xl/sharedStrings.xml",
      content:
        "<sst><si><t>Key</t></si><si><t>Value</t></si><si><t>Control-17</t></si><si><t>Encrypt backups</t></si></sst>",
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: [
        "<worksheet><sheetData>",
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" t="inlineStr"><is><t>Q4 &amp; audit</t></is></c></row>',
        "</sheetData></worksheet>",
      ].join(""),
    },
    ...extraEntries,
  ]);
}

describe("xlsxParser", () => {
  it("matches XLSX by extension and media type", () => {
    expect(
      xlsxParser.capability.matches(selectionFromBytes(new Uint8Array(), { extension: "xlsx" })),
    ).toBe(true);
    expect(
      xlsxParser.capability.matches(
        selectionFromBytes(new Uint8Array(), {
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ),
    ).toBe(true);
    expect(
      xlsxParser.capability.matches(selectionFromBytes(new Uint8Array(), { extension: "zip" })),
    ).toBe(false);
  });

  it("extracts worksheet rows with sheet and row lineage", async () => {
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(XLSX_SIMPLE, {
        extension: "xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      buildParserOptions(),
    );

    expect(result.parser.parserId).toBe("xlsx");
    expect(result.parser.dependencyVersions).toEqual([{ packageName: "yauzl", version: "3.4.0" }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({
      kind: "csv-row",
      tableName: "Controls",
      rowIndex: 1,
    });
    expect("normalizedText" in result ? result.normalizedText : undefined).toContain(
      "Controls!2: Key=Control-17 | Value=Encrypt backups | Column C=Q4 & audit",
    );
  });

  it("formats styled date serials instead of indexing raw Excel serial numbers", async () => {
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(
        workbookZip([
          {
            name: "xl/styles.xml",
            content:
              '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
          },
          {
            name: "xl/sharedStrings.xml",
            content: "<sst><si><t>Name</t></si><si><t>Due</t></si><si><t>Renewal</t></si></sst>",
          },
          {
            name: "xl/worksheets/sheet1.xml",
            content: [
              "<worksheet><sheetData>",
              '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
              '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45292</v></c></row>',
              "</sheetData></worksheet>",
            ].join(""),
          },
        ]),
        { extension: "xlsx" },
      ),
      buildParserOptions(),
    );

    const normalizedText = "normalizedText" in result ? result.normalizedText : "";
    expect(normalizedText).toContain("Name=Renewal | Due=2024-01-01");
    expect(normalizedText).not.toContain("45292");
  });

  it("drops incomplete raw XML tags from shared-string fallback text", async () => {
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(
        workbookZip([
          {
            name: "xl/sharedStrings.xml",
            content: "<sst><si>Safe value<script</si></sst>",
          },
          {
            name: "xl/worksheets/sheet1.xml",
            content:
              '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
          },
        ]),
        { extension: "xlsx" },
      ),
      buildParserOptions(),
    );

    const normalizedText = "normalizedText" in result ? result.normalizedText : "";
    expect(normalizedText).toContain("Safe value");
    expect(normalizedText).not.toContain("<script");
  });

  it("reports sync calls as unsupported because workbook parsing is async", () => {
    const result = xlsxParser.parse(
      selectionFromBytes(XLSX_SIMPLE, { extension: "xlsx" }),
      buildParserOptions(),
    );
    expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_FORMAT");
    expect(result.units[0]).toMatchObject({
      kind: "unsupported-media",
      reason: "xlsx-async-required",
    });
  });

  it("reports malformed archives safely", async () => {
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { extension: "xlsx" }),
      buildParserOptions(),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
  });

  it("rejects inflated XML entries that exceed parser limits", async () => {
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(
        workbookZip([{ name: "xl/worksheets/sheet2.xml", content: "A".repeat(65_536) }]),
        { extension: "xlsx" },
      ),
      buildParserOptions({ maxBytes: 4096 }),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
    expect(result.diagnostics[0]?.message).toBe(
      "xlsx parser rejected malformed or unsupported workbook",
    );
  });

  // Regression for typescript/javascript:S8786 (follow-up finding). `itemPattern` used to be
  // `/<si\b[\s\S]*?<\/si>/gi`: a lazy dot-all class searching for a literal `</si>` that an
  // unanchored `.exec()` loop retries from every "<si" occurrence in the document. When the
  // document contains many "<si " occurrences but no "</si>" at all, each of those retries
  // rescans all the way to the end of the (attacker-sized, up to 32 MiB) string before failing
  // — O(n) work at each of O(n) positions, i.e. O(n^2). 32,000 reps of "<si " with no closing
  // tag (128 KB) took well over half a second against the vulnerable pattern with clean
  // ~4x-per-doubling scaling; the indexOf-based scan keeps this linear.
  it("resolves an adversarial shared-strings document with no closing </si> in linear time", () => {
    const adversarialXml = "<sst>" + "<si ".repeat(32_000) + "</sst>";
    const input = selectionFromText("", { extension: "xlsx" });
    const options = buildParserOptions();

    const start = Date.now();
    const result = parseSharedStrings(adversarialXml, input, options);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(300);
    expect(result.strings).toEqual([]);
  });

  // Same S8786 follow-up finding, for the worksheet row splitter: `/<row\b[^>]*>[\s\S]*?<\/row>/gi`
  // has the identical shape and was independently measured at the same quadratic scaling for
  // "<row ..." with no "</row>" (497ms/1970ms at 80KB/160KB against the vulnerable pattern).
  it("resolves an adversarial worksheet document with no closing </row> in linear time", () => {
    const adversarialXml = "<sheetData>" + "<row ".repeat(32_000) + "</sheetData>";

    const start = Date.now();
    const result = readSheetRows("Sheet1", adversarialXml, [], EMPTY_STYLES);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(300);
    expect(result).toEqual([]);
  });

  // The same lazy-dot-all-then-literal-terminator shape was reused one level deeper for cell
  // splitting (`/<c\b[^>]*>[\s\S]*?<\/c>/gi`). A single legitimate, well-terminated `<row>` can
  // still carry a malicious cell payload (many "<c " occurrences, never closed) large enough to
  // reproduce the same O(n^2) blowup purely inside `readSheetRows`'s inner loop, even though the
  // outer row-splitting itself is fast.
  it("resolves a single row with an adversarial, never-closed cell payload in linear time", () => {
    const adversarialXml = `<row r="1">${"<c ".repeat(32_000)}</row>`;

    const start = Date.now();
    const result = readSheetRows("Sheet1", adversarialXml, [], EMPTY_STYLES);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(300);
    expect(result).toEqual([]);
  });

  it("still parses legitimate shared strings and rows unaffected by the linear rewrite", () => {
    const input = selectionFromText("", { extension: "xlsx" });
    const options = buildParserOptions();
    const sharedResult = parseSharedStrings(
      "<sst><si><t>Alpha</t></si><si><t>Bravo</t></si></sst>",
      input,
      options,
    );
    expect(sharedResult.strings).toEqual(["Alpha", "Bravo"]);

    const rows = readSheetRows(
      "Sheet1",
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Charlie</t></is></c></row>',
      [],
      EMPTY_STYLES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells).toEqual([{ column: "A", columnIndex: 0, value: "Charlie" }]);
  });
});

describe("columnIndexFromName", () => {
  // S7758 regression: the A-Z letter check is `charCodeAt` → `codePointAt` compared against a
  // fixed 0x41-0x5a range. `for...of` iterates a string by Unicode code point, so a
  // supplementary-plane character (e.g. an emoji) arrives as ONE loop item of 2 UTF-16 code
  // units; `codePointAt(0)` on it returns the combined code point (>=0x10000), which — like a
  // lone surrogate's charCodeAt value (0xD800-0xDFFF) — is always well outside 0x41-0x5a, so
  // it must be skipped exactly as if it were absent, never miscounted as a column letter.
  it("ignores a supplementary-plane character in a column ref instead of miscounting it as a letter", () => {
    expect(columnIndexFromName("😀B")).toBe(columnIndexFromName("B"));
    expect(columnIndexFromName("A😀B")).toBe(columnIndexFromName("AB"));
    expect(columnIndexFromName("😀")).toBe(0);
  });
});
