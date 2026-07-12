// CSV / TSV parser adapter (Epic #189, Issue #266). Pure, hand-rolled RFC 4180 tokenizer.
//
// No `csv-parse` or other dependency — the rules are small enough that a single state
// machine over the decoded string handles every case we need:
//
//   * Quoted fields preserve embedded delimiters (`,` or `\t`) and embedded newlines.
//   * `""` inside a quoted field decodes to a single literal `"`.
//   * CRLF, LF, and bare CR row terminators all work.
//   * A trailing newline does NOT emit a synthetic empty row.
//   * A row with only whitespace + empty fields is preserved verbatim (we do not lose data).
//
// Emits one ParsedUnit { kind: "csv-row" } per non-header row. The first row is treated as
// the header and is NOT emitted as a unit — its values are kept only for the implicit table
// schema. If the document has no header row (a single line), THAT line is emitted as the
// header AND a single data row, so a one-line CSV stays observable.

import {
  decodeUtf8,
  diagnostic,
  emptyResult,
  oversizeDiagnostic,
  shouldStop,
} from "./_internal.js";
import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import {
  LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS,
} from "@oscharko-dev/keiko-contracts";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "csv";
const PARSER_VERSION = "1";

const CSV_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS);
const TSV_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS);

function selectDelimiter(input: ParserSelectionInput): string | null {
  const ext = input.extension.toLowerCase();
  if (CSV_EXTENSIONS.has(ext)) return ",";
  if (TSV_EXTENSIONS.has(ext)) return "\t";
  const media = input.mediaType.toLowerCase();
  if (media === "text/csv") return ",";
  if (media === "text/tab-separated-values") return "\t";
  return null;
}

interface ParseState {
  readonly text: string;
  readonly delimiter: number; // char code
  cursor: number;
  rowStart: number;
}

// Returns the next row's [start, end) span and the field count. End is one past the last
// non-newline character; the cursor is advanced past any row terminator so a trailing newline
// does not emit a synthetic empty row.
interface RowSpan {
  readonly start: number;
  readonly end: number;
  readonly fieldCount: number;
  readonly done: boolean;
}

interface ParsedCsvRow {
  readonly start: number;
  readonly end: number;
  readonly fields: readonly string[];
}

function readField(state: ParseState): { readonly endOfRow: boolean } {
  const { text } = state;
  if (state.cursor >= text.length) return { endOfRow: true };
  const code = text.charCodeAt(state.cursor);
  if (code === 0x22 /* " */) return readQuotedField(state);
  return readBareField(state);
}

function readBareField(state: ParseState): { readonly endOfRow: boolean } {
  const { text, delimiter } = state;
  while (state.cursor < text.length) {
    const code = text.charCodeAt(state.cursor);
    if (code === delimiter) {
      state.cursor += 1;
      return { endOfRow: false };
    }
    if (code === 0x0a /* LF */) {
      // Caller advances past LF; we just signal end-of-row here.
      return { endOfRow: true };
    }
    if (code === 0x0d /* CR */) {
      return { endOfRow: true };
    }
    state.cursor += 1;
  }
  return { endOfRow: true };
}

function readQuotedField(state: ParseState): { readonly endOfRow: boolean } {
  const { text } = state;
  // Skip the opening quote.
  state.cursor += 1;
  while (state.cursor < text.length) {
    const code = text.charCodeAt(state.cursor);
    if (code === 0x22 /* " */) {
      // Escaped quote? Peek ahead.
      if (state.cursor + 1 < text.length && text.charCodeAt(state.cursor + 1) === 0x22) {
        state.cursor += 2;
        continue;
      }
      // Closing quote — consume it then expect delimiter / row terminator / EOF.
      state.cursor += 1;
      return consumeAfterQuote(state);
    }
    state.cursor += 1;
  }
  // Unterminated quoted field: treat the rest of the document as part of this field.
  return { endOfRow: true };
}

