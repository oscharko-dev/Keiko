import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { buildCorpus, corpusChange } from "../testing/jira-chat-lab/requirements/corpus.mjs";
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

const WIN_ANSI_PUNCTUATION = { 0x84: "„", 0x93: "“", 0x94: "”", 0x95: "•", 0x97: "—" };

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
    expect(xlsx.get("xl/worksheets/sheet1.xml")).toContain('<autoFilter ref="A1:G42"/>');
    const strings = xlsx.get("xl/sharedStrings.xml");
    const headers = [
      "ID",
      "Titel",
      "Bereich",
      "Priorität",
      "Abnahmekriterien",
      "Anforderung",
      "Kapitel",
    ];
    for (const header of headers) {
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

  describe("one document in every format", () => {
    const unescape = (value) =>
      value
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&");
    const texts = (xml, tag) =>
      [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "gu"))].map((m) =>
        unescape(m[1]),
      );
    const record = (id, title) => ({
      id,
      title,
      priority: "",
      chapter: 0,
      text: "",
      acceptance: [],
    });

    /** Folds the typed lines of a rendering into requirement records; the shared reading rules. */
    function fold(lines) {
      const records = [];
      let chapter = 0;
      let current;
      for (const [kind, text] of lines) {
        if (kind === "chapter") {
          // Prose outside a requirement (starting position, scope) belongs to no record.
          chapter = Number(text);
          current = undefined;
        } else if (kind === "heading") {
          current = { ...record(text.slice(0, 6), text.slice(7)), chapter };
          records.push(current);
        } else if (current === undefined) continue;
        else if (kind === "priority") current.priority = text;
        else if (kind === "text") current.text = text;
        else current.acceptance.push(text);
      }
      return records;
    }

    function fromDocx(parts) {
      const xml = parts.get("word/document.xml");
      const lines = [
        ...xml.matchAll(
          /<w:p>(?:<w:pPr><w:pStyle w:val="(\w+)"\/><\/w:pPr>)?<w:r><w:t[^>]*>([^<]*)<\/w:t><\/w:r><\/w:p>/gu,
        ),
      ].map(([, style, raw]) => {
        const text = unescape(raw);
        if (style === "Heading1") return ["chapter", /^(\d+)\./u.exec(text)?.[1] ?? "0"];
        if (style === "Heading2") return ["heading", text];
        if (style === "ListBullet") return ["criterion", text];
        if (text.startsWith("Priorität: ")) return ["priority", text.slice(11, -1)];
        return text === "Abnahmekriterien:" || style ? ["skip", text] : ["text", text];
      });
      return fold(lines.filter(([kind]) => kind !== "skip"));
    }

    function fromXlsx(parts) {
      const strings = texts(parts.get("xl/sharedStrings.xml"), "t");
      const rows = [
        ...parts.get("xl/worksheets/sheet1.xml").matchAll(/<row [^>]*>(.*?)<\/row>/gsu),
      ];
      const table = rows.map(([, cells]) =>
        [...cells.matchAll(/<c r="([A-Z])\d+"[^>]*t="s"><v>(\d+)<\/v>/gu)].map(
          ([, column, index]) => [column, strings[Number(index)]],
        ),
      );
      return table.slice(1).map((cells) => {
        const byColumn = Object.fromEntries(cells);
        return {
          id: byColumn.A,
          title: byColumn.B,
          priority: byColumn.D,
          chapter: Number(byColumn.G),
          text: byColumn.F,
          acceptance: byColumn.E === "" ? [] : byColumn.E.split("\n"),
        };
      });
    }

    function fromPptx(parts) {
      const slides = [...parts.keys()]
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
        .sort((a, b) => Number(/(\d+)\.xml$/u.exec(a)[1]) - Number(/(\d+)\.xml$/u.exec(b)[1]));
      const lines = slides.slice(1).flatMap((name) =>
        texts(parts.get(name), "a:t")
          .slice(1)
          .map((text) => {
            if (/^LH-\d{3} /u.test(text)) return ["heading", text];
            const priority = /^Priorität: (\w+) · Kapitel (\d+)$/u.exec(text);
            if (priority) return ["slide-meta", `${priority[1]}|${priority[2]}`];
            if (text.startsWith("Anforderung: ")) return ["text", text.slice(13)];
            return ["criterion", text.replace(/^Abnahmekriterium: /u, "")];
          }),
      );
      const records = [];
      for (const [kind, text] of lines) {
        if (kind === "heading") records.push(record(text.slice(0, 6), text.slice(7)));
        else if (kind === "slide-meta") {
          [records.at(-1).priority, records.at(-1).chapter] = [
            text.split("|")[0],
            Number(text.split("|")[1]),
          ];
        } else if (kind === "text") records.at(-1).text = text;
        else records.at(-1).acceptance.push(text);
      }
      return records;
    }

    function fromPdf(buffer) {
      const lines = pdfText(buffer).split("\n");
      const blocks = [];
      for (const line of lines) {
        const starts = /^(\d+)\. /u.test(line) || /^LH-\d{3} /u.test(line);
        if (starts || blocks.length === 0) blocks.push([line]);
        else blocks.at(-1).push(line);
      }
      const typed = [];
      for (const [first, ...rest] of blocks) {
        const chapter = /^(\d+)\. /u.exec(first);
        if (chapter) typed.push(["chapter", chapter[1]]);
        else if (/^LH-\d{3} /u.test(first)) {
          typed.push(["heading", first], ...pdfBody(rest));
        }
      }
      return fold(typed);
    }

    function pdfBody(lines) {
      const body = lines.join(" ").replace(/\s+/gu, " ").trim();
      const priority = /Priorität: (\w+)\.$/u.exec(body);
      const [description, criteria = ""] = body
        .slice(0, priority.index)
        .split(" Abnahmekriterien: ");
      return [
        ["text", description.trim()],
        ...criteria
          .split("• ")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map((entry) => ["criterion", entry]),
        ["priority", priority[1]],
      ];
    }

    const byId = (records) => [...records].sort((a, b) => a.id.localeCompare(b.id));

    const expected = (version) =>
      buildCorpus(version).truth.map(({ id, title, priority, chapter, text, acceptance }) => ({
        id,
        title,
        priority,
        chapter,
        text,
        acceptance,
      }));

    function extractAll(version) {
      const [docx, xlsx, pptx, pdf] = writeCorpusDocuments(outputDirectory(), version).map((path) =>
        readFileSync(path),
      );
      return {
        docx: fromDocx(readZip(docx)),
        xlsx: fromXlsx(readZip(xlsx)),
        pptx: fromPptx(readZip(pptx)),
        pdf: fromPdf(pdf),
      };
    }

    it.each([1, 2])(
      "every format yields exactly the requirement records of the truth (version %i)",
      (version) => {
        const records = extractAll(version);
        for (const [format, extracted] of Object.entries(records)) {
          // Renderings group requirements by chapter, so a version 2 addition sits in its area.
          expect(byId(extracted), format).toEqual(byId(expected(version)));
        }
      },
    );

    it("every format shows the same version 1 to 2 change as the truth", () => {
      const first = extractAll(1);
      const second = extractAll(2);
      for (const format of Object.keys(first)) {
        const before = new Map(first[format].map((item) => [item.id, item]));
        const after = new Map(second[format].map((item) => [item.id, item]));
        const change = {
          changed: [...after.keys()]
            .filter((id) => before.has(id) && before.get(id).text !== after.get(id).text)
            .sort(),
          removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
          added: [...after.keys()].filter((id) => !before.has(id)).sort(),
        };
        expect(change, format).toEqual(corpusChange());
      }
    });

    it("keeps the seeded ambiguity and the version 2 edit in the spreadsheet and the slides", () => {
      const { xlsx, pptx } = extractAll(2);
      for (const records of [xlsx, pptx]) {
        const vague = records.find((item) => item.id === "LH-007");
        expect(vague.text).toContain("schnell und benutzerfreundlich");
        expect(records.find((item) => item.id === "LH-004").text).toContain("15 Minuten");
      }
    });
  });
});
