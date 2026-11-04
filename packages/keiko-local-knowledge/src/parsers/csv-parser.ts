// CSV / TSV parser adapter (Epic #189, Issue #266; table projection #4235). Pure, hand-rolled
// RFC 4180 tokenizer with no `csv-parse` dependency.
//
//   * The delimiter is chosen from evidence: a `.tsv`/`.tab` file is tab separated; any other CSV
//     is probed for `,` `;` tab and `|`, and the delimiter that splits the first records into the
//     same number of fields wins (German Excel writes `;`).
//   * Quoted fields keep embedded delimiters and line breaks; `""` is a literal quote; spaces
//     before an opening quote or after a closing quote are not part of the field.
//   * CRLF, LF and bare CR all end a record. A trailing break emits no synthetic record.
//   * A quote that is never closed is read as a literal character and counted in a body-free
//     `TABLE_QUOTE_UNTERMINATED` diagnostic, so one stray quote cannot swallow the rest of the file.
//
// The records are projected by the shared table projection (`tabular.ts`), so a CSV and the same
// data in a workbook produce the same lines (`csv!2: ID=FR-1 | Titel=Login`): header evidence,
// plain lines for titles and header-only files, empty cells dropped, and unit `rowIndex` equal to
// the 0-based source record.

import { decodeUtf8, diagnostic, emptyResult, oversizeDiagnostic } from "./_internal.js";
import type { ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import {
  LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import { emitProjectedLines, projectTable, type TabularRow } from "./tabular.js";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "csv";
const PARSER_VERSION = "2";

const CSV_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS);
const TSV_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS);

const CANDIDATE_DELIMITERS: readonly string[] = [",", ";", "\t", "|"];
// The records and characters the delimiter probe reads; enough to see a stable column count.
const PROBE_RECORDS = 40;
const PROBE_CHARS = 64 * 1024;

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;

type DelimiterSelection =
  { readonly kind: "fixed"; readonly delimiter: string } | { readonly kind: "detect" };

