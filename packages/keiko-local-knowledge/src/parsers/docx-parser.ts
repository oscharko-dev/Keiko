import { Buffer } from "node:buffer";

import type {
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
  SectionRecord,
} from "@oscharko-dev/keiko-contracts";
import yauzl from "yauzl";

import { diagnostic, emptyResult, oversizeDiagnostic, shouldStop } from "./_internal.js";
import type {
  AsyncParserAdapter,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "docx";
const PARSER_VERSION = "1";
const DOCX_MEDIA =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isDocx(input: ParserSelectionInput): boolean {
  return (
    input.extension.toLowerCase() === "docx" || input.mediaType.toLowerCase() === DOCX_MEDIA
  );
}

function cancelled(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult {
  return emptyResult(capability, input.documentId, options, [
    diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info"),
  ]);
}

function syncFallback(capability: ParserCapability): ParserAdapter["parse"] {
  return (input, options) =>
    emptyResult(
      capability,
      input.documentId,
      options,
      [
        diagnostic(
          "UNSUPPORTED_FORMAT",
          "docx parser requires async caller; use parseAsync via discovery",
          input.documentId,
          "info",
        ),
      ],
      [{ kind: "unsupported-media", documentId: input.documentId, reason: "docx-async-required" }],
    );
}

function openZip(bytes: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, decodeStrings: true }, (error, zip) => {
      if (error !== null || zip === undefined) {
        reject(error ?? new Error("failed to open docx zip"));
        return;
      }
      resolve(zip);
    });
  });
}

function readEntryText(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(error ?? new Error("failed to open docx entry stream"));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    });
  });
}

async function readDocumentXml(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  try {
    return await new Promise<string>((resolve, reject) => {
      let done = false;
      zip.readEntry();
      zip.on("entry", async (entry) => {
        if (entry.fileName === "word/document.xml") {
          try {
            const xml = await readEntryText(zip, entry);
            done = true;
            resolve(xml);
          } catch (error) {
            reject(error);
          } finally {
            try {
              zip.close();
            } catch {}
          }
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => {
        if (!done) {
          reject(new Error("docx missing word/document.xml"));
        }
      });
      zip.on("error", reject);
    });
  } finally {
    try {
      zip.close();
    } catch {}
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

interface Paragraph {
  readonly text: string;
  readonly headingLevel?: number;
}

function headingLevelOf(paragraphXml: string): number | undefined {
  const match = paragraphXml.match(/<w:pStyle\b[^>]*w:val="Heading([1-6])"/i);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function paragraphText(paragraphXml: string): string {
  const withBreaks = paragraphXml
    .replaceAll(/<w:tab\s*\/>/gi, "\t")
    .replaceAll(/<w:br\s*\/>/gi, "\n")
    .replaceAll(/<w:cr\s*\/>/gi, "\n");
  const parts = Array.from(withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi))
    .map((match) => decodeXmlEntities(match[1] ?? ""))
    .filter((part) => part.length > 0);
  return parts.join("").trim();
}

function parseParagraphs(xml: string): readonly Paragraph[] {
  const out: Paragraph[] = [];
  for (const match of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gi)) {
    const paragraphXml = match[0] ?? "";
    const text = paragraphText(paragraphXml);
    if (text.length === 0) continue;
    const headingLevel = headingLevelOf(paragraphXml);
    out.push(headingLevel === undefined ? { text } : { text, headingLevel });
  }
  return out;
}

function buildSections(
  paragraphs: readonly Paragraph[],
  input: ParserSelectionInput,
): { readonly sections: readonly SectionRecord[]; readonly units: readonly ParsedUnit[] } {
  const stack: string[] = [];
  const paragraphStarts: number[] = [];
  const sections: SectionRecord[] = [];
  const units: ParsedUnit[] = [];
  let cursor = 0;

  for (const paragraph of paragraphs) {
    paragraphStarts.push(cursor);
    cursor += paragraph.text.length + 1;
  }

  const headings = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter((entry) => entry.paragraph.headingLevel !== undefined);

  if (headings.length === 0) {
    const end = Math.max(0, cursor - 1);
    return {
      sections: [
        { documentId: input.documentId, sectionPath: [], characterStart: 0, characterEnd: end },
      ],
      units: [
        {
          kind: "section",
          documentId: input.documentId,
          sectionPath: [],
          characterStart: 0,
          characterEnd: end,
        },
      ],
    };
  }

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const next = headings[i + 1];
    if (current === undefined) continue;
    const level = current.paragraph.headingLevel ?? 1;
    while (stack.length >= level) stack.pop();
    stack.push(current.paragraph.text);
    const start = paragraphStarts[current.index] ?? 0;
    const end =
      next === undefined ? Math.max(0, cursor - 1) : (paragraphStarts[next.index] ?? cursor);
    const sectionPath = [...stack];
    sections.push({
      documentId: input.documentId,
      sectionPath,
      characterStart: start,
      characterEnd: end,
    });
    units.push({
      kind: "section",
      documentId: input.documentId,
      sectionPath,
      characterStart: start,
      characterEnd: end,
    });
  }

  return { sections, units };
}

async function asyncParse(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): Promise<ParserResult> {
  if (input.bytes.byteLength > options.maxBytes) {
    return emptyResult(capability, input.documentId, options, [
      oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
    ]);
  }
  if (options.signal?.aborted === true) {
    return cancelled(capability, input, options);
  }

  const startedAt = options.now();
  try {
    const xml = await readDocumentXml(input.bytes);
    const limit = shouldStop(startedAt, options, 0);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      return emptyResult(capability, input.documentId, options, [
        diagnostic(limit.code, limit.message, input.documentId, "info"),
      ]);
    }
    const paragraphs = parseParagraphs(xml);
    if (paragraphs.length === 0) {
      return emptyResult(
        capability,
        input.documentId,
        options,
        [
          diagnostic(
            "UNSUPPORTED_FORMAT",
            "docx has no extractable text content",
            input.documentId,
            "info",
          ),
        ],
        [{ kind: "unsupported-media", documentId: input.documentId, reason: "docx-no-text" }],
      );
    }
    const { sections, units } = buildSections(paragraphs, input);
    return {
      documentId: input.documentId,
      parser: { parserId: capability.parserId, parserVersion: capability.parserVersion },
      pages: [],
      sections,
      units,
      diagnostics: [] satisfies ParserDiagnostic[],
      extractedAt: options.now(),
    };
  } catch (error) {
    return emptyResult(capability, input.documentId, options, [
      diagnostic(
        "MALFORMED_INPUT",
        error instanceof Error ? error.message : "failed to parse docx",
        input.documentId,
        "error",
      ),
    ]);
  }
}

const capability: ParserCapability = Object.freeze({
  parserId: PARSER_ID,
  parserVersion: PARSER_VERSION,
  matches: isDocx,
});

export const docxParser: AsyncParserAdapter = Object.freeze({
  capability,
  parse: syncFallback(capability),
  parseAsync: (input: ParserSelectionInput, options: ParserOptions) =>
    asyncParse(capability, input, options),
});
