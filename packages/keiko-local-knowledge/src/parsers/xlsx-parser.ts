import type { ParserDiagnostic, ParserResult } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";

import {
  decodeXmlEntities,
  diagnostic,
  emptyResult,
  encryptedOoxmlRefusal,
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
import { emitProjectedLines, projectTable, type ProjectedLine } from "./tabular.js";
import {
  applyMergedCells,
  type MergeCell,
  type MergeRange,
  type MergeRow,
} from "./xlsx-merged-cells.js";
import { formatNumericCell } from "./xlsx-number-format.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserAdapter,
  ParserCapability,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "xlsx";
const PARSER_VERSION = "2";
const DEPENDENCY_VERSIONS = Object.freeze([
  Object.freeze({ packageName: "yauzl", version: "3.4.0" }),
]);
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_XML_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 256 * 1024 * 1024;
const SHEET_ENTRY_PREFIX = "xl/worksheets/";
const XLSX_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS);

interface XlsxEntry {
  readonly name: string;
  readonly xml: string;
}

interface WorkbookSheet {
  readonly name: string;
  readonly entryName: string;
  readonly hidden: boolean;
}

interface WorkbookInfo {
  readonly sheets: readonly WorkbookSheet[];
  readonly date1904: boolean;
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

// Exported (module-local only — not re-exported from the package barrel) so the S8786
// regression tests can build a minimal `XlsxStyles` value for `readSheetRows` directly.
export interface XlsxStyles {
  readonly cellFormatNumFmtIds: readonly number[];
  readonly customNumFmts: ReadonlyMap<number, string>;
}

interface CellContext {
  readonly sharedStrings: readonly string[];
  readonly styles: XlsxStyles;
  readonly date1904: boolean;
}

interface SheetReadResult {
  readonly rows: readonly SheetRow[];
  readonly hiddenRowCount: number;
  readonly hiddenColumnCount: number;
  readonly uncachedFormulaCount: number;
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
    // Every wanted part is held as text; without a ceiling on all of them a workbook of many sheets
    // each just under the ceiling of one part is read into memory in full.
    maxTotalInflatedBytes: ooxmlEntryInflatedLimit(options.maxBytes, MAX_TOTAL_INFLATED_BYTES),
    scanBudget: "none",
    duplicateParts: "replace",
  };
}

const SPREADSHEET_NAMESPACES: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
  "http://schemas.openxmlformats.org/package/2006/relationships",
]);
const NAMESPACE_DECLARATION = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;

// The start tag of the root element: the first tag that is no declaration, comment or doctype.
function rootStartTag(xml: string): string {
  let cursor = 0;
  for (;;) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) return "";
    const next = xml.charAt(open + 1);
    if (next !== "?" && next !== "!") {
      const end = findTagEnd(xml, open + 1);
      return end === -1 ? "" : xml.slice(open, end + 1);
    }
    cursor = open + 1;
  }
}

// Writers such as the Open XML SDK samples bind the spreadsheet namespace to a prefix
// (`<x:row><x:c>`). The scanners below match element names as the default namespace writes them,
// so the prefix is removed once, here; elements of other namespaces keep theirs.
function withoutSpreadsheetPrefix(xml: string): string {
  let out = xml;
  for (const declaration of rootStartTag(xml).matchAll(NAMESPACE_DECLARATION)) {
    const [, prefix, doubleQuoted, singleQuoted] = declaration;
    const namespace = doubleQuoted ?? singleQuoted;
    if (prefix === undefined || namespace === undefined) continue;
    if (!SPREADSHEET_NAMESPACES.has(namespace)) continue;
    out = out.replaceAll(`<${prefix}:`, "<").replaceAll(`</${prefix}:`, "</");
  }
  return out;
}

async function readRelevantEntries(
  bytes: Uint8Array,
  options: ParserOptions,
): Promise<readonly XlsxEntry[]> {
  const parts = await readOoxmlZipEntries(bytes, options, options.now(), xlsxZipPlan(options));
  return [...parts].map(([name, xml]) => ({ name, xml: withoutSpreadsheetPrefix(xml) }));
}

// GRD-027: delegate to the shared decoder so cell text resolves numeric character references
// (smart quotes, accents) instead of surfacing literal `&#8217;`.
function decodeXml(value: string): string {
  return decodeXmlEntities(value);
}

