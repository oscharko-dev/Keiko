// JSON parser adapter (Epic #189, Issue #266). Pure: bytes -> ParserResult.
//
// Emits one ParsedUnit { kind: "json-path", jsonPointer } per logical record. Objects keep
// sibling scalar fields together, arrays of objects emit one unit per element, and primitive
// / empty values still emit a unit at their own pointer. Pointers follow RFC 6901 — keys are
// encoded with `~0` for `~` and `~1` for `/`.
//
// Character offsets target a normalized line-oriented projection, not the raw JSON bytes:
//   /json/pointer: <leaf-json>
// This keeps downstream chunking bounded by the selected leaf instead of multiplying the whole
// document once per leaf while preserving the JSON Pointer citation.

import {
  decodeUtf8,
  diagnostic,
  emptyResult,
  oversizeDiagnostic,
  shouldStop,
} from "./_internal.js";
import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "json";
const PARSER_VERSION = "1";

const JSON_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS);

function isJson(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (JSON_EXTENSIONS.has(ext)) return true;
  const media = input.mediaType.toLowerCase();
  return media === "application/json" || media === "application/ld+json";
}

function encodePointerSegment(key: string): string {
  // RFC 6901: `~` -> `~0`, `/` -> `~1`. Order matters: replace `~` first.
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function joinPointer(parent: string, segment: string): string {
  return `${parent}/${segment}`;
}

interface ScanContext {
  readonly text: string;
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  readonly normalizedParts: string[];
  normalizedLength: number;
  stopped: boolean;
}

function stringifyValue(value: unknown): string {
  return JSON.stringify(value);
}

function appendNormalizedRecord(
  ctx: ScanContext,
  pointer: string,
  text: string,
): { readonly start: number; readonly end: number } {
  const label = pointer.length === 0 ? "/" : pointer;
  const line = `${label}: ${text}\n`;
  const start = ctx.normalizedLength;
  ctx.normalizedParts.push(line);
  ctx.normalizedLength += line.length;
  return { start, end: ctx.normalizedLength };
}

function pushRecord(ctx: ScanContext, pointer: string, text: string): void {
  const limit = shouldStop(ctx.startedAt, ctx.options, ctx.units.length);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    ctx.diagnostics.push(diagnostic(limit.code, limit.message, ctx.input.documentId, "info"));
    ctx.stopped = true;
    return;
  }
  const span = appendNormalizedRecord(ctx, pointer, text);
  ctx.units.push({
    kind: "json-path",
    documentId: ctx.input.documentId,
    jsonPointer: pointer,
    characterStart: span.start,
    characterEnd: span.end,
  });
}

function isScalar(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === "object" && Object.keys(value).length === 0;
}

function isScalarOrEmpty(value: unknown): boolean {
  return isScalar(value) || isEmptyContainer(value);
}

function scalarProjection(value: unknown): string {
  return stringifyValue(value);
}

function pushNestingLimit(ctx: ScanContext, pointer: string): void {
  const displayPointer = pointer.length === 0 ? "/" : pointer;
  ctx.diagnostics.push(
    diagnostic(
      "NESTING_LIMIT_REACHED",
      `JSON nesting depth exceeds maxNestingDepth=${String(ctx.options.maxNestingDepth)} at ${displayPointer}`,
      ctx.input.documentId,
      "error",
    ),
  );
  ctx.stopped = true;
}

function descendArray(
  ctx: ScanContext,
  value: readonly unknown[],
  pointer: string,
  depth: number,
): void {
  if (value.length === 0) {
    pushRecord(ctx, pointer, "[]");
    return;
  }
  if (value.every(isScalarOrEmpty)) {
    pushRecord(ctx, pointer, scalarProjection(value));
    return;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (ctx.stopped) return;
    walk(ctx, value[i], joinPointer(pointer, String(i)), depth + 1);
  }
}

function objectScalarFields(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value)
    .filter((key) => isScalarOrEmpty(value[key]))
    .map((key) => `${key}=${scalarProjection(value[key])}`);
}

