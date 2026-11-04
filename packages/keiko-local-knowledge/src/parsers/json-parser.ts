// JSON parser adapter (Epic #189, Issue #266). Pure: bytes -> ParserResult.
//
// Emits one ParsedUnit { kind: "json-path", jsonPointer } per logical record. Objects keep
// sibling scalar fields together, arrays of objects emit one unit per element, and primitive
// / empty values still emit a unit at their own pointer. Pointers follow RFC 6901 — keys are
// encoded with `~0` for `~` and `~1` for `/`.
//
// Character offsets target a normalized line-oriented projection, not the raw JSON bytes:
//   /json/pointer: key=value | key=value
// A string scalar reads as its value (`id=FA-1`, not `id="FA-1"`), so an identifier or a sentence
// stays recognizable for retrieval and for the requirement inventory. This keeps downstream
// chunking bounded by the selected leaf instead of multiplying the whole document once per leaf
// while preserving the JSON Pointer citation.
//
// The document is read by `json-reader.ts`, which keeps every digit of a large integer, keeps both
// values of a repeated key and locates a malformed document by line and column.

import {
  binaryContentRefusal,
  decodeUtf8,
  diagnostic,
  emptyResult,
  encodingDiagnostic,
  oversizeDiagnostic,
  shouldStop,
  textByteLimit,
  type DecodedText,
} from "./_internal.js";
import type {
  DocumentId,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import { cleanHeaderLabel, neutraliseFieldSeparator } from "./tabular.js";
import {
  readJson,
  type JsonArray,
  type JsonObject,
  type JsonReadResult,
  type JsonValue,
} from "./json-reader.js";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "json";
const PARSER_VERSION = "2";

// A JSON document is read, walked and projected on the event loop in one synchronous call, about
// 12 ms per MB measured (a 50 MB document of small records: 0.75 s). 256 MiB keeps that under about
// three seconds; a larger document is refused with OVERSIZED_FILE instead of freezing the process.
const JSON_MAX_BYTES = 256 * 1024 * 1024;

const JSON_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS);

function isJson(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (JSON_EXTENSIONS.has(ext)) return true;
  const media = input.mediaType.toLowerCase();
  return media === "application/json" || media === "application/ld+json";
}