// ST_Xstring escapes a character XML cannot carry as `_xHHHH_` (`_x000D_` for a carriage return).
// One pass: `_x005F_` decodes to a literal underscore and what follows it is never decoded again,
// so `_x005F_x000D_` stays the text `_x000D_`.
function decodeXstring(value: string): string {
  return value.replaceAll(/_x([0-9A-Fa-f]{4})_/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodeText(value: string): string {
  return decodeXstring(decodeXml(value));
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
  return decodeText(out);
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
// candidate's tag end or closing token genuinely does not exist anywhere in the remainder, the
// scan stops there rather than manufacturing an ever-growing "element" out of the rest of the
// document.
//
// An element is either paired (`<c ...>...</c>`) or self-closing (`<c .../>`). Excel writes an
// empty cell, an empty shared string, an empty row and a shared formula as the self-closing
// form; treating it as paired made the element swallow its next sibling (#4235).
//
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

// The `>` that ends the tag whose attributes start at `fromIndex`, skipping a `>` inside a quoted
// attribute value; -1 when the tag never ends.
function findTagEnd(xml: string, fromIndex: number): number {
  let quote = "";
  for (let index = fromIndex; index < xml.length; index += 1) {
    const ch = xml.charAt(index);
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return index;
    }
  }
  return -1;
}

interface OpenTag {
  readonly openIndex: number;
  readonly tagEnd: number;
  readonly selfClosing: boolean;
}

function readOpenTag(xml: string, tagNameLower: string, fromIndex: number): OpenTag | undefined {
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
    const tagEnd = findTagEnd(xml, afterOpen);
    if (tagEnd === -1) return undefined;
    return { openIndex, tagEnd, selfClosing: xml.charAt(tagEnd - 1) === "/" };
  }
  return undefined;
}

// Replacement for `/<tag\b[\s\S]*?<\/tag>/gi`: yields each full `<tag ...>...</tag>` element
// (open tag through close tag, inclusive) or self-closing `<tag .../>` in document order.
function* iterateXmlElements(xml: string, tagNameLower: string): Generator<string, void, unknown> {
  const closeNeedle = `</${tagNameLower}>`;
  let cursor = 0;
  for (;;) {
    const open = readOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) return;
    if (open.selfClosing) {
      yield xml.slice(open.openIndex, open.tagEnd + 1);
      cursor = open.tagEnd + 1;
      continue;
    }
    const closeIndex = indexOfAsciiCaseInsensitive(xml, closeNeedle, open.tagEnd + 1);
    if (closeIndex === -1) return;
    const elementEnd = closeIndex + closeNeedle.length;
    yield xml.slice(open.openIndex, elementEnd);
    cursor = elementEnd;
  }
}

// Replacement for `/<tag\b[^>]*>([\s\S]*?)<\/tag>/gi`: yields each element's inner content
// (between the open tag's `>` and the matching `</tag>`; empty for a self-closing element).
function* iterateXmlElementContents(
  xml: string,
  tagNameLower: string,
): Generator<string, void, unknown> {
  const closeNeedle = `</${tagNameLower}>`;
  let cursor = 0;
  for (;;) {
    const open = readOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) return;
    if (open.selfClosing) {
      yield "";
      cursor = open.tagEnd + 1;
      continue;
    }
    const closeIndex = indexOfAsciiCaseInsensitive(xml, closeNeedle, open.tagEnd + 1);
    if (closeIndex === -1) return;
    yield xml.slice(open.tagEnd + 1, closeIndex);
    cursor = closeIndex + closeNeedle.length;
  }
}

// Replacement for `/<tag\b[^>]*>/gi`: yields each self-contained start/self-closing tag (no
// paired close tag required) in document order.
function* iterateXmlStartTags(xml: string, tagNameLower: string): Generator<string, void, unknown> {
  let cursor = 0;
  for (;;) {
    const open = readOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) return;
    yield xml.slice(open.openIndex, open.tagEnd + 1);
    cursor = open.tagEnd + 1;
  }
}

// The element text without every `<tag>` element (paired or self-closing) of that name.
function withoutXmlElements(xml: string, tagNameLower: string): string {
  const closeNeedle = `</${tagNameLower}>`;
  const kept: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = readOpenTag(xml, tagNameLower, cursor);
    if (open === undefined) break;
    kept.push(xml.slice(cursor, open.openIndex));
    if (open.selfClosing) {
      cursor = open.tagEnd + 1;
      continue;
    }
    const closeIndex = indexOfAsciiCaseInsensitive(xml, closeNeedle, open.tagEnd + 1);
    cursor = closeIndex === -1 ? xml.length : closeIndex + closeNeedle.length;
  }
  kept.push(xml.slice(cursor));
  return kept.join("");
}