function consumeAfterQuote(state: ParseState): { readonly endOfRow: boolean } {
  if (state.cursor >= state.text.length) return { endOfRow: true };
  const code = state.text.charCodeAt(state.cursor);
  if (code === state.delimiter) {
    state.cursor += 1;
    return { endOfRow: false };
  }
  if (code === 0x0a || code === 0x0d) return { endOfRow: true };
  // Malformed: bytes after the closing quote that are neither delimiter nor newline. We
  // tolerate by consuming until the next delimiter / newline rather than crashing.
  while (state.cursor < state.text.length) {
    const inner = state.text.charCodeAt(state.cursor);
    if (inner === state.delimiter) {
      state.cursor += 1;
      return { endOfRow: false };
    }
    if (inner === 0x0a || inner === 0x0d) return { endOfRow: true };
    state.cursor += 1;
  }
  return { endOfRow: true };
}

function consumeRowTerminator(state: ParseState): void {
  if (state.cursor >= state.text.length) return;
  const code = state.text.charCodeAt(state.cursor);
  if (code === 0x0d) {
    state.cursor += 1;
    if (state.cursor < state.text.length && state.text.charCodeAt(state.cursor) === 0x0a) {
      state.cursor += 1;
    }
    return;
  }
  if (code === 0x0a) state.cursor += 1;
}

function readRow(state: ParseState): RowSpan {
  if (state.cursor >= state.text.length) {
    return { start: state.cursor, end: state.cursor, fieldCount: 0, done: true };
  }
  const start = state.cursor;
  state.rowStart = start;
  let fieldCount = 0;
  for (;;) {
    const field = readField(state);
    fieldCount += 1;
    if (field.endOfRow) break;
  }
  const end = state.cursor;
  consumeRowTerminator(state);
  return { start, end, fieldCount, done: false };
}

interface RowEmission {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly normalizedText: string;
}

interface FieldSplitState {
  readonly rowText: string;
  readonly delimiter: string;
  readonly fields: string[];
  cursor: number;
  current: string;
  quoted: boolean;
}

// Inside a quoted field: `""` decodes to a literal `"`, a lone `"` closes the quote, and
// anything else is copied through verbatim.
function consumeQuotedChar(state: FieldSplitState): void {
  const ch = state.rowText.charAt(state.cursor);
  if (ch === '"') {
    const next = state.cursor + 1;
    if (next < state.rowText.length && state.rowText.charAt(next) === '"') {
      state.current += '"';
      state.cursor += 2;
      return;
    }
    state.quoted = false;
    state.cursor += 1;
    return;
  }
  state.current += ch;
  state.cursor += 1;
}

// A field only opens as quoted when the `"` is the very first character collected so far.
function tryStartQuotedField(state: FieldSplitState): boolean {
  const ch = state.rowText.charAt(state.cursor);
  if (ch !== '"' || state.current.length !== 0) return false;
  state.quoted = true;
  state.cursor += 1;
  return true;
}

function tryConsumeDelimiter(state: FieldSplitState): boolean {
  const ch = state.rowText.charAt(state.cursor);
  if (ch !== state.delimiter) return false;
  state.fields.push(state.current.trim());
  state.current = "";
  state.cursor += 1;
  return true;
}

function consumeBareChar(state: FieldSplitState): void {
  state.current += state.rowText.charAt(state.cursor);
  state.cursor += 1;
}

function parseRowValues(rowText: string, delimiter: string): readonly string[] {
  const state: FieldSplitState = {
    rowText,
    delimiter,
    fields: [],
    cursor: 0,
    current: "",
    quoted: false,
  };
  while (state.cursor < state.rowText.length) {
    if (state.quoted) {
      consumeQuotedChar(state);
      continue;
    }
    if (tryStartQuotedField(state)) continue;
    if (tryConsumeDelimiter(state)) continue;
    consumeBareChar(state);
  }
  state.fields.push(state.current.trim());
  return state.fields;
}

