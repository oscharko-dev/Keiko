// Synthetic .docx builders for the docx parser tests. Every part is a literal string the test
// controls, zipped by the shared fixture zip writer - no binary blobs, no filesystem.

import { selectionFromBytes, zipTextEntries, type ZipTextEntry } from "./parser-test-fixtures.js";
import { docxParser } from "./docx-parser.js";
import { buildParserOptions } from "./registry.js";
import type { ParserOptions, ParserResult } from "./types.js";

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
].join(" ");

export interface DocxParts {
  readonly document: string;
  readonly styles?: string;
  readonly numbering?: string;
  readonly footnotes?: string;
  readonly endnotes?: string;
  readonly comments?: string;
}

export function runXml(text: string, properties = ""): string {
  const rPr = properties.length > 0 ? `<w:rPr>${properties}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

export interface ParagraphOptions {
  readonly style?: string;
  readonly numId?: string;
  readonly ilvl?: number;
  readonly outline?: number;
  readonly extra?: string;
}

function numPrXml(numId: string | undefined, ilvl: number | undefined): string {
  if (numId === undefined && ilvl === undefined) return "";
  const level = ilvl === undefined ? "" : `<w:ilvl w:val="${String(ilvl)}"/>`;
  const id = numId === undefined ? "" : `<w:numId w:val="${numId}"/>`;
  return `<w:numPr>${level}${id}</w:numPr>`;
}

export function paraXml(content: string, options: ParagraphOptions = {}): string {
  const numbering = numPrXml(options.numId, options.ilvl);
  const properties = [
    options.style === undefined ? "" : `<w:pStyle w:val="${options.style}"/>`,
    numbering,
    options.outline === undefined ? "" : `<w:outlineLvl w:val="${String(options.outline)}"/>`,
    options.extra ?? "",
  ].join("");
  const pPr = properties.length > 0 ? `<w:pPr>${properties}</w:pPr>` : "";
  return `<w:p>${pPr}${content}</w:p>`;
}

/** A paragraph of one plain run. */
export function textPara(text: string, options: ParagraphOptions = {}): string {
  return paraXml(runXml(text), options);
}

export function documentXml(...blocks: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NAMESPACES}><w:body>${blocks.join("")}</w:body></w:document>`;
}

export function cellXml(content: string, properties = ""): string {
  const tcPr = properties.length > 0 ? `<w:tcPr>${properties}</w:tcPr>` : "";
  return `<w:tc>${tcPr}${content}</w:tc>`;
}

export function textCell(text: string, properties = ""): string {
  return cellXml(textPara(text), properties);
}

export function rowXml(cells: readonly string[], properties = ""): string {
  const trPr = properties.length > 0 ? `<w:trPr>${properties}</w:trPr>` : "";
  return `<w:tr>${trPr}${cells.join("")}</w:tr>`;
}

export function tableXml(...rows: readonly string[]): string {
  return `<w:tbl><w:tblPr/><w:tblGrid/>${rows.join("")}</w:tbl>`;
}

/** A table of plain text rows. */
export function plainTable(rows: readonly (readonly string[])[], header = false): string {
  return tableXml(
    ...rows.map((cells, index) =>
      rowXml(
        cells.map((cell) => textCell(cell)),
        header && index === 0 ? "<w:tblHeader/>" : "",
      ),
    ),
  );
}

export interface StyleOptions {
  readonly name?: string;
  readonly basedOn?: string;
  readonly outline?: number;
  readonly numId?: string;
  readonly ilvl?: number;
  readonly type?: string;
}

export function styleXml(id: string, options: StyleOptions = {}): string {
  const numbering = options.numId === undefined ? "" : numPrXml(options.numId, options.ilvl);
  const outline =
    options.outline === undefined ? "" : `<w:outlineLvl w:val="${String(options.outline)}"/>`;
  const pPr = numbering + outline;
  return [
    `<w:style w:type="${options.type ?? "paragraph"}" w:styleId="${id}">`,
    options.name === undefined ? "" : `<w:name w:val="${options.name}"/>`,
    options.basedOn === undefined ? "" : `<w:basedOn w:val="${options.basedOn}"/>`,
    pPr.length > 0 ? `<w:pPr>${pPr}</w:pPr>` : "",
    "</w:style>",
  ].join("");
}

export function stylesXml(...styles: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NAMESPACES}><w:docDefaults/>${styles.join("")}</w:styles>`;
}

export interface LevelOptions {
  readonly format: string;
  readonly text: string;
  readonly start?: number;
  readonly style?: string;
}

export function levelXml(ilvl: number, options: LevelOptions): string {
  return [
    `<w:lvl w:ilvl="${String(ilvl)}">`,
    `<w:start w:val="${String(options.start ?? 1)}"/>`,
    `<w:numFmt w:val="${options.format}"/>`,
    options.style === undefined ? "" : `<w:pStyle w:val="${options.style}"/>`,
    `<w:lvlText w:val="${options.text}"/>`,
    "</w:lvl>",
  ].join("");
}

export function abstractNumXml(id: string, levels: readonly string[], extra = ""): string {
  return `<w:abstractNum w:abstractNumId="${id}">${extra}${levels.join("")}</w:abstractNum>`;
}

export function numXml(id: string, abstractId: string, overrides = ""): string {
  return `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>${overrides}</w:num>`;
}

export function numberingXml(...parts: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${NAMESPACES}>${parts.join("")}</w:numbering>`;
}

export function notesXml(
  kind: "footnote" | "endnote",
  notes: readonly { readonly id: string; readonly text: string; readonly type?: string }[],
): string {
  const body = notes
    .map((note) => {
      const type = note.type === undefined ? "" : ` w:type="${note.type}"`;
      return `<w:${kind} w:id="${note.id}"${type}>${textPara(note.text)}</w:${kind}>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><w:${kind}s ${NAMESPACES}>${body}</w:${kind}s>`;
}

export function buildDocx(parts: DocxParts): Uint8Array {
  const entries: ZipTextEntry[] = [{ name: "word/document.xml", content: parts.document }];
  const optional: readonly (readonly [string, string | undefined])[] = [
    ["word/styles.xml", parts.styles],
    ["word/numbering.xml", parts.numbering],
    ["word/footnotes.xml", parts.footnotes],
    ["word/endnotes.xml", parts.endnotes],
    ["word/comments.xml", parts.comments],
  ];
  for (const [name, content] of optional) {
    if (content !== undefined) entries.push({ name, content });
  }
  return zipTextEntries(entries);
}

export async function parseDocx(
  parts: DocxParts | Uint8Array,
  overrides: Partial<ParserOptions> = {},
): Promise<ParserResult> {
  const bytes = parts instanceof Uint8Array ? parts : buildDocx(parts);
  return docxParser.parseAsync(
    selectionFromBytes(bytes, { extension: "docx" }),
    buildParserOptions({ now: () => 0, ...overrides }),
  );
}

export function textOf(result: ParserResult): string {
  return "normalizedText" in result && typeof result.normalizedText === "string"
    ? result.normalizedText
    : "";
}

export function linesOf(result: ParserResult): readonly string[] {
  const text = textOf(result);
  return text.length === 0 ? [] : text.split("\n");
}

export function pathsOf(result: ParserResult): readonly string[] {
  return result.sections.map((section) => section.sectionPath.join(" > "));
}