function descendObject(
  ctx: ScanContext,
  value: Record<string, unknown>,
  pointer: string,
  depth: number,
): void {
  const keys = Object.keys(value);
  if (keys.length === 0) {
    pushRecord(ctx, pointer, "{}");
    return;
  }
  const fields = objectScalarFields(value);
  if (fields.length > 0) {
    pushRecord(ctx, pointer, fields.join(" | "));
    if (ctx.stopped) return;
  }
  for (const key of Object.keys(value)) {
    if (ctx.stopped) return;
    const child = value[key];
    if (isScalarOrEmpty(child)) continue;
    walk(ctx, child, joinPointer(pointer, encodePointerSegment(key)), depth + 1);
  }
}

function walk(ctx: ScanContext, value: unknown, pointer: string, depth: number): void {
  if (ctx.stopped) return;
  if (isScalarOrEmpty(value)) {
    pushRecord(ctx, pointer, scalarProjection(value));
    return;
  }
  if (depth >= ctx.options.maxNestingDepth) {
    pushNestingLimit(ctx, pointer);
    return;
  }
  if (Array.isArray(value)) {
    descendArray(ctx, value, pointer, depth);
    return;
  }
  descendObject(ctx, value as Record<string, unknown>, pointer, depth);
}

function parseJsonValue(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    // Return only the error TYPE name, never the raw parser message. Modern Node embeds a
    // fragment of the surrounding document text in JSON.parse error messages, which would
    // leak indexed content into the persisted diagnostic surfaced in the capsule detail UI.
    return { ok: false, error: error instanceof Error ? error.name : "SyntaxError" };
  }
}

// GRD-011: JSON Lines / NDJSON is a sequence of independent JSON values, one per line — NOT a
// single JSON document. Whole-document `JSON.parse` always throws on a multi-record file, so
// `.jsonl`/`.ndjson` (advertised as supported) were 100% unparseable. Detect and parse per line.
const JSONL_EXTENSIONS: ReadonlySet<string> = new Set(
  LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS.filter((extension) => extension !== "json"),
);
function isJsonLines(input: ParserSelectionInput): boolean {
  if (JSONL_EXTENSIONS.has(input.extension.toLowerCase())) return true;
  return input.mediaType.toLowerCase() === "application/x-ndjson";
}

// Parse each non-empty line independently and walk it under an `/<lineIndex>` pointer prefix
// (RFC 6901 array-index style), so a record on file line N cites as `/N/...`. A malformed line
// is surfaced as a non-fatal `warning` diagnostic and skipped — one bad line never discards the
// whole file's good records.
function walkJsonLines(ctx: ScanContext): void {
  const lines = ctx.text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (ctx.stopped) return;
    const raw = lines[i];
    if (raw === undefined || raw.trim().length === 0) continue;
    const parsed = parseJsonValue(raw);
    if (!parsed.ok) {
      ctx.diagnostics.push(
        diagnostic(
          "MALFORMED_INPUT",
          `JSONL line ${String(i)} parse failed: ${parsed.error}`,
          ctx.input.documentId,
          "warning",
        ),
      );
      continue;
    }
    walk(ctx, parsed.value, joinPointer("", String(i)), 0);
  }
}

export const jsonParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isJson(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(jsonParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    const decoded = decodeUtf8(input.bytes);
    const jsonLines = isJsonLines(input);
    // Whole-document parse only for true JSON; JSONL is parsed line-by-line below.
    const parsed = jsonLines ? undefined : parseJsonValue(decoded.text);
    if (parsed !== undefined && !parsed.ok) {
      return emptyResult(jsonParser.capability, input.documentId, options, [
        diagnostic(
          "MALFORMED_INPUT",
          `JSON parse failed: ${parsed.error}`,
          input.documentId,
          "error",
        ),
      ]);
    }
    const ctx: ScanContext = {
      text: decoded.text,
      input,
      options,
      startedAt: options.now(),
      units: [],
      diagnostics: [],
      normalizedParts: [],
      normalizedLength: 0,
      stopped: false,
    };
    if (jsonLines) {
      walkJsonLines(ctx);
    } else if (parsed?.ok === true) {
      walk(ctx, parsed.value, "", 0);
    }
    if (ctx.diagnostics.some((diagnostic) => diagnostic.code === "NESTING_LIMIT_REACHED")) {
      return emptyResult(jsonParser.capability, input.documentId, options, ctx.diagnostics);
    }
    return {
      ...emptyResult(jsonParser.capability, input.documentId, options, ctx.diagnostics, ctx.units),
      normalizedText: ctx.normalizedParts.join(""),
    } satisfies InternalParserResult;
  },
});
