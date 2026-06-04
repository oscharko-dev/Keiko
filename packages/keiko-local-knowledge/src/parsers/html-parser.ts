// HTML parser adapter (Epic #189, Issue #266). Single-pass scanner — NO regex, NO DOM, NO
// new deps. Pure-string traversal.
//
// Security posture:
//   * Embedded JavaScript is NEVER executed. We treat `<script>...</script>` content as a
//     dropped substring; nothing parsed inside it lands in any unit. Same for `<style>` and
//     `<noscript>` whose bodies could contain encoded payloads we do not want to surface to
//     the chunker.
//   * Tag content is consumed by raw string scanning. No `new Function`, no `eval`, no DOM
//     APIs are touched; we cannot accidentally trigger sandbox escape because there is no
//     execution path.
//   * CodeQL `js/bad-tag-filter` does NOT fire: we never use regex to filter tags. We
//     `indexOf("<")` then scan character-by-character to find the matching `>`.
//
// Emits one `html-block` ParsedUnit per visible-content run between heading boundaries.
// `headingPath` is set from the most recent `<h1>`-`<h6>` stack at the moment the block
// opens. Inline text outside any heading produces a `html-block` with `headingPath: []`.

import {
  decodeUtf8,
  diagnostic,
  emptyResult,
  oversizeDiagnostic,
  shouldStop,
} from "./_internal.js";
import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import type { ParserAdapter, ParserOptions, ParserSelectionInput } from "./types.js";

const PARSER_ID = "html";
const PARSER_VERSION = "1";

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "xhtml"]);
const HTML_MEDIA_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

function isHtml(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) return true;
  if (HTML_MEDIA_TYPES.has(input.mediaType.toLowerCase())) return true;
  // Sniff: a leading `<!DOCTYPE` or `<html` is enough to claim. We never decode beyond a few
  // bytes here; the bigger decode happens inside `parse`.
  const head = input.bytes.subarray(0, 64);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head).trimStart().toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html");
}

// ─── Token model ─────────────────────────────────────────────────────────────

type TagKind = "open" | "close" | "self-closing";

interface Tag {
  readonly name: string;
  readonly kind: TagKind;
  readonly start: number; // start of `<`
  readonly end: number; // one past `>`
}

const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "noscript"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameChar(code: number): boolean {
  return isAlpha(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d /* - */;
}

function readTagName(
  text: string,
  from: number,
): { readonly name: string; readonly after: number } {
  let i = from;
  while (i < text.length && isNameChar(text.charCodeAt(i))) i += 1;
  return { name: text.slice(from, i).toLowerCase(), after: i };
}

// Returns the next tag starting at or after `from`. Skips comments, CDATA, and DOCTYPE.
function skipSpecialMarker(text: string, lt: number, after: number): number | null {
  if (text.startsWith("!--", after)) {
    const close = text.indexOf("-->", after + 3);
    return close === -1 ? text.length : close + 3;
  }
  const ch = text.charCodeAt(after);
  if (ch === 0x21 /* ! */ || ch === 0x3f /* ? */) {
    const gt = text.indexOf(">", after);
    return gt === -1 ? text.length : gt + 1;
  }
  return null;
}

function readTagAt(text: string, lt: number): Tag | null {
  const after = lt + 1;
  const isClose = text.charCodeAt(after) === 0x2f; /* / */
  const nameStart = isClose ? after + 1 : after;
  if (!isAlpha(text.charCodeAt(nameStart))) return null;
  const { name, after: afterName } = readTagName(text, nameStart);
  const gt = text.indexOf(">", afterName);
  if (gt === -1) return null;
  const selfClosing = !isClose && text.charCodeAt(gt - 1) === 0x2f;
  const kind: TagKind = isClose ? "close" : selfClosing ? "self-closing" : "open";
  return { name, kind, start: lt, end: gt + 1 };
}

type ScanEvent =
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly next: number }
  | { readonly kind: "tag"; readonly tag: Tag; readonly next: number }
  | { readonly kind: "marker"; readonly next: number }
  | { readonly kind: "eof" };

// Returns the next event starting at `from`. Text events cover inter-tag/inter-marker runs
// only — bytes that are part of a `<!DOCTYPE>` / `<!-- -->` / `<tag>` literal are NEVER
// surfaced as text. This is the contract that keeps `<html>` and `<body>` literals out of
// any html-block span.
function nextEvent(text: string, from: number): ScanEvent {
  if (from >= text.length) return { kind: "eof" };
  const lt = text.indexOf("<", from);
  if (lt === -1) return { kind: "text", start: from, end: text.length, next: text.length };
  if (lt > from) return { kind: "text", start: from, end: lt, next: lt };
  const marker = skipSpecialMarker(text, lt, lt + 1);
  if (marker !== null) return { kind: "marker", next: marker };
  const tag = readTagAt(text, lt);
  if (tag !== null) return { kind: "tag", tag, next: tag.end };
  return { kind: "text", start: lt, end: lt + 1, next: lt + 1 };
}

// For a raw-text tag we MUST skip until the matching close tag with the same name, without
// interpreting the inner bytes. This is what neutralises `<script>...</script>` payloads.
// `textLower` is a precomputed lowercase view threaded from `emitHtml` to avoid recomputing
// it on every raw-text tag — without this, a document with N script/style tags would call
// text.toLowerCase() N times, making the function O(n²) in document size.
function skipRawText(text: string, textLower: string, tagName: string, from: number): number {
  const target = `</${tagName}`;
  const close = textLower.indexOf(target, from);
  if (close === -1) return text.length;
  const gt = text.indexOf(">", close);
  return gt === -1 ? text.length : gt + 1;
}