function selectDelimiter(input: ParserSelectionInput): DelimiterSelection | null {
  const ext = input.extension.toLowerCase();
  if (CSV_EXTENSIONS.has(ext)) return { kind: "detect" };
  if (TSV_EXTENSIONS.has(ext)) return { kind: "fixed", delimiter: "\t" };
  // A real `Content-Type` carries parameters (`text/csv; charset=utf-8`): match the essence.
  const media = (input.mediaType.toLowerCase().split(";")[0] ?? "").trim();
  if (media === "text/csv") return { kind: "detect" };
  if (media === "text/tab-separated-values") return { kind: "fixed", delimiter: "\t" };
  return null;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

interface Scanner {
  readonly text: string;
  readonly delimiter: number;
  cursor: number;
  unterminatedQuotes: number;
}

interface CsvRecord {
  // 1-based position in the file, blank lines included (a spreadsheet counts them as rows).
  readonly recordNumber: number;
  readonly fields: readonly string[];
}

function codeAt(scanner: Scanner, index: number): number | undefined {
  return scanner.text.codePointAt(index);
}

function isBreak(code: number | undefined): boolean {
  return code === LF || code === CR;
}

// Index of the first character at or after `from` that is not a space (or a tab, unless the tab
// is the delimiter).
function skipInlineSpace(scanner: Scanner, from: number): number {
  let index = from;
  for (;;) {
    const code = codeAt(scanner, index);
    const blank = code === SPACE || (code === TAB && scanner.delimiter !== TAB);
    if (!blank) return index;
    index += 1;
  }
}

// Reads the text from `start` up to the next delimiter or line break (exclusive).
function readUntilBoundary(scanner: Scanner, start: number): string {
  let index = start;
  for (;;) {
    const code = codeAt(scanner, index);
    if (code === undefined || code === scanner.delimiter || isBreak(code)) break;
    index += 1;
  }
  scanner.cursor = index;
  return scanner.text.slice(start, index);
}

// A quoted field starting at `quoteIndex`, or undefined when its closing quote does not exist.
function readQuoted(scanner: Scanner, quoteIndex: number): string | undefined {
  const parts: string[] = [];
  let from = quoteIndex + 1;
  for (;;) {
    const close = scanner.text.indexOf('"', from);
    if (close === -1) return undefined;
    parts.push(scanner.text.slice(from, close));
    if (codeAt(scanner, close + 1) !== QUOTE) {
      scanner.cursor = skipInlineSpace(scanner, close + 1);
      break;
    }
    parts.push('"');
    from = close + 2;
  }
  // Text between the closing quote and the delimiter is kept rather than dropped.
  const trailing = readUntilBoundary(scanner, scanner.cursor).trimEnd();
  return parts.join("") + trailing;
}

function readFieldValue(scanner: Scanner): string {
  const start = scanner.cursor;
  const first = skipInlineSpace(scanner, start);
  if (codeAt(scanner, first) === QUOTE) {
    const quoted = readQuoted(scanner, first);
    if (quoted !== undefined) return quoted.trim();
    scanner.unterminatedQuotes += 1;
  }
  return readUntilBoundary(scanner, start).trim();
}

function consumeRecordBreak(scanner: Scanner): void {
  const code = codeAt(scanner, scanner.cursor);
  if (code === CR) {
    scanner.cursor += codeAt(scanner, scanner.cursor + 1) === LF ? 2 : 1;
  } else if (code === LF) {
    scanner.cursor += 1;
  }
}

function readRecordFields(scanner: Scanner): readonly string[] {
  const fields: string[] = [];
  for (;;) {
    fields.push(readFieldValue(scanner));
    if (codeAt(scanner, scanner.cursor) !== scanner.delimiter) break;
    scanner.cursor += 1;
  }
  consumeRecordBreak(scanner);
  return fields;
}

interface Tokenized {
  // The records that hold at least one non-empty field, in file order.
  readonly records: readonly CsvRecord[];
  readonly unterminatedQuotes: number;
  // False when `maxRecords` stopped the scan before the end of the text.
  readonly complete: boolean;
}

function tokenize(
  text: string,
  delimiter: string,
  maxRecords = Number.POSITIVE_INFINITY,
): Tokenized {
  const scanner: Scanner = {
    text,
    delimiter: delimiter.codePointAt(0) ?? 0,
    cursor: 0,
    unterminatedQuotes: 0,
  };
  const records: CsvRecord[] = [];
  let recordNumber = 0;
  while (scanner.cursor < text.length && records.length < maxRecords) {
    recordNumber += 1;
    const fields = readRecordFields(scanner);
    // A blank line keeps its number (a spreadsheet counts it as a row) but holds nothing.
    if (fields.some((field) => field.length > 0)) records.push({ recordNumber, fields });
  }
  return {
    records,
    unterminatedQuotes: scanner.unterminatedQuotes,
    complete: scanner.cursor >= text.length,
  };
}

// ─── Delimiter detection ─────────────────────────────────────────────────────

interface DelimiterScore {
  readonly consistency: number;
  readonly columns: number;
  // The share of cuts that fall between two digits (`1,5` cut at the comma). A delimiter that
  // mostly cuts numbers apart is the decimal separator of another delimiter's fields.
  readonly numberCuts: number;
}

function modalColumns(records: readonly CsvRecord[]): { columns: number; frequency: number } {
  const counts = new Map<number, number>();
  for (const record of records) {
    counts.set(record.fields.length, (counts.get(record.fields.length) ?? 0) + 1);
  }
  let columns = 0;
  let frequency = 0;
  for (const [count, seen] of counts) {
    if (seen > frequency || (seen === frequency && count > columns)) {
      columns = count;
      frequency = seen;
    }
  }
  return { columns, frequency };
}

function numberCutShare(records: readonly CsvRecord[]): number {
  let cuts = 0;
  let numberCuts = 0;
  for (const { fields } of records) {
    for (let index = 1; index < fields.length; index += 1) {
      cuts += 1;
      if (/\d$/u.test(fields[index - 1] ?? "") && /^\d/u.test(fields[index] ?? "")) numberCuts += 1;
    }
  }
  return cuts === 0 ? 0 : numberCuts / cuts;
}

function scoreDelimiter(sample: string, delimiter: string): DelimiterScore {
  const { records } = tokenize(sample, delimiter, PROBE_RECORDS);
  const { columns, frequency } = modalColumns(records);
  return {
    consistency: columns < 2 ? 0 : frequency / records.length,
    columns,
    numberCuts: numberCutShare(records),
  };
}

// Consistency first. Between delimiters that split equally well, the one that cuts fewer numbers
// apart (`Miete;1.234,50` is two fields, not `Miete;1.234` and `50`), then the one with more fields.
function beats(score: DelimiterScore, best: DelimiterScore): boolean {
  if (score.consistency !== best.consistency) return score.consistency > best.consistency;
  if (score.consistency === 0) return false;
  if (score.numberCuts !== best.numberCuts) return score.numberCuts < best.numberCuts;
  return score.columns > best.columns;
}

/** The candidate that splits the first records into the same number of fields; `,` by default. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, PROBE_CHARS);
  let best = ",";
  let bestScore: DelimiterScore = { consistency: 0, columns: 0, numberCuts: 0 };
  for (const candidate of CANDIDATE_DELIMITERS) {
    const score = scoreDelimiter(sample, candidate);
    if (beats(score, bestScore)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ─── Projection ──────────────────────────────────────────────────────────────

function tabularRows(records: readonly CsvRecord[]): readonly TabularRow[] {
  const rows: TabularRow[] = [];
  for (const record of records) {
    const cells = record.fields.flatMap((value, columnIndex) =>
      value.length === 0 ? [] : [{ columnIndex, value }],
    );
    if (cells.length > 0) rows.push({ rowNumber: record.recordNumber, cells });
  }
  return rows;
}

function quoteDiagnostics(count: number, input: ParserSelectionInput): readonly ParserDiagnostic[] {
  if (count === 0) return [];
  return [
    diagnostic(
      "TABLE_QUOTE_UNTERMINATED",
      `unterminated quote read as literal: ${String(count)}`,
      input.documentId,
      "warning",
    ),
  ];
}

// Excel's first-line directive `sep=;` names the delimiter and is no data. Its text is dropped and
// its line break stays, so every record keeps its position in the file (the unit `rowIndex`).
const SEPARATOR_DIRECTIVE = /^sep=([^\r\n"\p{L}\p{N}])(?=\r\n|\r|\n)/u;

function withoutSeparatorDirective(text: string): {
  readonly text: string;
  readonly declared: string | undefined;
} {
  const match = SEPARATOR_DIRECTIVE.exec(text);
  if (match === null) return { text, declared: undefined };
  return { text: text.slice(match[0].length), declared: match[1] };
}

// Every row projects to at most one line, and a later table's header to none: a header needs a
// blank row before it, so at least every second non-empty row is a line. Reading twice the unit
// limit therefore still overruns the limit when the file does, and a file of millions of records
// is not held in memory to emit the first fifty thousand lines.
const ROW_HEADROOM = 32;

function rowAllowance(options: ParserOptions): number {
  return 2 * (options.maxUnitsPerDocument + 1) + ROW_HEADROOM;
}

// The scan stopped at the allowance and the projection did not itself report the limit.
function cutDiagnostics(
  complete: boolean,
  emitted: readonly ParserDiagnostic[],
  input: ParserSelectionInput,
  options: ParserOptions,
): readonly ParserDiagnostic[] {
  if (complete || emitted.some((entry) => entry.code === "UNIT_LIMIT_REACHED")) return [];
  return [
    diagnostic(
      "UNIT_LIMIT_REACHED",
      `reached maxUnitsPerDocument=${String(options.maxUnitsPerDocument)}`,
      input.documentId,
      "info",
    ),
  ];
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
    const selection = selectDelimiter(input);
    if (selection === null) {
      // Defensive: registry never routes here without a delimiter, but we honour the
      // contract by returning a typed diagnostic rather than throwing.
      return emptyResult(csvParser.capability, input.documentId, options, [
        diagnostic("UNSUPPORTED_FORMAT", "no delimiter selected", input.documentId, "error"),
      ]);
    }
    const { text, declared } = withoutSeparatorDirective(decodeUtf8(input.bytes).text);
    const delimiter =
      selection.kind === "fixed" ? selection.delimiter : (declared ?? detectDelimiter(text));
    // #2906 KEIKO-0832: label the table from the delimiter actually selected, so `.tab` files and
    // tab-separated documents identified only by media type are `tsv`, not `csv`.
    const tableName = selection.kind === "fixed" ? "tsv" : "csv";
    const tokenized = tokenize(text, delimiter, rowAllowance(options));
    const lines = projectTable(
      tableName,
      tabularRows(tokenized.records),
      (columnIndex) => `Column ${String(columnIndex + 1)}`,
    );
    const emitted = emitProjectedLines(lines, input, options);
    return {
      ...emptyResult(
        csvParser.capability,
        input.documentId,
        options,
        [
          ...quoteDiagnostics(tokenized.unterminatedQuotes, input),
          ...emitted.diagnostics,
          ...cutDiagnostics(tokenized.complete, emitted.diagnostics, input, options),
        ],
        emitted.units,
      ),
      normalizedText: emitted.normalizedText,
    } satisfies InternalParserResult;
  },
});
