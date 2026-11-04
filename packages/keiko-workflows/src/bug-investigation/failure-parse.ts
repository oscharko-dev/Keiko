// Failure-output parsing (ADR-0009 D7, NEW seam). Extracts candidate source frames and short
// error/assertion messages from a bug report's failingOutput + stackTrace, and merges the
// developer-provided targetFiles as line-less seed frames. The extracted frames are VERIFIED FACTS
// (what the tool parsed, not a model claim) and seed both context selection (D8) and the report.
//
// SECURITY (CodeQL js/polynomial-redos, steering note F): failure output is attacker-influenceable
// (a failing test can print arbitrary text), so this parser uses ONLY bounded, line-oriented string
// ops — split('\n'), indexOf/lastIndexOf, slice, a right-split on ':', and an all-digit check. The
// single regex used (ALL_DIGITS) is a bounded character class with NO nested quantifiers and NO
// `.*` alternation, so there is no super-linear backtracking surface. Line count and per-line work
// are both capped. Pure: no IO, no clock, no RNG.

import { fileURLToPath } from "node:url";
import { toPosix } from "./path-utils.js";
import type { BugReportInput, FailureEvidence, FailureFrame } from "./types.js";

// Caps that bound total work regardless of input size.
const MAX_LINES_SCANNED = 2_000;
export const MAX_FRAMES = 25;
const MAX_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 200;

const ALL_DIGITS = /^\d+$/;
const FILE_URL_PREFIX = "file://";
const MAX_URL_LOCATION_CHARACTERS = 8_192;
const MESSAGE_MARKERS: readonly string[] = [
  "assertionerror",
  "error:",
  "expected",
  "typeerror",
  "referenceerror",
  "✕",
  "×",
  "fail",
  "●",
];