function encodePointerSegment(key: string): string {
  // RFC 6901: `~` -> `~0`, `/` -> `~1`. Order matters: replace `~` first.
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function joinPointer(parent: string, segment: string): string {
  return `${parent}/${segment}`;
}

type ReadFailure = Extract<JsonReadResult, { readonly ok: false }>;

interface ScanContext {
  readonly text: string;
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  readonly normalizedParts: string[];
  normalizedLength: number;
  // Whole-file stop signal: PARSER_TIMEOUT / PARSER_CANCELLED. Once set the file-level walk aborts
  // and stays aborted.
  stopped: boolean;
  // Records walked after the unit cap was reached. They are counted, not emitted, so the cap
  // diagnostic can say how much of the document is missing from the index.
  omittedRecords: number;
  // Per-record stop signal set by pushNestingLimit only. `walk()` still short-circuits on it,
  // but walkJsonLines clears it between records so a deeply-nested line does not silently
  // discard every valid line that follows (PR-review follow-up on KEIKO-0484).
  nestingStopped: boolean;
}

// A line break inside a string value would split the line-oriented projection (and every unit span
// is a line), so line breaks read as one space.
const LINE_BREAKS = /[\r\n\u2028\u2029]+/gu;
// `\u0000` and its kin are legal in a JSON string and mean nothing in a text.
const CONTROL_CHARACTER = /(?!\t)\p{Cc}/gu;

function scalarText(value: Exclude<JsonValue, JsonArray | JsonObject>): string {
  if (typeof value === "string") {
    const text = value.replaceAll(LINE_BREAKS, " ").replaceAll(CONTROL_CHARACTER, "");
    return neutraliseFieldSeparator(text);
  }
  if (value !== null && typeof value === "object") return value.source;
  return value === null ? "null" : String(value);
}

// The position of an object among the elements of an array (or among the lines of a JSONL file).
interface RowRef {
  readonly parent: string;
  readonly number: number;
}

// An object that is an element of an array is a row of that array, labelled like a spreadsheet row
// (`/requirements!3:`, parent pointer plus a 1-based row number): the requirement inventory reads
// exactly that shape for workbooks. Every other record keeps its JSON Pointer as label. The label is
// presentation only; the unit's `jsonPointer` stays the citation.
function recordLabel(pointer: string, row: RowRef | undefined): string {
  if (row !== undefined) {
    const parent = row.parent.length === 0 ? "/" : labelText(row.parent);
    return `${parent}!${String(row.number)}`;
  }
  return pointer.length === 0 ? "/" : labelText(pointer);
}

// A key of the document is data: a line break, `|` or `=` in it would start another record or field,
// and a pointer ending in `!<number>` would read as the row label of another record.
function labelText(text: string): string {
  return cleanHeaderLabel(text).replaceAll(/!(?=\d+(?::|$))/gu, "! ");
}

function appendNormalizedRecord(
  ctx: ScanContext,
  pointer: string,
  text: string,
  row: RowRef | undefined,
): { readonly start: number; readonly end: number } {
  const label = recordLabel(pointer, row);
  const line = `${label}: ${text}\n`;
  const start = ctx.normalizedLength;
  ctx.normalizedParts.push(line);
  ctx.normalizedLength += line.length;
  return { start, end: ctx.normalizedLength };
}

function pushRecord(ctx: ScanContext, pointer: string, text: string, row?: RowRef): void {
  const limit = shouldStop(ctx.startedAt, ctx.options, ctx.units.length);
  if (limit.stop && limit.code === "UNIT_LIMIT_REACHED") {
    ctx.omittedRecords += 1;
    return;
  }
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    ctx.diagnostics.push(diagnostic(limit.code, limit.message, ctx.input.documentId, "info"));
    ctx.stopped = true;
    return;
  }
  const span = appendNormalizedRecord(ctx, pointer, text, row);
  ctx.units.push({
    kind: "json-path",
    documentId: ctx.input.documentId,
    jsonPointer: pointer,
    characterStart: span.start,
    characterEnd: span.end,
  });
}

function isContainer(value: JsonValue): value is JsonArray | JsonObject {
  return value !== null && typeof value === "object" && value.kind !== "exact-number";
}

function isEmptyContainer(value: JsonValue): boolean {
  if (!isContainer(value)) return false;
  return value.kind === "array" ? value.items.length === 0 : value.entries.length === 0;
}

function isScalarOrEmpty(value: JsonValue): boolean {
  return !isContainer(value) || isEmptyContainer(value);
}

// Scalars read as their value, an empty container as `[]` / `{}`, a flat array as `[a, b]`.
function projectionOf(value: JsonValue): string {
  if (!isContainer(value)) return scalarText(value);
  if (value.kind === "object") return "{}";
  return value.items.length === 0
    ? "[]"
    : `[${value.items.map((item) => projectionOf(item)).join(", ")}]`;
}

// Body-free: a document key or value must never reach a persisted diagnostic.
function nestingDiagnostic(
  options: ParserOptions,
  documentId: DocumentId,
  severity: ParserDiagnostic["severity"],
): ParserDiagnostic {
  return diagnostic(
    "NESTING_LIMIT_REACHED",
    `JSON nesting depth exceeds maxNestingDepth=${String(options.maxNestingDepth)}`,
    documentId,
    severity,
  );
}

function pushNestingLimit(ctx: ScanContext): void {
  ctx.diagnostics.push(nestingDiagnostic(ctx.options, ctx.input.documentId, "error"));
  // Per-record signal: walk()/descendArray()/descendObject() short-circuit on it, but
  // walkJsonLines resets it between records so later valid JSONL lines still parse.
  ctx.nestingStopped = true;
}

