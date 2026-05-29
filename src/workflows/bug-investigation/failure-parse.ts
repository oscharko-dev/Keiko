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

import type { BugReportInput, FailureEvidence, FailureFrame } from "./types.js";

// Caps that bound total work regardless of input size.
const MAX_LINES_SCANNED = 2_000;
export const MAX_FRAMES = 25;
const MAX_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 200;

const ALL_DIGITS = /^[0-9]+$/;
const FILE_URL_PREFIX = "file://";
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

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

// Parses a numeric line number from a token, or undefined when the token is not all-digits.
function toLine(token: string | undefined): number | undefined {
  if (token === undefined || token.length === 0 || !ALL_DIGITS.test(token)) {
    return undefined;
  }
  return Number(token);
}

// Strips a leading `file://` URL prefix from a location token. `file:///repo/x.ts` -> `/repo/x.ts`.
function stripFileUrl(location: string): string {
  if (!location.startsWith(FILE_URL_PREFIX)) {
    return location;
  }
  const afterScheme = location.slice(FILE_URL_PREFIX.length);
  // file:///path keeps the leading slash of the absolute path; file://host/path is not expected
  // from runtimes here, so we keep everything after the scheme verbatim.
  return afterScheme;
}

// Peels `:line:col` off the END of a location token using a right-split, returning the file path
// and the numeric line (when present). `src/x.ts:3:10` -> { file: "src/x.ts", line: 3 }. A token
// with no numeric `:line` segment yields no frame.
function peelLocation(rawLocation: string): FailureFrame | undefined {
  const location = stripFileUrl(rawLocation.trim());
  const lastColon = location.lastIndexOf(":");
  if (lastColon <= 0) {
    return undefined;
  }
  const beforeCol = location.slice(0, lastColon);
  const lineColon = beforeCol.lastIndexOf(":");
  // Case `file:line:col`: peel col then line.
  const lineToken = lineColon <= 0 ? undefined : beforeCol.slice(lineColon + 1);
  const line = toLine(lineToken);
  if (line !== undefined) {
    const file = toPosix(beforeCol.slice(0, lineColon));
    return file.length === 0 ? undefined : { file, line };
  }
  // Case `file:line` (no col): the token after the last colon is the line.
  const lineOnly = toLine(location.slice(lastColon + 1));
  if (lineOnly !== undefined) {
    const file = toPosix(beforeCol);
    return file.length === 0 ? undefined : { file, line: lineOnly };
  }
  return undefined;
}

// Extracts the location token from a stack-frame line. Handles `at fn (loc)`, `at loc`, and a bare
// `loc` line, all via plain indexOf/slice (no regex).
function locationToken(line: string): string | undefined {
  const trimmed = line.trim();
  const open = trimmed.lastIndexOf("(");
  if (open !== -1) {
    const close = trimmed.indexOf(")", open + 1);
    if (close !== -1) {
      return trimmed.slice(open + 1, close);
    }
  }
  const at = "at ";
  if (trimmed.startsWith(at)) {
    return trimmed.slice(at.length).trim();
  }
  return trimmed;
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

function scanLine(acc: Accumulator, line: string): void {
  const token = locationToken(line);
  const frame = token === undefined ? undefined : peelLocation(token);
  if (frame !== undefined) {
    pushFrame(acc, frame);
  }
  if (isMessageLine(line.toLowerCase())) {
    pushMessage(acc, line);
  }
}

function scanText(acc: Accumulator, text: string | undefined): void {
  if (text === undefined) {
    return;
  }
  const lines = text.split("\n");
  const limit = Math.min(lines.length, MAX_LINES_SCANNED);
  for (let i = 0; i < limit; i += 1) {
    scanLine(acc, lines[i] ?? "");
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
