import { Buffer } from "node:buffer";

import type { ParsedUnit, ParserDiagnostic, ParserResult } from "@oscharko-dev/keiko-contracts";
import yauzl from "yauzl";

import {
  diagnostic,
  emptyResult,
  objectLimitDiagnostic,
  oversizeDiagnostic,
  shouldStop,
} from "./_internal.js";
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
const MAX_XML_INFLATE_RATIO = 100;
const SHEET_ENTRY_PREFIX = "xl/worksheets/";

interface ZipFileLike {
  readonly readEntry: () => void;
  readonly close: () => void;
  readonly openReadStream: (
    entry: yauzl.Entry,
    callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void,
  ) => void;
  readonly on: (event: string, listener: (...args: readonly unknown[]) => void) => ZipFileLike;
  readonly once: (event: string, listener: (...args: readonly unknown[]) => void) => ZipFileLike;
  readonly removeListener: (
    event: string,
    listener: (...args: readonly unknown[]) => void,
  ) => ZipFileLike;
}

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
  readonly value: string;
}

interface RowProjection {
  readonly sheetName: string;
  readonly rowNumber: number;
  readonly text: string;
}

function isXlsx(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  const media = input.mediaType.toLowerCase();
  return ext === "xlsx" || media === XLSX_MEDIA;
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

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function closeZipQuietly(zip: ZipFileLike): void {
  try {
    zip.close();
  } catch {
    // Close failures are non-fatal during parser cleanup.
  }
}

function openZip(bytes: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true },
      (error, zip) => {
        if (error !== null) {
          reject(toError(error, "failed to open xlsx zip"));
          return;
        }
        resolve(zip);
      },
    );
  });
}

function maxInflatedEntryBytes(maxInputBytes: number): number {
  const inputCap = Math.max(1, Math.floor(maxInputBytes));
  return Math.min(MAX_XML_INFLATED_BYTES, inputCap * 10);
}

function isRelevantEntry(name: string): boolean {
  return (
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    (name.startsWith(SHEET_ENTRY_PREFIX) && name.endsWith(".xml"))
  );
}

function assertEntryWithinLimits(entry: yauzl.Entry, maxInflatedBytes: number): void {
  if (entry.uncompressedSize > maxInflatedBytes) {
    throw new Error("xlsx xml inflated size exceeds parser limit");
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_XML_INFLATE_RATIO
  ) {
    throw new Error("xlsx xml compression ratio exceeds parser limit");
  }
}

function destroyStream(readStream: NodeJS.ReadableStream, error: Error): void {
  const destroy = (readStream as { readonly destroy?: (cause?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(readStream, error);
  }
}

function readEntryText(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxInflatedBytes: number,
): Promise<string> {
  assertEntryWithinLimits(entry, maxInflatedBytes);
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(toError(error, "failed to open xlsx entry stream"));
        return;
      }
      const readStream = stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      let inflatedBytes = 0;
      let settled = false;
      const rejectOnce = (streamError: Error): void => {
        if (settled) return;
        settled = true;
        reject(streamError);
        destroyStream(readStream, streamError);
      };
      readStream.on("data", (chunk: Buffer) => {
        if (settled) return;
        inflatedBytes += chunk.byteLength;
        if (inflatedBytes > maxInflatedBytes) {
          rejectOnce(new Error("xlsx xml inflated stream exceeds parser limit"));
          return;
        }
        chunks.push(chunk);
      });
      readStream.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      readStream.on("error", (streamError: Error) => {
        rejectOnce(streamError);
      });
    });
  });
}

function removeZipEntryListeners(
  zip: ZipFileLike,
  listeners: {
    readonly onEntry: (entry: unknown) => void;
    readonly onEnd: () => void;
    readonly onError: (error: unknown) => void;
  },
): void {
  zip.removeListener("entry", listeners.onEntry);
  zip.removeListener("end", listeners.onEnd);
  zip.removeListener("error", listeners.onError);
}

