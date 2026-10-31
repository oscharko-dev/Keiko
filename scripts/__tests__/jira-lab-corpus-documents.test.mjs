import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { buildCorpus } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import { writeCorpusDocuments } from "../testing/jira-chat-lab/requirements/corpus-documents.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function outputDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-corpus-documents-"));
  directories.push(directory);
  return directory;
}

/** Independent minimal ZIP reader: walks the central directory and verifies every CRC. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const parts = new Map();
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const packedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const dataStart =
      local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(dataStart, dataStart + packedSize);
    const data = method === 8 ? inflateRawSync(packed) : packed;
    expect(data.length, name).toBe(size);
    expect(crc32(data), name).toBe(crc);
    parts.set(name, data.toString("utf8"));
    cursor += 46 + nameLength;
  }
  return parts;
}

const WIN_ANSI_PUNCTUATION = { 0x84: "„", 0x93: "“", 0x94: "”", 0x97: "—" };

function decodeWinAnsi(byte) {
  return WIN_ANSI_PUNCTUATION[byte] ?? String.fromCharCode(byte);
}

function pdfText(buffer) {
  const text = buffer.toString("latin1");
  const literals = [...text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/gu)].map((match) =>
    match[1].replace(/\\(\d{3}|.)/gu, (_, code) =>
      /^\d{3}$/u.test(code) ? decodeWinAnsi(Number.parseInt(code, 8)) : code,
    ),
  );
  return literals.join("\n");
}

const ids = (version) => buildCorpus(version).truth.map((item) => item.id);
const names = (paths) => paths.map((path) => path.split("/").at(-1));

describe("synthetic corpus Office documents", () => {
  it("writes the four formats next to the Markdown corpus name", () => {
    const paths = writeCorpusDocuments(outputDirectory(), 1);
    expect(names(paths)).toEqual([
      "Lastenheft-Schadenmeldung-v1.docx",
      "Anforderungsliste-Schadenmeldung-v1.xlsx",
      "Lenkungskreis-Schadenmeldung-v1.pptx",
      "Lastenheft-Schadenmeldung-v1.pdf",
    ]);
  });

  it.each([1, 2])("carries every requirement id in every format (version %i)", (version) => {
    const [docx, xlsx, pptx, pdf] = writeCorpusDocuments(outputDirectory(), version).map((path) =>
      readFileSync(path),
    );
    const word = readZip(docx).get("word/document.xml");
    const sheet = readZip(xlsx).get("xl/sharedStrings.xml");
    const slides = [...readZip(pptx)].filter(([name]) => name.startsWith("ppt/slides/slide"));
    const slideText = slides.map(([, xml]) => xml).join("");
    const pdfContent = pdfText(pdf);
    for (const id of ids(version)) {
      expect(word, id).toContain(id);
      expect(sheet, id).toContain(id);
      expect(slideText, id).toContain(id);
      expect(pdfContent, id).toContain(id);
    }
  });

  it("builds well-formed OOXML parts with the structure Office requires", () => {
    const [docx, xlsx, pptx] = writeCorpusDocuments(outputDirectory(), 1)
      .slice(0, 3)
      .map((path) => readZip(readFileSync(path)));
    expect(docx.get("[Content_Types].xml")).toContain("wordprocessingml.document.main+xml");
    expect(docx.get("word/document.xml")).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xlsx.get("xl/worksheets/sheet1.xml")).toContain('<autoFilter ref="A1:E42"/>');
    const strings = xlsx.get("xl/sharedStrings.xml");
    for (const header of ["ID", "Titel", "Bereich", "Priorität", "Abnahmekriterien"]) {
      expect(strings).toContain(`<t xml:space="preserve">${header}</t>`);
    }
    const slides = [...pptx.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    expect(slides).toHaveLength(9);
    expect(pptx.get("ppt/notesSlides/notesSlide2.xml")).toContain("Abnahmekriterien");
    const relationTargets = [
      ...pptx.get("ppt/_rels/presentation.xml.rels").matchAll(/Target="([^"]+)"/gu),
    ];
    for (const [, target] of relationTargets) expect(pptx.has(`ppt/${target}`), target).toBe(true);
  });

  it("writes a PDF with correct xref offsets and WinAnsi German text", () => {
    const [, , , pdf] = writeCorpusDocuments(outputDirectory(), 1).map((path) =>
      readFileSync(path),
    );
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF/u.exec(text)[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gmu)].map((m) =>
      Number(m[1]),
    );
    offsets.forEach((offset, index) => {
      expect(text.startsWith(`${index + 1} 0 obj\n`, offset)).toBe(true);
    });
    const content = pdfText(pdf);
    expect(content).toContain("Priorität: Muss.");
    expect(content).toContain("Gerätewechsel");
    expect(content).toContain("„Schadenmeldung Online“");
  });

  it("is byte-identical across runs and differs between versions", () => {
    const first = writeCorpusDocuments(outputDirectory(), 1).map((path) => readFileSync(path));
    const second = writeCorpusDocuments(outputDirectory(), 1).map((path) => readFileSync(path));
    const revised = writeCorpusDocuments(outputDirectory(), 2).map((path) => readFileSync(path));
    first.forEach((bytes, index) => {
      expect(bytes.equals(second[index])).toBe(true);
      expect(bytes.equals(revised[index])).toBe(false);
    });
  });
});
