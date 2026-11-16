// Strict JSON reader for the JSON parser (#4235). It exists because `JSON.parse` cannot report the
// three facts a knowledge index must not lose silently: an integer beyond 2^53 (it rounds the digits),
// a repeated object key (the first value is discarded), and WHERE a malformed document stops (the
// engine message embeds a fragment of the text). One linear pass yields the value tree together with
// the exact number literals, the duplicate-key count and, on failure, a closed reason plus a line
// and column. No document text ever enters a failure.

export interface JsonExactNumber {
  readonly kind: "exact-number";
  // The literal as written, whenever the double would read differently: `9007199254740993.0`,
  // `1e-400`, `-0`, `1.10`.
  readonly source: string;
}

export interface JsonArray {
  readonly kind: "array";
  readonly items: readonly JsonValue[];
}

export type JsonEntry = readonly [key: string, value: JsonValue];

export interface JsonObject {
  readonly kind: "object";
  // Insertion order; a repeated key keeps every occurrence.
  readonly entries: readonly JsonEntry[];
}

export type JsonValue = null | boolean | number | string | JsonExactNumber | JsonArray | JsonObject;

export type JsonFailureReason =
  | "unexpected-token"
  | "unexpected-end"
  | "invalid-string"
  | "invalid-number"
  | "trailing-content"
  | "nesting-depth";

/** Why a read ended before the end of the document: the value is what was read until then. */
export type JsonReadStop = "value-limit" | "interrupted";

export interface JsonReadLimits {
  /** A container nested deeper (root = depth 0) is refused as `nesting-depth`. */
  readonly maxDepth: number;
  /** The most values the tree may hold; the root is always admitted. */
  readonly maxValues: number;
  /** Asked at the first value and then at regular intervals: the deadline and the cancellation. */
  readonly interrupted?: () => boolean;
}

export type JsonReadResult =
  | {
      readonly ok: true;
      readonly value: JsonValue;
      readonly duplicateKeyCount: number;
      readonly valueCount: number;
      readonly stop?: JsonReadStop;
    }
  | {
      readonly ok: false;
      readonly reason: JsonFailureReason;
      readonly line: number;
      readonly column: number;
    };

// Recursion guard independent of the caller's depth option, so a hostile `[[[[…` cannot exhaust the
// stack even when a very large `maxNestingDepth` is configured.
const HARD_DEPTH_CEILING = 1000;
const SMALL_OBJECT_ENTRIES = 8;
const VALUES_PER_INTERRUPTION_CHECK = 4096;

class JsonReadError extends Error {
  public constructor(
    public readonly reason: JsonFailureReason,
    public readonly offset: number,
  ) {
    super(reason);
    this.name = "JsonReadError";
  }
}

interface Cursor {
  readonly text: string;
  readonly maxDepth: number;
  readonly maxValues: number;
  readonly interrupted: (() => boolean) | undefined;
  position: number;
  duplicateKeyCount: number;
  valueCount: number;
  stop: JsonReadStop | undefined;
}

/** Whether one more value may enter the tree. Refused once, the read ends where it stands. */
function admitsValue(cursor: Cursor): boolean {
  if (cursor.stop !== undefined) return false;
  if (cursor.valueCount >= cursor.maxValues) {
    cursor.stop = "value-limit";
    return false;
  }
  if (cursor.valueCount % VALUES_PER_INTERRUPTION_CHECK === 0 && cursor.interrupted?.() === true) {
    cursor.stop = "interrupted";
    return false;
  }
  cursor.valueCount += 1;
  return true;
}

function code(cursor: Cursor): number {
  return cursor.text.codePointAt(cursor.position) ?? Number.NaN;
}

function skipWhitespace(cursor: Cursor): void {
  for (;;) {
    const current = code(cursor);
    if (current !== 0x20 && current !== 0x09 && current !== 0x0a && current !== 0x0d) return;
    cursor.position += 1;
  }
}

function fail(cursor: Cursor, reason: JsonFailureReason): never {
  throw new JsonReadError(
    Number.isNaN(code(cursor)) && reason === "unexpected-token" ? "unexpected-end" : reason,
    cursor.position,
  );
}

function expectCode(cursor: Cursor, expected: number): void {
  if (code(cursor) !== expected) fail(cursor, "unexpected-token");
  cursor.position += 1;
}

// A string without escapes is a plain slice; one with escapes is decoded by the engine on the
// already delimited slice, which validates the escape grammar.
function readString(cursor: Cursor): string {
  const start = cursor.position + 1;
  let index = start;
  let escaped = false;
  for (;;) {
    const current = cursor.text.codePointAt(index) ?? Number.NaN;
    if (Number.isNaN(current)) throw new JsonReadError("unexpected-end", index);
    if (current === 0x22) break;
    if (current < 0x20) throw new JsonReadError("invalid-string", index);
    if (current === 0x5c) {
      escaped = true;
      index += 1;
    }
    index += 1;
  }
  cursor.position = index + 1;
  const raw = cursor.text.slice(start, index);
  if (!escaped) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    throw new JsonReadError("invalid-string", start);
  }
}

function skipDigits(cursor: Cursor): number {
  const start = cursor.position;
  for (;;) {
    const current = code(cursor);
    if (!(current >= 0x30 && current <= 0x39)) return cursor.position - start;
    cursor.position += 1;
  }
}

function skipIntegerPart(cursor: Cursor): void {
  if (code(cursor) === 0x30) {
    cursor.position += 1;
    return;
  }
  if (skipDigits(cursor) === 0) fail(cursor, "invalid-number");
}

