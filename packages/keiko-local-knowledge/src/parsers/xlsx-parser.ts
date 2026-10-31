import type { ParsedUnit, ParserDiagnostic, ParserResult } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";

import {
  decodeXmlEntities,
  diagnostic,
  emptyResult,
  objectLimitDiagnostic,
  oversizeDiagnostic,
  readAttribute,
  shouldStop,
} from "./_internal.js";
import {
  ooxmlEntryInflatedLimit,
  readOoxmlZipEntries,
  type OoxmlZipReadPlan,
} from "./ooxml-zip.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "xlsx";
const PARSER_VERSION = "1";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "yauzl", version: "3.4.0" }),
]);
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_XML_INFLATED_BYTES = 32 * 1024 * 1024;
const SHEET_ENTRY_PREFIX = "xl/worksheets/";
const XLSX_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS);

interface XlsxEntry {
  readonly name: string;
  readonly xml: string;
}

interface WorkbookSheet {
  readonly name: string;
  readonly entryName: string;
}

interface CellValue {
  readonly column: string;
  readonly columnIndex: number;
  readonly value: string;
}

interface SheetRow {
  readonly sheetName: string;
  readonly rowNumber: number;
  readonly cells: readonly CellValue[];
}

interface RowProjection {
  readonly sheetName: string;
  readonly rowNumber: number;
  readonly text: string;
}

// Exported (module-local only — not re-exported from the package barrel) so the S8786
// regression tests can build a minimal `XlsxStyles` value for `readSheetRows` directly.
export interface XlsxStyles {
  readonly cellFormatNumFmtIds: readonly number[];
  readonly customNumFmts: ReadonlyMap<number, string>;
}

function isXlsx(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  const media = input.mediaType.toLowerCase();
  return XLSX_EXTENSIONS.has(ext) || media === XLSX_MEDIA;
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
          "xlsx parser requires async caller; use parseAsync via discovery",
          input.documentId,
          "info",
        ),
      ],
      [{ kind: "unsupported-media", documentId: input.documentId, reason: "xlsx-async-required" }],
    );
}

function isRelevantEntry(name: string): boolean {
  return (
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    name === "xl/styles.xml" ||
    (name.startsWith(SHEET_ENTRY_PREFIX) && name.endsWith(".xml"))
  );
}

function xlsxZipPlan(options: ParserOptions): OoxmlZipReadPlan {
  return {
    format: "xlsx",
    isWanted: isRelevantEntry,
    maxEntryInflatedBytes: ooxmlEntryInflatedLimit(options.maxBytes, MAX_XML_INFLATED_BYTES),
    scanBudget: "none",
    duplicateParts: "replace",
  };
}

async function readRelevantEntries(
  bytes: Uint8Array,
  options: ParserOptions,
): Promise<readonly XlsxEntry[]> {
  const parts = await readOoxmlZipEntries(bytes, options, options.now(), xlsxZipPlan(options));
  return [...parts].map(([name, xml]) => ({ name, xml }));
}

// GRD-027: delegate to the shared decoder so cell text resolves numeric character references
// (smart quotes, accents) instead of surfacing literal `&#8217;`.
function decodeXml(value: string): string {
  return decodeXmlEntities(value);
}

// Delegates to the shared `readAttribute` (Epic #1855 promoted the single-tag attribute reader to
// `_internal.ts` so the HTML and XLSX parsers share one implementation instead of two regexes).
function attribute(tag: string, name: string): string | undefined {
  return readAttribute(tag, name);
}

function xmlTextContent(value: string): string {
  let out = "";
  let inTag = false;
  for (const char of value) {
    if (char === "<") {
      inTag = true;
      continue;
    }
    if (inTag) {
      if (char === ">") inTag = false;
      continue;
    }
    out += char;
  }
  return decodeXml(out);
}