function descendArray(ctx: ScanContext, value: JsonArray, pointer: string, depth: number): void {
  if (value.items.length === 0) {
    pushRecord(ctx, pointer, "[]");
    return;
  }
  if (value.items.every((item) => isScalarOrEmpty(item))) {
    pushRecord(ctx, pointer, projectionOf(value));
    return;
  }
  for (const [index, item] of value.items.entries()) {
    if (ctx.stopped || ctx.nestingStopped) return;
    walk(ctx, item, joinPointer(pointer, String(index)), depth + 1, {
      parent: pointer,
      number: index + 1,
    });
  }
}

function isValueList(value: JsonValue): value is JsonArray {
  return (
    isContainer(value) &&
    value.kind === "array" &&
    value.items.length > 0 &&
    value.items.every((item) => isScalarOrEmpty(item))
  );
}

/** Whether the child's values read in the row of an array element instead of a record of its own. */
function staysInRow(child: JsonValue, row: RowRef | undefined): boolean {
  return isScalarOrEmpty(child) || (row !== undefined && isValueList(child));
}

function isNonEmptyObject(value: JsonValue): value is JsonObject {
  return isContainer(value) && value.kind === "object" && !isEmptyContainer(value);
}

/**
 * The fields of a record. In a row, a list of values repeats its label, one field per value, and the
 * fields of an object stay in the row under a dotted label, so they stay with the row's identifier.
 */
function objectScalarFields(
  value: JsonObject,
  row: RowRef | undefined,
  prefix = "",
): readonly string[] {
  return value.entries.flatMap(([key, child]) => {
    const label = `${prefix}${cleanHeaderLabel(key)}`;
    if (row !== undefined && isNonEmptyObject(child)) {
      return objectScalarFields(child, row, `${label}.`);
    }
    if (!staysInRow(child, row)) return [];
    const values = isValueList(child) ? child.items : [child];
    return values.map((item) => `${label}=${projectionOf(item)}`);
  });
}

/** Walks what the fields of the record leave out: its nested records. */
function walkNestedRecords(
  ctx: ScanContext,
  value: JsonObject,
  pointer: string,
  depth: number,
  row: RowRef | undefined,
): void {
  for (const [key, child] of value.entries) {
    if (ctx.stopped || ctx.nestingStopped) return;
    const childPointer = joinPointer(pointer, encodePointerSegment(key));
    if (row !== undefined && isNonEmptyObject(child)) {
      walkNestedRecords(ctx, child, childPointer, depth + 1, row);
    } else if (!staysInRow(child, row)) {
      walk(ctx, child, childPointer, depth + 1);
    }
  }
}

function descendObject(
  ctx: ScanContext,
  value: JsonObject,
  pointer: string,
  depth: number,
  row: RowRef | undefined,
): void {
  if (value.entries.length === 0) {
    pushRecord(ctx, pointer, "{}");
    return;
  }
  const fields = objectScalarFields(value, row);
  if (fields.length > 0) {
    pushRecord(ctx, pointer, fields.join(" | "), row);
    if (ctx.stopped || ctx.nestingStopped) return;
  }
  walkNestedRecords(ctx, value, pointer, depth, row);
}

function walk(
  ctx: ScanContext,
  value: JsonValue,
  pointer: string,
  depth: number,
  row?: RowRef,
): void {
  if (ctx.stopped || ctx.nestingStopped) return;
  if (isScalarOrEmpty(value)) {
    pushRecord(ctx, pointer, projectionOf(value));
    return;
  }
  if (depth >= ctx.options.maxNestingDepth) {
    pushNestingLimit(ctx);
    return;
  }
  if (!isContainer(value)) return;
  if (value.kind === "array") descendArray(ctx, value, pointer, depth);
  else descendObject(ctx, value, pointer, depth, row);
}

// A malformed document is reported by closed reason and position only; the engine's own message
// embeds a fragment of the text and is never used.
function failureDiagnostic(
  failure: ReadFailure,
  documentId: DocumentId,
  scope: string,
  severity: ParserDiagnostic["severity"],
  // A JSONL record is one line, so only the column locates the failure inside it.
  locateLine = true,
): ParserDiagnostic {
  const column = `column ${String(failure.column)}`;
  const place = locateLine ? `line ${String(failure.line)}, ${column}` : column;
  return diagnostic(
    "MALFORMED_INPUT",
    `${scope} parse failed: ${failure.reason} at ${place}`,
    documentId,
    severity,
  );
}