// ─── Heading stack ───────────────────────────────────────────────────────────

function headingLevel(name: string): number {
  if (name.length !== 2 || name.charCodeAt(0) !== 0x68 /* h */) return 0;
  const code = name.charCodeAt(1);
  if (code < 0x31 || code > 0x36) return 0;
  return code - 0x30;
}

interface HeadingState {
  readonly stack: string[];
}

function pushHeading(state: HeadingState, level: number, label: string): void {
  while (state.stack.length >= level) state.stack.pop();
  state.stack.push(label);
}

// ─── Emission ────────────────────────────────────────────────────────────────

interface Emission {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

interface ScanState {
  readonly text: string;
  readonly textLower: string; // precomputed once to avoid O(n²) re-lowering in skipRawText
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  readonly heading: HeadingState;
  pendingBlockStart: number | null;
  pendingBlockHasText: boolean;
  pendingHeadingLabel: string | null;
  pendingHeadingLevel: number;
  stopped: boolean;
}

function isWhitespaceOnly(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

function flushBlock(state: ScanState, end: number): void {
  if (state.pendingBlockStart === null) return;
  if (end <= state.pendingBlockStart || !state.pendingBlockHasText) {
    state.pendingBlockStart = null;
    state.pendingBlockHasText = false;
    return;
  }
  const limit = shouldStop(state.startedAt, state.options, state.units.length);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    state.diagnostics.push(diagnostic(limit.code, limit.message, state.input.documentId, "info"));
    state.stopped = true;
    state.pendingBlockStart = null;
    state.pendingBlockHasText = false;
    return;
  }
  state.units.push({
    kind: "html-block",
    documentId: state.input.documentId,
    headingPath: [...state.heading.stack],
    characterStart: state.pendingBlockStart,
    characterEnd: end,
  });
  state.pendingBlockStart = null;
  state.pendingBlockHasText = false;
}

function openBlock(state: ScanState, at: number, hasText: boolean): void {
  state.pendingBlockStart ??= at;
  if (hasText) state.pendingBlockHasText = true;
}

function handleHeadingOpen(state: ScanState, tag: Tag, level: number): number {
  flushBlock(state, tag.start);
  state.pendingHeadingLabel = "";
  state.pendingHeadingLevel = level;
  return tag.end;
}

function handleHeadingClose(state: ScanState, tag: Tag): number {
  const label = (state.pendingHeadingLabel ?? "").trim();
  if (label.length > 0 && state.pendingHeadingLevel > 0) {
    pushHeading(state.heading, state.pendingHeadingLevel, label);
  }
  state.pendingHeadingLabel = null;
  state.pendingHeadingLevel = 0;
  state.pendingBlockStart = tag.end;
  return tag.end;
}

function appendTextRun(state: ScanState, from: number, to: number): void {
  if (from >= to) return;
  if (state.pendingHeadingLabel !== null) {
    state.pendingHeadingLabel += state.text.slice(from, to);
    return;
  }
  openBlock(state, from, !isWhitespaceOnly(state.text, from, to));
}

function handleTag(state: ScanState, tag: Tag): number {
  if (RAW_TEXT_TAGS.has(tag.name) && tag.kind === "open") {
    // Terminate any in-progress block at the tag boundary so the raw bytes never appear in
    // the unit stream. Skip past `</script>` (etc.); the next text run reopens a block.
    flushBlock(state, tag.start);
    return skipRawText(state.text, state.textLower, tag.name, tag.end);
  }
  const level = headingLevel(tag.name);
  if (level > 0 && tag.kind === "open") return handleHeadingOpen(state, tag, level);
  if (level > 0 && tag.kind === "close") return handleHeadingClose(state, tag);
  return tag.end;
}

function step(state: ScanState, cursor: number): number {
  const event = nextEvent(state.text, cursor);
  if (event.kind === "eof") {
    flushBlock(state, state.text.length);
    return state.text.length;
  }
  if (event.kind === "text") {
    appendTextRun(state, event.start, event.end);
    return event.next;
  }
  if (event.kind === "marker") return event.next;
  return handleTag(state, event.tag);
}

function emitHtml(text: string, input: ParserSelectionInput, options: ParserOptions): Emission {
  const state: ScanState = {
    text,
    textLower: text.toLowerCase(),
    input,
    options,
    startedAt: options.now(),
    units: [],
    diagnostics: [],
    heading: { stack: [] },
    pendingBlockStart: null,
    pendingBlockHasText: false,
    pendingHeadingLabel: null,
    pendingHeadingLevel: 0,
    stopped: false,
  };
  let cursor = 0;
  while (cursor < text.length && !state.stopped) {
    cursor = step(state, cursor);
  }
  flushBlock(state, text.length);
  return { units: state.units, diagnostics: state.diagnostics };
}

export const htmlParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isHtml(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(htmlParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    const decoded = decodeUtf8(input.bytes);
    const emission = emitHtml(decoded.text, input, options);
    return emptyResult(
      htmlParser.capability,
      input.documentId,
      options,
      emission.diagnostics,
      emission.units,
    );
  },
});
