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
import type { ParserAdapter, ParserOptions, ParserSelectionInput } from "./types.js";

const PARSER_ID = "csv";
const PARSER_VERSION = "1";

const CSV_EXTENSIONS: ReadonlySet<string> = new Set(["csv"]);
const TSV_EXTENSIONS: ReadonlySet<string> = new Set(["tsv", "tab"]);

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
}

function emitRows(
  text: string,
  delimiter: string,
  input: ParserSelectionInput,
  options: ParserOptions,
): RowEmission {
  const tableName = input.extension.toLowerCase() === "tsv" ? "tsv" : "csv";
  const state: ParseState = { text, delimiter: delimiter.charCodeAt(0), cursor: 0, rowStart: 0 };
  const startedAt = options.now();
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  // Read the header row first. If there are no further rows, emit the header itself as a
  // single data row at index 0 so a one-line CSV remains observable.
  const header = readRow(state);
  if (header.done) return { units, diagnostics };
  if (state.cursor >= text.length) {
    units.push(csvUnit(input, tableName, 0, header.start, header.end));
    return { units, diagnostics };
  }
  let rowIndex = 0;
  while (state.cursor < text.length) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    const row = readRow(state);
    if (row.done) break;
    units.push(csvUnit(input, tableName, rowIndex, row.start, row.end));
    rowIndex += 1;
  }
  return { units, diagnostics };
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
    return emptyResult(
      csvParser.capability,
      input.documentId,
      options,
      emission.diagnostics,
      emission.units,
    );
  },
});