// GRD-011: JSON Lines / NDJSON is a sequence of independent JSON values, one per line — NOT a
// single JSON document. Whole-document parsing always fails on a multi-record file, so
// `.jsonl`/`.ndjson` (advertised as supported) were 100% unparseable. Detect and parse per line.
const JSONL_EXTENSIONS: ReadonlySet<string> = new Set(
  LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS.filter((extension) => extension !== "json"),
);
function isJsonLines(input: ParserSelectionInput): boolean {
  if (JSONL_EXTENSIONS.has(input.extension.toLowerCase())) return true;
  return input.mediaType.toLowerCase() === "application/x-ndjson";
}

// Per-line problems ship as `warning`: discovery/extract.ts treats any error-severity diagnostic as
// fatal for the whole document, which JSONL's per-record independence forbids.
function lineFailureDiagnostic(
  ctx: ScanContext,
  failure: ReadFailure,
  index: number,
): ParserDiagnostic {
  if (failure.reason === "nesting-depth") {
    return nestingDiagnostic(ctx.options, ctx.input.documentId, "warning");
  }
  return failureDiagnostic(
    failure,
    ctx.input.documentId,
    `JSONL line ${String(index + 1)}`,
    "warning",
    false,
  );
}

// Extracted so TS's control-flow analysis does not narrow ctx.nestingStopped to the literal
// `false` after the reset assignment — the check after walk() would otherwise be flagged as
// unreachable. walk() mutates the flag through pushNestingLimit, and TS cannot see through
// the function boundary.
function resetLineNestingBail(ctx: ScanContext): void {
  ctx.nestingStopped = false;
}

// PR-review follow-up (Codex thread 3771815015): a per-record JSONL nesting overflow rolls back that
// line's units, but its diagnostic would still ship at severity "error", which makes the whole
// document `failed`. Downgrade the line-scoped diagnostic to "warning"; the whole-document JSON path
// keeps error severity because a single-JSON-document nesting violation IS fatal.
function downgradeLineNestingDiagnostics(ctx: ScanContext, mark: number): void {
  for (let j = mark; j < ctx.diagnostics.length; j += 1) {
    const entry = ctx.diagnostics[j];
    if (entry?.code === "NESTING_LIMIT_REACHED") {
      ctx.diagnostics[j] = { ...entry, severity: "warning" };
    }
  }
}

// Snapshot the per-record units and normalized-text position BEFORE walking so a nesting overflow
// rolls back any partial output for THIS line (a hostile row of the shape
// `{"visible":"x","deep":<deeply nested>}` must not index its shallow field).
function walkLineRolledBack(ctx: ScanContext, value: JsonValue, index: number): void {
  const unitsMark = ctx.units.length;
  const normalizedPartsMark = ctx.normalizedParts.length;
  const normalizedLengthMark = ctx.normalizedLength;
  const diagnosticsMark = ctx.diagnostics.length;
  const omittedMark = ctx.omittedRecords;
  walk(ctx, value, joinPointer("", String(index)), 0, { parent: "", number: index + 1 });
  if (!ctx.nestingStopped) return;
  ctx.units.length = unitsMark;
  ctx.normalizedParts.length = normalizedPartsMark;
  ctx.normalizedLength = normalizedLengthMark;
  ctx.omittedRecords = omittedMark;
  downgradeLineNestingDiagnostics(ctx, diagnosticsMark);
}