function firstXmlElement(xml: string, tagNameLower: string): string | undefined {
  return iterateXmlElements(xml, tagNameLower).next().value ?? undefined;
}

function firstXmlElementContent(xml: string, tagNameLower: string): string | undefined {
  return iterateXmlElementContents(xml, tagNameLower).next().value ?? undefined;
}

// The text of a rich-text container (`<si>`, `<is>`): its `<t>` runs, without the phonetic guide
// (`<rPh>`, furigana) a viewer shows above the text and not as part of it.
function richTextParts(xml: string): readonly string[] {
  return [...iterateXmlElementContents(withoutXmlElements(xml, "rph"), "t")].map((part) =>
    decodeText(part),
  );
}

// The opening tag of an element string, e.g. `<c r="A1" t="s">`.
function leadingTag(elementXml: string): string {
  const end = findTagEnd(elementXml, 0);
  return end === -1 ? elementXml : elementXml.slice(0, end + 1);
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
    // The table is a lookup, not a unit: cells address it by index, so cutting it at the unit limit
    // blanks every later cell. Only the deadline and the caller's abort stop it, and the object
    // limit below; the part itself is bounded by its inflated size.
    const limit = shouldStop(startedAt, options, 0);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    if (strings.length >= options.maxObjectsPerDocument) {
      diagnostics.push(objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument));
      break;
    }
    const parts = richTextParts(itemXml);
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