function readParsedRows(text: string, delimiter: string): readonly ParsedCsvRow[] {
  const state: ParseState = { text, delimiter: delimiter.charCodeAt(0), cursor: 0, rowStart: 0 };
  const rows: ParsedCsvRow[] = [];
  for (;;) {
    const row = readRow(state);
    if (row.done) break;
    rows.push({
      start: row.start,
      end: row.end,
      fields: parseRowValues(text.slice(row.start, row.end), delimiter),
    });
  }
  return rows;
}

function normalizeHeaderLabel(value: string, index: number): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : `Column ${String(index + 1)}`;
}

function normalizeHeaders(fields: readonly string[], minColumns: number): readonly string[] {
  const headers: string[] = [];
  const seen = new Map<string, number>();
  const columnCount = Math.max(fields.length, minColumns);
  for (let i = 0; i < columnCount; i += 1) {
    const base = normalizeHeaderLabel(fields[i] ?? "", i);
    const seenCount = seen.get(base) ?? 0;
    seen.set(base, seenCount + 1);
    headers.push(seenCount === 0 ? base : `${base} ${String(seenCount + 1)}`);
  }
  return headers;
}

function hasPlausibleHeader(rows: readonly ParsedCsvRow[]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first === undefined) return false;
  return first.fields.some((field) => /[A-Za-z_ÄÖÜäöüß]/u.test(field));
}

function projectRow(fields: readonly string[], headers: readonly string[]): string {
  const pairs: string[] = [];
  const columnCount = Math.max(fields.length, headers.length);
  for (let i = 0; i < columnCount; i += 1) {
    const header = headers[i] ?? `Column ${String(i + 1)}`;
    const value = fields[i] ?? "";
    pairs.push(`${header}=${value}`);
  }
  return `${pairs.join(" | ")}\n`;
}

// eslint-disable-next-line complexity
function emitRows(
  text: string,
  delimiter: string,
  input: ParserSelectionInput,
  options: ParserOptions,
): RowEmission {
  const tableName = input.extension.toLowerCase() === "tsv" ? "tsv" : "csv";
  const startedAt = options.now();
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const parts: string[] = [];
  let offset = 0;
  const rows = readParsedRows(text, delimiter);
  if (rows.length === 0) return { units, diagnostics, normalizedText: "" };
  const headerIsSchema = hasPlausibleHeader(rows);
  const dataRows = headerIsSchema ? rows.slice(1) : rows;
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.fields.length), 0);
  const headers = headerIsSchema
    ? normalizeHeaders(rows[0]?.fields ?? [], maxColumns)
    : normalizeHeaders([], maxColumns);
  let rowIndex = 0;
  for (const row of dataRows) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    const rowText = projectRow(row.fields, headers);
    const start = offset;
    parts.push(rowText);
    offset += rowText.length;
    units.push(csvUnit(input, tableName, rowIndex, start, offset));
    rowIndex += 1;
  }
  return { units, diagnostics, normalizedText: parts.join("") };
}

function csvUnit(
  input: ParserSelectionInput,
  tableName: string,
  rowIndex: number,
  start: number,
  end: number,
): ParsedUnit {
  return {
    kind: "csv-row",
    documentId: input.documentId,
    tableName,
    rowIndex,
    characterStart: start,
    characterEnd: end,
  };
}

export const csvParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => selectDelimiter(input) !== null,
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(csvParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    const delimiter = selectDelimiter(input);
    if (delimiter === null) {
      // Defensive: registry never routes here without a delimiter, but we honour the
      // contract by returning a typed diagnostic rather than throwing.
      return emptyResult(csvParser.capability, input.documentId, options, [
        diagnostic("UNSUPPORTED_FORMAT", "no delimiter selected", input.documentId, "error"),
      ]);
    }
    const decoded = decodeUtf8(input.bytes);
    const emission = emitRows(decoded.text, delimiter, input, options);
    return {
      ...emptyResult(
        csvParser.capability,
        input.documentId,
        options,
        emission.diagnostics,
        emission.units,
      ),
      normalizedText: emission.normalizedText,
    } satisfies InternalParserResult;
  },
});
