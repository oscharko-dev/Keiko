// Test-only builder for minimal, Excel-native workbooks (no openpyxl): every part is written
// by hand so a test controls self-closing cells, a missing `t`, merged cells, `styles.xml`,
// hidden sheets and the date system exactly as Excel stores them.

import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";

import { selectionFromBytes, zipTextEntries } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { ParserOptions } from "./types.js";
import { xlsxParser } from "./xlsx-parser.js";

export interface FixtureSheet {
  readonly name: string;
  // Raw `<worksheet>` XML. Use `sheetXml` for the common `<sheetData>` shape.
  readonly xml: string;
  readonly state?: "hidden" | "veryHidden";
}

export interface FixtureWorkbook {
  readonly sheets: readonly FixtureSheet[];
  // Raw `<sst>` XML; omitted -> no shared strings part.
  readonly sharedStrings?: string;
  // Raw `<styleSheet>` XML; omitted -> no styles part.
  readonly styles?: string;
  readonly date1904?: boolean;
}

const WORKSHEET_OPEN =
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

/** A `<worksheet>` with optional leading parts (`<cols>`), its rows and trailing parts. */
export function sheetXml(
  rows: string,
  parts: { readonly before?: string; readonly after?: string } = {},
): string {
  return `${WORKSHEET_OPEN}${parts.before ?? ""}<sheetData>${rows}</sheetData>${parts.after ?? ""}</worksheet>`;
}

/** `<row r="N">` with the given cell XML; extra attributes go in `attributes`. */
export function rowXml(rowNumber: number, cells: string, attributes = ""): string {
  return `<row r="${String(rowNumber)}"${attributes === "" ? "" : ` ${attributes}`}>${cells}</row>`;
}

/** An inline-string cell, the form that needs no shared-string table. */
export function inlineCell(ref: string, text: string, style?: number): string {
  const s = style === undefined ? "" : ` s="${String(style)}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/** A numeric cell exactly as Excel writes it: no `t` attribute. */
export function numberCell(ref: string, value: string, style?: number): string {
  const s = style === undefined ? "" : ` s="${String(style)}"`;
  return `<c r="${ref}"${s}><v>${value}</v></c>`;
}

/** Builds the workbook package bytes. */
export function buildWorkbook(workbook: FixtureWorkbook): Uint8Array {
  const sheetEntries = workbook.sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${String(index + 1)}.xml`,
    content: sheet.xml,
  }));
  const sheetTags = workbook.sheets
    .map((sheet, index) => {
      const state = sheet.state === undefined ? "" : ` state="${sheet.state}"`;
      return `<sheet name="${sheet.name}" sheetId="${String(index + 1)}"${state} r:id="rId${String(index + 1)}"/>`;
    })
    .join("");
  const rels = workbook.sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${String(index + 1)}" Type="worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
    )
    .join("");
  const properties = workbook.date1904 === true ? '<workbookPr date1904="1"/>' : "<workbookPr/>";
  return zipTextEntries([
    {
      name: "xl/workbook.xml",
      content: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${properties}<sheets>${sheetTags}</sheets></workbook>`,
    },
    { name: "xl/_rels/workbook.xml.rels", content: `<Relationships>${rels}</Relationships>` },
    ...(workbook.sharedStrings === undefined
      ? []
      : [{ name: "xl/sharedStrings.xml", content: workbook.sharedStrings }]),
    ...(workbook.styles === undefined ? [] : [{ name: "xl/styles.xml", content: workbook.styles }]),
    ...sheetEntries,
  ]);
}

/** A `<styleSheet>` whose cell formats (index = `s`) use the given number-format ids. */
export function stylesWith(
  cellFormatIds: readonly number[],
  customFormats: Readonly<Record<number, string>> = {},
): string {
  const custom = Object.entries(customFormats)
    .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`)
    .join("");
  const numFmts = custom === "" ? "" : `<numFmts count="1">${custom}</numFmts>`;
  const xfs = cellFormatIds.map((id) => `<xf numFmtId="${String(id)}"/>`).join("");
  return `<styleSheet>${numFmts}<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="${String(cellFormatIds.length)}">${xfs}</cellXfs></styleSheet>`;
}

export interface ParsedWorkbook {
  readonly text: string;
  readonly lines: readonly string[];
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

/** Runs the real xlsx adapter over the bytes. */
export async function parseWorkbook(
  bytes: Uint8Array,
  overrides: Partial<ParserOptions> = {},
): Promise<ParsedWorkbook> {
  const result = await xlsxParser.parseAsync(
    selectionFromBytes(bytes, { extension: "xlsx" }),
    buildParserOptions({ now: () => 0, ...overrides }),
  );
  const text = "normalizedText" in result ? (result.normalizedText as string) : "";
  return {
    text,
    lines: text.split("\n").filter((line) => line.length > 0),
    units: result.units,
    diagnostics: result.diagnostics,
  };
}