// Parses a numeric line number from a token, or undefined when the token is not all-digits.
function toLine(token: string | undefined): number | undefined {
  if (token === undefined || token.length === 0 || !ALL_DIGITS.test(token)) {
    return undefined;
  }
  const number = Number(token);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

// Runtime URLs retain their identity until their numeric suffix has been peeled. Ordinary
// filesystem spellings, including literal percent characters, never acquire URL semantics.
function sourceFile(location: string): string | undefined {
  if (!location.startsWith(FILE_URL_PREFIX)) {
    return toPosix(location);
  }
  try {
    if (location.length > MAX_URL_LOCATION_CHARACTERS) return undefined;
    const url = new URL(location);
    if (url.hostname !== "" || url.pathname.toLowerCase().includes("%5c")) return undefined;
    const file = fileURLToPath(url, { windows: /^\/[A-Za-z]:\//u.test(url.pathname) });
    return file.includes("\0") ? undefined : toPosix(file);
  } catch {
    return undefined;
  }
}

function sourceFrame(location: string, line: number): FailureFrame | undefined {
  const file = sourceFile(location);
  return file === undefined || file.length === 0 ? undefined : { file, line };
}

// Characters that may follow a `:line[:col]` suffix: the end of the token or a separator of the
// surrounding output (`file:12: message`, `file:12:5: message`, `file:15 +0x1d`, `(file:3:4)`).
const LOCATION_BOUNDARIES: ReadonlySet<string> = new Set([" ", "\t", ":", ",", ")", "]"]);
const HAS_LETTER = /\p{L}/u;

function digitRunEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text.charAt(end) >= "0" && text.charAt(end) <= "9") end += 1;
  return end;
}

// The line of a `:line[:col]` suffix that begins at `colon`, or undefined when the text there is
// not one. The suffix must end the token or sit before a separator, so a message such as
// `file:12:5: E assert` keeps its line and a path such as `host:3000/a.js` is not cut at the port.
function lineAfterColon(location: string, colon: number): number | undefined {
  const lineEnd = digitRunEnd(location, colon + 1);
  if (lineEnd === colon + 1) return undefined;
  let end = lineEnd;
  if (location.charAt(end) === ":") {
    const columnEnd = digitRunEnd(location, end + 1);
    if (columnEnd > end + 1) end = columnEnd;
  }
  if (end < location.length && !LOCATION_BOUNDARIES.has(location.charAt(end))) return undefined;
  return toLine(location.slice(colon + 1, lineEnd));
}

// A source file names letters. A bare output line additionally has to look like a path, not like
// the clock time, date or URL that a log prints before its message: no blanks, a directory or
// extension separator, and no non-`file:` URL scheme. A location delimited by `at ` or
// parentheses already declares itself a location, so it may hold blanks.
function plausibleSourceFile(file: string, delimited: boolean): boolean {
  if (file.length === 0 || file.includes("\0") || !HAS_LETTER.test(file)) return false;
  if (delimited) return true;
  if (/\s/u.test(file) || !/[./\\]/u.test(file)) return false;
  return !file.includes("://") || file.startsWith(FILE_URL_PREFIX);
}

// Peels `:line[:col]` off a location token: the first colon that starts a well-formed suffix splits
// the file from its line. `src/x.ts:3:10` -> { file: "src/x.ts", line: 3 }. A token with no
// numeric `:line` suffix yields no frame.
function peelLocation(rawLocation: string, delimited: boolean): FailureFrame | undefined {
  const location = rawLocation.trim();
  for (
    let colon = location.indexOf(":", 1);
    colon !== -1;
    colon = location.indexOf(":", colon + 1)
  ) {
    const line = lineAfterColon(location, colon);
    if (line === undefined) continue;
    const file = location.slice(0, colon);
    return plausibleSourceFile(file, delimited) ? sourceFrame(file, line) : undefined;
  }
  return undefined;
}

interface LocationToken {
  readonly text: string;
  // True when the line itself marks the token as a location (`at …`, `(…)`), not a bare line.
  readonly delimited: boolean;
}

// Extracts the location token from a stack-frame line. Handles `at fn (loc)`, `at [async] loc`, and
// a bare `loc` line, all via plain indexOf/slice (no regex).
function locationToken(line: string): LocationToken {
  const trimmed = line.trim();
  const open = trimmed.lastIndexOf("(");
  if (open !== -1) {
    const close = trimmed.indexOf(")", open + 1);
    if (close !== -1) {
      return { text: trimmed.slice(open + 1, close), delimited: true };
    }
  }
  const at = "at ";
  if (trimmed.startsWith(at)) {
    const rest = trimmed.slice(at.length).trim();
    return { text: rest.startsWith("async ") ? rest.slice(6).trim() : rest, delimited: true };
  }
  // `AssertionError at src/x.ts:1:2` names its location after the message. The text after the last
  // ` at ` is judged like a bare line, so `failed at 12:30:45` stays a clock time.
  const inlineAt = trimmed.lastIndexOf(" at ");
  return { text: inlineAt === -1 ? trimmed : trimmed.slice(inlineAt + 4), delimited: false };
}

function isControlSequenceEnd(code: number | undefined): boolean {
  return code !== undefined && code >= 0x40 && code <= 0x7e;
}

// Removes ANSI CSI escape sequences (colour and cursor codes) so that coloured test output reads as
// the plain text it colours. A single forward scan: no regex, no backtracking.
function stripAnsi(line: string): string {
  if (!line.includes("\u001b")) return line;
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (line.charAt(index) !== "\u001b") {
      out += line.charAt(index);
      index += 1;
    } else if (line.charAt(index + 1) === "[") {
      index += 2;
      while (index < line.length && !isControlSequenceEnd(line.codePointAt(index))) {
        index += 1;
      }
      index += 1;
    } else {
      index += 1;
    }
  }
  return out;
}

function isMessageLine(lower: string): boolean {
  return MESSAGE_MARKERS.some((marker) => lower.includes(marker));
}

interface Accumulator {
  readonly frames: FailureFrame[];
  readonly messages: string[];
  readonly seen: Set<string>;
}

function pushFrame(acc: Accumulator, frame: FailureFrame): void {
  const key = `${frame.file}:${frame.line === undefined ? "" : String(frame.line)}`;
  if (acc.seen.has(key) || acc.frames.length >= MAX_FRAMES) {
    return;
  }
  acc.seen.add(key);
  acc.frames.push(frame);
}

function pushMessage(acc: Accumulator, line: string): void {
  if (acc.messages.length >= MAX_MESSAGES) {
    return;
  }
  acc.messages.push(line.trim().slice(0, MAX_MESSAGE_LENGTH));
}