function readRelevantEntries(
  zip: ZipFileLike,
  maxInflatedBytes: number,
): Promise<readonly XlsxEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: XlsxEntry[] = [];
    let settled = false;

    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      removeZipEntryListeners(zip, { onEntry, onEnd, onError });
      resolve(entries);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      removeZipEntryListeners(zip, { onEntry, onEnd, onError });
      reject(error);
    };

    const onEnd = (): void => {
      resolveOnce();
    };
    const onError = (error: unknown): void => {
      rejectOnce(toError(error, "failed to read xlsx zip"));
    };

    const handleEntry = async (entry: yauzl.Entry): Promise<void> => {
      if (!isRelevantEntry(entry.fileName)) {
        zip.readEntry();
        return;
      }
      try {
        const xml = await readEntryText(zip as yauzl.ZipFile, entry, maxInflatedBytes);
        entries.push({ name: entry.fileName, xml });
        zip.readEntry();
      } catch (error) {
        rejectOnce(toError(error, "failed to read xlsx entry"));
      }
    };

    const onEntry = (entry: unknown): void => {
      void handleEntry(entry as yauzl.Entry);
    };

    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u");
  const match = pattern.exec(tag);
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
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

function parseSharedStrings(
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
  const itemPattern = /<si\b[\s\S]*?<\/si>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) !== null) {
    const limit = shouldStop(startedAt, options, strings.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    if (strings.length >= options.maxObjectsPerDocument) {
      diagnostics.push(objectLimitDiagnostic(input.documentId, options.maxObjectsPerDocument));
      break;
    }
    const itemXml = match[0];
    const parts = [...itemXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) =>
      decodeXml(part[1] ?? ""),
    );
    strings.push(parts.length > 0 ? parts.join("") : xmlTextContent(itemXml));
  }
  return { strings, diagnostics };
}

function parseRelationships(xml: string): ReadonlyMap<string, string> {
  const rels = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/gi)) {
    const tag = match[0];
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
    for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/gi)) {
      const tag = match[0];
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
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function rowNumber(rowTag: string, fallback: number): number {
  const raw = attribute(rowTag, "r");
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inlineStringValue(cellXml: string): string {
  const inline = /<is\b[\s\S]*?<\/is>/iu.exec(cellXml)?.[0];
  if (inline === undefined) return "";
  return [...inline.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
    .map((part) => decodeXml(part[1] ?? ""))
    .join("");
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
  const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/iu.exec(cellXml)?.[1];
  return formula === undefined ? "" : `=${decodeXml(formula)}`;
}

function cellValue(cellXml: string, sharedStrings: readonly string[]): string {
  const tag = /^<c\b[^>]*>/iu.exec(cellXml)?.[0] ?? "";
  const type = attribute(tag, "t");
  if (type === "inlineStr") return inlineStringValue(cellXml);
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/iu.exec(cellXml)?.[1];
  if (raw !== undefined) return rawCellValue(type, raw, sharedStrings);
  return formulaCellValue(cellXml);
}

function projectSheetRows(
  sheetName: string,
  xml: string,
  sharedStrings: readonly string[],
): readonly RowProjection[] {
  const rows: RowProjection[] = [];
  let fallbackRow = 1;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/gi)) {
    const rowXml = rowMatch[0];
    const rowTag = /^<row\b[^>]*>/iu.exec(rowXml)?.[0] ?? "";
    const number = rowNumber(rowTag, fallbackRow);
    fallbackRow = number + 1;
    const cells: CellValue[] = [];
    let fallbackCol = 0;
    for (const cellMatch of rowXml.matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/gi)) {
      const cellXml = cellMatch[0];
      const cellTag = /^<c\b[^>]*>/iu.exec(cellXml)?.[0] ?? "";
      const value = cellValue(cellXml, sharedStrings).trim();
      if (value.length === 0) {
        fallbackCol += 1;
        continue;
      }
      cells.push({ column: columnName(attribute(cellTag, "r"), fallbackCol), value });
      fallbackCol += 1;
    }
    if (cells.length === 0) continue;
    rows.push({
      sheetName,
      rowNumber: number,
      text: `${sheetName}!${String(number)}: ${cells
        .map((cell) => `${cell.column}=${cell.value}`)
        .join(" | ")}\n`,
    });
  }
  return rows;
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
  const workbookSheets = parseWorkbookSheets(
    byName.get("xl/workbook.xml"),
    byName.get("xl/_rels/workbook.xml.rels"),
    worksheetEntries,
  );
  const rows: RowProjection[] = [];
  for (const sheet of workbookSheets) {
    const xml = byName.get(sheet.entryName);
    if (xml === undefined) continue;
    rows.push(...projectSheetRows(sheet.name, xml, sharedResult.strings));
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
      const zip = await openZip(input.bytes);
      try {
        const entries = await readRelevantEntries(zip, maxInflatedEntryBytes(options.maxBytes));
        return parseWorkbook(entries, input, options);
      } finally {
        closeZipQuietly(zip);
      }
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