// --- S8786-safe XML element scanning -----------------------------------------------------
//
// Every function below replaces a `/<tag\b[\s\S]*?<\/tag>/gi`-or-`/<tag\b[^>]*>/gi`-shaped
// regex that used to run directly over untrusted, attacker-sized XML (sharedStrings.xml,
// worksheet XML, styles.xml, relationship XML — each up to MAX_XML_INFLATED_BYTES / 32 MiB).
// That shape is catastrophic on adversarial input: `.exec()`/`.matchAll()` retries the search
// from every position where the open-tag literal occurs, and when the corresponding close
// token (a literal `</tag>`, or just `>`) never appears in the remainder, EACH of those
// attempts rescans all the way to the end of the string before failing — O(n) work at each of
// O(n) candidate positions, i.e. O(n^2) (confirmed: 256 KB of "<si " with no "</si>" took
// ~2.3s with clean ~4x-per-doubling scaling; the same shape reproduces for "<row ...>").
//
// A bounded quantifier cannot fix this without being lossy: this file's own 32 MiB ceiling
// means a single legitimate `<si>`/`<row>`/`<c>` element can be large, and truncating the
// scan would silently drop or corrupt real spreadsheet content. Instead these scan the input
// exactly once: each `indexOf` call starts where the previous one finished, so total work is
// O(n) regardless of how many unmatched "<tag" occurrences a hostile document contains. When a
// candidate's closing token genuinely does not exist anywhere in the remainder, the scan stops
// there rather than manufacturing an ever-growing "element" out of the rest of the document —
// which is also the only situation where a regex-based scan could not have found a further,
// later element either (a later element's own close token would have to live in that same,
// entirely-empty remainder).
// ASCII-only case fold: uppercase A-Z to lowercase, everything else (including any non-ASCII
// character) unchanged. XML tag/attribute names in an XLSX part are always ASCII, so matching
// them never needs `String#toLowerCase()`'s general Unicode case fold -- which is exactly what a
// prior version of this file got wrong. `xml.toLowerCase()` is not always length-preserving (e.g.
// "İ".toLowerCase() has length 2, not 1); once such a character appears anywhere in a shared
// string or cell value, indices found by searching that separately-lowercased copy no longer line
// up with the original `xml` they were later sliced from, silently corrupting every subsequent
// tag boundary. Scanning `xml` itself, one ASCII-folded character at a time, keeps a single set
// of indices that is always correct.
function asciiLowerChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x41 && code <= 0x5a ? String.fromCodePoint(code + 32) : ch;
}

// Finds the first case-insensitive occurrence of `needleLower` (already ASCII-lowercase) in
// `haystack`, starting at `fromIndex`. `needleLower.length` is always small and fixed (a literal
// tag name or `</tag>` token), so this is linear in `haystack.length` -- the same complexity
// class `String#indexOf` has, with no possibility of the backtracking this file's regex rewrite
// was already built to avoid (S8786).
function indexOfAsciiCaseInsensitive(
  haystack: string,
  needleLower: string,
  fromIndex: number,
): number {
  const needleLength = needleLower.length;
  const limit = haystack.length - needleLength;
  candidate: for (let index = Math.max(fromIndex, 0); index <= limit; index += 1) {
    for (let offset = 0; offset < needleLength; offset += 1) {
      if (asciiLowerChar(haystack.charAt(index + offset)) !== needleLower.charAt(offset)) {
        continue candidate;
      }
    }
    return index;
  }
  return -1;
}

function isTagNameContinuation(xml: string, index: number): boolean {
  const ch = xml.charAt(index);
  if (ch === "") return false;
  const lowerCh = asciiLowerChar(ch);
  return (lowerCh >= "a" && lowerCh <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
}

function findOpenTag(
  xml: string,
  tagNameLower: string,
  fromIndex: number,
): { readonly openIndex: number; readonly afterOpen: number } | undefined {
  const openNeedle = `<${tagNameLower}`;
  let cursor = fromIndex;
  while (cursor < xml.length) {
    const openIndex = indexOfAsciiCaseInsensitive(xml, openNeedle, cursor);
    if (openIndex === -1) return undefined;
    const afterOpen = openIndex + openNeedle.length;
    if (isTagNameContinuation(xml, afterOpen)) {
      cursor = openIndex + 1;
      continue;
    }
    return { openIndex, afterOpen };
  }
  return undefined;
}

// Replacement for `/<tag\b[\s\S]*?<\/tag>/gi`: yields each full `<tag ...>...</tag>` element
// (open tag through close tag, inclusive) in document order.
function* iterateXmlElements(xml: string, tagNameLower: string): Generator<string, void, unknown> {
  const closeNeedle = `</${tagNameLower}>`;
  let cursor = 0;
  for (;;) {
    const open = findOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) return;
    const closeIndex = indexOfAsciiCaseInsensitive(xml, closeNeedle, open.afterOpen);
    if (closeIndex === -1) return;
    const elementEnd = closeIndex + closeNeedle.length;
    yield xml.slice(open.openIndex, elementEnd);
    cursor = elementEnd;
  }
}