function scanLine(acc: Accumulator, rawLine: string): void {
  const line = stripAnsi(rawLine);
  const frame = parseFailureFrame(line);
  if (frame !== undefined) {
    pushFrame(acc, frame);
  }
  if (isMessageLine(line.toLowerCase())) {
    pushMessage(acc, line);
  }
}

function pythonFrame(line: string): FailureFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('File "')) return undefined;
  const close = trimmed.indexOf('"', 6);
  if (close === -1) return undefined;
  const suffix = trimmed.slice(close + 1).trimStart();
  if (!suffix.startsWith(", line ")) return undefined;
  const token = suffix.slice(7).split(",", 1)[0]?.trim();
  const number = toLine(token);
  return number === undefined
    ? undefined
    : { file: toPosix(trimmed.slice(6, close)), line: number };
}

/** ADR-0009 D7: chat and bug investigation share the same bounded source-location parser. */
export function parseFailureFrame(rawLine: string): FailureFrame | undefined {
  const line = stripAnsi(rawLine);
  const python = pythonFrame(line);
  if (python !== undefined) return python;
  const token = locationToken(withoutOutputMarker(line));
  return peelLocation(token.text, token.delimited);
}

// The glyph a test runner or compiler puts in front of a location (vitest `❯ `, rustc `--> `).
function withoutOutputMarker(line: string): string {
  const trimmed = line.trimStart();
  for (const marker of ["❯ ", "--> "]) {
    if (trimmed.startsWith(marker)) return trimmed.slice(marker.length);
  }
  return line;
}

export interface DiagnosticTraceText {
  readonly frames: readonly FailureFrame[];
  readonly questionText: string;
  readonly detected: boolean;
}

function hasTracePrefix(line: string): boolean {
  return line.startsWith("at ") || line.startsWith('File "') || line.startsWith("❯ ");
}

function unparsedTraceLine(line: string): boolean {
  return (
    hasTracePrefix(line) ||
    (!line.includes(" ") && line.includes(":") && ALL_DIGITS.test(line.slice(-1)))
  );
}

function diagnosticTraceLine(
  line: string,
  frame: FailureFrame | undefined,
  scanned: number,
): boolean {
  return (
    (frame !== undefined && (hasTracePrefix(line) || !line.includes(" "))) ||
    (scanned >= MAX_LINES_SCANNED && unparsedTraceLine(line))
  );
}

/** Source locations and assertion output stay separate from the human's request terms. */
export function parseDiagnosticTraceText(text: string): DiagnosticTraceText {
  const acc: Accumulator = { frames: [], messages: [], seen: new Set() };
  const question: string[] = [];
  let start = 0;
  let scanned = 0;
  let detected = false;
  // Only source-location parsing is capped. Continue a linear pass over the admitted request
  // to preserve human terms after a long trace or blank prefix, without admitting later frames.
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    const trimmed = line.trim();
    const frame = scanned < MAX_LINES_SCANNED ? parseFailureFrame(line) : undefined;
    const traceLine = diagnosticTraceLine(trimmed, frame, scanned);
    if (traceLine) {
      detected = true;
      if (frame !== undefined) pushFrame(acc, frame);
    } else if (!trimmed.startsWith("AssertionError:") && !trimmed.startsWith("FAIL "))
      question.push(line);
    if (newline === -1) break;
    start = newline + 1;
    scanned += 1;
  }
  return { frames: acc.frames, questionText: question.join("\n"), detected };
}

function scanText(acc: Accumulator, text: string | undefined): void {
  if (text === undefined) {
    return;
  }
  let start = 0;
  let scanned = 0;
  while (scanned < MAX_LINES_SCANNED && start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    scanLine(acc, text.slice(start, end));
    scanned += 1;
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }
}

function mergeTargetFiles(acc: Accumulator, targetFiles: readonly string[] | undefined): void {
  if (targetFiles === undefined) {
    return;
  }
  for (const raw of targetFiles) {
    const file = toPosix(raw.trim());
    if (file.length > 0) {
      pushFrame(acc, { file, line: undefined });
    }
  }
}

export function parseFailureEvidence(report: BugReportInput): FailureEvidence {
  const acc: Accumulator = { frames: [], messages: [], seen: new Set<string>() };
  scanText(acc, report.failingOutput);
  scanText(acc, report.stackTrace);
  mergeTargetFiles(acc, report.targetFiles);
  return { frames: acc.frames, messages: acc.messages };
}