// Parse each non-empty line independently and walk it under an `/<lineIndex>` pointer prefix
// (RFC 6901 array-index style), so a record on file line N cites as `/N/...`. A malformed line
// is surfaced as a non-fatal `warning` diagnostic and skipped — one bad line never discards the
// whole file's good records. Returns the number of repeated object keys seen.
function walkJsonLines(ctx: ScanContext): number {
  let duplicateKeys = 0;
  for (const [index, raw] of ctx.text.split("\n").entries()) {
    if (ctx.stopped) break;
    // Clear the per-record nesting bail from any earlier line so a deeply-nested record does
    // not silently discard every valid record that follows (PR-review follow-up on KEIKO-0484).
    resetLineNestingBail(ctx);
    if (raw.trim().length === 0) continue;
    const parsed = readJson(raw, ctx.options.maxNestingDepth);
    if (!parsed.ok) {
      ctx.diagnostics.push(lineFailureDiagnostic(ctx, parsed, index));
      continue;
    }
    duplicateKeys += parsed.duplicateKeyCount;
    walkLineRolledBack(ctx, parsed.value, index);
  }
  return duplicateKeys;
}

function duplicateKeyDiagnostic(count: number, documentId: DocumentId): ParserDiagnostic {
  return diagnostic(
    "JSON_DUPLICATE_KEY",
    `${String(count)} repeated object key(s); every value is kept in document order`,
    documentId,
    "warning",
  );
}

// Reaching the unit cap drops records from the index, so it is a warning that says how many.
function unitCapDiagnostic(ctx: ScanContext): ParserDiagnostic {
  return diagnostic(
    "UNIT_LIMIT_REACHED",
    `reached maxUnitsPerDocument=${String(ctx.options.maxUnitsPerDocument)}; ${String(ctx.omittedRecords)} further record(s) were not indexed`,
    ctx.input.documentId,
    "warning",
  );
}

function newContext(
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
): ScanContext {
  return {
    text,
    input,
    options,
    startedAt: options.now(),
    units: [],
    diagnostics: [],
    normalizedParts: [],
    normalizedLength: 0,
    stopped: false,
    omittedRecords: 0,
    nestingStopped: false,
  };
}

function failedDocument(
  failure: ReadFailure,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult {
  const entry =
    failure.reason === "nesting-depth"
      ? nestingDiagnostic(options, input.documentId, "error")
      : failureDiagnostic(failure, input.documentId, "JSON", "error");
  return emptyResult(jsonParser.capability, input.documentId, options, [entry]);
}

function resultOf(
  ctx: ScanContext,
  decoded: DecodedText,
  duplicateKeys: number,
): InternalParserResult {
  const encoding = encodingDiagnostic(decoded, ctx.input.documentId);
  const diagnostics = [
    ...(encoding === undefined ? [] : [encoding]),
    ...(duplicateKeys > 0 ? [duplicateKeyDiagnostic(duplicateKeys, ctx.input.documentId)] : []),
    ...ctx.diagnostics,
    ...(ctx.omittedRecords > 0 ? [unitCapDiagnostic(ctx)] : []),
  ];
  return {
    ...emptyResult(
      jsonParser.capability,
      ctx.input.documentId,
      ctx.options,
      diagnostics,
      ctx.units,
    ),
    normalizedText: ctx.normalizedParts.join(""),
  } satisfies InternalParserResult;
}

// A whole-document nesting violation invalidates a single-JSON-document parse (the top-level value
// is one thing, and it is malformed). JSONL keeps the units of every other line.
function parseDocument(
  decoded: DecodedText,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult {
  const ctx = newContext(decoded.text, input, options);
  if (isJsonLines(input)) return resultOf(ctx, decoded, walkJsonLines(ctx));
  const parsed = readJson(decoded.text, options.maxNestingDepth);
  if (!parsed.ok) return failedDocument(parsed, input, options);
  walk(ctx, parsed.value, "", 0);
  if (ctx.nestingStopped) {
    return emptyResult(jsonParser.capability, input.documentId, options, ctx.diagnostics);
  }
  return resultOf(ctx, decoded, parsed.duplicateKeyCount);
}

export const jsonParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isJson(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    const byteLimit = textByteLimit(options, JSON_MAX_BYTES);
    if (input.bytes.byteLength > byteLimit) {
      return emptyResult(jsonParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, byteLimit),
      ]);
    }
    const binary = binaryContentRefusal(jsonParser.capability, input, options);
    if (binary !== undefined) return binary;
    return parseDocument(decodeUtf8(input.bytes), input, options);
  },
});