// Replacement for `/<tag\b[^>]*>([\s\S]*?)<\/tag>/gi`: yields each element's inner content
// (between the open tag's `>` and the matching `</tag>`) in document order.
function* iterateXmlElementContents(
  xml: string,
  tagNameLower: string,
): Generator<string, void, unknown> {
  const closeNeedle = `</${tagNameLower}>`;
  let cursor = 0;
  for (;;) {
    const open = findOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) return;
    const openTagEnd = xml.indexOf(">", open.afterOpen);
    if (openTagEnd === -1) return;
    const closeIndex = indexOfAsciiCaseInsensitive(xml, closeNeedle, openTagEnd + 1);
    if (closeIndex === -1) return;
    yield xml.slice(openTagEnd + 1, closeIndex);
    cursor = closeIndex + closeNeedle.length;
  }
}

// Replacement for `/<tag\b[^>]*>/gi`: yields each self-contained start/self-closing tag (no
// paired close tag required) in document order.
function* iterateXmlStartTags(xml: string, tagNameLower: string): Generator<string, void, unknown> {
  let cursor = 0;
  for (;;) {
    const open = findOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) return;
    const tagEnd = xml.indexOf(">", open.afterOpen);
    if (tagEnd === -1) return;
    yield xml.slice(open.openIndex, tagEnd + 1);
    cursor = tagEnd + 1;
  }
}

function firstXmlElement(xml: string, tagNameLower: string): string | undefined {
  return iterateXmlElements(xml, tagNameLower).next().value ?? undefined;
}

function firstXmlElementContent(xml: string, tagNameLower: string): string | undefined {
  return iterateXmlElementContents(xml, tagNameLower).next().value ?? undefined;
}

// Exported (module-local only — not re-exported from the package barrel) so the S8786
// regression below can call it directly with a crafted adversarial shared-strings XML instead
// of routing it through zip inflation, which would otherwise trip the compression-ratio guard
// before the vulnerable code path is even reached.
export function parseSharedStrings(
  xml: string,
  input: ParserSelectionInput,
  options: ParserOptions,
): {
  readonly strings: readonly string[];
  readonly diagnostics: readonly ParserDiagnostic[];
} {
  const strings: string[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const startedAt = options.now();
  for (const itemXml of iterateXmlElements(xml, "si")) {
    const limit = shouldStop(startedAt, options, strings.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    if (strings.length >= options.maxObjectsPerDocument) {
      diagnostics.push(objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument));
      break;
    }
    const parts = [...iterateXmlElementContents(itemXml, "t")].map((part) => decodeXml(part));
    strings.push(parts.length > 0 ? parts.join("") : xmlTextContent(itemXml));
  }
  return { strings, diagnostics };
}

function parseRelationships(xml: string): ReadonlyMap<string, string> {
  const rels = new Map<string, string>();
  for (const tag of iterateXmlStartTags(xml, "relationship")) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id === undefined || target === undefined) continue;
    rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//u, "")}`);
  }
  return rels;
}

function parseWorkbookSheets(
  workbookXml: string | undefined,
  relsXml: string | undefined,
  worksheetEntries: readonly XlsxEntry[],
): readonly WorkbookSheet[] {
  const rels = relsXml === undefined ? new Map<string, string>() : parseRelationships(relsXml);
  const sheets: WorkbookSheet[] = [];
  if (workbookXml !== undefined) {
    for (const tag of iterateXmlStartTags(workbookXml, "sheet")) {
      const name = attribute(tag, "name") ?? "Sheet";
      const relId = attribute(tag, "r:id");
      const entryName = relId === undefined ? undefined : rels.get(relId);
      if (entryName !== undefined) sheets.push({ name, entryName });
    }
  }
  if (sheets.length > 0) return sheets;
  return worksheetEntries
    .map((entry, index) => ({ name: `Sheet${String(index + 1)}`, entryName: entry.name }))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));
}