function skipFraction(cursor: Cursor): void {
  if (code(cursor) !== 0x2e) return;
  cursor.position += 1;
  if (skipDigits(cursor) === 0) fail(cursor, "invalid-number");
}

function skipExponent(cursor: Cursor): void {
  if (code(cursor) !== 0x65 && code(cursor) !== 0x45) return;
  cursor.position += 1;
  if (code(cursor) === 0x2b || code(cursor) === 0x2d) cursor.position += 1;
  if (skipDigits(cursor) === 0) fail(cursor, "invalid-number");
}

function readNumber(cursor: Cursor): number | JsonExactNumber {
  const start = cursor.position;
  if (code(cursor) === 0x2d) cursor.position += 1;
  skipIntegerPart(cursor);
  skipFraction(cursor);
  skipExponent(cursor);
  const source = cursor.text.slice(start, cursor.position);
  const value = Number(source);
  // Only a number the double writes back to the same token is the same number to a reader.
  return String(value) === source ? value : { kind: "exact-number", source };
}

function readLiteral(cursor: Cursor, word: string, value: boolean | null): boolean | null {
  if (!cursor.text.startsWith(word, cursor.position)) fail(cursor, "unexpected-token");
  cursor.position += word.length;
  return value;
}

function hasKey(
  entries: readonly JsonEntry[],
  seen: Set<string> | undefined,
  key: string,
): boolean {
  return seen === undefined ? entries.some((entry) => entry[0] === key) : seen.has(key);
}

function readObject(cursor: Cursor, depth: number): JsonObject {
  cursor.position += 1;
  const entries: JsonEntry[] = [];
  let seen: Set<string> | undefined;
  skipWhitespace(cursor);
  if (code(cursor) === 0x7d) {
    cursor.position += 1;
    return { kind: "object", entries };
  }
  for (;;) {
    skipWhitespace(cursor);
    if (code(cursor) !== 0x22) fail(cursor, "unexpected-token");
    const key = readString(cursor);
    skipWhitespace(cursor);
    expectCode(cursor, 0x3a);
    if (!admitsValue(cursor)) break;
    if (hasKey(entries, seen, key)) cursor.duplicateKeyCount += 1;
    entries.push([key, readValue(cursor, depth + 1)]);
    if (seen !== undefined) seen.add(key);
    else if (entries.length > SMALL_OBJECT_ENTRIES)
      seen = new Set(entries.map((entry) => entry[0]));
    if (cursor.stop !== undefined) break;
    skipWhitespace(cursor);
    if (code(cursor) === 0x7d) break;
    expectCode(cursor, 0x2c);
  }
  cursor.position += 1;
  return { kind: "object", entries };
}

function readArray(cursor: Cursor, depth: number): JsonArray {
  cursor.position += 1;
  const items: JsonValue[] = [];
  skipWhitespace(cursor);
  if (code(cursor) === 0x5d) {
    cursor.position += 1;
    return { kind: "array", items };
  }
  for (;;) {
    if (!admitsValue(cursor)) break;
    items.push(readValue(cursor, depth + 1));
    if (cursor.stop !== undefined) break;
    skipWhitespace(cursor);
    if (code(cursor) === 0x5d) break;
    expectCode(cursor, 0x2c);
  }
  cursor.position += 1;
  return { kind: "array", items };
}

function readScalar(cursor: Cursor, current: number): JsonValue {
  if (current === 0x22) return readString(cursor);
  if (current === 0x74) return readLiteral(cursor, "true", true);
  if (current === 0x66) return readLiteral(cursor, "false", false);
  if (current === 0x6e) return readLiteral(cursor, "null", null);
  if (current === 0x2d || (current >= 0x30 && current <= 0x39)) return readNumber(cursor);
  return fail(cursor, "unexpected-token");
}

function readValue(cursor: Cursor, depth: number): JsonValue {
  skipWhitespace(cursor);
  const current = code(cursor);
  if (current !== 0x7b && current !== 0x5b) return readScalar(cursor, current);
  if (depth > cursor.maxDepth) fail(cursor, "nesting-depth");
  return current === 0x7b ? readObject(cursor, depth) : readArray(cursor, depth);
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  let at = text.indexOf("\n");
  while (at !== -1 && at < offset) {
    line += 1;
    lineStart = at + 1;
    at = text.indexOf("\n", lineStart);
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Reads one JSON document, without recursing deeper than the caller is willing to walk and without
 * allocating past its allowance: a read stopped by the allowance or by an interruption returns what
 * it has read, says so, and has not looked at the rest of the document.
 */
export function readJson(text: string, limits: JsonReadLimits): JsonReadResult {
  const cursor: Cursor = {
    text,
    maxDepth: Math.min(limits.maxDepth, HARD_DEPTH_CEILING),
    maxValues: Math.max(1, limits.maxValues),
    interrupted: limits.interrupted,
    position: 0,
    duplicateKeyCount: 0,
    valueCount: 0,
    stop: undefined,
  };
  try {
    admitsValue(cursor);
    const value = cursor.stop === undefined ? readValue(cursor, 0) : null;
    return finishedRead(cursor, value);
  } catch (error) {
    if (!(error instanceof JsonReadError)) throw error;
    return { ok: false, reason: error.reason, ...lineAndColumn(text, error.offset) };
  }
}

function finishedRead(cursor: Cursor, value: JsonValue): JsonReadResult {
  const read = {
    ok: true as const,
    value,
    duplicateKeyCount: cursor.duplicateKeyCount,
    valueCount: cursor.valueCount,
  };
  if (cursor.stop !== undefined) return { ...read, stop: cursor.stop };
  skipWhitespace(cursor);
  if (cursor.position < cursor.text.length) fail(cursor, "trailing-content");
  return read;
}
