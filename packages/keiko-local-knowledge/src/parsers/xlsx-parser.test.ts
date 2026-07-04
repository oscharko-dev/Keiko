import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { buildParserOptions } from "./registry.js";
import { selectionFromBytes, XLSX_SIMPLE } from "./parser-test-fixtures.js";
import { xlsxParser } from "./xlsx-parser.js";

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
});