function columnName(ref: string | undefined, fallbackIndex: number): string {
  if (ref !== undefined) {
    const match = /^([A-Z]+)/iu.exec(ref);
    if (match?.[1] !== undefined) return match[1].toUpperCase();
  }
  let n = fallbackIndex + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCodePoint(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Exported (module-local only — not re-exported from the package barrel) so it can be unit
// tested directly with a supplementary-plane `ch` (see xlsx-parser.test.ts S7758 regression).
export function columnIndexFromName(column: string): number {
  let out = 0;
  for (const ch of column.toUpperCase()) {
    // `ch` comes from a `for...of` over a string, so it is already ONE Unicode code point —
    // 1 UTF-16 unit for a BMP letter, or a 2-unit surrogate pair for a supplementary-plane
    // character. `codePointAt(0)` reads that whole code point in either case; a lone/derived
    // surrogate value (0xD800-0xDFFF) and any real supplementary code point (>=0x10000) both
    // fall well outside the 0x41-0x5a ('A'-'Z') range checked below, so such a `ch` is always
    // (correctly) skipped rather than miscounted as a column letter.
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x41 || code > 0x5a) continue;
    out = out * 26 + (code - 0x40);
  }
  return Math.max(0, out - 1);
}

function rowNumber(rowTag: string, fallback: number): number {
  const raw = attribute(rowTag, "r");
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inlineStringValue(cellXml: string): string {
  const inline = firstXmlElement(cellXml, "is");
  if (inline === undefined) return "";
  return [...iterateXmlElementContents(inline, "t")].map((part) => decodeXml(part)).join("");
}

function rawCellValue(
  type: string | undefined,
  raw: string,
  sharedStrings: readonly string[],
): string {
  const decoded = decodeXml(raw);
  if (type !== "s") return decoded;
  const index = Number.parseInt(decoded, 10);
  return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
}

function formulaCellValue(cellXml: string): string {
  const formula = firstXmlElementContent(cellXml, "f");
  return formula === undefined ? "" : `=${decodeXml(formula)}`;
}

const BUILT_IN_DATE_NUM_FORMATS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 57,
]);

function parseStyles(xml: string | undefined): XlsxStyles {
  if (xml === undefined) return { cellFormatNumFmtIds: [], customNumFmts: new Map() };
  const customNumFmts = new Map<number, string>();
  for (const tag of iterateXmlStartTags(xml, "numfmt")) {
    const id = Number.parseInt(attribute(tag, "numFmtId") ?? "", 10);
    const format = attribute(tag, "formatCode");
    if (Number.isFinite(id) && format !== undefined) customNumFmts.set(id, format);
  }
  const cellXfsXml = firstXmlElementContent(xml, "cellxfs") ?? "";
  const cellFormatNumFmtIds: number[] = [];
  for (const tag of iterateXmlStartTags(cellXfsXml, "xf")) {
    const id = Number.parseInt(attribute(tag, "numFmtId") ?? "0", 10);
    cellFormatNumFmtIds.push(Number.isFinite(id) ? id : 0);
  }
  return { cellFormatNumFmtIds, customNumFmts };
}

function styleNumFmtId(styleIndex: string | undefined, styles: XlsxStyles): number | undefined {
  if (styleIndex === undefined) return undefined;
  const index = Number.parseInt(styleIndex, 10);
  if (!Number.isFinite(index) || index < 0) return undefined;
  return styles.cellFormatNumFmtIds[index];
}

function removeBracketedNumberFormatSections(value: string): string {
  const retained: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("[", cursor);
    if (open < 0) {
      retained.push(value.slice(cursor));
      break;
    }
    const close = value.indexOf("]", open + 1);
    if (close < 0) {
      retained.push(value.slice(cursor));
      break;
    }
    retained.push(value.slice(cursor, open));
    cursor = close + 1;
  }
  return retained.join("");
}