function isTrue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function parseWorkbookInfo(
  workbookXml: string | undefined,
  relsXml: string | undefined,
  worksheetEntries: readonly XlsxEntry[],
): WorkbookInfo {
  const rels = relsXml === undefined ? new Map<string, string>() : parseRelationships(relsXml);
  const sheets: WorkbookSheet[] = [];
  let date1904 = false;
  if (workbookXml !== undefined) {
    const properties = firstXmlElement(workbookXml, "workbookpr");
    date1904 = properties !== undefined && isTrue(attribute(properties, "date1904"));
    for (const tag of iterateXmlStartTags(workbookXml, "sheet")) {
      const name = attribute(tag, "name") ?? "Sheet";
      const relId = attribute(tag, "r:id");
      const entryName = relId === undefined ? undefined : rels.get(relId);
      const state = attribute(tag, "state");
      if (entryName !== undefined) {
        sheets.push({ name, entryName, hidden: state === "hidden" || state === "veryHidden" });
      }
    }
  }
  if (sheets.length > 0) return { sheets, date1904 };
  return {
    date1904,
    sheets: worksheetEntries
      .map((entry, index) => ({
        name: `Sheet${String(index + 1)}`,
        entryName: entry.name,
        hidden: false,
      }))
      .sort((a, b) => a.entryName.localeCompare(b.entryName)),
  };
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCodePoint(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function columnName(ref: string | undefined, fallbackIndex: number): string {
  if (ref !== undefined) {
    const match = /^([A-Z]+)/iu.exec(ref);
    if (match?.[1] !== undefined) return match[1].toUpperCase();
  }
  return columnLetters(fallbackIndex);
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

function rawCellValue(
  type: string | undefined,
  raw: string,
  sharedStrings: readonly string[],
): string {
  const decoded = decodeText(raw);
  if (type !== "s") return decoded;
  const index = Number.parseInt(decoded, 10);
  return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
}

// Only the workbook's own list: a differential style (`<dxf>`, conditional formatting) carries
// number formats whose ids may repeat the workbook's, and the cell styles do not refer to them.
function parseCustomNumFmts(xml: string): ReadonlyMap<number, string> {
  const customNumFmts = new Map<number, string>();
  const numFmtsXml = firstXmlElementContent(xml, "numfmts") ?? "";
  for (const tag of iterateXmlStartTags(numFmtsXml, "numfmt")) {
    const id = Number.parseInt(attribute(tag, "numFmtId") ?? "", 10);
    const format = attribute(tag, "formatCode");
    if (Number.isFinite(id) && format !== undefined) customNumFmts.set(id, format);
  }
  return customNumFmts;
}

function parseStyles(xml: string | undefined): XlsxStyles {
  if (xml === undefined) return { cellFormatNumFmtIds: [], customNumFmts: new Map() };
  const customNumFmts = parseCustomNumFmts(xml);
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

interface CellRead {
  readonly value: string;
  // A formula cell whose workbook stored no result: its displayed value is unknown.
  readonly uncachedFormula: boolean;
}

function typedCellValue(
  type: string | undefined,
  raw: string,
  tag: string,
  context: CellContext,
): string {
  if (type === "b") return /^(?:0|false)$/iu.test(raw.trim()) ? "FALSE" : "TRUE";
  if (type !== undefined && type !== "n") return rawCellValue(type, raw, context.sharedStrings);
  return formatNumericCell({
    raw: decodeText(raw),
    numFmtId: styleNumFmtId(attribute(tag, "s"), context.styles),
    customNumFmts: context.styles.customNumFmts,
    date1904: context.date1904,
  });
}

function readCell(cellXml: string, context: CellContext): CellRead {
  const tag = leadingTag(cellXml);
  const type = attribute(tag, "t");
  if (type === "inlineStr") {
    const inline = firstXmlElement(cellXml, "is");
    return {
      value: inline === undefined ? "" : richTextParts(inline).join(""),
      uncachedFormula: false,
    };
  }
  const raw = firstXmlElementContent(cellXml, "v");
  if (raw !== undefined) {
    return { value: typedCellValue(type, raw, tag, context), uncachedFormula: false };
  }
  return { value: "", uncachedFormula: firstXmlElementContent(cellXml, "f") !== undefined };
}

// ─── Merged cells ──────────────────────────────────────────────────────────────

function parseMergeRanges(xml: string): readonly MergeRange[] {
  const ranges: MergeRange[] = [];
  for (const tag of iterateXmlStartTags(xml, "mergecell")) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/iu.exec(attribute(tag, "ref") ?? "");
    if (match === null) continue;
    const [, firstCol = "", firstRow = "", lastCol = "", lastRow = ""] = match;
    ranges.push({
      firstRow: Number.parseInt(firstRow, 10),
      lastRow: Number.parseInt(lastRow, 10),
      firstColumn: columnIndexFromName(firstCol),
      lastColumn: columnIndexFromName(lastCol),
    });
  }
  return ranges;
}

interface MutableCell extends MergeCell {
  readonly column: string;
}

interface MutableRow extends MergeRow<MutableCell> {
  readonly hidden: boolean;
}

function mutableCell(columnIndex: number, value: string): MutableCell {
  return { column: columnLetters(columnIndex), columnIndex, value };
}

// ─── Hidden columns ─────────────────────────────────────────────────────────────

function hiddenColumnRanges(xml: string): readonly (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  for (const tag of iterateXmlStartTags(xml, "col")) {
    if (!isTrue(attribute(tag, "hidden"))) continue;
    const min = Number.parseInt(attribute(tag, "min") ?? "", 10);
    const max = Number.parseInt(attribute(tag, "max") ?? "", 10);
    if (Number.isFinite(min) && Number.isFinite(max)) ranges.push([min - 1, max - 1]);
  }
  return ranges;
}

function countHiddenColumns(
  rows: readonly MutableRow[],
  ranges: readonly (readonly [number, number])[],
): number {
  if (ranges.length === 0) return 0;
  const seen = new Set<number>();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (ranges.some(([min, max]) => cell.columnIndex >= min && cell.columnIndex <= max)) {
        seen.add(cell.columnIndex);
      }
    }
  }
  return seen.size;
}

// ─── Rows ───────────────────────────────────────────────────────────────────────

interface RowRead {
  readonly cells: MutableCell[];
  readonly uncachedFormulaCount: number;
}

function readRowCells(rowXml: string, context: CellContext): RowRead {
  const cells: MutableCell[] = [];
  let uncachedFormulaCount = 0;
  let fallbackCol = 0;
  for (const cellXml of iterateXmlElements(rowXml, "c")) {
    const ref = attribute(leadingTag(cellXml), "r");
    const column = columnName(ref, fallbackCol);
    const columnIndex = columnIndexFromName(column);
    fallbackCol = columnIndex + 1;
    const read = readCell(cellXml, context);
    if (read.uncachedFormula) uncachedFormulaCount += 1;
    const value = read.value.trim();
    if (value.length > 0) cells.push({ column, columnIndex, value });
  }
  return { cells, uncachedFormulaCount };
}

function readSheet(sheetName: string, xml: string, context: CellContext): SheetReadResult {
  const rows: MutableRow[] = [];
  let fallbackRow = 1;
  let uncachedFormulaCount = 0;
  for (const rowXml of iterateXmlElements(xml, "row")) {
    const rowTag = leadingTag(rowXml);
    const number = rowNumber(rowTag, fallbackRow);
    fallbackRow = number + 1;
    const read = readRowCells(rowXml, context);
    uncachedFormulaCount += read.uncachedFormulaCount;
    if (read.cells.length > 0) {
      rows.push({
        rowNumber: number,
        hidden: isTrue(attribute(rowTag, "hidden")),
        cells: read.cells,
        folded: false,
      });
    }
  }
  rows.sort((a, b) => a.rowNumber - b.rowNumber);
  const hiddenRowCount = rows.filter((row) => row.hidden).length;
  const hiddenColumnCount = countHiddenColumns(rows, hiddenColumnRanges(xml));
  applyMergedCells(rows, parseMergeRanges(xml), mutableCell);
  return {
    rows: rows
      .filter((row) => !row.folded)
      .map((row) => ({ sheetName, rowNumber: row.rowNumber, cells: row.cells })),
    hiddenRowCount,
    hiddenColumnCount,
    uncachedFormulaCount,
  };
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
  date1904 = false,
): readonly SheetRow[] {
  return readSheet(sheetName, xml, { sharedStrings, styles, date1904 }).rows;
}

// ─── Workbook ───────────────────────────────────────────────────────────────────

interface WorkbookTotals {
  hiddenSheets: number;
  hiddenRows: number;
  hiddenColumns: number;
  uncachedFormulas: number;
}

function totalsDiagnostics(
  totals: WorkbookTotals,
  input: ParserSelectionInput,
): readonly ParserDiagnostic[] {
  const found: ParserDiagnostic[] = [];
  if (totals.hiddenSheets + totals.hiddenRows + totals.hiddenColumns > 0) {
    found.push(
      diagnostic(
        "TABLE_HIDDEN_CONTENT",
        `hidden content indexed: sheets=${String(totals.hiddenSheets)} rows=${String(
          totals.hiddenRows,
        )} columns=${String(totals.hiddenColumns)}`,
        input.documentId,
        "info",
      ),
    );
  }
  if (totals.uncachedFormulas > 0) {
    found.push(
      diagnostic(
        "TABLE_FORMULA_UNCACHED",
        `formula cells without cached value: ${String(totals.uncachedFormulas)}`,
        input.documentId,
        "info",
      ),
    );
  }
  return found;
}

function readWorkbookSheets(
  workbook: WorkbookInfo,
  byName: ReadonlyMap<string, string>,
  context: CellContext,
  maxLines: number,
): { readonly lines: readonly ProjectedLine[]; readonly totals: WorkbookTotals } | undefined {
  const totals: WorkbookTotals = {
    hiddenSheets: 0,
    hiddenRows: 0,
    hiddenColumns: 0,
    uncachedFormulas: 0,
  };
  const lines: ProjectedLine[] = [];
  for (const sheet of workbook.sheets) {
    const xml = byName.get(sheet.entryName);
    if (xml === undefined) continue;
    const read = readSheet(sheet.name, xml, context);
    if (sheet.hidden && read.rows.length > 0) totals.hiddenSheets += 1;
    totals.hiddenRows += read.hiddenRowCount;
    totals.hiddenColumns += read.hiddenColumnCount;
    totals.uncachedFormulas += read.uncachedFormulaCount;
    // One push per line: spreading a sheet's lines into one call overflows the argument limit at a
    // few hundred thousand rows and failed the whole workbook as malformed.
    for (const line of projectTable(
      sheet.name,
      read.rows,
      (columnIndex) => `Column ${columnLetters(columnIndex)}`,
    )) {
      lines.push(line);
    }
    if (lines.length > maxLines) return undefined;
  }
  return { lines, totals };
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
  const workbook = parseWorkbookInfo(
    byName.get("xl/workbook.xml"),
    byName.get("xl/_rels/workbook.xml.rels"),
    entries.filter((entry) => entry.name.startsWith(SHEET_ENTRY_PREFIX)),
  );
  const context: CellContext = {
    sharedStrings: sharedResult.strings,
    styles: parseStyles(byName.get("xl/styles.xml")),
    date1904: workbook.date1904,
  };
  const read = readWorkbookSheets(workbook, byName, context, options.maxObjectsPerDocument);
  if (read === undefined) {
    return emptyResult(xlsxParser.capability, input.documentId, options, [
      objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument),
    ]);
  }
  const emitted = emitProjectedLines(read.lines, input, options);
  return {
    ...emptyResult(
      xlsxParser.capability,
      input.documentId,
      options,
      [
        ...sharedResult.diagnostics,
        ...totalsDiagnostics(read.totals, input),
        ...emitted.diagnostics,
      ],
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
    const encrypted = encryptedOoxmlRefusal(xlsxParser.capability, input, options, "xlsx");
    if (encrypted !== undefined) return encrypted;
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
