import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

import { buildParserOptions } from "./registry.js";
import { DOCX_SIMPLE, DOCX_WITH_PREAMBLE, selectionFromBytes } from "./parser-test-fixtures.js";
import { docxParser } from "./docx-parser.js";

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

function zipDocumentXml(xml: string): Uint8Array {
  const filename = Buffer.from("word/document.xml", "utf8");
  const raw = Buffer.from(xml, "utf8");
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

  const centralOffset = localHeader.byteLength + filename.byteLength + compressed.byteLength;
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

  const centralSize = centralHeader.byteLength + filename.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Uint8Array.from(
    Buffer.concat([localHeader, filename, compressed, centralHeader, filename, end]),
  );
}

function headingParagraphXml(text: string, level = 1): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${String(level)}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe("docxParser", () => {
  it("extracts heading-based sections from DOCX", async () => {
    const result = await docxParser.parseAsync(
      selectionFromBytes(DOCX_SIMPLE, {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions(),
    );
    expect(result.parser.parserId).toBe("docx");
    expect(result.parser.dependencyVersions).toEqual([{ packageName: "yauzl", version: "3.4.0" }]);
    expect(result.sections).toHaveLength(2);
    expect(result.units[0]).toMatchObject({
      kind: "section",
      sectionPath: ["Policy"],
    });
    expect(result.units[1]).toMatchObject({
      kind: "section",
      sectionPath: ["Policy", "Controls"],
    });
    expect("normalizedText" in result ? result.normalizedText : undefined).toContain("Policy");
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a root section for paragraphs before the first heading", async () => {
    const result = await docxParser.parseAsync(
      selectionFromBytes(DOCX_WITH_PREAMBLE, {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions(),
    );
    expect(result.units[0]).toMatchObject({
      kind: "section",
      sectionPath: [],
      characterStart: 0,
    });
    expect(result.units[1]).toMatchObject({
      kind: "section",
      sectionPath: ["Policy"],
    });
    expect("normalizedText" in result ? result.normalizedText : undefined).toContain(
      "Intro paragraph",
    );
  });

  it("reports malformed archives safely", async () => {
    const result = await docxParser.parseAsync(
      selectionFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions(),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
  });

  it("rejects inflated document.xml entries that exceed parser limits", async () => {
    const bomb = zipDocumentXml(`<w:document>${"A".repeat(65_536)}</w:document>`);
    const result = await docxParser.parseAsync(
      selectionFromBytes(bomb, {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions({ maxBytes: 4096 }),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
    expect(result.diagnostics[0]?.message).toBe(
      "docx parser rejected malformed or unsupported document",
    );
  });

  it("stops section emission at maxUnitsPerDocument", async () => {
    const xml = `<w:document>${Array.from({ length: 5 }, (_, index) =>
      headingParagraphXml(`Section ${String(index + 1)}`),
    ).join("")}</w:document>`;
    const result = await docxParser.parseAsync(
      selectionFromBytes(zipDocumentXml(xml), {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      buildParserOptions({ maxUnitsPerDocument: 2, now: () => 0 }),
    );
    expect(result.units).toHaveLength(2);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "UNIT_LIMIT_REACHED")).toBe(
      true,
    );
  });
});