function isDateNumFmt(numFmtId: number | undefined, styles: XlsxStyles): boolean {
  if (numFmtId === undefined) return false;
  if (BUILT_IN_DATE_NUM_FORMATS.has(numFmtId)) return true;
  const custom = styles.customNumFmts.get(numFmtId);
  if (custom === undefined) return false;
  const stripped = removeBracketedNumberFormatSections(
    custom.replaceAll(/"[^"]*"/g, ""),
  ).replaceAll(/\\./g, "");
  return /[ymdhHs]/.test(stripped);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function excelSerialDate(serial: number): Date {
  const millis = Math.round(serial * 86_400_000);
  return new Date(Date.UTC(1899, 11, 30) + millis);
}

// eslint-disable-next-line complexity
function formatExcelDate(raw: string, numFmtId: number | undefined, styles: XlsxStyles): string {
  const serial = Number(raw);
  if (!Number.isFinite(serial)) return decodeXml(raw);
  const date = excelSerialDate(serial);
  const custom = numFmtId === undefined ? undefined : styles.customNumFmts.get(numFmtId);
  const wantsTime =
    numFmtId === 18 ||
    numFmtId === 19 ||
    numFmtId === 20 ||
    numFmtId === 21 ||
    numFmtId === 22 ||
    numFmtId === 45 ||
    numFmtId === 46 ||
    numFmtId === 47 ||
    (custom !== undefined && /[hHs]/.test(custom));
  const datePart = `${String(date.getUTCFullYear())}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}`;
  if (!wantsTime) return datePart;
  return `${datePart} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function cellValue(cellXml: string, sharedStrings: readonly string[], styles: XlsxStyles): string {
  const tag = /^<c\b[^>]*>/iu.exec(cellXml)?.[0] ?? "";
  const type = attribute(tag, "t");
  if (type === "inlineStr") return inlineStringValue(cellXml);
  const raw = firstXmlElementContent(cellXml, "v");
  if (raw !== undefined) {
    const numFmtId = styleNumFmtId(attribute(tag, "s"), styles);
    if (type === undefined && isDateNumFmt(numFmtId, styles)) {
      return formatExcelDate(raw, numFmtId, styles);
    }
    return rawCellValue(type, raw, sharedStrings);
  }
  return formulaCellValue(cellXml);
}

// Exported (module-local only — not re-exported from the package barrel) so the S8786
// regression below can call it directly with a crafted adversarial worksheet XML instead of
// routing it through zip inflation, which would otherwise trip the compression-ratio guard
// before the vulnerable code path is even reached.
export function readSheetRows(
  sheetName: string,
  xml: string,
  sharedStrings: readonly string[],
  styles: XlsxStyles,
): readonly SheetRow[] {
  const rows: SheetRow[] = [];
  let fallbackRow = 1;
  for (const rowXml of iterateXmlElements(xml, "row")) {
    const rowTag = /^<row\b[^>]*>/iu.exec(rowXml)?.[0] ?? "";
    const number = rowNumber(rowTag, fallbackRow);
    fallbackRow = number + 1;
    const cells: CellValue[] = [];
    let fallbackCol = 0;
    for (const cellXml of iterateXmlElements(rowXml, "c")) {
      const cellTag = /^<c\b[^>]*>/iu.exec(cellXml)?.[0] ?? "";
      const column = columnName(attribute(cellTag, "r"), fallbackCol);
      const value = cellValue(cellXml, sharedStrings, styles).trim();
      if (value.length === 0) {
        fallbackCol += 1;
        continue;
      }
      cells.push({ column, columnIndex: columnIndexFromName(column), value });
      fallbackCol += 1;
    }
    if (cells.length === 0) continue;
    rows.push({
      sheetName,
      rowNumber: number,
      cells,
    });
  }
  return rows;
}

function normalizeHeaderLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeSheetHeaders(headerCells: readonly CellValue[]): ReadonlyMap<number, string> {
  const headers = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const cell of headerCells) {
    const base = normalizeHeaderLabel(cell.value, `Column ${cell.column}`);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headers.set(cell.columnIndex, count === 0 ? base : `${base} ${String(count + 1)}`);
  }
  return headers;
}

function hasPlausibleHeader(rows: readonly SheetRow[]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first === undefined) return false;
  return first.cells.some((cell) => /[A-Za-z_ÄÖÜäöüß]/u.test(cell.value));
}

function projectSheetRows(rows: readonly SheetRow[]): readonly RowProjection[] {
  if (rows.length === 0) return [];
  const headerIsSchema = hasPlausibleHeader(rows);
  const headers: ReadonlyMap<number, string> = headerIsSchema
    ? normalizeSheetHeaders(rows[0]?.cells ?? [])
    : new Map<number, string>();
  const dataRows = headerIsSchema ? rows.slice(1) : rows;
  return dataRows.map((row) => {
    const cellsText = row.cells
      .map((cell) => {
        const headerLabel = headers.get(cell.columnIndex) ?? `Column ${cell.column}`;
        return `${headerLabel}=${cell.value}`;
      })
      .join(" | ");
    return {
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      text: `${row.sheetName}!${String(row.rowNumber)}: ${cellsText}\n`,
    };
  });
}

function emitUnits(
  rows: readonly RowProjection[],
  input: ParserSelectionInput,
  options: ParserOptions,
): {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly normalizedText: string;
} {
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const parts: string[] = [];
  let offset = 0;
  const startedAt = options.now();
  for (const row of rows) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    const start = offset;
    parts.push(row.text);
    offset += row.text.length;
    units.push({
      kind: "csv-row",
      documentId: input.documentId,
      tableName: row.sheetName,
      rowIndex: Math.max(0, row.rowNumber - 1),
      characterStart: start,
      characterEnd: offset,
    });
  }
  return { units, diagnostics, normalizedText: parts.join("") };
}

function parseWorkbook(
  entries: readonly XlsxEntry[],
  input: ParserSelectionInput,
  options: ParserOptions,
): InternalParserResult {
  const byName = new Map(entries.map((entry) => [entry.name, entry.xml] as const));
  const shared = byName.get("xl/sharedStrings.xml");
  const sharedResult =
    shared === undefined
      ? { strings: [], diagnostics: [] }
      : parseSharedStrings(shared, input, options);
  if (sharedResult.diagnostics.some((entry) => entry.severity === "error")) {
    return emptyResult(xlsxParser.capability, input.documentId, options, sharedResult.diagnostics);
  }
  const worksheetEntries = entries.filter((entry) => entry.name.startsWith(SHEET_ENTRY_PREFIX));
  const styles = parseStyles(byName.get("xl/styles.xml"));
  const workbookSheets = parseWorkbookSheets(
    byName.get("xl/workbook.xml"),
    byName.get("xl/_rels/workbook.xml.rels"),
    worksheetEntries,
  );
  const rows: RowProjection[] = [];
  for (const sheet of workbookSheets) {
    const xml = byName.get(sheet.entryName);
    if (xml === undefined) continue;
    rows.push(...projectSheetRows(readSheetRows(sheet.name, xml, sharedResult.strings, styles)));
    if (rows.length > options.maxObjectsPerDocument) {
      return emptyResult(xlsxParser.capability, input.documentId, options, [
        objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument),
      ]);
    }
  }
  const emitted = emitUnits(rows, input, options);
  return {
    ...emptyResult(
      xlsxParser.capability,
      input.documentId,
      options,
      [...sharedResult.diagnostics, ...emitted.diagnostics],
      emitted.units,
    ),
    normalizedText: emitted.normalizedText,
  };
}

export const xlsxParser: AsyncParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    dependencyVersions: DEPENDENCY_VERSIONS,
    matches: (input: ParserSelectionInput): boolean => isXlsx(input),
  }),
  parse: syncFallback({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    dependencyVersions: DEPENDENCY_VERSIONS,
    matches: (input: ParserSelectionInput): boolean => isXlsx(input),
  }),
  parseAsync: async (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(xlsxParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    if (options.signal?.aborted === true) {
      return cancelled(xlsxParser.capability, input, options);
    }
    try {
      const entries = await readRelevantEntries(input.bytes, options);
      return parseWorkbook(entries, input, options);
    } catch {
      return emptyResult(xlsxParser.capability, input.documentId, options, [
        diagnostic(
          "MALFORMED_INPUT",
          "xlsx parser rejected malformed or unsupported workbook",
          input.documentId,
          "error",
        ),
      ]);
    }
  },
});
